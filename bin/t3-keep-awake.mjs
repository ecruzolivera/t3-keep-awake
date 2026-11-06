#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
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
import { pairingInput } from '../lib/pairing-input.mjs';
import { install } from '../lib/installer.mjs';
import { installIndicator } from '../lib/indicator.mjs';

process.umask(0o077);
const HELP = `t3-keep-awake (Linux, Node >=24)

  install [--server ORIGIN] [--credential-file FILE] [--no-start]
                         Autodetect T3; guided user installation and activation
  pair --server http://127.0.0.1:PORT --credential-file /private/file
  run [--observe]         Supervise local work (observe never inhibits sleep)
  status                 Show private, redacted daemon status
  install-indicator      Add the T3 status indicator to your existing DankBar
  diagnose [--server ORIGIN]  Read-only compatibility and permission checks
  service-unit           Print an installable user unit; changes nothing
  help

Installation asks you to paste the pairing code without echoing it.
Never pass codes as arguments. For --credential-file, use an owned mode 0600 file.
Configuration and credentials use XDG_CONFIG_HOME/t3-keep-awake.
Only 'install' installs a service; it asks before enabling/starting it.
'run' acquires real sleep inhibitors unless --observe is supplied.
See README for activation and limitations.
`;

async function main() {
  const { values, positionals } = parseArgs({ options: {
    server: { type: 'string' }, 'credential-file': { type: 'string' }, observe: { type: 'boolean' }, help: { type: 'boolean' },
    'no-start': { type: 'boolean' }, version: { type: 'boolean' },
  }, allowPositionals: true });
  if (values.version) { console.log(JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version); return; }
  const command = values.help ? 'help' : positionals[0] ?? 'help';
  if (positionals.length > 1) throw new AppError('usage', 'Unexpected arguments; run help.', true);
  if (command === 'help') { console.log(HELP); return; }
  const allowed = { install: ['server', 'credential-file', 'no-start'], pair: ['server', 'credential-file'], run: ['observe'], diagnose: ['server'], status: [], 'service-unit': [], 'install-indicator': [] };
  for (const key of Object.keys(values)) if (!allowed[command]?.includes(key)) throw new AppError('usage', 'Option is not supported by this command; run help.', true);
  if (platform() !== 'linux' || /microsoft/i.test(release())) throw new AppError('platform', 'Only native Linux is supported; WSL is outside this release.', true);
  const p = paths();
  switch (command) {
    case 'install-indicator': await installIndicator(); break;
    case 'install': await install({ server: values.server, credentialFile: values['credential-file'], noStart: values['no-start'] }); break;
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
        threadStates: live ? value.threadStates ?? null : null,
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
