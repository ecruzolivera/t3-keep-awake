import test from 'node:test';
import assert from 'node:assert/strict';
import { ShellState } from '../lib/activity.mjs';
import { thread, snapshot, update, synchronized } from './fixtures.mjs';

test('concurrent threads: release only on last work completion or removal', () => {
  const state = new ShellState();
  state.apply(snapshot([thread('a', { status: 'running' }), thread('b', { activityRunStatus: 'running' })]));
  state.apply(synchronized);
  assert.equal(state.activeCount, 2);
  state.apply(update(thread('a', { status: 'completed' }), 10));
  assert.equal(state.activeCount, 1);
  state.apply({ kind: 'thread.removed', threadId: 'b', sequence: 12, location: 'active' });
  assert.equal(state.activeCount, 0);
});
test('blocking approvals and inputs stop own run; async questions do not', () => {
  const state = new ShellState();
  state.apply(snapshot([
    thread('approval', { status: 'running', pendingRuntimeRequest: { kind: 'approval' } }),
    thread('input', { status: 'running', pendingRuntimeRequest: { kind: 'user_input' } }),
    thread('async', { status: 'running', pendingRuntimeRequest: { kind: 'user_input', blocking: false } }),
  ]));
  assert.equal(state.activeCount, 1);
  state.apply(update(thread('async'), 2));
  assert.equal(state.activeCount, 0);
});
test('awaited background work outlives turn, and independent work outlives user input', () => {
  const state = new ShellState();
  const command = { taskId: 'cmd', kind: 'command', awaited: true };
  state.apply(snapshot([thread('a', { status: 'completed', pendingBackgroundTasks: [command] })]));
  assert.equal(state.activeCount, 1);
  state.apply(update(thread('a', { pendingRuntimeRequest: { kind: 'user_input' }, pendingBackgroundTasks: [command] }), 2));
  assert.equal(state.activeCount, 1);
  state.apply(update(thread('a'), 3));
  assert.equal(state.activeCount, 0);
});
test('unawaited servers, awaited PR watchers, future schedules and plain waiting are idle', () => {
  const state = new ShellState();
  state.apply(snapshot([
    thread('server', { pendingBackgroundTasks: [{ taskId: 'server', kind: 'command' }] }),
    thread('pr', { pendingBackgroundTasks: [{ taskId: 'pull-request-watch:github:1', kind: 'monitor', awaited: true }] }),
    thread('future', { status: 'completed', scheduledAt: '2099-01-01' }),
    thread('wait', { status: 'waiting' }),
    thread('remote-wait', { status: 'running', blockedOnThreadWait: true }),
  ]));
  assert.equal(state.activeCount, 0);
});
test('local child activity counts separately; waiting parent alone does not', () => {
  const state = new ShellState();
  state.apply(snapshot([
    thread('parent', { status: 'running', blockedOnThreadWait: true }),
    thread('child', { status: 'running', delegatedFrom: { environmentId: 'remote-parent', threadId: 'elsewhere' } }),
  ]));
  assert.equal(state.activeCount, 1);
  state.apply(update(thread('child', { status: 'running', pendingRuntimeRequest: { kind: 'user_input' } })));
  assert.equal(state.activeCount, 0);
});
test('native subagents count after turn; app-owned child summaries follow the child state', () => {
  const state = new ShellState();
  state.apply(snapshot([thread('native', { pendingBackgroundTasks: [{ kind: 'subagent', taskId: 'native-child' }] })]));
  assert.equal(state.activeCount, 1);
  state.apply(snapshot([
    thread('app', { pendingBackgroundTasks: [{ kind: 'subagent', taskId: 'app-child', childThreadId: 'child' }] }),
    thread('child', { status: 'running', pendingRuntimeRequest: { kind: 'approval' } }),
  ], 2));
  assert.equal(state.activeCount, 0);
});
test('project-only enrichment cannot clear running threads; authoritative snapshots replace them', () => {
  const state = new ShellState();
  state.apply(snapshot([thread('a', { status: 'running', title: 'PRIVATE', latestVisibleMessage: 'PRIVATE' })]));
  state.apply({ ...snapshot([], 1), resolvedRepositoryIdentityRoots: ['/repo'] });
  assert.equal(state.activeCount, 1);
  assert.equal(JSON.stringify([...state.threads.values()]).includes('PRIVATE'), false);
  state.apply(snapshot([], 10));
  assert.equal(state.activeCount, 0);
});
test('reject unknown schema/activity and updates before initial snapshot', () => {
  assert.throws(() => new ShellState().apply(update(thread('a'))), { code: 'protocol' });
  const value = snapshot(); value.snapshot.schemaVersion = 3;
  assert.throws(() => new ShellState().apply(value), { code: 'protocol' });
  assert.throws(() => new ShellState().apply(snapshot([thread('a', { status: 'unrecognized' })])), { code: 'protocol' });
});
