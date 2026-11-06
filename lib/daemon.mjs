import { setTimeout as delay } from 'node:timers/promises';
import { descriptor, socketUrl, verifySession } from './auth.mjs';
import { connectStream } from './protocol.mjs';
import { HoldController } from './inhibitor.mjs';
import { AppError, safeError, authError } from './errors.mjs';

export async function runDaemon({ config, credential, inhibitor, signal, log = console.error, status = async () => {},
  getDescriptor = descriptor, verify = verifySession, getSocketUrl = socketUrl, stream = connectStream, random = Math.random }) {
  const hold = new HoldController(inhibitor, config.disconnectGraceMs);
  const aborter = new AbortController();
  const combined = signal ? AbortSignal.any([signal, aborter.signal]) : aborter.signal;
  let failure = null;
  let current = { connected: false, activeThreads: 0, lastError: null, sequence: null };
  let lastHeld = false;
  let attempt = 0;
  let statusChain = Promise.resolve();
  const publish = () => {
    const value = { ...current, held: inhibitor.active, updatedAt: new Date().toISOString() };
    statusChain = statusChain.then(() => status(value)).catch(() => { fail(new AppError('status', 'Cannot write private daemon status.')); });
  };
  const fail = error => { failure ??= error; aborter.abort(); };
  inhibitor.onLost = () => fail(new AppError('inhibitor', 'Sleep inhibitor exited unexpectedly; restarting the supervisor.'));
  const tick = async () => {
    try {
      if (credential.expiresAt <= Date.now()) { fail(authError()); return; }
      await hold.reconcile();
      if (inhibitor.active !== lastHeld) {
        lastHeld = inhibitor.active;
        log(lastHeld ? 'Sleep inhibitor acquired.' : 'Sleep inhibitor released.');
      }
      publish();
    } catch (error) { fail(error); }
  };
  const ticker = setInterval(tick, 500);
  try {
    publish();
    while (!combined.aborted) {
      let synchronized = false;
      try {
        const environment = await getDescriptor(config.server, { signal: combined });
        if (environment.environmentId !== credential.environmentId) throw new AppError('environment', 'The local T3 environment changed. Run pair again for this environment.', true);
        await verify(config.server, credential, { signal: combined });
        const url = await getSocketUrl(config.server, credential, { signal: combined });
        await stream(url, { signal: combined, onState: state => {
          if (combined.aborted) return;
          if (!synchronized) { log('T3 shell snapshot synchronized.'); synchronized = true; attempt = 0; }
          current = { connected: true, activeThreads: state.activeCount, threadStates: state.threadStates ?? null, sequence: state.sequence, lastError: null };
          hold.commit(state.activeCount);
          void tick();
        } });
        if (!combined.aborted) throw new AppError('network', 'T3 status stream ended; reconnecting.');
      } catch (error) {
        if (combined.aborted) break;
        current = { ...current, connected: false, lastError: error instanceof AppError ? error.code : 'unknown' };
        if (error instanceof AppError && error.fatal) throw error;
        hold.disconnect();
        log(safeError(error));
        await tick();
        // Never reset the disconnect deadline on failed reconnects. A partial
        // snapshot is not recovery; only a synchronized snapshot is recovery.
        const backoff = Math.min(config.reconnectMaxMs, config.reconnectMinMs * 2 ** Math.min(attempt++, 16));
        await delay(Math.round(backoff * (0.8 + random() * 0.2)), undefined, { signal: combined }).catch(() => {});
      }
    }
    if (failure) throw failure;
  } catch (error) {
    current.lastError = error instanceof AppError ? error.code : 'unknown';
    throw error;
  } finally {
    clearInterval(ticker);
    aborter.abort();
    await hold.stop();
    current.connected = false;
    current.activeThreads = 0;
    current.threadStates = null;
    publish();
    await statusChain;
    log('Supervisor stopped; sleep inhibitor released.');
  }
}
