import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { validateIdentifierInput } from '../config.mjs';
import { loadRuntime } from '../runtime.mjs';
import { StateStore, targetKey } from '../state-store.mjs';
import { runLoop, runOnce } from '../tracking.mjs';
import { DEFAULT_UI_PORT, HEALTH_MARKER, createApp, parsePublicOrigin } from '../ui-server.mjs';
import { formatWhen } from '../ui-pages.mjs';

const entry = { key: 'k1', date: '2025-09-20T12:00:00.000Z', description: 'd', status: 's', registrationNumber: '1' };
const samples = {
  cadastral: { type: 'cadastral', value: '01.14.16.007.381' },
  id: { type: 'id', value: '01234567890' },
  registration: { type: 'registration', value: '882022123456' },
};
const quiet = { log() {}, error() {} };

async function start(t, { env = {}, search, fetchImpl, tracked, publicOrigin } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mygov-ui-test-'));
  const configPath = join(dir, 'tracked.json');
  if (tracked) await writeFile(configPath, JSON.stringify(tracked));
  const searched = [];
  const app = createApp({
    configPath, dataDir: join(dir, 'data'), port: 0, logger: quiet, fetchImpl, publicOrigin,
    env: { TRACKER_ENV_FILE: '/dev/null', ...env },
    search: search ?? (async target => { searched.push(target); return [entry]; }),
  });
  await app.listen();
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const get = async path => (await fetch(app.url + path)).text();
  const csrf = async () => (await get('/')).match(/name="_csrf" value="([0-9a-f]+)"/)?.[1]
    ?? (await get('/new')).match(/name="_csrf" value="([0-9a-f]+)"/)[1];
  const post = async (path, fields = {}, { token } = {}) => fetch(app.url + path, {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: token ?? await csrf(), ...fields }),
  });
  const listed = async () => JSON.parse(await readFile(configPath, 'utf8').catch(() => '{"identifiers":[]}')).identifiers;
  return { app, dir, configPath, dataDir: join(dir, 'data'), searched, get, post, listed, store: new StateStore(join(dir, 'data')) };
}

test('adding each identifier type saves it and runs a silent baseline check', async t => {
  const messages = [];
  const h = await start(t, { fetchImpl: async (url, init) => { messages.push(JSON.parse(init.body).text); return { ok: true, json: async () => ({ ok: true }) }; },
    env: { TELEGRAM_BOT_TOKEN: 'env-tok-1', TELEGRAM_CHAT_ID: '42' } });
  for (const [type, sample] of Object.entries(samples)) {
    const response = await h.post('/track/add', { ...sample, label: `my ${type}` });
    assert.equal(response.status, 303);
    await h.app.idle();
  }
  assert.deepEqual(h.searched.map(({ type, value }) => ({ type, value })), Object.values(samples));
  assert.deepEqual(await h.listed(), Object.values(samples).map(s => ({ type: s.type, value: s.value, label: `my ${s.type}` })));
  assert.equal(JSON.stringify(await h.listed()).includes('undefined'), false);
  const state = await h.store.read();
  for (const sample of Object.values(samples)) assert.equal(state.targets[targetKey(sample)].baselineDate, entry.date);
  assert.deepEqual(messages, []);
  const page = await h.get('/');
  for (const sample of Object.values(samples)) assert.ok(page.includes(sample.value));
  assert.match(page, /active/);
  assert.match(page, /Check now/);
  assert.match(page, /Latest entry/);
});

test('cadastral codes accept any nonempty text, trim whitespace and reject duplicates', async t => {
  const h = await start(t);
  const values = ['82.01.44.932', '01.14.16.007.381', '01.14.16.007.381.01.500', '01.14.16', 'abc', 'arbitrary cadastral / value', 'x'.repeat(80)];
  const targets = values.map(value => ({ type: 'cadastral', value }));
  for (const target of targets) {
    assert.equal(validateIdentifierInput(target.type, ` ${target.value} `), target.value);
    assert.equal((await h.post('/track/add', { ...target, value: ` ${target.value} ` })).status, 303, target.value);
    await h.app.idle();
    const duplicate = await h.post('/track/add', target);
    assert.equal(duplicate.status, 400);
    assert.match(await duplicate.text(), /already tracked/);
  }
  assert.deepEqual(await h.listed(), targets);
  assert.deepEqual(h.searched, targets);
  const page = await h.get('/new');
  assert.match(page, /placeholder="82\.01\.44\.932 or 01\.14\.16\.007\.381"/);
  assert.doesNotMatch(page, /Expected: like/);
  assert.doesNotMatch(page.match(/<input[^>]+id="v-cadastral"[^>]*>/)[0], /maxlength|pattern=/);
  for (const value of ['', '   ', '\t\n']) {
    assert.throws(() => validateIdentifierInput('cadastral', value), /Invalid cadastral value; enter a nonempty value/);
    const response = await h.post('/track/add', { type: 'cadastral', value });
    assert.equal(response.status, 400);
    assert.doesNotMatch(await response.text(), /expected like/i);
  }
  assert.deepEqual(await h.listed(), targets);
});

