import test from 'node:test';
import assert from 'node:assert/strict';
import { connectStream } from '../lib/protocol.mjs';
import { FakeSocket, thread, snapshot, chunk, synchronized, turn } from './fixtures.mjs';

test('Effect envelope, chunk acknowledgement, ping/pong, and staged snapshot completion', async () => {
  const aborter = new AbortController();
  const states = [];
  const running = connectStream('ws://127.0.0.1/ws', { signal: aborter.signal, WebSocketImpl: FakeSocket, onState: state => states.push(state.activeCount) });
  await turn();
  const socket = FakeSocket.instances.at(-1);
  assert.deepEqual(socket.sent[0], { _tag: 'Request', id: 'shell', tag: 'orchestration.subscribeShell', payload: { requestCompletionMarker: true }, headers: [] });
  socket.receive(chunk([snapshot([thread('a', { status: 'running' })])]));
  assert.deepEqual(states, []);
  assert.deepEqual(socket.sent.at(-1), { _tag: 'Ack', requestId: 'shell' });
  socket.receive([{ _tag: 'Ping' }, { _tag: 'Pong' }, chunk([synchronized])]);
  assert.deepEqual(states, [1]);
  assert.ok(socket.sent.some(frame => frame._tag === 'Pong'));
  aborter.abort(); await running;
  assert.equal(socket.readyState, 3);
});
test('silent connection has bounded timeout even without close/error frames', async () => {
  await assert.rejects(connectStream('ws://127.0.0.1/ws', { WebSocketImpl: FakeSocket, onState() {}, heartbeatMs: 5, timeoutMs: 15 }), { code: 'timeout' });
});
test('malformed and terminal frames terminate rather than retain stale stream state', async () => {
  for (const frame of ['not-json', { _tag: 'Exit', requestId: 'shell', exit: { _tag: 'Failure', cause: 'PRIVATE' } }]) {
    const running = connectStream('ws://127.0.0.1/ws', { WebSocketImpl: FakeSocket, onState() {} });
    const rejected = assert.rejects(running, { code: 'protocol', fatal: true });
    await turn(); FakeSocket.instances.at(-1).receive(frame); await rejected;
  }
});
