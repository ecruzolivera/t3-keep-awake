import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError } from './errors.mjs';

const NAME = 't3-keep-awake';
export const MANAGED = '# Managed by t3-keep-awake installer';
export async function ownedDirectory(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o022)) throw new AppError('permissions', 'Installation directories must be owned by you and not writable by other users.', true);
}
export async function managedFile(path, kind) {
  let info;
  try { info = await lstat(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!info.isFile() || info.uid !== process.getuid() || info.size > 65536 || (info.mode & 0o022)) throw new AppError('conflict', `Refusing to replace an unsafe or unmanaged ${kind}. Move it aside explicitly before retrying.`, true);
  const content = await readFile(path, 'utf8');
  const legacyUnit = kind === 'service unit' && content.startsWith('[Unit]\nDescription=Keep this host awake while local T3 Code agents work\n') && content.includes('SyslogIdentifier=t3-keep-awake\n');
  if (!content.startsWith(`${MANAGED}\n`) && !content.startsWith(`#!/bin/sh\n${MANAGED}\n`) && !legacyUnit) throw new AppError('conflict', `An unmanaged ${kind} already exists. Move it aside explicitly before retrying.`, true);
}
export async function atomicFile(file, content, mode, kind) {
  await ownedDirectory(dirname(file));
  await managedFile(file, kind);
  const temporary = join(dirname(file), `.${NAME}.${randomUUID()}`);
  try {
    const handle = await open(temporary, 'wx', mode);
    try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(() => {}); }
}