test('invalid input, unknown types, duplicates and forged requests are rejected', async t => {
  const h = await start(t);
  const bad = [
    ['cadastral', ''], ['id', '123'], ['id', '1234567890a'],
    ['registration', '12'], ['registration', 'a b c d e f'], ['bogus', '123456789'], ['toString', 'x'],
  ];
  for (const [type, value] of bad) {
    const response = await h.post('/track/add', { type, value });
    assert.equal(response.status, 400, `${type} ${value}`);
  }
  assert.equal((await h.post('/track/add', { ...samples.id, label: 'x'.repeat(101) })).status, 400);
  assert.deepEqual(await h.listed(), []);
  assert.equal((await h.post('/track/add', samples.id)).status, 303);
  assert.equal((await h.post('/track/add', samples.id)).status, 400);
  assert.equal((await h.listed()).length, 1);
  await h.app.idle();
  // Missing/incorrect form token and foreign Host/Origin headers.
  assert.equal((await h.post('/track/add', samples.cadastral, { token: 'wrong' })).status, 403);
  const cross = await fetch(h.app.url + '/track/add', { method: 'POST', headers: { origin: 'http://evil.example', 'content-type': 'application/x-www-form-urlencoded' }, body: '' });
  assert.equal(cross.status, 403);
  const status = await new Promise((resolve, reject) => {
    const { port } = h.app.server.address();
    request({ host: '127.0.0.1', port, path: '/', headers: { host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject).end();
  });
  assert.equal(status, 403);
  assert.deepEqual(await h.listed(), [samples.id]);
  for (const [type, value] of [['cadastral', '01.14.16.007.381'], ['cadastral', '01.14.16.007.381.01.500'], ['id', '123456789'], ['registration', 'AB-12345/6']]) {
    assert.equal(validateIdentifierInput(type, ` ${value} `), value);
  }
});

test('the server only binds to loopback', async t => {
  assert.throws(() => createApp({ host: '0.0.0.0', search: async () => [] }), /loopback/);
  const h = await start(t);
  assert.equal(h.app.server.address().address, '127.0.0.1');
});

test('scheduler skips paused items and picks up UI changes without a restart', async t => {
  const h = await start(t, { tracked: { identifiers: [samples.cadastral, samples.id], intervalMinutes: 5 } });
  const cycles = [];
  const controller = new AbortController();
  let sleeps = 0;
  const loop = h.app.startScheduler(controller.signal, { sleep: async () => {
    cycles.push(h.searched.splice(0).map(t => t.type));
    sleeps++;
    if (sleeps === 1) {
      assert.equal((await h.post('/track/pause', samples.id)).status, 303);
      assert.equal((await h.post('/track/add', samples.registration)).status, 303);
      await h.app.idle();
      h.searched.splice(0);
    }
    if (sleeps === 2) assert.equal((await h.post('/track/resume', samples.id)).status, 303);
    if (sleeps === 3) controller.abort();
  } });
  await loop;
  assert.deepEqual(cycles[0], ['cadastral', 'id']);
  assert.deepEqual(cycles[1], ['cadastral', 'registration']);
  assert.deepEqual(cycles[2], ['cadastral', 'id', 'registration']);
  const paused = (await h.listed()).filter(t => t.paused);
  assert.deepEqual(paused, []);
});

test('pausing is stored, shown, and skipped by runOnce; Check now still works', async t => {
  const h = await start(t, { tracked: { identifiers: [samples.cadastral, samples.id] } });
  await h.post('/track/pause', samples.id);
  assert.deepEqual((await h.listed())[1], { ...samples.id, paused: true });
  assert.match(await h.get('/'), /paused/);
  const config = await loadRuntime({ env: { TRACKER_ENV_FILE: '/dev/null' }, configPath: h.configPath, dataDir: h.dataDir });
  const seen = [];
  await runOnce({ config, logger: quiet, notify: async () => {}, search: async target => { seen.push(target.type); return [entry]; } });
  assert.deepEqual(seen, ['cadastral']);
  await h.post('/track/check', samples.id);
  await h.app.idle();
  assert.deepEqual(h.searched.map(t => t.type), ['id']);
  await h.post('/track/resume', samples.id);
  assert.deepEqual((await h.listed())[1], samples.id);
});

test('delete asks for confirmation and removes the tracking and its history', async t => {
  const h = await start(t, { tracked: { identifiers: [samples.cadastral, samples.id], intervalMinutes: 30 } });
  await h.post('/track/check', samples.cadastral);
  await h.app.idle();
  assert.ok((await h.store.read()).targets[targetKey(samples.cadastral)]);
  const confirm = await h.get(`/track/delete?type=cadastral&value=${samples.cadastral.value}`);
  assert.match(confirm, /Delete permanently/);
  assert.equal((await h.listed()).length, 2);
  assert.equal((await h.post('/track/delete', samples.cadastral)).status, 303);
  assert.deepEqual(await h.listed(), [samples.id]);
  assert.deepEqual((await h.store.read()).targets, {});
  assert.deepEqual(await h.store.readStatus(), {});
  assert.equal(JSON.parse(await readFile(h.configPath, 'utf8')).intervalMinutes, 30);
  assert.equal((await h.post('/track/delete', samples.cadastral)).status, 404);
});

test('a failed check is shown on the list with its error', async t => {
  const h = await start(t, { tracked: { identifiers: [samples.cadastral] }, search: async () => { throw new Error('Search timed out'); } });
  await h.post('/track/check', samples.cadastral);
  await h.app.idle();
  const page = await h.get('/');
  assert.match(page, /Search timed out/);
  assert.deepEqual((await h.store.read()).targets, {});
});

test('settings save and load with the bot token masked, stored privately and used by the scheduler', async t => {
  const tok = `1:${randomBytes(8).toString('hex')}`;
  const sent = [];
  const h = await start(t, {
    env: { TELEGRAM_BOT_TOKEN: 'envtoken1', TELEGRAM_CHAT_ID: '7', TRACKER_INTERVAL_MINUTES: '90' },
    fetchImpl: async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return { ok: true, json: async () => ({ ok: true }) }; },
  });
  let page = await h.get('/settings');
  assert.match(page, /environment \/ \.env/);
  assert.match(page, /value="90"/);
  assert.equal((await h.post('/settings', { telegramBotToken: tok, telegramChatId: '555', intervalMinutes: '15' })).status, 303);
  page = await h.get('/settings');
  assert.match(page, /Settings saved/);
  assert.ok(!page.includes(tok), 'token must not be rendered');
  assert.ok(page.includes(`••••••••${tok.slice(-4)}`));
  assert.match(page, /value="555"/);
  assert.match(page, /value="15"/);
  const file = join(h.dataDir, 'ui-settings.json');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).telegramBotToken, tok);
  // UI-saved values beat the environment; the scheduler config shows the same values.
  const config = await loadRuntime({ env: { TELEGRAM_BOT_TOKEN: 'envtoken1', TELEGRAM_CHAT_ID: '7', TRACKER_INTERVAL_MINUTES: '90', TRACKER_ENV_FILE: '/dev/null' }, configPath: h.configPath, dataDir: h.dataDir, allowEmpty: true });
  assert.equal(config.settings.TELEGRAM_BOT_TOKEN, tok);
  assert.equal(config.settings.TELEGRAM_CHAT_ID, '555');
  assert.equal(config.intervalMinutes, 15);
  // A blank token keeps the saved one; clearing falls back to the environment.
  await h.post('/settings', { telegramBotToken: '', telegramChatId: '556', intervalMinutes: '20' });
  assert.equal(JSON.parse(await readFile(file, 'utf8')).telegramBotToken, tok);
  await h.post('/settings', { clearTelegram: '1', telegramChatId: '', intervalMinutes: '' });
  const cleared = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(cleared.telegramBotToken, undefined);
  assert.equal(cleared.intervalMinutes, undefined);
  assert.match(await h.get('/settings'), /value="90"/);
  assert.deepEqual(sent, []);
});

