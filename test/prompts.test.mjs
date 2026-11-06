import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { terminalPrompts } from '../lib/prompts.mjs';
import { parsePairingInput } from '../lib/pairing-input.mjs';

function terminal() {
  const input = new PassThrough(); input.isTTY = true; input.isRaw = false;
  input.setRawMode = value => { input.isRaw = value; }; input.pause();
  let rendered = '';
  const output = new Writable({ write(chunk, _encoding, next) { rendered += chunk.toString(); next(); } });
  output.isTTY = true;
  return { input, output, rendered: () => rendered };
}
test('hidden entry never echoes input, handles deletion, and restores terminal state', async () => {
  const term = terminal();
  const result = terminalPrompts(term.input, term.output).secret('Pairing: ');
  term.input.write('PRIVATE-X\u007fTOKEN\r');
  assert.equal(await result, 'PRIVATE-TOKEN');
  assert.equal(term.rendered(), 'Pairing: \n');
  assert.equal(term.input.isRaw, false); assert.equal(term.input.isPaused(), true);
});
test('cancelled hidden input restores terminal state and returns a redacted error', async () => {
  const term = terminal();
  const result = terminalPrompts(term.input, term.output).secret('Pairing: ');
  const rejected = assert.rejects(result, { code: 'input' });
  term.input.write('PRIVATE\u0003'); await rejected;
  assert.equal(term.input.isRaw, false); assert.equal(term.rendered().includes('PRIVATE'), false);
});
test('pairing input requires direct matching local URL and extracts its fragment token', () => {
  assert.equal(parsePairingInput('http://localhost:1234/pair#token=PRIVATE', 'http://localhost:1234'), 'PRIVATE');
  assert.throws(() => parsePairingInput('https://remote.example/pair#token=PRIVATE', 'http://localhost:1234'), { code: 'pairing' });
});
