import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareActivation } from '../lib/activation.mjs';
import { processIdentity } from '../lib/runtime.mjs';
import { writePrivate } from '../lib/config.mjs';

const invocation = 'a'.repeat(32);
async function fixture(t, { active = false, connected = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 't3-activation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDirectory = join(root, 'state');
  const definitionPath = join(root, 'systemd/t3-keep-awake.service');
  const status = { pid: process.pid, startTime: await processIdentity(), connected, activeThreads: 2, held: true };
  const logs = []; const calls = []; let elapsed = 0; let enabled = false;
  const f = { status, logs, calls, active, journal: { code: 0, stdout: JSON.stringify({ MESSAGE: 'T3 shell snapshot synchronized.' }) } };
  const options = { commands: { systemctl: 'systemctl', journalctl: 'journalctl', 'systemd-analyze': 'systemd-analyze' },
    definitionPath, workDirectory: root, stateDirectory, nodePath: process.execPath,
    cliPath: join(root, "release with spaces '$/bin/t3-keep-awake.mjs"), log: line => logs.push(line),
    clock: { now: () => elapsed, wait: async ms => { elapsed += ms; if (f.onWait) await f.onWait(); } },
    run: (command, args) => {
      calls.push([command, ...args]);
      if (f.fail && args.includes(f.fail)) return { code: 1, stdout: '' };
      if (command === 'journalctl') return f.journal;
      if (args.includes('is-active')) return { code: f.active ? 0 : 4, stdout: f.active ? 'active' : 'inactive' };
      if (args.includes('enable')) { enabled = true; f.active = true; }
      if (args.includes('show')) return { code: 0, stdout: f.output ?? `ActiveState=${f.active ? 'active' : 'inactive'}\nSubState=running\nResult=success\nInvocationID=${invocation}\nMainPID=${process.pid}\n` };
      return { code: 0, stdout: '' };
    },
  };
  f.options = options;
  f.prepare = async () => { const prepared = await prepareActivation(options); await writePrivate(stateDirectory, 'status.json', status); return prepared; };
  f.saveStatus = () => writePrivate(stateDirectory, 'status.json', status);
  f.elapsed = () => elapsed; f.enabled = () => enabled;
  return f;
}

test('preparation validates without publishing or activating; application exercises real readiness and journal', async t => {
  const f = await fixture(t); const activation = await f.prepare();
  await assert.rejects(stat(f.options.definitionPath), { code: 'ENOENT' });
  assert.equal(f.enabled(), false);
  assert.ok(f.calls.some(call => call.includes('verify')));
  assert.deepEqual(await activation.apply({ start: true }), { activated: true, unchanged: false });
  assert.ok((await readFile(f.options.definitionPath, 'utf8')).includes('ExecStart='));
  assert.equal((await stat(f.options.definitionPath)).mode & 0o777, 0o600);
  assert.ok(f.logs.includes('T3: connected. Active threads: 2. Sleep inhibitor: held.'));
  assert.ok(f.logs.includes('  T3 shell snapshot synchronized.'));
  assert.ok(f.calls.some(call => call.includes(`_SYSTEMD_INVOCATION_ID=${invocation}`)));
});
test('activation waits for actual synchronization within the five-second deadline', async t => {
  const f = await fixture(t, { connected: false }); const activation = await f.prepare();
  f.onWait = async () => { if (f.elapsed() >= 400) { f.status.connected = true; await f.saveStatus(); } };
  await activation.apply({ start: true });
  assert.equal(f.elapsed(), 400);
});
test('readiness timeout fails while leaving an enabled process and its files available', async t => {
  const f = await fixture(t, { connected: false }); const activation = await f.prepare();
  await assert.rejects(activation.apply({ start: true }), { code: 'readiness', fatal: true });
  assert.equal(f.elapsed(), 5000); assert.equal(f.enabled(), true); assert.equal(f.active, true);
  assert.equal(f.calls.some(call => call.includes('stop') || call.includes('disable')), false);
  assert.equal((await stat(f.options.definitionPath)).isFile(), true);
  assert.ok(f.logs.some(line => line.startsWith('Recent startup journal:')));
  assert.equal(f.logs.some(line => line.startsWith('Setup complete.')), false);
});
test('stale status cannot make activation succeed', async t => {
  const f = await fixture(t); const activation = await f.prepare();
  f.status.startTime = '0'; await f.saveStatus();
  await assert.rejects(activation.apply({ start: true }), { code: 'readiness' });
  assert.ok(f.logs.some(line => line.includes('not confirmed yet')));
});
test('a failed process still shows its journal using activation time if invocation ID cleared', async t => {
  const f = await fixture(t); const activation = await f.prepare();
  f.output = 'ActiveState=failed\nSubState=failed\nResult=exit-code\nMainPID=0\n';
  f.journal.stdout = JSON.stringify({ MESSAGE: 'Pairing expired; pair again.' });
  await assert.rejects(activation.apply({ start: true }), { code: 'systemd' });
  assert.ok(f.calls.some(call => call.some(arg => arg.startsWith('--since=@'))));
  assert.ok(f.logs.includes('  Pairing expired; pair again.'));
});
test('unavailable or malformed journal neither hides readiness nor echoes raw records', async t => {
  for (const journal of [{ code: 1, stdout: 'PRIVATE-RAW' }, { code: 0, stdout: 'PRIVATE-RAW' }]) {
    const f = await fixture(t); const activation = await f.prepare(); f.journal = journal;
    await activation.apply({ start: true });
    assert.equal(f.logs.join('\n').includes('PRIVATE-RAW'), false);
    assert.ok(f.logs.some(line => line.startsWith('Follow logs:')));
  }
});
test('journal rendering redacts credentials and URLs and strips terminal escapes', async t => {
  const f = await fixture(t); const activation = await f.prepare();
  f.journal.stdout = JSON.stringify({ MESSAGE: '\u001b[31mPRIVATE-TOKEN Bearer OTHER-TOKEN http://localhost/pair#token=SECRET\u001b[0m' });
  await activation.apply({ start: true, secrets: ['PRIVATE-TOKEN'] });
  const text = f.logs.join('\n');
  for (const secret of ['PRIVATE-TOKEN', 'OTHER-TOKEN', 'SECRET', '\u001b']) assert.equal(text.includes(secret), false);
});
test('declining an update leaves a running process and its published definition unchanged', async t => {
  const f = await fixture(t, { active: true });
  const oldDefinition = '# Managed by t3-keep-awake installer\nold definition\n';
  await mkdir(join(f.options.definitionPath, '..'), { recursive: true, mode: 0o700 });
  await writeFile(f.options.definitionPath, oldDefinition, { mode: 0o600 });
  const activation = await f.prepare(); f.calls.length = 0;
  assert.deepEqual(await activation.apply({ start: false }), { activated: false, unchanged: true });
  assert.equal(await readFile(f.options.definitionPath, 'utf8'), oldDefinition);
  assert.equal(f.calls.length, 0);
});
test('validation failure never publishes a definition or starts a process', async t => {
  const f = await fixture(t); f.fail = 'verify';
  await assert.rejects(f.prepare(), { code: 'unit' });
  await assert.rejects(stat(f.options.definitionPath), { code: 'ENOENT' });
  assert.equal(f.enabled(), false);
});
test('an unmanaged process definition is rejected before activation commands', async t => {
  const f = await fixture(t);
  await mkdir(join(f.options.definitionPath, '..'), { recursive: true, mode: 0o700 });
  await writeFile(f.options.definitionPath, 'an unrelated definition', { mode: 0o600 });
  await assert.rejects(f.prepare(), { code: 'conflict' });
  assert.equal(f.calls.length, 0);
});
test('restart and reload failures show diagnostics and never claim success', async t => {
  for (const fail of ['daemon-reload', 'restart']) {
    const f = await fixture(t, { active: true }); const activation = await f.prepare(); f.fail = fail;
    await assert.rejects(activation.apply({ start: true }), { code: 'systemd' });
    assert.ok(f.logs.includes('  T3 shell snapshot synchronized.'));
    assert.equal(f.logs.some(line => line.startsWith('Setup complete.')), false);
    assert.equal(f.calls.some(call => call.includes('stop') || call.includes('disable')), false);
  }
});
