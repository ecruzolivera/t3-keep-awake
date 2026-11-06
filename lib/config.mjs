import { constants } from 'node:fs';
import { open, mkdir, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError } from './errors.mjs';

export function paths(env = process.env) {
  const base = (key, fallback) => env[key] && isAbsolute(env[key]) ? env[key] : fallback;
  return {
    config: join(base('XDG_CONFIG_HOME', join(homedir(), '.config')), 't3-keep-awake'),
    state: join(base('XDG_STATE_HOME', join(homedir(), '.local/state')), 't3-keep-awake'),
    runtime: env.XDG_RUNTIME_DIR && isAbsolute(env.XDG_RUNTIME_DIR) ? join(env.XDG_RUNTIME_DIR, 't3-keep-awake') : null,
  };
}
export function localServer(value) {
  let url;
  try { url = new URL(value); } catch { throw new AppError('config', 'Provide a loopback HTTP(S) server origin.', true); }
  // Numeric loopback or localhost only: never follow an arbitrary remote host.
  if (!['http:', 'https:'].includes(url.protocol) ||
      !(url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\./.test(url.hostname)) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new AppError('config', 'Server must be a loopback HTTP(S) origin without credentials, path, query, or fragment.', true);
  }
  return url.origin;
}
export function validateConfig(input) {
  const config = { server: localServer(input.server), disconnectGraceMs: 30000, reconnectMinMs: 1000, reconnectMaxMs: 30000, ...input };
  config.server = localServer(input.server);
  for (const [key, min, max] of [['disconnectGraceMs', 0, 300000], ['reconnectMinMs', 100, 60000], ['reconnectMaxMs', 100, 300000]]) {
    if (!Number.isSafeInteger(config[key]) || config[key] < min || config[key] > max) throw new AppError('config', `Invalid ${key}.`, true);
  }
  if (config.reconnectMaxMs < config.reconnectMinMs) throw new AppError('config', 'Reconnect maximum must be at least the minimum.', true);
  return config;
}
export async function privateDirectory(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await checkPrivateDirectory(dir);
}
export async function checkPrivateDirectory(dir) {
  const handle = await open(dir, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
  try {
    const info = await handle.stat();
    if (info.uid !== process.getuid() || (info.mode & 0o077)) throw new AppError('permissions', 'App directories must be owned by you with mode 0700.', true);
  } finally { await handle.close(); }
}
export async function readPrivate(file) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) || info.size > 65536) throw new AppError('permissions', 'Configuration and credential files must be private, owned regular files (mode 0600).', true);
    return JSON.parse(await handle.readFile('utf8'));
  } finally { await handle.close(); }
}
export async function writePrivate(dir, name, value) {
  await privateDirectory(dir);
  const temporary = join(dir, `.${name}.${randomUUID()}`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, join(dir, name));
  } finally { await unlink(temporary).catch(() => {}); }
}
export async function loadSettings(p = paths()) {
  await checkPrivateDirectory(p.config);
  const config = validateConfig(await readPrivate(join(p.config, 'config.json')));
  const credential = await readPrivate(join(p.config, 'credentials.json'));
  if (credential.server !== config.server || typeof credential.accessToken !== 'string' || !credential.accessToken ||
      !Number.isFinite(credential.expiresAt) || typeof credential.environmentId !== 'string') {
    throw new AppError('config', 'Credentials do not match this configuration. Run pair again.', true);
  }
  return { config, credential };
}
