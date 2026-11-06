// Synthetic, privacy-safe V2 wire fixtures. Field names verified against T3
// 310a0d5 contracts/orchestrationV2.ts and Effect 4.1.2 RpcMessage.ts.
export const thread = (id, overrides = {}) => ({
  id, status: 'idle', activeRunId: null, activityRunStatus: null,
  pendingRuntimeRequest: null, pendingBackgroundTasks: [], deletedAt: null,
  ...overrides,
});
export const snapshot = (threads = [], sequence = 1) => ({ kind: 'snapshot', snapshot: {
  schemaVersion: 2, snapshotSequence: sequence, projects: [], threads, archivedThreads: [],
} });
export const synchronized = { kind: 'synchronized' };
export const update = (value, sequence = 2) => ({ kind: 'thread.updated', sequence, location: 'active', thread: value });
export const chunk = values => ({ _tag: 'Chunk', requestId: 'shell', values });
export class FakeSocket extends EventTarget {
  static instances = [];
  readyState = 0;
  sent = [];
  constructor(url) {
    super(); this.url = url; FakeSocket.instances.push(this);
    queueMicrotask(() => { if (this.readyState === 3) return; this.readyState = 1; this.dispatchEvent(new Event('open')); });
  }
  send(value) { this.sent.push(JSON.parse(value)); }
  receive(value) { this.dispatchEvent(new MessageEvent('message', { data: typeof value === 'string' ? value : JSON.stringify(value) })); }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
}
export const turn = () => new Promise(resolve => setImmediate(resolve));
