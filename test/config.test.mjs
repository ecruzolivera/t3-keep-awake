import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, chmod, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localServer, validateConfig, writePrivate, readPrivate } from '../lib/config.mjs';
import { singleInstance, isLive, processIdentity } from '../lib/runtime.mjs';

test('configuration accepts loopback only and enforces bounded reconnect/grace', () => {
  for (const value of ['http://127.0.0.1:1234', 'http://localhost:5555', 'https://[::1]:3333']) assert.equal(localServer(value), value);
  for (const value of ['https://remote.example', 'http://localhost.evil', 'http://127.0.0.1:1/path', 'http://secret@localhost', 'http://localhost/#token=PRIVATE']) assert.throws(() => localServer(value), { code: 'config' });
  assert.throws(() => validateConfig({ server: 'http://localhost', disconnectGraceMs: Infinity }), { code: 'config' });
  assert.throws(() => validateConfig({ server: 'http://localhost', reconnectMinMs: 1000, reconnectMaxMs: 500 }), { code: 'config' });
});
test('private storage creates 0700/0600, rejects symlinks and loose existing permissions', async t => {
  const temp = await mkdtemp(join(tmpdir(), 't3-awake-config-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const dir = join(temp, 'private');
  await writePrivate(dir, 'credentials.json', { token: 'PRIVATE' });
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.equal((await stat(join(dir, 'credentials.json'))).mode & 0o777, 0o600);
  await symlink(join(dir, 'credentials.json'), join(dir, 'link.json'));
  await assert.rejects(readPrivate(join(dir, 'link.json')), { code: 'ELOOP' });
  await chmod(join(dir, 'credentials.json'), 0o644);
  await assert.rejects(readPrivate(join(dir, 'credentials.json')), { code: 'permissions' });
  await chmod(dir, 0o755);
  await assert.rejects(writePrivate(dir, 'new.json', {}), { code: 'permissions' });
});
test('single instance lock rejects concurrent supervisors and recovers a stale socket', async t => {
  const temp = await mkdtemp(join(tmpdir(), 't3-awake-lock-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const unlock = await singleInstance(temp);
  await assert.rejects(singleInstance(temp), { code: 'instance' });
  await unlock();
  // Simulate a stale pathname left after a crash; failed connect permits recovery.
  await writeFile(join(temp, 'supervisor.sock'), 'stale', { mode: 0o600 });
  const unlockAgain = await singleInstance(temp); await unlockAgain();
});
test('status never trusts a stale PID or a reused PID with different process start time', async () => {
  assert.equal(await isLive({ pid: process.pid, startTime: await processIdentity() }), true);
  assert.equal(await isLive({ pid: process.pid, startTime: '0' }), false);
  assert.equal(await isLive({ pid: 999999999, startTime: '0' }), false);
});