test('invalid settings are rejected without changing the saved file', async t => {
  const h = await start(t);
  const file = join(h.dataDir, 'ui-settings.json');
  for (const fields of [
    { telegramBotToken: 'has space', telegramChatId: '1' }, { telegramBotToken: 'abcde:fghij' },
    { telegramBotToken: 'abcde:fghij', telegramChatId: 'not a chat' }, { telegramChatId: '555' },
    { intervalMinutes: '0' }, { intervalMinutes: '10081' }, { intervalMinutes: '1.5' }, { intervalMinutes: 'abc' },
  ]) {
    await h.post('/settings', fields);
    assert.match(await h.get('/settings'), /class="flash error"/, JSON.stringify(fields));
    await assert.rejects(stat(file));
  }
});

test('changing the interval in the UI wakes the sleeping scheduler', async t => {
  const h = await start(t, { tracked: { identifiers: [samples.cadastral], intervalMinutes: 60 } });
  const controller = new AbortController();
  const waits = [];
  const loop = h.app.startScheduler(controller.signal, { sleep: (ms, _value, { signal }) => {
    waits.push(ms);
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      if (waits.length === 1) h.post('/settings', { intervalMinutes: '10' }).then(() => {});
      else controller.abort();
    });
  } });
  await loop;
  assert.equal(waits[0], 3600000);
  assert.ok(waits[1] <= 600000 && waits[1] > 590000, String(waits[1]));
});

