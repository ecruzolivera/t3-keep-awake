#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { release, platform } from 'node:os';
import { spawnSync } from 'node:child_process';
import { paths, localServer, loadSettings, readPrivate, writePrivate, validateConfig, privateDirectory } from '../lib/config.mjs';
import { pair, descriptor, verifySession } from '../lib/auth.mjs';
import { Inhibitor, ObserveInhibitor } from '../lib/inhibitor.mjs';
import { runDaemon } from '../lib/daemon.mjs';
import { AppError, safeError } from '../lib/errors.mjs';
import { singleInstance, processIdentity, isLive } from '../lib/runtime.mjs';
import { serviceUnit } from '../lib/service.mjs';

process.umask(0o077);
const HELP = `t3-keep-awake (Linux, Node >=24)

  pair --server http://127.0.0.1:PORT --credential-file /private/file
  run [--observe]         Supervise local work (observe never inhibits sleep)
  status                 Show private, redacted daemon status
  diagnose [--server ORIGIN]  Read-only compatibility and permission checks
  service-unit           Print an installable user unit; changes nothing
  help

Pairing input is a raw bootstrap credential or a direct local /pair#token= URL.
Never pass secrets as arguments. The input file must be owned by you, mode 0600.
Configuration and credentials use XDG_CONFIG_HOME/t3-keep-awake.
No command installs or enables a service. 'run' acquires real sleep inhibitors
unless --observe is supplied. See README for activation and limitations.
`;

async function pairingInput(file, server) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let value;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) || info.size > 65536) throw new AppError('permissions', 'Pairing input must be an owned regular file with mode 0600.', true);
    value = (await handle.readFile('utf8')).trim();
  } finally { await handle.close(); }
  if (/^https?:/i.test(value)) {
    let url;
    try { url = new URL(value); } catch { throw new AppError('pairing', 'Invalid direct pairing URL.', true); }
    if (url.origin !== server || url.pathname !== '/pair' || url.search) throw new AppError('pairing', 'Pairing URL must belong to the configured local server; hosted links are not accepted.', true);
    value = new URLSearchParams(url.hash.slice(1)).get('token') ?? '';
  }
  if (!value || /\s/.test(value)) throw new AppError('pairing', 'Pairing input is missing or malformed.', true);
  return value;
}

async function main() {
  const { values, positionals } = parseArgs({ options: {
    server: { type: 'string' }, 'credential-file': { type: 'string' }, observe: { type: 'boolean' }, help: { type: 'boolean' },
  }, allowPositionals: true });
  const command = values.help ? 'help' : positionals[0] ?? 'help';
  if (positionals.length > 1) throw new AppError('usage', 'Unexpected arguments; run help.', true);
  if (command === 'help') { console.log(HELP); return; }
  if (platform() !== 'linux' || /microsoft/i.test(release())) throw new AppError('platform', 'Only native Linux is supported; WSL is outside this release.', true);
  const p = paths();
  switch (command) {
    case 'pair': {
      if (!values.server || !values['credential-file']) throw new AppError('usage', 'pair requires --server and --credential-file. Run help.', true);
      const server = localServer(values.server);
      await privateDirectory(p.config);
      let previous;
      try { previous = validateConfig(await readPrivate(join(p.config, 'config.json'))); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const credential = await pair(server, await pairingInput(values['credential-file'], server));
      // Pairing is a setup action only. No inhibitor or service is started.
      await writePrivate(p.config, 'credentials.json', credential);
      await writePrivate(p.config, 'config.json', previous?.server === server ? previous : validateConfig({ server }));
      console.log('Paired with orchestration:read only. Service remains inactive. Securely remove the pairing input file.');
      break;
    }
    case 'run': {
      const unlock = await singleInstance(p.runtime);
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
      try {
        const startTime = await processIdentity();
        let settings;
        try { settings = await loadSettings(p); }
        catch (error) {
          if (error.code === 'ENOENT') throw new AppError('config', 'Not paired. Run pair with the local server and a private credential file before starting the supervisor.', true);
          throw error;
        }
        const { config, credential } = settings;
        if (values.observe) console.error('Observe mode: sleep inhibition is simulated.');
        await runDaemon({ config, credential, inhibitor: values.observe ? new ObserveInhibitor() : new Inhibitor(), signal: controller.signal,
          log: message => console.error(values.observe ? `[observe] ${message}` : message),
          status: value => writePrivate(p.state, 'status.json', { ...value, held: !values.observe && value.held, observing: !!values.observe, pid: process.pid, startTime }) });
      } finally {
        process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
        await unlock();
      }
      break;
    }
    case 'status': {
      let value;
      try { value = await readPrivate(join(p.state, 'status.json')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const live = value ? await isLive(value) : false;
      console.log(JSON.stringify({ running: live, held: live && value?.held === true,
        connected: live && value?.connected === true, observing: live && value?.observing === true,
        activeThreads: live ? value.activeThreads : 0, lastError: value?.lastError ?? null,
        updatedAt: value?.updatedAt ?? null }, null, 2));
      break;
    }
    case 'service-unit': console.log(await serviceUnit()); break;
    case 'diagnose': {
      const commandAvailable = command => spawnSync(command, ['--version'], { stdio: 'ignore', timeout: 3000 }).status === 0;
      const output = { linux: true, node: process.version, inhibitorCommandAvailable: commandAvailable('systemd-inhibit'),
        userSystemdAvailable: spawnSync('systemctl', ['--user', 'show-environment'], { stdio: 'ignore', timeout: 3000 }).status === 0,
        runtimeDirectoryAvailable: !!p.runtime, inhibitorAcquired: false };
      // Query policy metadata only. This does not call login1.Inhibit or ask for
      // authorization; actual permission is established at activation time.
      const policy = spawnSync('pkaction', ['--action-id', 'org.freedesktop.login1.inhibit-block-sleep', '--verbose'], { encoding: 'utf8', timeout: 3000 });
      output.sleepInhibitPolicyAvailable = policy.status === 0;
      output.sleepInhibitImplicitActive = policy.stdout?.match(/implicit active:\s*(\S+)/)?.[1] ?? 'unknown';
      let settings;
      try { settings = await loadSettings(p); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const server = values.server ? localServer(values.server) : settings?.config.server;
      if (server) {
        const environment = await descriptor(server);
        output.serverVersion = environment.serverVersion;
        output.protocolVersion = environment.orchestrationProtocolVersion;
        if (settings && settings.config.server === server) { await verifySession(server, settings.credential); output.readOnlySessionValid = true; }
      }
      console.log(JSON.stringify(output, null, 2));
      break;
    }
    default: throw new AppError('usage', 'Unknown command; run help.', true);
  }
}

main().catch(error => {
  console.error(safeError(error));
  process.exitCode = error instanceof AppError && error.fatal ? 78 : 1;
});
