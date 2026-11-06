import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { install, installLayout } from '../lib/installer.mjs';
import { paths, readPrivate, writePrivate } from '../lib/config.mjs';
import { processIdentity } from '../lib/runtime.mjs';

async function fixture(t, { active = false, confirm = false, connected = true } = {}) {
  const temp = await mkdtemp(join(tmpdir(), 't3-awake-install-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const home = join(temp, "home with spaces '$");
  const source = join(temp, 'npx-cache');
  const env = { ...process.env, XDG_DATA_HOME: join(home, 'data'), XDG_CONFIG_HOME: join(home, 'config'), XDG_STATE_HOME: join(home, 'state'), XDG_RUNTIME_DIR: temp };
  for (const dir of ['bin', 'lib', 'systemd', 'docs', 'plugins']) await mkdir(join(source, dir), { recursive: true });
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: 't3-keep-awake', version: '0.2.0' }));
  await writeFile(join(source, 'bin/t3-keep-awake.mjs'), "console.log('durable installed fixture');\n");
  for (const name of ['README.md', 'LICENSE', 'lib/example.mjs', 'systemd/example', 'docs/example.md', 'plugins/example.qml']) await writeFile(join(source, name), 'fixture\n');
  const calls = []; const logs = [];
  const p = paths(env);
  const startTime = await processIdentity();
  let pairings = 0; let secrets = 0; let confirmations = 0;
  const options = { env, home, source, server: 'http://127.0.0.1:12345', log: value => logs.push(value),
    preflight: async () => ({ systemctl: '/mock/systemctl', 'systemd-inhibit': '/mock/systemd-inhibit', 'systemd-analyze': '/mock/systemd-analyze', journalctl: '/mock/journalctl' }),
    run: (command, args) => {
      calls.push([command, ...args]);
      if (args.includes('is-active')) return { code: active ? 0 : 4, stdout: active ? 'active' : 'inactive' };
      if (args.includes('enable')) {
        active = true;
        mkdirSync(p.state, { recursive: true, mode: 0o700 });
        writeFileSync(join(p.state, 'status.json'), JSON.stringify({ pid: process.pid, startTime, connected, activeThreads: 1, held: connected }), { mode: 0o600 });
      }
      if (args.includes('show')) return { code: 0, stdout: `ActiveState=${active ? 'active' : 'inactive'}\nSubState=${active ? 'running' : 'dead'}\nResult=success\nInvocationID=${'a'.repeat(32)}\nMainPID=${active ? process.pid : 0}\n` };
      if (command === '/mock/journalctl') return { code: 0, stdout: JSON.stringify({ MESSAGE: connected ? 'T3 shell snapshot synchronized.' : 'Local T3 connection failed; retrying.' }) };
      return { code: 0, stdout: '' };
    },
    getDescriptor: async () => ({ environmentId: 'local' }), verify: async () => {},
    exchange: async (server, bootstrap) => {
      assert.equal(bootstrap, 'PRIVATE-BOOTSTRAP'); pairings++;
      return { server, accessToken: 'PRIVATE-ACCESS', environmentId: 'local', expiresAt: Date.now() + 100000 };
    },
    prompts: { interactive: true, question: async () => assert.fail('server already supplied'),
      secret: async message => { assert.equal(message, 'Paste the pairing code (hidden): '); secrets++; return 'PRIVATE-BOOTSTRAP'; }, confirm: async () => { confirmations++; return confirm; } },
  };
  return { temp, home, source, env, options, calls, logs, metrics: () => ({ pairings, secrets, confirmations }), p: paths(env), layout: installLayout(env, home) };
}