test('Telegram test message uses saved settings through the mocked HTTP call', async t => {
  const tok = `2:${randomBytes(8).toString('hex')}`;
  const calls = [];
  let reply = { ok: true, json: async () => ({ ok: true }) };
  const h = await start(t, { fetchImpl: async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return reply; } });
  await h.post('/settings/test');
  assert.match(await h.get('/settings'), /Save a Telegram bot token and chat ID first/);
  assert.equal(calls.length, 0);
  await h.post('/settings', { telegramBotToken: tok, telegramChatId: '321' });
  await h.post('/settings/test');
  assert.match(await h.get('/settings'), /Test message sent/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://api.telegram.org/bot${tok}/sendMessage`);
  assert.equal(calls[0].body.chat_id, '321');
  assert.match(calls[0].body.text, /test message/);
  reply = { ok: false, status: 401 };
  await h.post('/settings/test');
  const page = await h.get('/settings');
  assert.match(page, /Telegram notification failed: HTTP 401/);
  assert.ok(!page.includes(tok));
});

test('runLoop accepts a loader so each cycle sees fresh options', async () => {
  const intervals = [3, 4];
  const waits = [];
  const controller = new AbortController();
  let loads = 0;
  const cycles = await runLoop(async () => ({
    config: { dataDir: await mkdtemp(join(tmpdir(), 'mygov-loop-')), identifiers: [], intervalMinutes: intervals[loads++] },
  }), { signal: controller.signal, sleep: async ms => { waits.push(ms); if (waits.length === 2) controller.abort(); } });
  assert.equal(cycles, 2);
  assert.deepEqual(waits, [180000, 240000]);
});

test('CLI prints usage, serves the UI on loopback and rejects non-loopback hosts', { timeout: 30000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mygov-ui-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cli = new URL('../ui.mjs', import.meta.url).pathname;
  const env = { ...process.env, TRACKER_ENV_FILE: '/dev/null', TRACKER_DATA_DIR: join(dir, 'data'), TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '' };
  const run = promisify(execFile);
  assert.match((await run(process.execPath, [cli, '--help'], { env, timeout: 10000 })).stdout, /--port/);
  await assert.rejects(run(process.execPath, [cli, '--host', '0.0.0.0', '--port', '0'], { env, timeout: 10000 }), error => error.code === 1 && /loopback/.test(error.stderr));
  const child = spawn(process.execPath, [cli, '--port', '0', '--no-scheduler', '--config', join(dir, 'tracked.json')], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => child.kill());
  const url = await new Promise((resolve, reject) => {
    child.on('exit', code => reject(new Error(`exited ${code}`)));
    child.stdout.on('data', chunk => { const m = String(chunk).match(/(http:\/\/127\.0\.0\.1:\d+)/); if (m) resolve(m[1]); });
  });
  const page = await (await fetch(url)).text();
  assert.match(page, /Current trackings/);
});

