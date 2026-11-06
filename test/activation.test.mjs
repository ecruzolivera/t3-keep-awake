import test from 'node:test';
import assert from 'node:assert/strict';
import { reportActivation } from '../lib/activation.mjs';
import { processIdentity } from '../lib/runtime.mjs';

const invocation = 'a'.repeat(32);
const service = (extra = '') => `ActiveState=active\nSubState=running\nResult=success\nInvocationID=${invocation}\nMainPID=${process.pid}\n${extra}`;
async function fixture() {
  const status = { pid: process.pid, startTime: await processIdentity(), connected: true, activeThreads: 2, held: true };
  const logs = []; const calls = [];
  const options = { commands: { systemctl: 'systemctl', journalctl: 'journalctl' }, timeoutMs: 0,
    stateDirectory: '/unused', log: line => logs.push(line), readStatus: async () => status,
    run: (command, args) => {
      calls.push([command, ...args]);
      return { code: 0, stdout: command === 'systemctl' ? service() : JSON.stringify({ MESSAGE: 'T3 shell snapshot synchronized.' }) };
    },
  };
  return { options, status, logs, calls };
}
test('startup report shows service status, actual T3 connection and current-invocation journal', async () => {
  const f = await fixture();
  assert.deepEqual(await reportActivation(f.options), { active: true, connected: true });
  assert.ok(f.logs.includes('T3: connected. Active threads: 2. Sleep inhibitor: held.'));
  assert.ok(f.logs.includes('  T3 shell snapshot synchronized.'));
  assert.ok(f.calls.some(call => call.includes(`_SYSTEMD_INVOCATION_ID=${invocation}`)));
  assert.ok(f.calls.every(call => !call.includes('restart') && !call.includes('enable')));
});
test('Type=simple active is not treated as T3 ready; bounded check waits for synchronization', async () => {
  const f = await fixture(); let clock = 0; let reads = 0;
  const result = await reportActivation({ ...f.options, timeoutMs: 1000, now: () => clock, wait: async ms => { clock += ms; },
    readStatus: async () => ({ ...f.status, connected: ++reads >= 3 }) });
  assert.equal(reads, 3); assert.equal(clock, 400); assert.equal(result.connected, true);
});
test('stale daemon status never reports a successful T3 connection', async () => {
  const f = await fixture();
  const result = await reportActivation({ ...f.options, readStatus: async () => ({ ...f.status, startTime: '0' }) });
  assert.equal(result.active, true); assert.equal(result.connected, false);
  assert.ok(f.logs.some(line => line.includes('not confirmed yet')));
});
test('failed service still shows its startup journal, using activation time if invocation ID is cleared', async () => {
  const f = await fixture();
  const result = await reportActivation({ ...f.options, sinceMs: 1234567890000, run: (command, args) => {
    f.calls.push([command, ...args]);
    return { code: 0, stdout: command === 'systemctl' ? 'ActiveState=failed\nSubState=failed\nResult=exit-code\nMainPID=0\n' : JSON.stringify({ MESSAGE: 'Pairing expired; pair again.' }) };
  } });
  assert.equal(result.active, false);
  assert.ok(f.calls.some(call => call.includes('--since=@1234567890.000')));
  assert.ok(f.logs.includes('  Pairing expired; pair again.'));
});
test('unavailable or malformed journal does not hide service status or echo raw content', async () => {
  const f = await fixture();
  for (const journal of [{ code: 1, stdout: 'PRIVATE-RAW' }, { code: 0, stdout: 'PRIVATE-RAW' }]) {
    const result = await reportActivation({ ...f.options, run: command => command === 'systemctl' ? { code: 0, stdout: service() } : journal });
    assert.equal(result.active, true);
  }
  assert.equal(f.logs.join('\n').includes('PRIVATE-RAW'), false);
  assert.ok(f.logs.some(line => line.startsWith('Follow logs:')));
});
test('journal rendering redacts credentials and URLs and strips terminal escapes', async () => {
  const f = await fixture();
  await reportActivation({ ...f.options, secrets: ['PRIVATE-TOKEN'], run: command => ({ code: 0, stdout: command === 'systemctl' ? service() : JSON.stringify({ MESSAGE: '\u001b[31mPRIVATE-TOKEN Bearer OTHER-TOKEN http://localhost/pair#token=SECRET\u001b[0m' }) }) });
  const text = f.logs.join('\n');
  for (const secret of ['PRIVATE-TOKEN', 'OTHER-TOKEN', 'SECRET', '\u001b']) assert.equal(text.includes(secret), false);
});
