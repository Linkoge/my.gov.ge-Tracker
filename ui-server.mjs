import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { defaultConfigPath, validateIdentifierInput } from './config.mjs';
import { createNotifier, safeError } from './notifications.mjs';
import { describeSettings, loadRuntime } from './runtime.mjs';
import { StateStore, targetKey } from './state-store.mjs';
import { TargetsStore } from './targets-store.mjs';
import { Waker, runLoop, runOnce, withDataLock, checkState } from './tracking.mjs';
import { SettingsStore, applyUiSettings, validateUiSettings } from './ui-settings.mjs';
import { deletePage, layout, testAlertPage, newPage, settingsPage, trackingsPage } from './ui-pages.mjs';

class UserError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }

export const LOOPBACK_HOSTS = ['127.0.0.1', '::1', 'localhost'];
export const DEFAULT_UI_PORT = 8790;
// Plain-text identity served at /healthz so deploy/health can tell this app from anything else on the port.
export const HEALTH_MARKER = 'mygov-tracker ok';

// Parse the single external origin a private reverse proxy (e.g. Tailscale serve) presents, such as
// "https://host.tailnet.ts.net:8791". Returns { origin, hosts } where hosts are the exact Host header values accepted.
export function parsePublicOrigin(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const text = String(value).trim();
  let url;
  try { url = new URL(text); } catch { throw new Error('Invalid public origin; use scheme://hostname[:port]'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || url.pathname !== '/' || /[/?#]$/.test(text) || !url.hostname || url.hostname.includes('*')) {
    throw new Error('Invalid public origin; use scheme://hostname[:port] with no path, credentials or wildcard');
  }
  const defaultPort = url.protocol === 'https:' ? '443' : '80';
  const port = url.port || defaultPort;
  const hosts = [`${url.hostname}:${port}`];
  if (port === defaultPort) hosts.push(url.hostname);
  return { origin: url.origin, hosts };
}

// Local web UI + optional scheduler. `search(target, config)` performs one registry search.
export function createApp({
  search, configPath = defaultConfigPath, dataDir, env = process.env, envPath, fetchImpl = fetch,
  logger = console, host = '127.0.0.1', port = DEFAULT_UI_PORT, publicOrigin,
} = {}) {
  if (!LOOPBACK_HOSTS.includes(host)) throw new Error('The UI has no login and can only bind to a loopback address (127.0.0.1, ::1 or localhost)');
  const external = parsePublicOrigin(publicOrigin);
  configPath = resolve(configPath);
  const csrf = randomBytes(24).toString('hex');
  const targets = new TargetsStore(configPath);
  const waker = new Waker();
  const running = new Set();
  const jobs = new Set();
  let flash = null;
  let address;

  const runtime = () => loadRuntime({ env, envPath, configPath, dataDir, allowEmpty: true });
  const notifierFor = config => {
    try { return createNotifier(config.settings, { fetchImpl, logger, timeoutMs: config.timeoutMs }); }
    catch (error) { logger.error(safeError(error, config.settings)); return async message => logger.error(message); }
  };
  const runOptions = async () => {
    const config = await runtime();
    return { config, notify: notifierFor(config), search: target => search(target, config), logger };
  };

  function startCheck(target) {
    const key = targetKey(target);
    if (running.has(key)) return false;
    running.add(key);
    const job = (async () => {
      try {
        if (!(await targets.list()).some(t => targetKey(t) === key)) return;
        const report = await runOnce({ ...(await runOptions()), targets: [target] });
        flash = report.ok ? { kind: 'ok', text: `Check completed for ${target.value}` }
          : { kind: 'error', text: `Check failed for ${target.value}; see Last result` };
      } catch (error) { logger.error(`Check failed: ${safeError(error)}`); flash = { kind: 'error', text: `Check failed for ${target.value}; see the server log` }; }
      finally { running.delete(key); }
    })();
    jobs.add(job);
    job.finally(() => jobs.delete(job));
    return true;
  }

  async function snapshot() {
    const config = await runtime();
    const store = new StateStore(config.dataDir);
    let problem, state = { targets: {} };
    try { state = await store.read(); } catch (error) { problem = error.message; }
    const status = await store.readStatus();
    const rows = config.identifiers.map(target => {
      const key = targetKey(target);
      const known = state.targets[key];
      const check = status[key] ?? (known?.lastCheckedAt ? { ok: true, checkedAt: known.lastCheckedAt, error: null } : null);
      const count = status[key]?.count ?? (known ? Object.keys(known.seen).length + Object.keys(known.pending).length : null);
      return { ...target, running: running.has(key) || Boolean(checkState(config.dataDir, target)), checkState: checkState(config.dataDir, target) ?? (running.has(key) ? 'queued' : null), check, count, latestDate: known?.latestDate ?? null, testPending: Boolean(known?.testPending) };
    });
    return { config, rows, problem };
  }

  const requireTarget = async form => {
    const type = form.get('type'), value = form.get('value');
    const target = (await targets.list()).find(t => t.type === type && t.value === value);
    if (!target) throw new UserError('That tracking no longer exists', 404);
    return target;
  };
  const setPaused = (target, paused) => targets.update(list => list.map(t =>
    targetKey(t) === targetKey(target) ? { ...t, paused: paused || undefined } : t));

  async function addTracking(form) {
    const type = form.get('type');
    let value;
    try { value = validateIdentifierInput(type, form.get('value')); } catch (error) { throw new UserError(error.message); }
    const label = (form.get('label') ?? '').trim();
    if (label.length > 100) throw new UserError('Label is too long (100 characters at most)');
    const target = { type, value, ...(label && { label }) };
    await targets.update(list => {
      if (list.some(t => targetKey(t) === targetKey(target))) throw new UserError('This identifier is already tracked');
      return [...list, target];
    });
    startCheck(target);
    return target;
  }

  async function saveSettings(form) {
    const config = await runtime();
    const ui = { ...config.ui };
    const token = (form.get('telegramBotToken') ?? '').trim();
    const chat = (form.get('telegramChatId') ?? '').trim();
    if (form.get('clearTelegram')) { delete ui.telegramBotToken; delete ui.telegramChatId; }
    else {
      if (token) ui.telegramBotToken = token;
      if (chat) ui.telegramChatId = chat; else delete ui.telegramChatId;
    }
    const interval = (form.get('intervalMinutes') ?? '').trim();
    if (interval) ui.intervalMinutes = interval; else delete ui.intervalMinutes;
    let clean;
    try { clean = validateUiSettings(ui); } catch (error) { throw new UserError(error.message); }
    const effective = applyUiSettings(config.baseSettings, clean);
    if (Boolean(effective.TELEGRAM_BOT_TOKEN) !== Boolean(effective.TELEGRAM_CHAT_ID)) {
      throw new UserError('Set both the Telegram bot token and chat ID, or neither');
    }
    await new SettingsStore(config.dataDir).write(clean);
    waker.wake();
  }

  // Test mode: rewinds the stored baseline so the next check re-alerts the newest entry through the normal path.
  async function rewindForTest(target) {
    const key = targetKey(target);
    const config = await runtime();
    if (running.has(key) || checkState(config.dataDir, target)) throw new UserError('A check is queued or running for this tracking; try again when it finishes', 409);
    let result;
    try { result = await withDataLock(config.dataDir, store => store.rewindBaseline(key)); }
    catch (error) { throw new UserError(safeError(error, config.settings), 409); }
    const problems = {
      'no-baseline': 'No baseline saved yet; run a check first',
      'already-pending': 'A test alert is already pending; run Check now',
      'nothing-saved': 'No saved entries to re-alert for this tracking',
    };
    if (problems[result.status]) throw new UserError(problems[result.status], 409);
    return result;
  }

  async function sendTest() {
    const config = await runtime();
    const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chat } = config.settings;
    if (!token || !chat) throw new UserError('Save a Telegram bot token and chat ID first');
    try {
      await createNotifier(config.settings, { fetchImpl, logger, timeoutMs: config.timeoutMs })('my.gov.ge tracker: test message');
    } catch (error) { throw new UserError(safeError(error, config.settings), 502); }
  }

  async function route(req, url, form) {
    const page = (name, body, extra = {}) => ({ status: 200, html: layout({ title: name, body, ...extra }) });
    const take = () => { const f = flash; flash = null; return f; };
    const go = (kind, text) => { flash = { kind, text }; return { redirect: '/' }; };
    const post = req.method === 'POST';
    switch (`${req.method} ${url.pathname}`) {
      case 'GET /': {
        const { rows, problem } = await snapshot();
        return page('Trackings', trackingsPage({ rows, csrf, problem }), { active: 'list', flash: take(), refresh: rows.some(r => r.running) });
      }
      case 'GET /new': return page('New tracking', newPage({ csrf }), { active: 'new', flash: take() });
      case 'POST /track/add':
        try { const target = await addTracking(form); return go('ok', `Added ${target.value}; the baseline check is queued.`); }
        catch (error) {
          if (!(error instanceof UserError)) throw error;
          return { ...page('New tracking', newPage({ csrf, error: error.message, values: { type: form.get('type'), value: form.get('value'), label: form.get('label') } }), { active: 'new' }), status: 400 };
        }
      case 'POST /track/pause': await setPaused(await requireTarget(form), true); return go('ok', 'Paused');
      case 'POST /track/resume': await setPaused(await requireTarget(form), false); return go('ok', 'Resumed');
      case 'POST /track/check': {
        const target = await requireTarget(form);
        return go('ok', startCheck(target) ? 'Check queued; waiting for any current cycle to finish' : 'A check is already queued or checking');
      }
      case 'GET /track/test-alert': {
        const target = await requireTarget(url.searchParams);
        return page('Test alert', testAlertPage({ csrf, target }), { active: 'list' });
      }
      case 'POST /track/test-alert': {
        const target = await requireTarget(form);
        try { await rewindForTest(target); }
        catch (error) {
          if (!(error instanceof UserError)) throw error;
          flash = { kind: 'error', text: error.message }; return { redirect: '/' };
        }
        return go('ok', 'Test alert armed: the next check re-sends the newest entry');
      }
      case 'GET /track/delete': {
        const target = await requireTarget(url.searchParams);
        return page('Delete tracking', deletePage({ csrf, target }), { active: 'list' });
      }
      case 'POST /track/delete': {
        const target = await requireTarget(form);
        await targets.update(list => list.filter(t => targetKey(t) !== targetKey(target)));
        const config = await runtime();
        await withDataLock(config.dataDir, store => store.forget(targetKey(target)))
          .catch(error => logger.error(`Could not clear saved history: ${safeError(error)}`));
        return go('ok', 'Deleted');
      }
      case 'GET /settings': {
        const config = await runtime();
        return page('Settings', settingsPage({ csrf, view: describeSettings(config) }), { active: 'settings', flash: take() });
      }
      case 'POST /settings':
        try { await saveSettings(form); flash = { kind: 'ok', text: 'Settings saved' }; return { redirect: '/settings' }; }
        catch (error) {
          if (!(error instanceof UserError)) throw error;
          flash = { kind: 'error', text: error.message }; return { redirect: '/settings' };
        }
      case 'POST /settings/test':
        try { await sendTest(); flash = { kind: 'ok', text: 'Test message sent' }; }
        catch (error) { if (!(error instanceof UserError)) throw error; flash = { kind: 'error', text: error.message }; }
        return { redirect: '/settings' };
      default:
        if (post || req.method === 'GET') throw new UserError('Not found', 404);
        throw new UserError('Method not allowed', 405);
    }
  }

  const server = createServer(async (req, res) => {
    const send = (status, body, headers = {}) => {
      res.writeHead(status, {
        'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
        ...headers,
      });
      res.end(body);
    };
    try {
      // Reject DNS-rebinding and cross-site requests; the UI has no login of its own. Only loopback hosts and the one
      // configured external origin are accepted; forwarded headers (X-Forwarded-*) are deliberately ignored.
      const hostHeader = (req.headers.host ?? '').toLowerCase();
      const allowed = LOOPBACK_HOSTS.map(h => (h.includes(':') ? `[${h}]` : h));
      const viaProxy = Boolean(external?.hosts.includes(hostHeader));
      if (!viaProxy && !allowed.includes(hostHeader.replace(/:\d+$/, ''))) throw new UserError('Forbidden host', 403);
      const expectedOrigin = viaProxy ? external.origin : `http://${hostHeader}`;
      const url = new URL(req.url, `http://${hostHeader}`);
      if (req.method === 'GET' && url.pathname === '/healthz') {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        res.end(`${HEALTH_MARKER}\n`);
        return;
      }
      let form = new URLSearchParams();
      if (req.method === 'POST') {
        if (req.headers.origin && req.headers.origin !== expectedOrigin) throw new UserError('Forbidden origin', 403);
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 16384) throw new UserError('Request too large', 413); }
        form = new URLSearchParams(body);
        const given = Buffer.from(form.get('_csrf') ?? ''), expected = Buffer.from(csrf);
        if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new UserError('Invalid or missing form token; reload the page', 403);
      }
      const result = await route(req, url, form);
      if (result.redirect) send(303, '', { location: result.redirect });
      else send(result.status, result.html);
    } catch (error) {
      const status = error instanceof UserError ? error.status : 500;
      if (status === 500) logger.error(`UI error: ${safeError(error)}`);
      send(status, layout({ title: 'Error', body: `<div class="flash error">${status === 500 ? 'Internal error; see the server log' : error.message}</div><p><a href="/">Back</a></p>` }));
    }
  });

  return {
    server, targets, waker, publicOrigin: external?.origin ?? null,
    get url() { return `http://${host.includes(':') ? `[${host}]` : host}:${address?.port ?? port}`; },
    listen: () => new Promise((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => { address = server.address(); server.off('error', reject); resolveListen(address); });
    }),
    // Resolves when background checks started from the UI have finished.
    async idle() { while (jobs.size) await Promise.allSettled([...jobs]); },
    // Scheduler: reloads identifiers, paused flags and settings from disk before every cycle.
    startScheduler: (signal, loopOptions = {}) => runLoop(runOptions, { signal, waker, logger, ...loopOptions }),
    close: () => new Promise(done => { server.close(done); server.closeAllConnections?.(); }),
  };
}