// Raw request so Host/Origin/X-Forwarded-* can be set exactly as a reverse proxy would send them.
function raw(app, { method = 'GET', path = '/', headers = {}, body = '' }) {
  return new Promise((resolve, reject) => {
    const { port } = app.server.address();
    const req = request({ host: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', c => { text += c; }); res.on('end', () => resolve({ status: res.statusCode, text, headers: res.headers }));
    });
    req.on('error', reject); req.end(body);
  });
}
const PROXY = 'https://tracker-host.example.ts.net:8791';
const PROXY_HOST = 'tracker-host.example.ts.net:8791';

test('dedicated default port is 8790, never the Bot Boss port 8787', () => {
  assert.equal(DEFAULT_UI_PORT, 8790);
});

test('public origin parsing accepts only an exact scheme, hostname and port', () => {
  assert.equal(parsePublicOrigin(undefined), null);
  assert.equal(parsePublicOrigin(''), null);
  assert.deepEqual(parsePublicOrigin(PROXY), { origin: PROXY, hosts: [PROXY_HOST] });
  assert.deepEqual(parsePublicOrigin('https://Tracker.Example.ts.net'), { origin: 'https://tracker.example.ts.net', hosts: ['tracker.example.ts.net:443', 'tracker.example.ts.net'] });
  for (const bad of ['tracker.example', 'ftp://h.example', 'https://u:p@h.example', 'https://h.example/path', 'https://h.example/', 'https://h.example?x', 'https://*.example']) {
    assert.throws(() => parsePublicOrigin(bad), /public origin/, bad);
  }
  assert.throws(() => createApp({ publicOrigin: 'https://h.example/x', search: async () => [] }), /public origin/);
});

test('configured private HTTPS origin works through a proxy while CSRF and foreign hosts stay enforced', async t => {
  const h = await start(t, { publicOrigin: PROXY });
  const page = await raw(h.app, { headers: { host: PROXY_HOST } });
  assert.equal(page.status, 200);
  assert.match(page.text, /my\.gov\.ge tracker/);
  const token = (await raw(h.app, { path: '/new', headers: { host: PROXY_HOST } })).text.match(/name="_csrf" value="([0-9a-f]+)"/)[1];
  const form = fields => new URLSearchParams(fields).toString();
  // Exact external Host + HTTPS Origin with the token: accepted.
  const ok = await raw(h.app, { method: 'POST', path: '/track/add', headers: { host: PROXY_HOST, origin: PROXY }, body: form({ _csrf: token, ...samples.id }) });
  assert.equal(ok.status, 303);
  await h.app.idle();
  assert.deepEqual((await h.listed()).map(({ type, value }) => ({ type, value })), [samples.id]);
  // Missing or wrong token through the proxy: rejected.
  assert.equal((await raw(h.app, { method: 'POST', path: '/track/add', headers: { host: PROXY_HOST, origin: PROXY }, body: form(samples.cadastral) })).status, 403);
  assert.equal((await raw(h.app, { method: 'POST', path: '/track/add', headers: { host: PROXY_HOST, origin: PROXY }, body: form({ _csrf: 'f'.repeat(48), ...samples.cadastral }) })).status, 403);
  // Mismatched origins for the proxy host: wrong scheme, port, hostname, foreign site.
  for (const origin of ['http://tracker-host.example.ts.net:8791', 'https://tracker-host.example.ts.net', 'https://tracker-host.example.ts.net:8792', 'https://other.example.ts.net:8791', 'https://evil.example']) {
    const r = await raw(h.app, { method: 'POST', path: '/track/add', headers: { host: PROXY_HOST, origin }, body: form({ _csrf: token, ...samples.cadastral }) });
    assert.equal(r.status, 403, origin);
  }
  // The proxy origin is not valid for a loopback Host, and vice versa.
  assert.equal((await raw(h.app, { method: 'POST', path: '/track/add', headers: { host: '127.0.0.1', origin: PROXY }, body: form({ _csrf: token, ...samples.cadastral }) })).status, 403);
  // Foreign or near-miss hosts are rejected; forwarded headers grant nothing.
  for (const host of ['evil.example', 'tracker-host.example.ts.net', 'tracker-host.example.ts.net:8792', 'other.example.ts.net:8791']) {
    assert.equal((await raw(h.app, { headers: { host } })).status, 403, host);
  }
  assert.equal((await raw(h.app, { headers: { host: 'evil.example', 'x-forwarded-host': PROXY_HOST, 'x-forwarded-proto': 'https' } })).status, 403);
  assert.equal((await raw(h.app, { method: 'POST', path: '/track/add', headers: { host: PROXY_HOST, origin: 'https://evil.example', 'x-forwarded-host': 'evil.example' }, body: form({ _csrf: token, ...samples.cadastral }) })).status, 403);
  assert.equal((await h.listed()).length, 1);
  // Local access is unchanged.
  assert.equal((await h.post('/track/add', samples.registration)).status, 303);
  await h.app.idle();
  assert.equal(h.app.server.address().address, '127.0.0.1');
});

