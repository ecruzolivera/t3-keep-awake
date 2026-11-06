import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir, endianness } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { listeningOrigins, localCandidates, discoverServers, resolveServer } from '../lib/discovery.mjs';

const header = 'sl local_address rem_address st tx_queue tr retrnsmt uid timeout inode\n';
function address(hex) {
  const bytes = Buffer.from(hex, 'hex');
  if (endianness() === 'LE') for (let i = 0; i < bytes.length; i += 4) bytes.subarray(i, i + 4).reverse();
  return bytes.toString('hex').toUpperCase();
}
const row = (host, port, inode, uid = process.getuid(), state = '0A') => `0: ${host}:${port.toString(16)} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000 ${uid} 0 ${inode}\n`;
const candidate = (port, id = 'local') => ({ origin: `http://127.0.0.1:${port}`, environment: { environmentId: id, label: id } });

test('socket parser restricts discovery to owned listening loopback/wildcard sockets', () => {
  const table = header + row(address('7f000001'), 1234, '1') + row(address('00000000'), 1235, '2') +
    row(address('c0a80101'), 1236, '3') + row(address('7f000001'), 1237, '4', process.getuid() + 1) +
    row(address('7f000001'), 1238, '5', process.getuid(), '01') + row(address('7f000001'), 1239, '6');
  assert.deepEqual(listeningOrigins(table, new Set(['1', '2', '3', '4', '5']), process.getuid()), ['http://127.0.0.1:1234', 'http://127.0.0.1:1235']);
});
test('IPv6 loopback, wildcard and mapped loopback sockets are supported', () => {
  const table = header + row(address('00000000000000000000000000000001'), 3333, '1') +
    row(address('00000000000000000000000000000000'), 3334, '2') + row(address('00000000000000000000ffff7f000001'), 3335, '3');
  assert.deepEqual(listeningOrigins(table, new Set(['1', '2', '3']), process.getuid(), true), ['http://[::1]:3333', 'http://[::1]:3334', 'http://127.0.0.1:3335']);
});
test('process discovery uses only socket links and names, skipping unrelated applications', async t => {
  const root = await mkdtemp(join(tmpdir(), 't3-discovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'net'));
  for (const [pid, name, inode] of [['10', 't3code', '123'], ['11', 'node', '456'], ['12', 'unrelated', '789']]) {
    await mkdir(join(root, pid, 'fd'), { recursive: true });
    await writeFile(join(root, pid, 'comm'), name + '\n');
    await symlink(`socket:[${inode}]`, join(root, pid, 'fd/7'));
    // No cmdline, environ, database or credential files exist in this fixture.
  }
  await writeFile(join(root, 'net/tcp'), header + row(address('7f000001'), 1234, '123') + row(address('7f000001'), 1235, '456') + row(address('7f000001'), 1236, '789'));
  assert.deepEqual(await localCandidates({ procRoot: root }), ['http://127.0.0.1:1234', 'http://127.0.0.1:1235']);
});
test('descriptor probes reject unrelated listeners and deduplicate routes by environment', async () => {
  const found = await discoverServers({ candidates: async () => ['http://[::1]:1234', 'http://127.0.0.1:1234', 'http://127.0.0.1:9999'],
    getDescriptor: async (origin, options) => { assert.ok(options.signal); if (origin.endsWith('9999')) throw new Error('not T3'); return { environmentId: 'same' }; } });
  assert.equal(found.length, 1); assert.equal(found[0].environment.environmentId, 'same');
  assert.equal(found[0].origin, 'http://127.0.0.1:1234');
});
test('real HTTP discovery validates the public descriptor without authentication', async t => {
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/.well-known/t3/environment'); assert.equal(req.headers.authorization, undefined);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ environmentId: 'test', orchestrationProtocolVersion: 2, platform: { os: 'linux' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const found = await discoverServers({ candidates: async () => [origin] });
  assert.deepEqual(found, [{ origin, environment: { environmentId: 'test', orchestrationProtocolVersion: 2, platform: { os: 'linux' } } }]);
});
test('fresh discovery selects a unique environment without asking any question', async () => {
  const selected = await resolveServer({ discover: async () => [candidate(5555)], log() {}, prompts: { question: () => assert.fail('must not ask for port') } });
  assert.equal(selected.origin, 'http://127.0.0.1:5555');
});
test('changed saved port rediscovers the paired environment rather than a different T3 instance', async () => {
  const result = await resolveServer({ savedServer: 'http://127.0.0.1:1111', environmentId: 'paired',
    getDescriptor: async () => ({ environmentId: 'different' }), discover: async () => [candidate(2222, 'other'), candidate(3333, 'paired')], log() {},
    prompts: { question: () => assert.fail('paired identity should resolve ambiguity') } });
  assert.equal(result.origin, 'http://127.0.0.1:3333');
});
test('multiple environments prompt for selection; noninteractive discovery never guesses', async () => {
  const found = [candidate(1111, 'first'), candidate(2222, 'second')];
  const selected = await resolveServer({ discover: async () => found, log() {}, prompts: { interactive: true, question: async text => { assert.ok(text.startsWith('Environment')); return '2'; } } });
  assert.equal(selected.environment.environmentId, 'second');
  await assert.rejects(resolveServer({ discover: async () => found, log() {}, prompts: { interactive: false } }), { code: 'discovery' });
});
test('no running T3 reports an actionable error instead of asking users to find a port', async () => {
  await assert.rejects(resolveServer({ discover: async () => [], log() {}, prompts: { question: () => assert.fail('must not ask for port') } }), { code: 'discovery' });
});
test('explicit --server overrides discovery', async () => {
  const selected = await resolveServer({ server: 'http://127.0.0.1:9999', getDescriptor: async () => ({ environmentId: 'custom' }), discover: async () => assert.fail('explicit origin must win') });
  assert.equal(selected.environment.environmentId, 'custom');
});
