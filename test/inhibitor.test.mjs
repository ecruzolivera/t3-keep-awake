import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { HoldController, Inhibitor, ObserveInhibitor } from '../lib/inhibitor.mjs';

test('disconnect grace is bounded across repeated failures; reconnect keeps existing hold', async () => {
  let now = 0;
  const inhibitor = new ObserveInhibitor();
  const controller = new HoldController(inhibitor, 30, () => now);
  controller.commit(2); await controller.reconcile(); assert.equal(inhibitor.active, true);
  controller.disconnect(); now = 10; controller.disconnect();
  await controller.reconcile(); assert.equal(inhibitor.active, true);
  controller.commit(1); await controller.reconcile(); assert.equal(inhibitor.active, true);
  now = 20; controller.disconnect(); now = 49; controller.disconnect();
  await controller.reconcile(); assert.equal(inhibitor.active, true);
  now = 50; await controller.reconcile(); assert.equal(inhibitor.active, false);
  controller.commit(1); await controller.reconcile(); assert.equal(inhibitor.active, true);
  await controller.stop(); assert.equal(inhibitor.active, false);
});

async function fakeCommand(t) {
  const dir = await mkdtemp(join(tmpdir(), 't3-awake-inhibitor-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'fake-inhibit');
  // Only replace the OS boundary. Execute the production EOF helper with the
  // same stdin pipe that systemd-inhibit would inherit. No real inhibitor.
  await writeFile(file, '#!/bin/sh\nshift 5\nexec "$@"\n', { mode: 0o700 });
  return file;
}
test('inhibitor readiness, clean stop and reacquisition use real subprocess pipes', async t => {
  const inhibitor = new Inhibitor({ command: await fakeCommand(t) });
  t.after(() => inhibitor.release());
  await inhibitor.acquire(); assert.equal(inhibitor.active, true);
  const pid = inhibitor.child.pid;
  await inhibitor.release(); assert.equal(inhibitor.active, false);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  await inhibitor.acquire(); assert.equal(inhibitor.active, true);
});
test('authorization/spawn failures never report a working inhibitor', async t => {
  const inhibitor = new Inhibitor({ command: '/definitely/missing/t3-inhibit' });
  t.after(() => inhibitor.release());
  await assert.rejects(inhibitor.acquire(), { code: 'inhibitor' });
  assert.equal(inhibitor.active, false);
});
test('SIGKILL of supervisor closes lease pipe and the helper cannot stay alive', async t => {
  const command = await fakeCommand(t);
  const module = new URL('../lib/inhibitor.mjs', import.meta.url).href;
  const source = `import { Inhibitor } from ${JSON.stringify(module)};
    const inhibitor = new Inhibitor({ command: ${JSON.stringify(command)} });
    await inhibitor.acquire(); console.log(inhibitor.child.pid); setInterval(()=>{},1000);`;
  const supervisor = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => supervisor.kill('SIGKILL'));
  const [bytes] = await once(supervisor.stdout, 'data');
  const helperPid = Number(bytes.toString().trim());
  assert.ok(helperPid > 0);
  const stopped = once(supervisor, 'exit'); supervisor.kill('SIGKILL'); await stopped;
  const running = async () => {
    try { const stat = await readFile(`/proc/${helperPid}/stat`, 'utf8'); return stat.slice(stat.lastIndexOf(')') + 2)[0] !== 'Z'; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  };
  for (let i = 0; i < 50 && await running(); i++) await delay(10);
  assert.equal(await running(), false, 'helper must exit on supervisor pipe EOF');
});
