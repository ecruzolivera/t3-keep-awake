import { setTimeout as pause } from 'node:timers/promises';
import { join } from 'node:path';
import { readPrivate } from './config.mjs';
import { isLive } from './runtime.mjs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { privateDirectory } from './config.mjs';
import { AppError } from './errors.mjs';
import { serviceUnit } from './service.mjs';
import { MANAGED, ownedDirectory, managedFile, atomicFile } from './managed-files.mjs';

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
async function reportActivation({ commands, run, stateDirectory, log = console.error, secrets = [],
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
    if (!readable || !['active', 'activating', 'reloading'].includes(service.ActiveState) || (service.ActiveState === 'active' && status?.connected === true) || now() >= deadline) break;
    await wait(Math.min(200, Math.max(0, deadline - now())));
  } while (true);
  const active = readable && service.ActiveState === 'active';
  const word = value => /^[a-z-]+$/.test(value ?? '') ? value : 'unknown';
  log(readable ? `Service: ${word(service.ActiveState)} (${word(service.SubState)}); result: ${word(service.Result)}.` : 'Service status could not be read.');
  if (active && status?.connected === true) {
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
  return { active, connected: status?.connected === true };
}

export async function prepareActivation({ commands, run, definitionPath, workDirectory, stateDirectory,
  nodePath, cliPath, environment = {}, log = console.error, clock = {} }) {
  await ownedDirectory(dirname(definitionPath));
  await managedFile(definitionPath, 'service unit');
  const activity = run(commands.systemctl, ['--user', 'is-active', UNIT]);
  if (![0, 3, 4].includes(activity.code)) throw new AppError('systemd', 'Cannot determine existing service state. Inspect systemctl --user status before retrying.', true);
  const wasActive = activity.code === 0;
  let existing;
  try { existing = await readPrivate(join(stateDirectory, 'status.json')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!wasActive && existing && await isLive(existing)) throw new AppError('instance', 'A manually started supervisor is running. Stop it before installing the service.', true);
  const definition = `${MANAGED}\n` + await serviceUnit({ nodePath, cliPath, environment });
  await privateDirectory(workDirectory);
  const staging = await mkdtemp(join(workDirectory, '.unit-'));
  try {
    const file = join(staging, UNIT);
    const handle = await open(file, 'wx', 0o600);
    try { await handle.writeFile(definition); } finally { await handle.close(); }
    if (run(commands['systemd-analyze'], ['--user', 'verify', file]).code !== 0) throw new AppError('unit', 'Generated service failed systemd validation; nothing was activated.', true);
  } finally { await rm(staging, { recursive: true, force: true }); }

  return Object.freeze({ wasActive, async apply({ start = false, secrets = [] } = {}) {
    if (wasActive && !start) {
      log('Existing running service left unchanged. New release and launcher are staged; rerun install to apply the service update.');
      return { activated: false, unchanged: true };
    }
    await atomicFile(definitionPath, definition, 0o600, 'service unit');
    const sinceMs = Date.now();
    const reloaded = run(commands.systemctl, ['--user', 'daemon-reload']).code === 0;
    if (!start) {
      if (!reloaded) throw new AppError('systemd', 'Files installed, but systemd daemon-reload failed. Inspect the user manager before starting the service.', true);
      log('User service installed and left stopped. Activate later with systemctl --user enable --now t3-keep-awake.service.');
      return { activated: false, unchanged: false };
    }
    const started = reloaded && run(commands.systemctl, ['--user', 'enable', '--now', UNIT]).code === 0 &&
      (!wasActive || run(commands.systemctl, ['--user', 'restart', UNIT]).code === 0);
    log('Checking service startup and journal…');
    const health = await reportActivation({ commands, run, stateDirectory, log, secrets, sinceMs,
      now: clock.now, wait: clock.wait, ...(started ? {} : { timeoutMs: 0 }) });
    if (!started || !health.active) throw new AppError('systemd', 'Activation did not complete. Inspect systemctl --user status and journalctl --user -u t3-keep-awake.service; files and credentials are retained.', true);
    if (!health.connected) throw new AppError('readiness', 'T3 connectivity was not confirmed within five seconds. Activation failed; the companion remains enabled and will retry temporary connection failures. Review the journal above and run t3-keep-awake status. Files and pairing are retained.', true);
    log('Setup complete. User service is enabled and connected to T3.');
    return { activated: true, unchanged: false };
  } });
}
