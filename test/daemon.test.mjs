import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { runDaemon } from '../lib/daemon.mjs';
import { ObserveInhibitor } from '../lib/inhibitor.mjs';
import { AppError, authError } from '../lib/errors.mjs';
import { connectStream } from '../lib/protocol.mjs';
import { FakeSocket, thread, snapshot, chunk, synchronized } from './fixtures.mjs';

const config = { server: 'http://127.0.0.1:12345', disconnectGraceMs: 50, reconnectMinMs: 5, reconnectMaxMs: 10 };
const credential = { environmentId: 'env', expiresAt: Date.now() + 60000 };
async function until(predicate) {
  for (let i = 0; i < 150 && !predicate(); i++) await delay(5);
  assert.ok(predicate(), 'condition must become true within bounded time');
}
function setup(t, extra = {}) {
  const aborter = new AbortController();
  const inhibitor = new ObserveInhibitor();
  const transitions = [];
  inhibitor.acquire = async () => { transitions.push('acquire'); inhibitor.active = true; };
  inhibitor.release = async () => { if (inhibitor.active) transitions.push('release'); inhibitor.active = false; };
  const statuses = [];
  const logs = [];
  const running = runDaemon({ config, credential, inhibitor, signal: aborter.signal,
    getDescriptor: async () => ({ environmentId: 'env' }), verify: async () => {}, getSocketUrl: async () => 'ws://127.0.0.1/ws',
    stream: (url, options) => connectStream(url, { ...options, WebSocketImpl: FakeSocket }),
    status: async value => statuses.push(value), log: value => logs.push(value), ...extra });
  running.catch(() => {});
  t.after(async () => { aborter.abort(); await running.catch(() => {}); });
  return { aborter, inhibitor, transitions, statuses, logs, running };
}
test('daemon: synchronized concurrent work, reconnect without flicker, last completion, graceful stop', async t => {
  const start = FakeSocket.instances.length;
  const context = setup(t);
  await until(() => FakeSocket.instances.length > start);
  const first = FakeSocket.instances.at(-1);
  first.receive(chunk([snapshot([thread('a', { status: 'running' }), thread('b', { status: 'running' })]), synchronized]));
  await until(() => context.inhibitor.active);
  await until(() => context.statuses.some(value => value.threadStates?.working === 2));
  first.close();
  await until(() => FakeSocket.instances.length > start + 1);
  const second = FakeSocket.instances.at(-1);
  second.receive(chunk([snapshot([thread('b', { status: 'running' })], 10)]));
  assert.deepEqual(context.transitions, ['acquire']);
  second.receive(chunk([synchronized]));
  assert.deepEqual(context.transitions, ['acquire']);
  second.receive(chunk([{ kind: 'thread.removed', threadId: 'b', location: 'active', sequence: 11 }]));
  await until(() => !context.inhibitor.active);
  context.aborter.abort(); await context.running;
  assert.deepEqual(context.transitions, ['acquire', 'release']);
  assert.equal(context.statuses.at(-1).connected, false);
  assert.equal(context.statuses.at(-1).threadStates, null);
});
test('repeated disconnects and partial snapshots never extend grace forever', async t => {
  let sessions = 0;
  const context = setup(t, { stream: async (_url, { onState }) => {
    if (sessions++ === 0) onState({ activeCount: 1, sequence: 1 });
    throw new AppError('network', 'Synthetic disconnect');
  } });
  await until(() => context.transitions.includes('acquire'));
  await until(() => context.transitions.includes('release'));
  assert.ok(sessions > 2);
  assert.equal(context.inhibitor.active, false);
});
test('revoked auth after disconnect releases immediately and stops retries', async t => {
  let verifies = 0;
  const context = setup(t, {
    config: { ...config, disconnectGraceMs: 300000 },
    verify: async () => { if (verifies++ > 0) throw authError(); },
    stream: async (_url, { onState }) => { onState({ activeCount: 1, sequence: 1 }); await delay(5); throw new AppError('network', 'Synthetic disconnect'); },
  });
  await assert.rejects(context.running, { code: 'auth', fatal: true });
  assert.equal(context.inhibitor.active, false);
  assert.deepEqual(context.transitions, ['acquire', 'release']);
  assert.equal(verifies, 2);
});
test('inhibitor loss is unrecoverable in current process and triggers cleanup', async t => {
  const context = setup(t, { stream: async (_url, { onState, signal }) => {
    onState({ activeCount: 1, sequence: 1 });
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  } });
  await until(() => context.inhibitor.active);
  context.inhibitor.onLost();
  await assert.rejects(context.running, { code: 'inhibitor' });
  assert.equal(context.inhibitor.active, false);
});
