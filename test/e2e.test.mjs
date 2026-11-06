import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chunk, snapshot, synchronized, thread, update } from './fixtures.mjs';

// Minimal synthetic RFC6455 server, used to test Node's actual built-in client
// and HTTP stack. No test dependency, real T3 access or real inhibitor needed.
function textFrame(value) {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(body.length < 126 ? 2 : 4);
  header[0] = 0x81;
  if (body.length < 126) header[1] = body.length;
  else { header[1] = 126; header.writeUInt16BE(body.length, 2); }
  return Buffer.concat([header, body]);
}
test('installed-style CLI pairs, observes real HTTP/WebSocket traffic, writes private status and stops cleanly', async t => {
  const temp = await mkdtemp(join(tmpdir(), 't3-awake-e2e-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const requests = [];
  const rpc = [];
  let socket;
  const server = http.createServer(async (req, res) => {
    requests.push(req.url);
    let body = ''; for await (const part of req) body += part;
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/.well-known/t3/environment') {
      res.end(JSON.stringify({ environmentId: 'local', platform: { os: 'linux' }, serverVersion: '0.1.7', orchestrationProtocolVersion: 2 }));
    } else if (req.url === '/oauth/token') {
      assert.equal(new URLSearchParams(body).get('scope'), 'orchestration:read');
      assert.equal(new URLSearchParams(body).get('subject_token'), 'PRIVATE-BOOTSTRAP');
      res.end(JSON.stringify({ access_token: 'PRIVATE-ACCESS', token_type: 'Bearer', expires_in: 1000, scope: 'orchestration:read' }));
    } else if (req.url === '/api/auth/session') {
      assert.equal(req.headers.authorization, 'Bearer PRIVATE-ACCESS');
      res.end(JSON.stringify({ authenticated: true, permissions: ['orchestration:read'] }));
    } else if (req.url === '/api/auth/websocket-ticket/rpc') {
      assert.equal(req.method, 'POST');
      assert.equal(req.headers.authorization, 'Bearer PRIVATE-ACCESS');
      res.end(JSON.stringify({ ticket: 'PRIVATE-TICKET', expiresAt: new Date(Date.now() + 60000).toISOString() }));
    } else { res.statusCode = 404; res.end('{}'); }
  });
  server.on('upgrade', (req, connection) => {
    socket = connection;
    const url = new URL(req.url, 'http://localhost');
    assert.equal(url.pathname, '/ws');
    assert.equal(url.searchParams.get('orchestrationProtocol'), '2');
    assert.equal(url.searchParams.get('wsTicket'), 'PRIVATE-TICKET');
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    connection.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buffer = Buffer.alloc(0);
    connection.on('data', bytes => {
      buffer = Buffer.concat([buffer, bytes]);
      while (buffer.length >= 2) {
        let size = buffer[1] & 127; let offset = 2;
        if (size === 126) { if (buffer.length < 4) return; size = buffer.readUInt16BE(2); offset = 4; }
        assert.notEqual(size, 127);
        const masked = (buffer[1] & 128) !== 0;
        const maskOffset = offset; if (masked) offset += 4;
        if (buffer.length < offset + size) return;
        const opcode = buffer[0] & 15;
        const payload = Buffer.from(buffer.subarray(offset, offset + size));
        if (masked) for (let i = 0; i < size; i++) payload[i] ^= buffer[maskOffset + i % 4];
        buffer = buffer.subarray(offset + size);
        if (opcode === 8) { connection.end(Buffer.from([0x88, 0])); return; }
        if (opcode !== 1) continue;
        const message = JSON.parse(payload.toString()); rpc.push(message);
        if (message._tag === 'Request') connection.write(textFrame(chunk([snapshot([thread('work', { status: 'running', title: 'PRIVATE-CONVERSATION' })]), synchronized])));
        if (message._tag === 'Ping') connection.write(textFrame({ _tag: 'Pong' }));
      }
    });
    connection.on('error', () => {});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { socket?.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const env = { ...process.env, XDG_CONFIG_HOME: join(temp, 'config'), XDG_STATE_HOME: join(temp, 'state'), XDG_RUNTIME_DIR: temp };
  const cli = fileURLToPath(new URL('../bin/t3-keep-awake.mjs', import.meta.url));
  const secretFile = join(temp, 'pairing');
  await writeFile(secretFile, 'PRIVATE-BOOTSTRAP', { mode: 0o600 });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const pairing = spawn(process.execPath, [cli, 'pair', '--server', origin, '--credential-file', secretFile], { env });
  let logs = '';
  pairing.stdout.on('data', bytes => { logs += bytes; }); pairing.stderr.on('data', bytes => { logs += bytes; });
  const [pairExit] = await once(pairing, 'exit'); assert.equal(pairExit, 0, logs);
  const observing = spawn(process.execPath, [cli, 'run', '--observe'], { env });
  let ended = false; observing.once('exit', () => { ended = true; });
  t.after(async () => { if (!ended) { observing.kill('SIGTERM'); await once(observing, 'exit'); } });
  observing.stdout.on('data', bytes => { logs += bytes; }); observing.stderr.on('data', bytes => { logs += bytes; });
  const readStatus = async () => {
    try { return JSON.parse(await readFile(join(temp, 'state/t3-keep-awake/status.json'), 'utf8')); }
    catch { return {}; }
  };
  async function waitFor(predicate) {
    for (let i = 0; i < 200; i++) { const status = await readStatus(); if (predicate(status)) return status; await delay(10); }
    assert.fail(`Expected status not reached; ${logs}`);
  }
  const working = await waitFor(status => status.connected && status.activeThreads === 1);
  assert.equal(working.held, false); assert.equal(working.observing, true);
  socket.write(textFrame(chunk([update(thread('work', { status: 'completed' }), 2)])));
  await waitFor(status => status.activeThreads === 0 && status.sequence === 2);
  const stopped = once(observing, 'exit'); observing.kill('SIGTERM');
  const [stopExit] = await stopped; assert.equal(stopExit, 0, logs);
  assert.equal((await readStatus()).connected, false);
  assert.ok(rpc.some(value => value._tag === 'Ack'));
  assert.ok(requests.includes('/oauth/token'));
  assert.equal(logs.includes('PRIVATE-'), false);
  assert.equal(JSON.stringify(await readStatus()).includes('PRIVATE-'), false);
});
