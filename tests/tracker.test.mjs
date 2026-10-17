import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadTrackerConfig, validateTargets } from '../config.mjs';
import { completeResults, parseRegistryDate, parseResultPage } from '../results.mjs';
import { createNotifier, safeError } from '../notifications.mjs';
import { readSearchResponse, loginWithCredentials } from '../registry.mjs';
import { StateStore, targetKey } from '../state-store.mjs';
import { runOnce, runLoop } from '../tracking.mjs';

const fixture = JSON.parse(await readFile(new URL('./fixtures/search.json', import.meta.url), 'utf8'));
const empty = JSON.parse(await readFile(new URL('./fixtures/empty.json', import.meta.url), 'utf8'));
const failure = JSON.parse(await readFile(new URL('./fixtures/failure.json', import.meta.url), 'utf8'));
const target = { type: 'cadastral', value: '01.14.16.007.381' };
const entries = completeResults([parseResultPage(fixture)]);
const latest = entries.at(-1).date;
const parsed = rows => completeResults([parseResultPage({ ...fixture, applist: rows, total: rows.length })]);

async function harness(t, identifiers = [target]) {
  const dataDir = await mkdtemp(join(tmpdir(), 'mygov-test-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const messages = [], errors = [], logs = [];
  let result = entries;
  const options = {
    config: { dataDir, identifiers, settings: {}, intervalMinutes: 60 },
    search: async () => { if (result instanceof Error) throw result; return result; },
    notify: async message => { messages.push(message); },
    logger: { log: message => logs.push(message), error: message => errors.push(message) },
    now: () => new Date('2026-10-17T12:00:00Z'),
  };
  const store = new StateStore(dataDir);
  return { options, store, messages, errors, logs, setResults: value => { result = value; }, run: () => runOnce(options) };
}

test('parses observed registry schema, activity dates, descriptions and IDs', () => {
  assert.equal(entries.length, 2);
  const row = entries.find(e => e.documentId);
  assert.equal(row.documentId, 'fake-document-2');
  assert.equal(row.registrationNumber, '000000000002');
  assert.equal(row.description, 'ცვლილება');
  assert.equal(row.date, '2025-09-20T12:00:00.000Z');
  assert.ok(row.date > row.registeredAt);
  assert.equal(parseRegistryDate('1758369600000'), row.date);
  assert.equal(parseRegistryDate('2025-09-20T12:00:00Z'), row.date);
  assert.equal(parseRegistryDate('0'), null);
  assert.equal(completeResults([parseResultPage(empty)]).length, 0);
});

test('malformed dates, rows, error envelopes and pagination fail closed', async () => {
  for (const payload of [failure, {}, null, { ...fixture, page: 2 }, { ...fixture, applist: [] }, { ...fixture, total: '2' }]) {
    assert.throws(() => parseResultPage(payload), /Parsing failed/);
  }
  for (const override of [{ lastActDate: 'yesterday' }, { lastActDate: null, appRegDate: null }, { webTransact: '', status: '' }]) {
    assert.throws(() => parsed([{ ...fixture.applist[0], ...override }]), /Parsing failed/);
  }
  assert.throws(() => parseRegistryDate('2025-09-20'), /unsupported/);
  await assert.rejects(readSearchResponse({ ok: () => false, status: () => 503 }, 1), /HTTP 503/);
  await assert.rejects(readSearchResponse({ ok: () => true, json: async () => { throw Error('HTML'); } }, 1), /non-JSON/);
  await assert.rejects(readSearchResponse({ ok: () => true, json: async () => failure }, 1), /applist/);
});

test('all pages are required; changing totals and overlapping pages cannot baseline', () => {
  const first = parseResultPage({ ...fixture, applist: [fixture.applist[0]], lastpage: 2 });
  const second = parseResultPage({ ...fixture, applist: [fixture.applist[1]], page: 2, lastpage: 2 }, 2);
  assert.equal(completeResults([first, second]).length, 2);
  assert.throws(() => completeResults([first]), /incomplete/);
  assert.throws(() => completeResults([first, { ...second, total: 3 }]), /changed/);
  assert.throws(() => completeResults([first, { ...second, entries: first.entries }]), /overlap/);
});

test('first run saves baseline silently and restart does not notify', async t => {
  const h = await harness(t);
  const report = await h.run();
  assert.equal(report.ok, true);
  assert.equal(report.identifiers[0].baselined, true);
  assert.deepEqual(h.messages, []);
  const tracked = (await h.store.read()).targets[targetKey(target)];
  assert.equal(tracked.baselineDate, latest);
  assert.equal(tracked.latestDate, latest);
  assert.equal(Object.keys(tracked.seen).length, 2);
  assert.equal((await stat(h.store.path)).mode & 0o777, 0o600);
  assert.equal((await h.run()).identifiers[0].notified, 0);
  assert.deepEqual(h.messages, []);
});

test('newer, same-date and backfilled unseen records notify once while baseline stays fixed', async t => {
  const h = await harness(t);
  await h.run();
  const additions = [
    { ...fixture.applist[0], appID: 'newer', lastActDate: '1758456000' },
    { ...fixture.applist[0], appID: 'same-date' },
    { ...fixture.applist[0], appID: 'older-unseen', lastActDate: '1758196800' },
  ];
  h.setResults(parsed([...fixture.applist, ...additions]));
  assert.equal((await h.run()).identifiers[0].notified, 3);
  assert.equal(h.messages.length, 3);
  await h.run();
  assert.equal(h.messages.length, 3);
  const tracked = (await h.store.read()).targets[targetKey(target)];
  assert.equal(tracked.baselineDate, latest);
  assert.equal(tracked.latestDate, '2025-09-21T12:00:00.000Z');
});

test('stable keys ignore ordering and personal display data but detect same-ID updates', async t => {
  const h = await harness(t);
  await h.run();
  h.setResults(parsed(fixture.applist.toReversed().map(r => ({ ...r, address: 'changed', applicants: [], appID: String(r.appID) }))));
  await h.run();
  assert.deepEqual(h.messages, []);
  h.setResults(parsed([{ ...fixture.applist[0], status: 'new status on same date' }, fixture.applist[1]]));
  assert.equal((await h.run()).identifiers[0].notified, 1);
  await h.run();
  assert.equal(h.messages.length, 1);
});

test('an empty successful baseline still notifies for a later first result', async t => {
  const h = await harness(t);
  h.setResults([]);
  await h.run();
  assert.equal((await h.store.read()).targets[targetKey(target)].baselineDate, null);
  h.setResults(entries);
  assert.equal((await h.run()).identifiers[0].notified, 2);
});

test('search/login/parsing errors are logged/notified and never establish or advance baseline', async t => {
  const h = await harness(t);
  for (const message of ['Login requires a verification code', 'Search timed out', 'Parsing failed: expected applist']) {
    h.setResults(new Error(message));
    assert.equal((await h.run()).ok, false);
    assert.deepEqual((await h.store.read()).targets, {});
    assert.ok(h.messages.at(-1).includes(message));
    assert.ok(h.errors.at(-1).includes(message));
  }
  h.setResults(entries);
  await h.run();
  const before = await readFile(h.store.path, 'utf8');
  h.setResults(new Error('HTTP 503'));
  await h.run();
  assert.equal(await readFile(h.store.path, 'utf8'), before);
  h.setResults(entries);
  assert.equal((await h.run()).identifiers[0].notified, 0);
});

test('one failed identifier does not block a second identifier baseline', async t => {
  const other = { type: 'id', value: '00000000000' };
  const h = await harness(t, [target, other]);
  h.options.search = async identifier => { if (identifier.type === 'cadastral') throw Error('failed search'); return entries; };
  const report = await h.run();
  assert.equal(report.ok, false);
  assert.equal(report.identifiers[1].baselined, true);
  const state = await h.store.read();
  assert.equal(Object.keys(state.targets).length, 1);
  assert.ok(state.targets[targetKey(other)]);
});

test('delivery failures persist outbox, retry disappearing entries, and preserve acknowledged dedupe', async t => {
  const h = await harness(t);
  await h.run();
  const newEntries = parsed([{ ...fixture.applist[0], appID: 'new-first' }, { ...fixture.applist[0], appID: 'new-second' }]);
  h.setResults([...entries, ...newEntries]);
  let calls = 0;
  h.options.notify = async message => {
    if (message.startsWith('my.gov.ge update:') && ++calls === 2) throw new Error('Telegram unavailable');
    h.messages.push(message);
  };
  assert.equal((await h.run()).ok, false);
  let tracked = (await h.store.read()).targets[targetKey(target)];
  assert.equal(Object.keys(tracked.pending).length, 1);
  assert.equal(Object.keys(tracked.seen).length, 3);
  h.setResults(entries);
  assert.equal((await h.run()).identifiers[0].notified, 1);
  tracked = (await h.store.read()).targets[targetKey(target)];
  assert.equal(Object.keys(tracked.pending).length, 0);
  assert.equal(Object.keys(tracked.seen).length, 4);
  assert.equal((await h.run()).identifiers[0].notified, 0);
});

test('both search and notification errors remain visible even with Telegram down', async t => {
  const h = await harness(t);
  h.setResults(new Error('registry unavailable'));
  h.options.notify = async () => { throw Error('Telegram unavailable'); };
  assert.equal((await h.run()).ok, false);
  assert.ok(h.errors.some(e => e.includes('registry unavailable')));
  assert.ok(h.errors.some(e => e.includes('Failure notification also failed')));
});

test('corrupt state and a held lock fail visibly without silently rebaselining', async t => {
  const h = await harness(t);
  await writeFile(h.store.path, '{ invalid');
  assert.equal((await h.run()).ok, false);
  assert.equal(await readFile(h.store.path, 'utf8'), '{ invalid');
  await writeFile(h.store.path, JSON.stringify({ version: 1, targets: { broken: { seen: {} } } }));
  assert.equal((await h.run()).ok, false);
  await rm(h.store.path);
  const unlock = await h.store.lock();
  try {
    assert.equal((await h.run()).ok, false);
    assert.match(h.errors.at(-1), /locked/);
  } finally { await unlock(); }
  assert.equal((await h.run()).ok, true);
});

test('loop checks immediately, honors interval, survives a failed cycle, and stops on abort', async t => {
  const h = await harness(t);
  const controller = new AbortController();
  let searches = 0, sleeps = 0;
  h.options.config.intervalMinutes = 7;
  h.options.search = async () => { if (++searches === 1) throw Error('transient failure'); return entries; };
  const cycles = await runLoop(h.options, {
    signal: controller.signal,
    sleep: async milliseconds => {
      assert.equal(milliseconds, 420000);
      if (++sleeps === 2) controller.abort();
    },
  });
  assert.equal(cycles, 2);
  assert.equal(searches, 2);
  assert.equal(Object.keys((await h.store.read()).targets).length, 1);
});

test('Telegram uses existing variables, validates HTTP/API failures, redacts secrets and falls back to console', async () => {
  const messages = [];
  await createNotifier({}, { logger: { log: message => messages.push(message) } })('console update');
  assert.deepEqual(messages, ['console update']);
  assert.throws(() => createNotifier({ TELEGRAM_CHAT_ID: 'fake-chat' }), /both/);
  const settings = { TELEGRAM_BOT_TOKEN: 'fake-secret', TELEGRAM_CHAT_ID: 'fake-chat' };
  let request;
  await createNotifier(settings, { fetchImpl: async (url, options) => {
    request = { url, options }; return { ok: true, json: async () => ({ ok: true }) };
  } })('plain update');
  assert.ok(request.url.endsWith('/botfake-secret/sendMessage'));
  assert.deepEqual(JSON.parse(request.options.body), { chat_id: 'fake-chat', text: 'plain update' });
  assert.ok(request.options.signal instanceof AbortSignal);
  for (const response of [{ ok: false, status: 429 }, { ok: true, json: async () => ({ ok: false }) }]) {
    await assert.rejects(createNotifier(settings, { fetchImpl: async () => response })('update'), /Telegram notification failed/);
  }
  await assert.rejects(createNotifier(settings, { fetchImpl: async () => { throw Error('url fake-secret'); } })('update'), /url \[redacted\]/);
  assert.equal(safeError(new Error('test-pass-3'), { MYGOV_PASSWORD: 'test-pass-3' }), '[redacted]');
});

test('configuration supports multiple typed identifiers, defaults, env overrides and rejects empty searches', async t => {
  const h = await harness(t);
  const configPath = join(h.options.config.dataDir, 'tracked.json');
  await writeFile(configPath, JSON.stringify({ identifiers: [target, { type: 'registration', value: '000000000001' }] }));
  const config = await loadTrackerConfig({ configPath, settings: {} });
  assert.equal(config.intervalMinutes, 60);
  assert.equal(config.identifiers[1].value, '000000000001');
  const changed = await loadTrackerConfig({ configPath, settings: { TRACKER_DATA_DIR: h.options.config.dataDir, TRACKER_INTERVAL_MINUTES: '5' } });
  assert.equal(changed.intervalMinutes, 5);
  assert.equal(changed.dataDir, h.options.config.dataDir);
  const blanks = await loadTrackerConfig({ configPath, settings: { TRACKER_INTERVAL_MINUTES: '', TRACKER_TIMEOUT_MS: '', TRACKER_DATA_DIR: '' } });
  assert.equal(blanks.intervalMinutes, 60);
  for (const identifiers of [[], [target, target], [{ type: 'unknown', value: 'x' }], [{ type: 'id', value: '' }], [{ type: 'id', value: 123 }], [{ type: 'toString', value: 'x' }]]) {
    assert.throws(() => validateTargets(identifiers));
  }
  for (const value of ['0', '-1', 'NaN', 'Infinity']) {
    await assert.rejects(loadTrackerConfig({ configPath, settings: { TRACKER_INTERVAL_MINUTES: value } }), /intervalMinutes/);
  }
});

test('unattended login explicitly fails on MFA instead of waiting or requesting a code', async () => {
  const clicks = [];
  const locator = selector => ({ fill: async () => {}, filter: () => locator('submit'), click: async () => clicks.push(selector) });
  const page = { goto: async () => {}, locator, waitForURL: async () => {}, url: () => 'https://www.my.gov.ge/ka-ge/account/login/verification' };
  await assert.rejects(loginWithCredentials(page, { settings: { TRACKER_ENV_FILE: '/dev/null', MYGOV_LOGIN_ID: 'fake-id', MYGOV_PASSWORD: 'test-pass-3' }, timeoutMs: 100 }), /verification code/);
  assert.deepEqual(clicks, ['submit']);
});

test('CLI exposes usage and returns nonzero for invalid mode/config without opening the browser', async () => {
  const cli = new URL('../tracker.mjs', import.meta.url).pathname;
  const execute = promisify(execFile);
  const exec = (file, args, options) => execute(file, args, { ...options, env: {
    ...process.env, TRACKER_ENV_FILE: '/dev/null', TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '',
    MYGOV_LOGIN_ID: '', MYGOV_PASSWORD: '',
  } });
  const help = await exec(process.execPath, [cli, '--help'], { timeout: 10000 });
  assert.match(help.stdout, /once\|loop/);
  await assert.rejects(exec(process.execPath, [cli, 'invalid-mode'], { timeout: 10000 }), error => error.code === 1 && /Specify once or loop/.test(error.stderr));
  await assert.rejects(exec(process.execPath, [cli, 'once', '--config', '/nonexistent/tracked.json'], { timeout: 10000 }), error => error.code === 1 && /configuration JSON/.test(error.stderr));
});