test('without a public origin only loopback hosts are accepted', async t => {
  const h = await start(t);
  assert.equal(h.app.publicOrigin, null);
  assert.equal((await raw(h.app, { headers: { host: PROXY_HOST } })).status, 403);
  assert.equal((await raw(h.app, { headers: { host: `localhost:${h.app.server.address().port}` } })).status, 200);
});

test('health endpoint identifies the tracker on loopback and through the proxy only', async t => {
  const h = await start(t, { publicOrigin: PROXY });
  const local = await raw(h.app, { path: '/healthz' });
  assert.equal(local.status, 200);
  assert.equal(local.text, `${HEALTH_MARKER}\n`);
  assert.equal((await raw(h.app, { path: '/healthz', headers: { host: PROXY_HOST } })).status, 200);
  assert.equal((await raw(h.app, { path: '/healthz', headers: { host: 'evil.example' } })).status, 403);
});

test('a fresh install without config opens an empty tracking page and adds nothing', async t => {
  const messages = [];
  const h = await start(t, { fetchImpl: async () => { messages.push(1); return { ok: true, json: async () => ({ ok: true }) }; } });
  const page = await h.get('/');
  assert.match(page, /my\.gov\.ge tracker/);
  assert.equal(page.includes(samples.cadastral.value), false);
  await h.app.idle();
  assert.deepEqual(await h.listed(), []);
  assert.deepEqual(h.searched, []);
  assert.deepEqual(messages, []);
});

