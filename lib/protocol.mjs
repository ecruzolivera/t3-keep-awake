import { ShellState } from './activity.mjs';
import { AppError, protocolError } from './errors.mjs';

export const REQUEST_ID = 'shell';
export const subscribeRequest = () => ({ _tag: 'Request', id: REQUEST_ID, tag: 'orchestration.subscribeShell', payload: { requestCompletionMarker: true }, headers: [] });

export function frames(data) {
  if (typeof data !== 'string' || data.length > 64 * 1024 * 1024) throw protocolError();
  let parsed;
  try { parsed = JSON.parse(data); } catch { throw protocolError(); }
  return Array.isArray(parsed) ? parsed : [parsed];
}

export function connectStream(url, { signal, onState, WebSocketImpl = WebSocket, heartbeatMs = 10000, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const state = new ShellState();
    const socket = new WebSocketImpl(url);
    const started = performance.now();
    let lastPong = started;
    let finished = false;
    const send = value => socket.send(JSON.stringify(value));
    function finish(error) {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      signal?.removeEventListener('abort', abort);
      // Keep the error listener installed to absorb close/abort handshake errors.
      try { socket.close(); } catch {}
      if (error) reject(error); else resolve();
    }
    const abort = () => finish();
    const timer = setInterval(() => {
      const now = performance.now();
      if ((!state.synchronized && now - started >= timeoutMs) || now - lastPong >= timeoutMs) {
        finish(new AppError('timeout', 'T3 status stream stopped responding; reconnecting.'));
      } else if (socket.readyState === 1) {
        try { send({ _tag: 'Ping' }); } catch { finish(new AppError('network', 'T3 WebSocket disconnected; reconnecting.')); }
      }
    }, heartbeatMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { finish(); return; }
    socket.addEventListener('open', () => {
      if (!finished) {
        try { send(subscribeRequest()); }
        catch { finish(new AppError('network', 'T3 WebSocket disconnected; reconnecting.')); }
      }
    });
    socket.addEventListener('message', event => {
      if (finished) return;
      try {
        for (const frame of frames(event.data)) {
          switch (frame?._tag) {
            case 'Pong': lastPong = performance.now(); break;
            case 'Ping': send({ _tag: 'Pong' }); break;
            case 'Chunk':
              if (frame.requestId !== REQUEST_ID || !Array.isArray(frame.values)) throw protocolError();
              for (const item of frame.values) state.apply(item);
              // Commit once for the complete chunk. Reconnect retains the old
              // hold until the new authoritative snapshot is synchronized.
              if (state.synchronized) onState(state);
              send({ _tag: 'Ack', requestId: REQUEST_ID });
              break;
            case 'Exit': case 'Defect': throw protocolError();
            default: throw protocolError();
          }
        }
      } catch (error) { finish(error); }
    });
    socket.addEventListener('error', () => finish(new AppError('network', 'T3 WebSocket connection failed; check local server availability.')));
    socket.addEventListener('close', () => finish(new AppError('network', 'T3 WebSocket disconnected; reconnecting.')));
  });
}
