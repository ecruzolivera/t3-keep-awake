import { setTimeout as pause } from 'node:timers/promises';
import { join } from 'node:path';
import { readPrivate } from './config.mjs';
import { isLive } from './runtime.mjs';

const UNIT = 't3-keep-awake.service';
function properties(output) {
  return Object.fromEntries(output.split('\n').filter(line => line.includes('=')).map(line => {
    const split = line.indexOf('='); return [line.slice(0, split), line.slice(split + 1)];
  }));
}
function safeMessage(message, secrets) {
  if (typeof message !== 'string') return null;
  let safe = message;
  for (const secret of secrets.filter(Boolean)) safe = safe.replaceAll(secret, '[redacted]');
  return safe.replace(/\b(?:https?|wss?):\/\/[^\s]+/gi, '[URL omitted]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, 400);
}
async function statusFile(directory) {
  try { return await readPrivate(join(directory, 'status.json')); } catch { return null; }
}

// A Type=simple service being active does not mean T3 has connected. Give this
// invocation a bounded startup window, then show its journal even on failure.
export async function reportActivation({ commands, run, stateDirectory, log = console.error, secrets = [],
  timeoutMs = 5000, sinceMs = Date.now(), now = () => performance.now(), wait = pause, readStatus = statusFile } = {}) {
  const deadline = now() + timeoutMs;
  let service = {}; let status = null; let readable = false;
  do {
    const result = run(commands.systemctl, ['--user', 'show', UNIT,
      '--property=ActiveState', '--property=SubState', '--property=Result', '--property=InvocationID', '--property=MainPID']);
    readable = result.code === 0;
    service = readable ? properties(result.stdout ?? '') : {};
    const candidate = await readStatus(stateDirectory);
    status = candidate && Number(service.MainPID) === candidate.pid && await isLive(candidate) ? candidate : null;
    if (!readable || !['active', 'activating', 'reloading'].includes(service.ActiveState) || (service.ActiveState === 'active' && status?.connected) || now() >= deadline) break;
    await wait(Math.min(200, Math.max(0, deadline - now())));
  } while (true);
  const active = readable && service.ActiveState === 'active';
  const word = value => /^[a-z-]+$/.test(value ?? '') ? value : 'unknown';
  log(readable ? `Service: ${word(service.ActiveState)} (${word(service.SubState)}); result: ${word(service.Result)}.` : 'Service status could not be read.');
  if (active && status?.connected) {
    const count = Number.isSafeInteger(status.activeThreads) && status.activeThreads >= 0 ? status.activeThreads : 0;
    log(`T3: connected. Active threads: ${count}. Sleep inhibitor: ${status.held === true ? 'held' : 'released'}.`);
  } else if (active) log('T3 connection is not confirmed yet. Review the startup messages below.');
  else log('The service did not stay running. Review the startup messages below.');

  const invocation = service.InvocationID;
  if (commands.journalctl) {
    const filter = /^[0-9a-f]{32}$/i.test(invocation ?? '') ? [`_SYSTEMD_INVOCATION_ID=${invocation}`] : [`--since=@${(sinceMs / 1000).toFixed(3)}`];
    const journal = run(commands.journalctl, ['--user', '--unit', UNIT, '--no-pager', '--output=json', '--lines=12', ...filter]);
    if (journal.code === 0) {
      const messages = [];
      for (const line of (journal.stdout ?? '').split('\n').filter(Boolean)) {
        try { const message = safeMessage(JSON.parse(line).MESSAGE, secrets); if (message) messages.push(message); } catch { /* Never echo malformed raw journal data. */ }
      }
      log(messages.length ? 'Recent startup journal:' : 'No journal messages are available for this start yet.');
      for (const message of messages) log(`  ${message}`);
    } else log('The startup journal could not be read.');
  } else log('The startup journal is not available for this service invocation.');
  log('Follow logs: journalctl --user -u t3-keep-awake.service -f');
  return { active, connected: !!status?.connected };
}
