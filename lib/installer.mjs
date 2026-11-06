import { access, chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { homedir, platform, release } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { AppError } from './errors.mjs';
import { paths, privateDirectory, readPrivate, writePrivate, validateConfig, loadSettings } from './config.mjs';
import { pair, descriptor, verifySession } from './auth.mjs';
import { pairingInput, parsePairingInput } from './pairing-input.mjs';
import { serviceUnit } from './service.mjs';
import { singleInstance, isLive } from './runtime.mjs';
import { terminalPrompts } from './prompts.mjs';
import { discoverServers, resolveServer } from './discovery.mjs';
import { reportActivation } from './activation.mjs';

const NAME = 't3-keep-awake';
const MANAGED = '# Managed by t3-keep-awake installer';
const SOURCE = fileURLToPath(new URL('..', import.meta.url));
const CONTENT = ['package.json', 'bin', 'lib', 'systemd', 'README.md', 'LICENSE', 'docs'];
const shellQuote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";

export function installLayout(env = process.env, home = homedir()) {
  const base = (name, fallback) => env[name] && isAbsolute(env[name]) ? env[name] : fallback;
  const root = join(base('XDG_DATA_HOME', join(home, '.local/share')), NAME);
  const configHome = base('XDG_CONFIG_HOME', join(home, '.config'));
  return { root, releases: join(root, 'releases'), launcher: join(home, '.local/bin', NAME), unit: join(configHome, 'systemd/user', `${NAME}.service`) };
}
export function runCommand(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
  return { code: result.status, stdout: result.stdout ?? '' };
}
async function executable(name, env) {
  for (const dir of (env.PATH ?? '').split(':').filter(isAbsolute)) {
    const path = join(dir, name);
    try { await access(path, constants.X_OK); if ((await lstat(path)).isDirectory()) continue; return await realpath(path); } catch {}
  }
  throw new AppError('prerequisite', `Required command ${name} is missing. Install your distribution's systemd tools before retrying; this installer never uses sudo.`, true);
}
export async function checkPrerequisites({ env = process.env, run = runCommand } = {}) {
  if (platform() !== 'linux' || /microsoft/i.test(release())) throw new AppError('platform', 'Installation requires native Linux; WSL is unsupported.', true);
  if (Number(process.versions.node.split('.')[0]) < 24) throw new AppError('node', 'Install Node.js 24 or newer, then rerun the npx command.', true);
  if (process.getuid() === 0) throw new AppError('root', 'Run the installer as your normal user, without sudo.', true);
  if (!env.XDG_RUNTIME_DIR || !isAbsolute(env.XDG_RUNTIME_DIR)) throw new AppError('session', 'Run from a logged-in user session with XDG_RUNTIME_DIR and a systemd user manager.', true);
  const runtime = await lstat(env.XDG_RUNTIME_DIR);
  if (!runtime.isDirectory() || runtime.uid !== process.getuid() || (runtime.mode & 0o077)) throw new AppError('session', 'XDG_RUNTIME_DIR must be your private runtime directory (0700).', true);
  const commands = Object.fromEntries(await Promise.all(['systemctl', 'systemd-inhibit', 'systemd-analyze', 'busctl', 'journalctl'].map(async name => [name, await executable(name, env)])));
  if (run(commands.systemctl, ['--user', 'show-environment']).code !== 0) throw new AppError('session', 'The systemd user manager is unavailable. Log into a systemd user session before retrying.', true);
  if (run(commands['systemd-inhibit'], ['--version']).code !== 0) throw new AppError('prerequisite', 'systemd-inhibit is not usable. Repair your systemd installation before retrying.', true);
  if (run(commands.busctl, ['--system', '--timeout=5', 'status', 'org.freedesktop.login1']).code !== 0) throw new AppError('prerequisite', 'systemd-logind is unavailable on the system bus. Use a Linux session with logind before retrying.', true);
  return commands;
}
async function optionalPrivate(file) {
  try { return await readPrivate(file); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}
async function ownedDirectory(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o022)) throw new AppError('permissions', 'Installation directories must be owned by you and not writable by other users.', true);
}
async function managedFile(path, kind) {
  let info;
  try { info = await lstat(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!info.isFile() || info.uid !== process.getuid() || info.size > 65536 || (info.mode & 0o022)) throw new AppError('conflict', `Refusing to replace an unsafe or unmanaged ${kind}. Move it aside explicitly before retrying.`, true);
  const content = await readFile(path, 'utf8');
  const legacyUnit = kind === 'service unit' && content.startsWith('[Unit]\nDescription=Keep this host awake while local T3 Code agents work\n') && content.includes('SyslogIdentifier=t3-keep-awake\n');
  if (!content.startsWith(`${MANAGED}\n`) && !content.startsWith(`#!/bin/sh\n${MANAGED}\n`) && !legacyUnit) throw new AppError('conflict', `An unmanaged ${kind} already exists. Move it aside explicitly before retrying.`, true);
}
async function atomicFile(file, content, mode, kind) {
  await ownedDirectory(dirname(file));
  await managedFile(file, kind);
  const temporary = join(dirname(file), `.${NAME}.${randomUUID()}`);
  try {
    const handle = await open(temporary, 'wx', mode);
    try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(() => {}); }
}
async function entries(root, relative) {
  const info = await lstat(join(root, relative));
  if (info.isSymbolicLink()) throw new AppError('package', 'Package contains an unexpected symbolic link; reinstall from a trusted package.', true);
  if (info.isFile()) return [relative];
  if (!info.isDirectory()) throw new AppError('package', 'Unsupported package entry.', true);
  return (await Promise.all((await readdir(join(root, relative))).sort().map(name => entries(root, join(relative, name))))).flat();
}
async function packageFiles(root) { return (await Promise.all(CONTENT.map(name => entries(root, name)))).flat().sort(); }
async function digest(root, files) {
  const hash = createHash('sha256');
  for (const file of files) { hash.update(file); hash.update('\0'); hash.update(await readFile(join(root, file))); hash.update('\0'); }
  return hash.digest('hex');
}
async function durableCopy(source, layout) {
  const files = await packageFiles(source);
  const id = await digest(source, files);
  const pkg = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  if (pkg.name !== NAME || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(pkg.version)) throw new AppError('package', 'Invalid application package.', true);
  await privateDirectory(layout.root); await privateDirectory(layout.releases);
  const destination = join(layout.releases, `${pkg.version}-${id.slice(0, 16)}`);
  try {
    const info = await lstat(destination);
    if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077) || await digest(destination, await packageFiles(destination)) !== id) throw new AppError('package', 'Existing installed release has unexpected contents or permissions; inspect it before retrying.', true);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const stage = await mkdtemp(join(layout.releases, '.stage-'));
    try {
      for (const file of files) {
        await mkdir(dirname(join(stage, file)), { recursive: true, mode: 0o700 });
        await copyFile(join(source, file), join(stage, file));
        await chmod(join(stage, file), file.startsWith('bin/') ? 0o700 : 0o600);
      }
      if (await digest(stage, files) !== id) throw new AppError('package', 'Package changed while copying; retry installation.', true);
      await rename(stage, destination);
    } finally { await rm(stage, { recursive: true, force: true }); }
  }
  return { version: pkg.version, cli: join(destination, 'bin/t3-keep-awake.mjs'), destination };
}

