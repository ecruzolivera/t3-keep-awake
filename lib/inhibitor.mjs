import { spawn } from 'node:child_process';
import { AppError } from './errors.mjs';

const CHILD_CODE = "process.stdin.resume(); process.stdin.on('end',()=>process.exit(0)); process.stdin.on('error',()=>process.exit(0)); process.stdout.write('READY\\n');";
export class Inhibitor {
  child = null;
  expectedExit = false;
  onLost = () => {};
  constructor({ command = 'systemd-inhibit', spawnImpl = spawn } = {}) {
    this.command = command;
    this.spawn = spawnImpl;
  }
  get active() { return this.child !== null && this.child.exitCode === null && this.child.signalCode === null; }
  async acquire() {
    if (this.active) return;
    this.expectedExit = false;
    const child = this.spawn(this.command, [
      '--no-ask-password', '--what=sleep', '--mode=block',
      '--who=t3-keep-awake', '--why=Local T3 Code agents are working',
      process.execPath, '-e', CHILD_CODE,
    ], { stdio: ['pipe', 'pipe', 'ignore'] });
    this.child = child;
    child.stdin.on('error', () => {});
    const exited = new Promise(resolve => child.once('close', resolve));
    this.exited = exited;
    let ready = false;
    child.once('exit', () => { if (ready && !this.expectedExit) this.onLost(); });
    try {
      await new Promise((resolve, reject) => {
        let buffer = '';
        const fail = () => reject(new AppError('inhibitor', 'Sleep inhibition failed or was denied. Check systemd-inhibit and local login1 policy.'));
        const timer = setTimeout(fail, 3000);
        const clean = () => { clearTimeout(timer); child.stdout.removeListener('data', data); child.removeListener('error', fail); child.removeListener('exit', fail); };
        const data = chunk => {
          buffer += chunk.toString();
          if (buffer === 'READY\n') { ready = true; clean(); resolve(); }
          else if (buffer.length > 64) { clean(); fail(); }
        };
        child.stdout.on('data', data);
        child.once('error', fail);
        child.once('exit', fail);
        // Ensure failure cleanup removes the timer/listeners too.
        exited.then(() => { if (!ready) { clearTimeout(timer); clean(); fail(); } });
      });
    } catch (error) { await this.release(); throw error; }
  }
  async release() {
    const child = this.child;
    if (!child) return;
    this.expectedExit = true;
    child.stdin.end();
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 1500);
    try { await this.exited; } finally { clearTimeout(killTimer); this.child = null; }
  }
}

export class ObserveInhibitor {
  active = false;
  onLost = () => {};
  async acquire() { this.active = true; }
  async release() { this.active = false; }
}

// The helper's sole liveness lease is its stdin pipe. An abrupt supervisor
// crash closes that pipe in the kernel; EOF exits the helper and releases the
// inherited logind fd. systemd also kills the entire service control group.
export class HoldController {
  wanted = false;
  disconnectedAt = null;
  busy = null;
  constructor(inhibitor, graceMs, now = () => performance.now()) {
    this.inhibitor = inhibitor; this.graceMs = graceMs; this.now = now;
  }
  commit(activeCount) { this.wanted = activeCount > 0; this.disconnectedAt = null; }
  disconnect() { this.disconnectedAt ??= this.now(); }
  tick() {
    if (this.disconnectedAt !== null && this.now() - this.disconnectedAt >= this.graceMs) this.wanted = false;
  }
  reconcile() {
    this.tick();
    if (this.busy) return this.busy;
    this.busy = (async () => {
      do {
        if (this.wanted && !this.inhibitor.active) await this.inhibitor.acquire();
        else if (!this.wanted && this.inhibitor.active) await this.inhibitor.release();
        this.tick();
      } while (this.wanted !== this.inhibitor.active);
    })().finally(() => { this.busy = null; });
    return this.busy;
  }
  async stop() {
    this.wanted = false;
    try { await this.busy; } finally { await this.inhibitor.release(); }
  }
}
