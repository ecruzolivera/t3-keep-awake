import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
export function unitQuote(value) {
  return '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', '$$').replaceAll('\n', '\\n').replaceAll('\r', '\\r') + '"';
}
export async function serviceUnit() {
  const template = await readFile(new URL('../systemd/t3-keep-awake.service.in', import.meta.url), 'utf8');
  return template.replace('@@NODE@@', unitQuote(process.execPath)).replace('@@CLI@@', unitQuote(fileURLToPath(new URL('../bin/t3-keep-awake.mjs', import.meta.url))));
}
