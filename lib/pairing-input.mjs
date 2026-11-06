import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { AppError } from './errors.mjs';

export function parsePairingInput(input, server) {
  let value = input.trim();
  if (/^https?:/i.test(value)) {
    let url;
    try { url = new URL(value); } catch { throw new AppError('pairing', 'Invalid direct pairing URL.', true); }
    if (url.origin !== server || url.pathname !== '/pair' || url.search) throw new AppError('pairing', 'Pairing URL must belong to the configured local server; hosted links are not accepted.', true);
    value = new URLSearchParams(url.hash.slice(1)).get('token') ?? '';
  }
  if (!value || /\s/.test(value)) throw new AppError('pairing', 'Pairing input is missing or malformed.', true);
  return value;
}
export async function pairingInput(file, server) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) || info.size > 65536) throw new AppError('permissions', 'Pairing input must be an owned regular file with mode 0600.', true);
    return parsePairingInput(await handle.readFile('utf8'), server);
  } finally { await handle.close(); }
}
