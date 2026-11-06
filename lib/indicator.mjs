import { readFile, lstat, open, rename, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { paths, privateDirectory, readPrivate } from './config.mjs';
import { ownedDirectory } from './managed-files.mjs';
import { AppError } from './errors.mjs';

const ID = 't3KeepAwake';
const FILES = ['plugin.json', 'IndicatorState.js', 'T3Monitor.qml', 'T3Widget.qml'];
async function atomicText(path, text, mode = 0o600) {
  const temporary = join(dirname(path), `.t3-indicator-${randomUUID()}`);
  try {
    const handle = await open(temporary, 'wx', mode);
    try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => {}); }
}
export function addIndicatorToBar(settings) {
  const next = structuredClone(settings);
  const bar = next.barConfigs?.find(value => value.enabled !== false && Array.isArray(value.rightWidgets));
  if (!bar) throw new AppError('indicator', 'No compatible enabled DankBar found. Add T3 Code Status through DMS Settings → DankBar.', true);
  for (const section of ['leftWidgets', 'centerWidgets', 'rightWidgets']) {
    const index = (bar[section] ?? []).findIndex(value => (typeof value === 'string' ? value : value.id) === ID);
    if (index !== -1) { bar[section][index] = { ...(typeof bar[section][index] === 'object' ? bar[section][index] : {}), id: ID, enabled: true }; return next; }
  }
  const tray = bar.rightWidgets.findIndex(value => (typeof value === 'string' ? value : value.id) === 'systemTray');
  bar.rightWidgets.splice(tray === -1 ? 0 : tray + 1, 0, { id: ID, enabled: true });
  return next;
}
function command(args) {
  const result = spawnSync('dms', ['ipc', 'call', ...args], { encoding: 'utf8', timeout: 5000 });
  return { code: result.status, stdout: result.stdout ?? '' };
}
export async function installIndicator({ env = process.env, log = console.error, run = command,
  source = new URL('../plugins/dms-t3-keep-awake/', import.meta.url), wait = delay } = {}) {
  const p = paths(env);
  const config = join(p.config, '..', 'DankMaterialShell');
  const settingsPath = join(config, 'settings.json');
  const settingsInfo = await lstat(settingsPath).catch(() => null);
  if (!settingsInfo?.isFile() || settingsInfo.uid !== process.getuid() || (settingsInfo.mode & 0o022)) throw new AppError('indicator', 'DMS settings were not found or have unsafe permissions. This indicator requires your existing DMS user session.', true);
  const original = await readFile(settingsPath, 'utf8');
  const updated = addIndicatorToBar(JSON.parse(original));
  const destination = join(config, 'plugins/t3-keep-awake');
  await ownedDirectory(dirname(destination));
  const existing = await lstat(destination).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (existing) try {
    const info = existing;
    if (!info.isDirectory()) throw new Error();
    const metadata = await readPrivate(join(destination, 'plugin.json'));
    if (metadata.id !== ID) throw new Error();
  } catch { throw new AppError('indicator', 'An unmanaged indicator directory already exists. Inspect it before replacing it.', true); }
  await privateDirectory(destination);
  for (const file of FILES) await atomicText(join(destination, file), await readFile(new URL(file, source), 'utf8'));
  await atomicText(join(destination, 'StatusLocation.js'), `var statusPath = ${JSON.stringify(join(p.state, 'status.json'))};\n`);
  if (run(['plugin-scan', 'scan']).code !== 0) throw new AppError('indicator', 'Indicator files are installed, but DMS could not be reached. Start DMS and rerun install-indicator.', true);
  let loaded = false;
  for (let attempt = 0; attempt < 25; attempt++) {
    const result = run(['plugins', 'enable', ID]);
    const status = run(['plugin-scan', 'status', ID]);
    if (result.code === 0 && result.stdout.includes('SUCCESS') && status.code === 0 && status.stdout.startsWith('loaded\t')) { loaded = true; break; }
    await wait(200);
  }
  if (!loaded) throw new AppError('indicator', 'DMS could not load T3 Code Status. Inspect DMS plugin errors; no bar layout was changed.', true);
  const reloaded = run(['plugins', 'reload', ID]);
  if (reloaded.code !== 0 || !reloaded.stdout.includes('SUCCESS')) throw new AppError('indicator', 'DMS could not reload T3 Code Status. No bar layout was changed.', true);
  const current = await readFile(settingsPath, 'utf8');
  if (current !== original) throw new AppError('indicator', 'DMS settings changed during installation. Rerun install-indicator to safely add the widget.', true);
  const backup = settingsPath + '.before-t3-indicator';
  try { const file = await open(backup, 'wx', 0o600); try { await file.writeFile(original); } finally { await file.close(); } }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  await atomicText(settingsPath, JSON.stringify(updated, null, 2) + '\n', settingsInfo.mode & 0o777);
  log('T3 Code Status added beside the system tray. Click T3 for activity and sleep-protection details.');
  log('The companion was not restarted. Existing releases show working/idle and protection; full thread counts appear after upgrading the companion.');
  return destination;
}
