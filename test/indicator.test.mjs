import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { addIndicatorToBar, installIndicator } from '../lib/indicator.mjs';
import { ShellState } from '../lib/activity.mjs';
import { snapshot, thread } from './fixtures.mjs';

const script = await readFile(new URL('../plugins/dms-t3-keep-awake/IndicatorState.js', import.meta.url), 'utf8');
const ui = vm.createContext({}); vm.runInContext(script, ui);
const counts = overrides => ({ working: 0, blocked: 0, done: 0, idle: 0, failed: 0, ...overrides });
const value = overrides => ({ updatedAt: new Date().toISOString(), activeThreads: 0, held: false, connected: true, threadStates: counts(), ...overrides });
const view = data => ui.snapshot(JSON.stringify(data), Date.now(), 5000);

test('indicator mirrors Herdr priorities while exposing missing sleep protection', () => {
  assert.equal(view(value({ activeThreads: 1, held: true, threadStates: counts({ working: 1 }) })).state, 'working');
  assert.equal(view(value({ threadStates: counts({ working: 1, blocked: 1, done: 1 }) })).state, 'blocked');
  assert.equal(view(value({ threadStates: counts({ done: 1, working: 1 }) })).state, 'done');
  assert.equal(view(value()).state, 'idle');
  assert.equal(view(value({ activeThreads: 1, held: false })).state, 'error');
  assert.equal(view(value({ connected: false })).state, 'unknown');
  assert.equal(view(value({ activeThreads: 1, observing: true })).state, 'unknown');
});
test('stale, malformed and invalid status never claims protection; old companion format works', () => {
  assert.equal(view(value({ updatedAt: '2000-01-01' })).available, false);
  assert.equal(ui.snapshot('broken JSON', Date.now(), 5000).available, false);
  assert.equal(view(value({ activeThreads: -1 })).available, false);
  const old = view(value({ activeThreads: 2, held: true, threadStates: null }));
  assert.equal(old.state, 'working'); assert.equal(old.legacy, true);
});
test('published thread counts distinguish input waits and omit settled or archived completion', () => {
  const state = new ShellState();
  state.apply(snapshot([
    thread('working', { status: 'running' }), thread('blocked', { status: 'running', pendingRuntimeRequest: { kind: 'user_input' } }),
    thread('done', { status: 'completed' }), thread('old', { status: 'completed', settledAt: '2020-01-01' }),
    thread('archived', { status: 'completed', archivedAt: '2020-01-01' }), thread('idle'),
  ]));
  assert.deepEqual(state.threadStates, counts({ working: 1, blocked: 1, done: 1, idle: 1 }));
});
test('bar insertion preserves existing widgets and does not duplicate the indicator', () => {
  const settings = { unrelated: 'keep', barConfigs: [{ enabled: true, rightWidgets: ['systemTray', { id: 'herdrAgents', enabled: false }, 'clock'] }] };
  const updated = addIndicatorToBar(settings);
  assert.equal(settings.barConfigs[0].rightWidgets.length, 3);
  assert.equal(updated.unrelated, 'keep');
  assert.deepEqual(updated.barConfigs[0].rightWidgets, ['systemTray', { id: 't3KeepAwake', enabled: true }, { id: 'herdrAgents', enabled: false }, 'clock']);
  assert.deepEqual(addIndicatorToBar(updated), updated);
});
test('reinstall preserves an indicator moved to another bar without adding a duplicate', () => {
  for (const section of ['leftWidgets', 'centerWidgets', 'rightWidgets']) {
    const settings = { barConfigs: [
      { id: 'main', enabled: true, rightWidgets: [{ id: 'systemTray', enabled: true }] },
      { id: 'secondary', enabled: true, rightWidgets: [], [section]: [
        { id: 'clock', enabled: true }, { id: 't3KeepAwake', enabled: true, customSetting: 'keep' },
      ] },
    ] };
    assert.deepEqual(addIndicatorToBar(settings), settings);
  }
});
test('indicator installation uses the selected private status path and backs up bar configuration', async t => {
  const root = await mkdtemp(join(tmpdir(), 't3-indicator-install-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, 'config/DankMaterialShell'); await mkdir(config, { recursive: true });
  const original = JSON.stringify({ barConfigs: [{ enabled: true, rightWidgets: ['systemTray'] }] });
  await writeFile(join(config, 'settings.json'), original);
  const calls = [];
  const destination = await installIndicator({ env: { XDG_CONFIG_HOME: join(root, 'config'), XDG_STATE_HOME: join(root, 'state') }, log() {}, run: args => {
    calls.push(args); return { code: 0, stdout: args.includes('status') ? 'loaded\tcomposite\t' : 'PLUGIN_ENABLE_SUCCESS' };
  } });
  assert.ok((await readFile(join(destination, 'StatusLocation.js'), 'utf8')).includes(join(root, 'state/t3-keep-awake/status.json')));
  assert.equal(await readFile(join(config, 'settings.json.before-t3-indicator'), 'utf8'), original);
  assert.ok(calls.every(args => !args.includes('restart') && !args.includes('systemctl')));
  await assert.rejects(installIndicator({ env: { XDG_CONFIG_HOME: join(root, 'config'), XDG_STATE_HOME: join(root, 'state') }, log() {}, run: () => ({ code: 1, stdout: '' }) }), { code: 'indicator' });
  const after = await readFile(join(config, 'settings.json'), 'utf8');
  assert.equal(JSON.parse(after).barConfigs[0].rightWidgets.filter(widget => widget.id === 't3KeepAwake').length, 1);
  assert.equal(await readFile(join(config, 'settings.json.before-t3-indicator'), 'utf8'), original);
});

test('real QML monitor follows atomic status updates, deletion, recovery and staleness', { timeout: 10000 }, async t => {
  try { await readFile('/usr/bin/qs'); } catch { t.skip('Quickshell is not installed'); return; }
  const root = await mkdtemp(join(tmpdir(), 't3-indicator-qml-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const file of ['T3Monitor.qml', 'IndicatorState.js', 'StatusLocation.js']) await writeFile(join(root, file), await readFile(new URL('../plugins/dms-t3-keep-awake/' + file, import.meta.url)));
  const statusPath = join(root, 'status.json');
  const publish = async data => { await writeFile(statusPath + '.new', JSON.stringify(data)); await rename(statusPath + '.new', statusPath); };
  await publish(value({ activeThreads: 1, held: true, threadStates: counts({ working: 1 }) }));
  await writeFile(join(root, 'shell.qml'), `import QtQuick\nimport Quickshell\nItem { T3Monitor { statusPath: ${JSON.stringify(statusPath)}; refreshMs: 30; staleMs: 400; onSnapshotChanged: console.log("T3_STATE:"+JSON.stringify(snapshot)) } Timer { interval: 3500; running: true; onTriggered: Qt.quit() } }`);
  const process = spawn('/usr/bin/qs', ['--no-color', '-p', join(root, 'shell.qml')], { env: { ...globalThis.process.env, QT_QPA_PLATFORM: 'offscreen', QT_LOGGING_RULES: 'qml.debug=true' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => process.kill('SIGTERM'));
  let output = ''; let step = 0; let pending = Promise.resolve(); let buffered = '';
  const receive = bytes => {
    output += bytes;
    buffered += bytes.toString();
    const lines = buffered.split('\n'); buffered = lines.pop();
    for (const line of lines) {
      const at = line.indexOf('T3_STATE:'); if (at === -1) continue;
      let state; try { state = JSON.parse(line.slice(at + 9)); } catch { continue; }
      if (step === 0 && state.state === 'working') { step++; pending = pending.then(() => publish(value({ threadStates: counts({ blocked: 1 }) }))); }
      else if (step === 1 && state.state === 'blocked') { step++; pending = pending.then(() => unlink(statusPath)); }
      else if (step === 2 && state.label === 'Companion is stopped or unavailable') { step++; pending = pending.then(() => publish(value({ threadStates: counts({ done: 1 }) }))); }
      else if (step === 3 && state.state === 'done') step++;
      else if (step === 4 && state.label === 'Companion status is stale') { step++; process.kill('SIGTERM'); }
    }
  };
  process.stdout.on('data', receive); process.stderr.on('data', receive);
  await once(process, 'exit'); await pending;
  assert.equal(step, 5, output);
  assert.equal(output.includes('TypeError'), false, output);
});
