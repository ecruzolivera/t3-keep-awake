import { createInterface } from 'node:readline/promises';
import { AppError } from './errors.mjs';

export function terminalPrompts(input = process.stdin, output = process.stderr) {
  const interactive = !!input.isTTY && !!output.isTTY;
  return {
    interactive,
    async question(message) {
      if (!interactive) throw new AppError('input', 'Interactive setup needs a terminal. Supply --credential-file and --no-start for unattended installation; --server can resolve ambiguous discovery.', true);
      const rl = createInterface({ input, output });
      try { return await rl.question(message); } finally { rl.close(); }
    },
    async secret(message) {
      if (!interactive || !input.setRawMode) throw new AppError('input', 'Hidden pairing entry needs a terminal; otherwise supply --credential-file.', true);
      output.write(message);
      const wasRaw = input.isRaw;
      const wasPaused = input.isPaused();
      return new Promise((resolve, reject) => {
        let value = '';
        function cleanup() {
          input.removeListener('data', data); input.removeListener('end', ended); input.removeListener('error', ended);
          input.setRawMode(!!wasRaw);
          if (wasPaused) input.pause();
          output.write('\n');
        }
        function ended() { cleanup(); reject(new AppError('input', 'Pairing input cancelled; no service was activated.', true)); }
        function data(bytes) {
          for (const char of bytes.toString('utf8')) {
            if (char === '\u0003' || char === '\u0004') { ended(); return; }
            if (char === '\r' || char === '\n') { cleanup(); resolve(value); return; }
            if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
            else if (char >= ' ') value += char;
            if (value.length > 65536) { ended(); return; }
          }
        }
        input.setRawMode(true);
        input.on('data', data); input.once('end', ended); input.once('error', ended); input.resume();
      });
    },
    async confirm(message) { return /^(y|yes)$/i.test((await this.question(`${message} [y/N] `)).trim()); },
  };
}
