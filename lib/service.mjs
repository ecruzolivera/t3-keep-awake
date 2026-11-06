import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
export function unitQuote(value, expandDollar = true) {
  let result = value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('\n', '\\n').replaceAll('\r', '\\r');
  if (expandDollar) result = result.replaceAll('$', '$$');
  return '"' + result + '"';
}
export async function serviceUnit({ nodePath = process.execPath, cliPath = fileURLToPath(new URL('../bin/t3-keep-awake.mjs', import.meta.url)), environment = {} } = {}) {
  const template = await readFile(new URL('../systemd/t3-keep-awake.service.in', import.meta.url), 'utf8');
  const envLines = Object.entries(environment).map(([key, value]) => `Environment=${unitQuote(`${key}=${value}`, false)}\n`).join('');
  return template.replace('@@NODE@@', unitQuote(nodePath)).replace('@@CLI@@', unitQuote(cliPath)).replace('[Service]\n', `[Service]\n${envLines}`);
}