test('pages are mobile-first: viewport meta, no external assets, active tab marked', async t => {
  const h = await start(t, { tracked: { identifiers: [samples.cadastral] } });
  for (const [path, label] of [['/', 'Trackings'], ['/new', 'New tracking'], ['/settings', 'Settings']]) {
    const page = await h.get(path);
    assert.match(page, /<meta name="viewport" content="width=device-width,initial-scale=1">/);
    assert.match(page, new RegExp(`<a href="${path}" class="on" aria-current="page">${label}</a>`));
    assert.equal((page.match(/aria-current="page"/g) ?? []).length, 1);
    assert.match(page, /--accent:#c2410c/);
    assert.match(page, /--accent-dark:#9a3412/);
    assert.match(page, /header\{position:sticky;top:0/);
    assert.doesNotMatch(page, /nav\.tabs\{[^}]*position:\s*fixed[^}]*bottom\s*:/);
    assert.doesNotMatch(page, /<script|<link|https?:\/\/(?!www\.w3\.org)|@import|url\(/i);
  }
});

test('each tracking is a card with status, facts and Check now / Pause / Delete actions', async t => {
  const h = await start(t, { tracked: { identifiers: [samples.cadastral, { ...samples.id, paused: true, label: 'Mom' }] } });
  await h.post('/track/check', samples.cadastral);
  await h.app.idle();
  const page = await h.get('/');
  assert.doesNotMatch(page, /<table/);
  const cards = page.match(/<article class="card tracking">[\s\S]*?<\/article>/g);
  assert.equal(cards.length, 2);
  const [first, second] = cards;
  assert.match(first, /class="t-id">01\.14\.16\.007\.381</);
  assert.match(first, /class="pill">active</);
  assert.match(first, /Last check[\s\S]*Last result[\s\S]*<span class="ok">OK<\/span>[\s\S]*Latest entry[\s\S]*20 Sep 2025, 12:00[\s\S]*Results/);
  assert.match(first, /action="\/track\/check"[\s\S]*name="_csrf"[\s\S]*<button>Check now<\/button>/);
  assert.match(first, /action="\/track\/pause"[\s\S]*<button>Pause<\/button>/);
  assert.match(first, /<form method="get" action="\/track\/delete">[\s\S]*name="type" value="cadastral"[\s\S]*<button class="danger">Delete<\/button>/);
  assert.match(second, /class="t-id">Mom</);
  assert.match(second, /class="pill paused">paused</);
  assert.match(second, /action="\/track\/resume"[\s\S]*<button>Resume<\/button>/);
  assert.match(second, /not checked yet/);
});

test('dates are shown compactly in UTC', () => {
  assert.equal(formatWhen('2026-10-20T10:45:30.123Z'), '20 Oct 2026, 10:45');
  assert.equal(formatWhen('2025-01-05'), '5 Jan 2025');
  assert.equal(formatWhen(null), '—');
  assert.equal(formatWhen('<b>soon</b>'), '&lt;b&gt;soon&lt;/b&gt;');
});

test('new tracking offers three type choices, one form each, with unchanged field names', async t => {
  const h = await start(t);
  const page = await h.get('/new');
  for (const type of ['cadastral', 'id', 'registration']) {
    assert.match(page, new RegExp(`<input class="seg-radio" type="radio" name="kind" id="t-${type}" value="${type}"`));
    assert.match(page, new RegExp(`<label for="t-${type}">`));
    assert.match(page, new RegExp(`pane-${type}[\\s\\S]*?action="/track/add"[\\s\\S]*?name="type" value="${type}"[\\s\\S]*?id="v-${type}" name="value"`));
  }
  assert.equal((page.match(/checked>/g) ?? []).length, 1);
  assert.match(page, /id="t-cadastral"[^>]* checked>/);
  assert.equal((page.match(/<button class="primary">Add and run baseline check<\/button>/g) ?? []).length, 3);
  const rejected = await h.post('/track/add', { type: 'id', value: 'abc' });
  assert.equal(rejected.status, 400);
  assert.match(await rejected.text(), /id="t-id"[^>]* checked>/);
});

test('settings keeps its field names and shows full-width Save and Send test message buttons', async t => {
  const h = await start(t);
  const page = await h.get('/settings');
  for (const name of ['telegramBotToken', 'telegramChatId', 'intervalMinutes', 'clearTelegram']) assert.ok(page.includes(`name="${name}"`), name);
  assert.match(page, /<button class="primary">Save settings<\/button>/);
  assert.match(page, /action="\/settings\/test"[\s\S]*<button>Send test message<\/button>/);
});

// Real-browser layout check; needs the optional Playwright dependency and Chrome, otherwise it reports itself skipped.
test('top navigation and visible tappable actions at 320px, 390px and desktop', async t => {
  let chromium;
  try { ({ chromium } = await import('playwright')); } catch { return t.skip('playwright not installed'); }
  const executablePath = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';
  const browser = await chromium.launch({ executablePath, headless: true }).catch(() => null);
  if (!browser) return t.skip('Chrome not available');
  t.after(() => browser.close());
  const long = { type: 'cadastral', value: '01.14.16.007.381', label: 'A very long label for a cadastral code (საკადასტრო კოდი) that must wrap' };
  const h = await start(t, { tracked: { identifiers: [long, samples.id, { ...samples.registration, paused: true }] },
    search: async () => { throw new Error('Search timed out '.repeat(8)); } });
  await h.post('/track/check', samples.id);
  await h.app.idle();
  for (const width of [320, 390, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    for (const path of ['/', '/new', '/settings', `/track/delete?type=id&value=${samples.id.value}`]) {
      await page.goto(h.app.url + path);
      const m = await page.evaluate(() => {
        const nav = document.querySelector('nav.tabs').getBoundingClientRect();
        const header = document.querySelector('header').getBoundingClientRect();
        return { scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth,
          navTop: nav.top, navBottom: nav.bottom, headerBottom: header.bottom, viewportBottom: innerHeight,
          position: getComputedStyle(document.querySelector('nav.tabs')).position };
      });
      assert.ok(m.scroll <= m.client, `${path} overflows at ${width}px: ${m.scroll} > ${m.client}`);
      assert.ok(m.navTop >= m.headerBottom - 1 && m.navBottom <= m.headerBottom + 1, `${path} nav is outside header at ${width}px`);
      assert.notEqual(m.position, 'fixed', `${path} nav must not be fixed at ${width}px`);
      assert.ok(m.navBottom < m.viewportBottom, `${path} nav overlaps page bottom at ${width}px`);
      for (const box of await page.locator('button:visible, nav a').evaluateAll(els => els.map(e => { const r = e.getBoundingClientRect(); return { text: e.textContent, left: r.left, right: r.right, height: r.height }; }))) {
        assert.ok(box.left >= 0 && box.right <= width && box.height >= 40, `${path} ${width}px: ${JSON.stringify(box)}`);
      }
    }
    await page.close();
  }
});

test('Test alert asks for confirmation, rewinds the baseline, shows Test pending and re-alerts once via Telegram', async t => {
  const messages = [];
  const older = { ...entry, key: 'k0', date: '2025-08-01T12:00:00.000Z', description: 'older entry' };
  const h = await start(t, {
    tracked: { identifiers: Object.values(samples) }, search: async () => [older, entry],
    fetchImpl: async (url, init) => { messages.push(JSON.parse(init.body).text); return { ok: true, json: async () => ({ ok: true }) }; },
    env: { TELEGRAM_BOT_TOKEN: 'env-tok-1', TELEGRAM_CHAT_ID: '42' },
  });
  for (const sample of Object.values(samples)) { await h.post('/track/check', sample); await h.app.idle(); }
  assert.deepEqual(messages, []);
  assert.match(await h.get('/'), /action="\/track\/test-alert"[\s\S]*<button>Test alert<\/button>/);

  for (const sample of Object.values(samples)) {
    const confirm = await h.get(`/track/test-alert?type=${sample.type}&value=${encodeURIComponent(sample.value)}`);
    assert.match(confirm, /Simulate old baseline/);
    assert.match(confirm, /action="\/track\/test-alert"/);
    assert.equal((await h.post('/track/test-alert', sample)).status, 303);
    const state = (await h.store.read()).targets[targetKey(sample)];
    assert.equal(state.testPending, true);
    assert.deepEqual(Object.keys(state.seen), ['k0']);
    assert.equal(state.latestDate, older.date);
  }
  const page = await h.get('/');
  assert.equal((page.match(/Test pending/g) ?? []).length, 3);
  assert.deepEqual(messages, []);

  await h.post('/track/check', samples.id);
  await h.app.idle();
  assert.equal(messages.length, 1);
  assert.match(messages[0], /01234567890/);
  assert.match(messages[0], /2025-09-20T12:00:00.000Z/);
  assert.equal((await h.get('/')).match(/Test pending/g).length, 2);
  await h.post('/track/check', samples.id);
  await h.app.idle();
  assert.equal(messages.length, 1);
  for (const sample of [samples.cadastral, samples.registration]) { await h.post('/track/check', sample); await h.app.idle(); }
  assert.equal(messages.length, 3);
  assert.doesNotMatch(await h.get('/'), /Test pending/);
});

test('Test alert enforces CSRF and Origin and reports unusable trackings', async t => {
  const h = await start(t, { tracked: { identifiers: [samples.cadastral, samples.id] } });
  await h.post('/track/check', samples.cadastral);
  await h.app.idle();
  const token = await (async () => (await h.get('/')).match(/name="_csrf" value="([0-9a-f]+)"/)[1])();
  assert.equal((await h.post('/track/test-alert', samples.cadastral, { token: 'bad' })).status, 403);
  const foreign = await fetch(h.app.url + '/track/test-alert', {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://evil.example' },
    body: new URLSearchParams({ _csrf: token, ...samples.cadastral }),
  });
  assert.equal(foreign.status, 403);
  assert.equal((await h.store.read()).targets[targetKey(samples.cadastral)].testPending, undefined);

  assert.equal((await h.post('/track/test-alert', { type: 'cadastral', value: 'nope' })).status, 404);
  // Never checked: no baseline to rewind.
  assert.equal((await h.post('/track/test-alert', samples.id)).status, 303);
  assert.match(await h.get('/'), /No baseline saved yet/);
  // Second press while pending does not rewind further.
  await h.post('/track/test-alert', samples.cadastral);
  await h.post('/track/test-alert', samples.cadastral);
  assert.match(await h.get('/'), /already pending/);
});
