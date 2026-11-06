import { readdir, readFile, readlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { endianness } from 'node:os';
import { descriptor } from './auth.mjs';
import { localServer } from './config.mjs';
import { AppError } from './errors.mjs';

// Read socket metadata only. Never inspect process arguments, environment,
// databases, browser caches or credentials. T3 may run as a desktop executable
// or as a Node/Bun CLI process; the public descriptor is the final authority.
const SERVER_PROCESS = /^(?:t3(?:code)?(?:[-_].*)?|node|bun|electron)$/i;
export function listeningOrigins(table, ownedInodes, uid, ipv6 = false) {
  const origins = new Set();
  for (const line of table.trim().split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields[3] !== '0A' || Number(fields[7]) !== uid || !ownedInodes.has(fields[9])) continue;
    const [hex, portHex] = fields[1].split(':');
    const port = parseInt(portHex, 16);
    if (!port || port > 65535 || !/^[0-9A-F]+$/i.test(hex)) continue;
    const bytes = Buffer.from(hex, 'hex');
    if ((ipv6 && bytes.length !== 16) || (!ipv6 && bytes.length !== 4)) continue;
    if (endianness() === 'LE') for (let i = 0; i < bytes.length; i += 4) bytes.subarray(i, i + 4).reverse();
    let host;
    if (!ipv6) {
      if (bytes.every(byte => byte === 0)) host = '127.0.0.1';
      else if (bytes[0] === 127) host = [...bytes].join('.');
    } else if (bytes.every(byte => byte === 0) || (bytes.subarray(0, 15).every(byte => byte === 0) && bytes[15] === 1)) {
      host = '[::1]';
    } else if (bytes.subarray(0, 10).every(byte => byte === 0) && bytes[10] === 255 && bytes[11] === 255 && bytes[12] === 127) {
      host = [...bytes.subarray(12)].join('.');
    }
    if (host) origins.add(`http://${host}:${port}`);
  }
  return [...origins];
}
async function parallelMap(values, concurrency, visit) {
  let index = 0;
  const results = [];
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (index < values.length) { const value = values[index++]; results.push(await visit(value)); }
  }));
  return results;
}
export async function localCandidates({ procRoot = '/proc', uid = process.getuid() } = {}) {
  let pids;
  try { pids = (await readdir(procRoot)).filter(value => /^\d+$/.test(value)); }
  catch { throw new AppError('discovery', 'Cannot inspect local listening sockets. Start T3 Code and retry, or supply --server for a custom setup.', true); }
  const inodes = new Set();
  await parallelMap(pids, 16, async pid => {
    try {
      const dir = join(procRoot, pid);
      if ((await stat(dir)).uid !== uid || !SERVER_PROCESS.test((await readFile(join(dir, 'comm'), 'utf8')).trim())) return;
      const fds = await readdir(join(dir, 'fd'));
      for (const fd of fds) {
        try {
          const match = (await readlink(join(dir, 'fd', fd))).match(/^socket:\[(\d+)\]$/);
          if (match) inodes.add(match[1]);
        } catch { /* Process/FD may have closed during discovery. */ }
      }
    } catch { /* Other users' processes and exiting processes are skipped. */ }
  });
  const tables = await Promise.all(['tcp', 'tcp6'].map(async name => {
    try { return await readFile(join(procRoot, 'net', name), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT' && name === 'tcp6') return ''; throw new AppError('discovery', 'Local socket information is unavailable. Use --server for a custom setup.', true); }
  }));
  return [...new Set([...listeningOrigins(tables[0], inodes, uid), ...listeningOrigins(tables[1], inodes, uid, true)])].sort();
}
export async function discoverServers({ candidates = localCandidates, getDescriptor = descriptor, timeoutMs = 1200 } = {}) {
  const origins = await candidates();
  const results = await parallelMap(origins, 8, async origin => {
    try { return { origin: localServer(origin), environment: await getDescriptor(origin, { signal: AbortSignal.timeout(timeoutMs) }) }; }
    catch { return null; } // Unrelated listeners, incompatible T3 and refused probes are not candidates.
  });
  // IPv4/IPv6 listeners for the same environment are one choice. Prefer IPv4
  // deterministically, without guessing at a fixed default port.
  const environments = new Map();
  for (const candidate of results.filter(Boolean).sort((a, b) => Number(a.origin.includes('[')) - Number(b.origin.includes('[')) || a.origin.localeCompare(b.origin))) {
    if (!environments.has(candidate.environment.environmentId)) environments.set(candidate.environment.environmentId, candidate);
  }
  return [...environments.values()];
}
export async function resolveServer({ server, savedServer, environmentId, prompts, log = console.error,
  discover = discoverServers, getDescriptor = descriptor } = {}) {
  if (server !== undefined) {
    const origin = localServer(server);
    return { origin, environment: await getDescriptor(origin) };
  }
  if (savedServer) {
    try {
      const origin = localServer(savedServer);
      const environment = await getDescriptor(origin, { signal: AbortSignal.timeout(1200) });
      if (!environmentId || environment.environmentId === environmentId) return { origin, environment };
    } catch { /* An old/changed port should trigger rediscovery, not a manual port prompt. */ }
  }
  log('Detecting the running local T3 Code server…');
  const found = await discover();
  let selected = environmentId ? found.find(value => value.environment.environmentId === environmentId) : null;
  if (!selected && found.length === 1) selected = found[0];
  if (!selected && !found.length) throw new AppError('discovery', 'No compatible local T3 Code server detected. Start T3 Code and rerun install. Use --server only for a custom setup.', true);
  if (!selected) {
    if (!prompts.interactive) throw new AppError('discovery', 'Multiple local T3 environments detected. Rerun interactively to select one, or supply --server.', true);
    log('Multiple local T3 environments are running. Choose one:');
    found.forEach((value, index) => {
      const label = String(value.environment.label ?? 'T3 environment').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, 80);
      log(`${index + 1}. ${label} (${value.origin})`);
    });
    const answer = (await prompts.question(`Environment [1-${found.length}]: `)).trim();
    if (!/^\d+$/.test(answer) || !found[Number(answer) - 1]) throw new AppError('discovery', 'Invalid environment selection; rerun install and choose a listed number.', true);
    selected = found[Number(answer) - 1];
  }
  log(`Detected local T3 Code at ${selected.origin}.`);
  return selected;
}