test('fresh install is durable outside npx cache, private, redacted and stopped on decline', async t => {
  const f = await fixture(t);
  const result = await install(f.options);
  assert.equal(result.activated, false);
  assert.ok(result.cli.startsWith(f.layout.root));
  assert.equal(result.cli.includes('npx-cache'), false);
  assert.equal((await stat(f.layout.launcher)).mode & 0o777, 0o700);
  assert.equal((await stat(f.layout.unit)).mode & 0o777, 0o600);
  const unit = await readFile(f.layout.unit, 'utf8');
  assert.equal(unit.includes(f.source), false);
  assert.ok(unit.includes('Environment="XDG_CONFIG_HOME='));
  assert.ok(unit.includes('Environment="PATH=/mock"'));
  assert.equal(f.calls.some(call => call.includes('enable') || call.includes('restart')), false);
  assert.ok(f.calls.some(call => call.includes('daemon-reload')));
  assert.equal(f.logs.join('\n').includes('PRIVATE-'), false);
  assert.equal(JSON.stringify(await readPrivate(join(f.layout.root, 'install.json'))).includes('PRIVATE-'), false);
  await rm(f.source, { recursive: true });
  const launched = spawnSync(f.layout.launcher, ['--version'], { encoding: 'utf8' });
  assert.equal(launched.status, 0, launched.stderr);
  assert.equal(launched.stdout.trim(), 'durable installed fixture');
});
test('repeat installation reuses credentials, release and custom configuration', async t => {
  const f = await fixture(t);
  const first = await install(f.options);
  const config = await readPrivate(join(f.p.config, 'config.json'));
  await writePrivate(f.p.config, 'config.json', { ...config, disconnectGraceMs: 12345, reconnectMinMs: 2000 });
  const second = await install(f.options);
  assert.equal(first.cli, second.cli);
  assert.deepEqual(f.metrics(), { pairings: 1, secrets: 1, confirmations: 2 });
  const saved = await readPrivate(join(f.p.config, 'config.json'));
  assert.equal(saved.disconnectGraceMs, 12345); assert.equal(saved.reconnectMinMs, 2000);
});
test('activation occurs only after affirmative confirmation', async t => {
  const f = await fixture(t, { confirm: true });
  const result = await install(f.options);
  assert.equal(result.activated, true);
  assert.ok(f.logs.includes('T3: connected. Active threads: 1. Sleep inhibitor: held.'));
  assert.ok(f.logs.includes('  T3 shell snapshot synchronized.'));
  const actions = f.calls.map(call => call.slice(1));
  assert.ok(actions.some(args => args.join(' ') === '--user enable --now t3-keep-awake.service'));
  assert.ok(actions.findIndex(args => args.includes('daemon-reload')) < actions.findIndex(args => args.includes('enable')));
});
test('unconfirmed T3 readiness fails installation but leaves the companion enabled to retry', async t => {
  const f = await fixture(t, { confirm: true, connected: false });
  await assert.rejects(install(f.options), { code: 'readiness', fatal: true });
  assert.equal(f.options.run('/mock/systemctl', ['--user', 'is-active', 't3-keep-awake.service']).code, 0);
  assert.equal(f.calls.some(call => call.includes('stop') || call.includes('disable')), false);
  assert.ok(f.logs.includes('  Local T3 connection failed; retrying.'));
  assert.equal((await stat(f.layout.unit)).isFile(), true);
  assert.equal((await readPrivate(join(f.p.config, 'credentials.json'))).accessToken, 'PRIVATE-ACCESS');
});
test('updating an active service without restart confirmation preserves its unit and process', async t => {
  const f = await fixture(t, { confirm: true });
  await install(f.options);
  const before = await readFile(f.layout.unit, 'utf8');
  await writeFile(join(f.source, 'lib/example.mjs'), 'new release\n');
  f.calls.length = 0;
  const updated = await install({ ...f.options, prompts: { ...f.options.prompts, confirm: async () => false } });
  assert.equal(updated.activated, false);
  assert.equal(await readFile(f.layout.unit, 'utf8'), before);
  assert.equal(f.calls.some(call => call.includes('restart') || call.includes('stop') || call.includes('enable') || call.includes('daemon-reload')), false);
  assert.ok(f.logs.some(value => value.includes('Existing running service left unchanged')));
});
test('confirmed active-service update restarts onto a new immutable release', async t => {
  const f = await fixture(t, { confirm: true });
  const old = await install(f.options);
  await writeFile(join(f.source, 'lib/example.mjs'), 'updated\n');
  f.calls.length = 0;
  const newer = await install(f.options);
  assert.notEqual(newer.cli, old.cli);
  assert.ok(f.calls.some(call => call.includes('restart')));
  assert.equal((await stat(old.cli)).isFile(), true, 'old release is retained until explicitly removed');
});
test('no-start bypasses activation prompt, while expired auth prompts for a fresh narrow pairing', async t => {
  const f = await fixture(t);
  await install({ ...f.options, noStart: true });
  assert.equal(f.metrics().confirmations, 0);
  const second = await install({ ...f.options, noStart: true, verify: async () => { throw Object.assign(new Error('expired'), { code: 'auth' }); } });
  assert.equal(second.activated, false);
  assert.equal(f.metrics().pairings, 2);
  assert.equal(f.calls.some(call => call.includes('enable')), false);
});
test('unmanaged launcher conflicts fail before pairing or activation', async t => {
  const f = await fixture(t);
  await mkdir(join(f.home, '.local/bin'), { recursive: true });
  await writeFile(f.layout.launcher, '#!/bin/sh\necho custom\n');
  await assert.rejects(install(f.options), { code: 'conflict' });
  assert.equal(f.metrics().pairings, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(await readFile(f.layout.launcher, 'utf8'), '#!/bin/sh\necho custom\n');
});
test('failed unit validation never consumes pairing input or activates', async t => {
  const f = await fixture(t);
  const runner = f.options.run;
  await assert.rejects(install({ ...f.options, run: (command, args) => command.includes('systemd-analyze') ? { code: 1 } : runner(command, args) }), { code: 'unit' });
  assert.equal(f.metrics().pairings, 0);
  assert.equal(f.calls.some(call => call.includes('enable')), false);
});
test('prerequisite failure exits before writing settings or consuming a pairing', async t => {
  const f = await fixture(t);
  await assert.rejects(install({ ...f.options, preflight: async () => { throw Object.assign(new Error('missing logind'), { code: 'prerequisite' }); } }), { code: 'prerequisite' });
  assert.equal(f.metrics().pairings, 0); assert.equal(f.calls.length, 0);
  await assert.rejects(stat(f.layout.launcher), { code: 'ENOENT' });
  await assert.rejects(stat(join(f.p.config, 'credentials.json')), { code: 'ENOENT' });
});
test('activation failure is actionable and retains installed files and private credentials', async t => {
  const f = await fixture(t, { confirm: true });
  const runner = f.options.run;
  await assert.rejects(install({ ...f.options, run: (command, args) => args.includes('enable') ? { code: 1 } : runner(command, args) }), { code: 'systemd', fatal: true });
  assert.equal((await stat(f.layout.launcher)).isFile(), true);
  assert.equal((await stat(f.layout.unit)).isFile(), true);
  assert.equal((await readPrivate(join(f.p.config, 'credentials.json'))).accessToken, 'PRIVATE-ACCESS');
  assert.equal(f.logs.join('\n').includes('PRIVATE-'), false);
});
test('fresh install automatically selects one detected T3 server without asking for its port', async t => {
  const f = await fixture(t);
  const result = await install({ ...f.options, server: undefined,
    discover: async () => [{ origin: 'http://127.0.0.1:45678', environment: { environmentId: 'local', label: 'Desktop' } }],
  });
  assert.equal(result.activated, false);
  assert.equal((await readPrivate(join(f.p.config, 'config.json'))).server, 'http://127.0.0.1:45678');
});
