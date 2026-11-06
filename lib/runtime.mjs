import net from 'node:net';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError } from './errors.mjs';
import { privateDirectory } from './config.mjs';

export async function processIdentity(pid = process.pid) {
  // Fields after ')' begin with field 3; starttime is field 22.
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
}
export async function isLive(status) {
  try { return status.pid > 0 && typeof status.startTime === 'string' && await processIdentity(status.pid) === status.startTime; }
  catch { return false; }
}
export async function singleInstance(runtime) {
  if (!runtime) throw new AppError('runtime', 'XDG_RUNTIME_DIR is required; run inside your Linux user session.', true);
  await privateDirectory(runtime);
  const path = join(runtime, 'supervisor.sock');
  const server = net.createServer(socket => socket.end());
  const listen = () => new Promise((resolve, reject) => {
    const error = value => { server.removeListener('listening', success); reject(value); };
    const success = () => { server.removeListener('error', error); resolve(); };
    server.once('error', error); server.once('listening', success); server.listen(path);
  });
  try { await listen(); }
  catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
    const alive = await new Promise(resolve => {
      const socket = net.connect(path);
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', error => resolve(!['ECONNREFUSED', 'ENOENT'].includes(error.code)));
      socket.setTimeout(1000, () => { socket.destroy(); resolve(true); });
    });
    if (alive) throw new AppError('instance', 'Another t3-keep-awake supervisor is running.', true);
    await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
    try { await listen(); } catch { throw new AppError('instance', 'Another supervisor started concurrently. Retry after stopping it.', true); }
  }
  return () => new Promise(resolve => server.close(resolve));
}