export async function install({ server, credentialFile, noStart = false, env = process.env, home = homedir(), source = SOURCE,
  prompts = terminalPrompts(), log = console.error, run = runCommand, preflight = checkPrerequisites,
  getDescriptor = descriptor, verify = verifySession, exchange = pair, discover = discoverServers, checkActivation = reportActivation } = {}) {
  const commands = await preflight({ env, run });
  const p = paths(env);
  const layout = installLayout(env, home);
  const unlock = await singleInstance(join(p.runtime, 'installer'));
  try {
    await ownedDirectory(dirname(layout.launcher)); await ownedDirectory(dirname(layout.unit));
    await managedFile(layout.launcher, 'CLI launcher'); await managedFile(layout.unit, 'service unit');
    const activity = run(commands.systemctl, ['--user', 'is-active', `${NAME}.service`]);
    if (![0, 3, 4].includes(activity.code)) throw new AppError('systemd', 'Cannot determine existing service state. Inspect systemctl --user status before retrying.', true);
    const wasActive = activity.code === 0;
    const currentStatus = await optionalPrivate(join(p.state, 'status.json'));
    if (!wasActive && currentStatus && await isLive(currentStatus)) throw new AppError('instance', 'A manually started supervisor is running. Stop it before installing the service.', true);
    const saved = await optionalPrivate(join(p.config, 'config.json'));
    const previous = saved ? validateConfig(saved) : undefined;
    const storedCredential = await optionalPrivate(join(p.config, 'credentials.json'));
    const { origin, environment } = await resolveServer({ server, savedServer: previous?.server,
      environmentId: storedCredential?.environmentId, prompts, log, discover, getDescriptor });
    let credential;
    try {
      const settings = await loadSettings(p);
      if (settings.credential.environmentId === environment.environmentId) {
        await verify(origin, settings.credential);
        credential = { ...settings.credential, server: origin };
        log('Reusing the existing read-only companion session.');
      }
    } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'auth' && error.code !== 'scope') throw error; }
    // Complete package checks before consuming a one-time pairing credential.
    const installed = await durableCopy(source, layout);
    const node = await realpath(process.execPath);
    const unit = `${MANAGED}\n` + await serviceUnit({ nodePath: node, cliPath: installed.cli, environment: {
      XDG_CONFIG_HOME: dirname(p.config), XDG_STATE_HOME: dirname(p.state), XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR,
      PATH: dirname(commands['systemd-inhibit']),
    } });
    const staging = await mkdtemp(join(layout.root, '.unit-'));
    try {
      const unitFile = join(staging, `${NAME}.service`);
      const handle = await open(unitFile, 'wx', 0o600);
      try { await handle.writeFile(unit); } finally { await handle.close(); }
      if (run(commands['systemd-analyze'], ['--user', 'verify', unitFile]).code !== 0) throw new AppError('unit', 'Generated service failed systemd validation; nothing was activated.', true);
    } finally { await rm(staging, { recursive: true, force: true }); }
    if (!credential) {
      log('In T3 Authorized Clients, create a read-only pairing code and copy it.');
      log('Use only orchestration:read. This permission includes conversation access; the companion reads activity only.');
      const bootstrap = credentialFile ? await pairingInput(credentialFile, origin) : parsePairingInput(await prompts.secret('Paste the pairing code (hidden): '), origin);
      credential = await exchange(origin, bootstrap);
    }
    await writePrivate(p.config, 'credentials.json', credential);
    await writePrivate(p.config, 'config.json', validateConfig({ ...previous, server: origin }));
    const launcher = `#!/bin/sh\n${MANAGED}\nexec ${shellQuote(node)} ${shellQuote(installed.cli)} "$@"\n`;
    await atomicFile(layout.launcher, launcher, 0o700, 'CLI launcher');
    log('Application installed in permanent user storage. Configuration is preserved.');
    log(`CLI: ${layout.launcher}`);
    log('Sleep inhibition can also block ordinary manual suspend. No power settings are edited.');
    const activate = !noStart && prompts.interactive && await prompts.confirm(wasActive ? 'Apply this update and restart the existing user service now?' : 'Enable and start the user service now?');
    // Declining a fresh install leaves it stopped. On updates an already active
    // service keeps its old unit/release until the owner confirms a restart.
    if (wasActive && !activate) {
      log('Existing running service left unchanged. New release and launcher are staged; rerun install to apply the service update.');
    } else {
      await atomicFile(layout.unit, unit, 0o600, 'service unit');
      if (run(commands.systemctl, ['--user', 'daemon-reload']).code !== 0) throw new AppError('systemd', 'Files installed, but systemd daemon-reload failed. Inspect the user manager before starting the service.', true);
      if (activate) {
        const sinceMs = Date.now();
        const started = run(commands.systemctl, ['--user', 'enable', '--now', `${NAME}.service`]).code === 0 &&
          (!wasActive || run(commands.systemctl, ['--user', 'restart', `${NAME}.service`]).code === 0);
        log('Checking service startup and journal…');
        const health = await checkActivation({ commands, run, stateDirectory: p.state, log, secrets: [credential.accessToken], sinceMs, ...(started ? {} : { timeoutMs: 0 }) });
        if (!started || !health.active) {
          throw new AppError('systemd', 'Activation did not complete. Inspect systemctl --user status and journalctl --user -u t3-keep-awake.service; files and credentials are retained.', true);
        }
        log(health.connected ? 'Setup complete. User service is enabled and connected to T3.' : 'User service is enabled; its T3 connection still needs verification.');
      } else log('User service installed and left stopped. Activate later with systemctl --user enable --now t3-keep-awake.service.');
    }
    await writePrivate(layout.root, 'install.json', { format: 1, ...installed, launcher: layout.launcher, unit: layout.unit, node, activated: !!activate, serviceUnchanged: wasActive && !activate });
    if (credentialFile) log('The pairing input file was not deleted; remove it when no longer needed.');
    if (!(env.PATH ?? '').split(':').includes(dirname(layout.launcher))) log(`Add ${dirname(layout.launcher)} to your shell PATH, or use the full CLI path above. No shell startup file was edited.`);
    return { ...installed, ...layout, activated: !!activate, wasActive };
  } finally { await unlock(); }
}
