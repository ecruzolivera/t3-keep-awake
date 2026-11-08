import { protocolError } from './errors.mjs';

const RUNNING = new Set(['preparing', 'starting', 'running']);
const STATUSES = new Set(['idle', 'queued', ...RUNNING, 'waiting', 'completed', 'cancelled', 'failed', 'interrupted', 'rolled_back']);
function validateThread(t) {
  if (!t || typeof t.id !== 'string' || !STATUSES.has(t.status) ||
      (t.activityRunStatus != null && ![...RUNNING, 'waiting'].includes(t.activityRunStatus)) ||
      !Array.isArray(t.pendingBackgroundTasks ?? []) ||
      (t.pendingRuntimeRequest != null && typeof t.pendingRuntimeRequest !== 'object')) throw protocolError();
  for (const task of t.pendingBackgroundTasks ?? []) {
    if (!task || typeof task.taskId !== 'string' || typeof task.kind !== 'string' || (task.awaited !== undefined && task.awaited !== true)) throw protocolError();
  }
  return t;
}

// No titles, messages, descriptions or model output are kept in our projection.
function project(t) {
  validateThread(t);
  return { id: t.id, status: t.status, activityRunStatus: t.activityRunStatus,
    blockedOnThreadWait: t.blockedOnThreadWait === true,
    needsInput: t.pendingRuntimeRequest != null,
    blocking: t.pendingRuntimeRequest != null && t.pendingRuntimeRequest.blocking !== false,
    deleted: t.deletedAt != null, archived: t.archivedAt != null,
    settled: t.settledOverride === 'settled' || t.settledAt != null,
    tasks: (t.pendingBackgroundTasks ?? []).map(task => ({ taskId: task.taskId, kind: task.kind, awaited: task.awaited === true, childThreadId: task.childThreadId })) };
}
export function activeThreadIds(threads) {
  const active = new Set();
  for (const t of threads.values()) {
    if (!t.deleted && !t.blocking && !t.blockedOnThreadWait && RUNNING.has(t.activityRunStatus ?? t.status)) active.add(t.id);
  }
  // Propagate observable local child activity. A parent waiting for a child that
  // needs input is not itself work. Native subagents without app thread rows are
  // observable only through the subagent summary (see documented locality gap).
  let changed;
  do {
    changed = false;
    for (const t of threads.values()) {
      if (t.deleted || active.has(t.id)) continue;
      const background = t.tasks.some(task => {
        if (task.taskId.startsWith('pull-request-watch:')) return false;
        if (task.kind === 'subagent') {
          return task.childThreadId ? active.has(task.childThreadId) : true;
        }
        return task.awaited;
      });
      if (background) { active.add(t.id); changed = true; }
    }
  } while (changed);
  return [...active];
}

export class ShellState {
  threads = new Map();
  sequence = 0;
  initialized = false;
  synchronized = false;
  apply(item) {
    if (!item || typeof item.kind !== 'string') throw protocolError();
    if (item.kind === 'snapshot') {
      const snapshot = item.snapshot;
      if (snapshot?.schemaVersion !== 2 || !Number.isSafeInteger(snapshot.snapshotSequence) || snapshot.snapshotSequence < 0 ||
          !Array.isArray(snapshot.threads) || !Array.isArray(snapshot.archivedThreads)) throw protocolError();
      // T3 sends marked, project-only enrichment snapshots. These are NOT an
      // authoritative replacement of the thread collection.
      if (item.resolvedRepositoryIdentityRoots !== undefined) return;
      this.threads = new Map([...snapshot.threads, ...snapshot.archivedThreads].map(t => [t.id, project(t)]));
      this.sequence = snapshot.snapshotSequence;
      this.initialized = true;
      return;
    }
    if (!this.initialized) throw protocolError();
    if (item.kind === 'synchronized') { this.synchronized = true; return; }
    if (!Number.isSafeInteger(item.sequence) || item.sequence < 0) throw protocolError();
    // Application sequence numbers have legitimate gaps and coalesced events.
    // A fresh snapshot is requested on every connection; no cross-session replay.
    if (item.sequence < this.sequence) return;
    this.sequence = item.sequence;
    switch (item.kind) {
      case 'thread.updated': this.threads.set(item.thread?.id, project(item.thread)); break;
      case 'thread.removed':
        if (typeof item.threadId !== 'string') throw protocolError();
        this.threads.delete(item.threadId); break;
      case 'project.updated': case 'project.removed': break;
      default: throw protocolError();
    }
  }
  get activeCount() { return activeThreadIds(this.threads).length; }
  get threadStates() {
    const active = new Set(activeThreadIds(this.threads));
    const counts = { working: active.size, blocked: 0, done: 0, idle: 0, failed: 0 };
    for (const t of this.threads.values()) {
      if (t.deleted || t.archived || t.settled) continue;
      // Attention and activity are independent: a question can need an answer
      // while this same thread still has work that requires sleep protection.
      if (t.needsInput) counts.blocked++;
      else if (active.has(t.id)) continue;
      else if (t.status === 'failed') counts.failed++;
      else if (t.status === 'completed') counts.done++;
      else counts.idle++;
    }
    return counts;
  }
}
