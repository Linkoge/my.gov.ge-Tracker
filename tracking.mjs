import { setTimeout as delay } from 'node:timers/promises';
import { SEARCH_BUDGET_MS } from './registry.mjs';
import { StateStore, targetKey } from './state-store.mjs';
import { entryMessage, safeError } from './notifications.mjs';

export async function reportFailure(message, { notify, logger = console }) {
  logger.error(message);
  try { await notify(message); }
  catch (error) { logger.error(`Failure notification also failed: ${safeError(error)}`); }
}

const FAILURE_DELAY_MS = 24 * 60 * 60 * 1000;

async function recordCheckFailure({ target, message, store, logger, now }) {
  const key = targetKey(target);
  const time = now().toISOString();
  let previous;
  try { previous = (await store.readStatus())[key]; }
  catch (error) { logger.error(`Could not read check status: ${safeError(error)}`); }
  const failureSince = previous?.failureSince ?? time;
  const lastFailureNotifiedAt = previous?.lastFailureNotifiedAt;
  const due = Date.parse(time) - Date.parse(failureSince) >= FAILURE_DELAY_MS &&
    (!lastFailureNotifiedAt || Date.parse(time) - Date.parse(lastFailureNotifiedAt) >= FAILURE_DELAY_MS);
  await store.recordStatus(key, {
    checkedAt: time, ok: false, count: previous?.count ?? null, error: message,
    failureSince, ...(lastFailureNotifiedAt ? { lastFailureNotifiedAt } : {}),
    ...(due ? { lastFailureNotifiedAt: time } : {}),
  }).catch(error => logger.error(`Could not record check status for ${target.type} ${target.value}: ${safeError(error)}`));
  logger.error(message);
  return due ? { target, failureSince, error: message } : null;
}

function combinedFailureMessage(failures) {
  return `my.gov.ge check failures (${failures.length}):\n\n` + failures.map(({ target, failureSince, error }) =>
    `${target.type} ${target.value}\nFailing since: ${failureSince}\nLast error: ${error}`
  ).join('\n\n');
}

// In-process queue per data directory so UI actions and the scheduler never overlap.
const chains = new Map();
export function serialize(dataDir, task) {
  const run = (chains.get(dataDir) ?? Promise.resolve()).then(task);
  const tail = run.catch(() => {});
  chains.set(dataDir, tail);
  tail.then(() => { if (chains.get(dataDir) === tail) chains.delete(dataDir); });
  return run;
}

export function withDataLock(dataDir, task, store = new StateStore(dataDir)) {
  return serialize(dataDir, async () => {
    const unlock = await store.lock();
    try { return await task(store); } finally { await unlock(); }
  });
}

// `targets` overrides the scheduled set (used by "Check now"); by default paused items are skipped.
const activity = new Map();
export function checkState(dataDir, target) {
  const states = activity.get(dataDir)?.get(targetKey(target));
  return states?.some(t => t.state === 'checking') ? 'checking' : states?.length ? 'queued' : null;
}

export function runOnce(options) {
  const active = options.targets ?? options.config.identifiers.filter(t => !t.paused);
  const dir = options.config.dataDir;
  if (!activity.has(dir)) activity.set(dir, new Map());
  const map = activity.get(dir);
  const tokens = active.map(target => {
    const key = targetKey(target), token = { key, target, state: 'queued' };
    const states = map.get(key) ?? [];
    states.push(token); map.set(key, states);
    return token;
  });
  const finish = target => {
    const token = tokens.find(t => t.key === targetKey(target));
    token.state = 'done';
    const states = map.get(token.key);
    states.splice(states.indexOf(token), 1);
  };
  return serialize(dir, () => checkTargets({ ...options, targets: active,
    onTarget: target => { tokens.find(t => t.key === targetKey(target)).state = 'checking'; },
    onFinished: finish,
  })).finally(() => {
    for (const token of tokens) {
      if (token.state !== 'done') finish(token.target);
      if (!map.get(token.key)?.length) map.delete(token.key);
    }
    if (!map.size) activity.delete(dir);
  });
}

async function boundedSearch(search, target, timeoutMs) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(() => search(target)), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Search exceeded its ${timeoutMs}ms deadline`)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

async function checkTargets({ config, search, notify, targets, logger = console, store = new StateStore(config.dataDir), now = () => new Date(), searchTimeoutMs = SEARCH_BUDGET_MS + 5000, onTarget = () => {}, onFinished = () => {} }) {
  const report = { ok: true, identifiers: [] };
  const dueFailures = [];
  const active = targets ?? config.identifiers.filter(target => !target.paused);
  if (!active.length) return report;
  let unlock;
  try {
    unlock = await store.lock();
    const state = await store.read();
    for (const target of active) {
      try {
        onTarget(target);
        // Search must finish and validate EVERY page before state can change.
        const entries = await boundedSearch(search, target, searchTimeoutMs);
        if (!Array.isArray(entries) || entries.some(e => !e?.key || !e.date || !Number.isFinite(Date.parse(e.date)))) {
          throw new Error('Search returned invalid parsed entries');
        }
        const key = targetKey(target);
        const latest = entries.map(e => e.date).sort().at(-1) ?? null;
        let tracked = state.targets[key];
        const baselined = !tracked;
        if (baselined) {
          tracked = state.targets[key] = {
            baselineAt: now().toISOString(), baselineDate: latest, latestDate: latest,
            seen: Object.fromEntries(entries.map(e => [e.key, e])), pending: {},
          };
        } else {
          tracked.latestDate = [tracked.latestDate, latest].filter(Boolean).sort().at(-1) ?? null;
          for (const entry of entries) {
            if (!Object.hasOwn(tracked.seen, entry.key)) tracked.pending[entry.key] = entry;
          }
        }
        tracked.lastCheckedAt = now().toISOString();
        // Durable outbox: delivery failures and disappearing results remain retryable.
        await store.write(state);
        let notified = 0;
        for (const entry of Object.values(tracked.pending).sort((a, b) => a.date.localeCompare(b.date))) {
          await notify(entryMessage(target, entry));
          tracked.seen[entry.key] = entry;
          delete tracked.pending[entry.key];
          await store.write(state);
          notified++;
        }
        if (tracked.testPending) { delete tracked.testPending; await store.write(state); }
        await store.recordStatus(key, { checkedAt: tracked.lastCheckedAt, ok: true, count: entries.length, error: null });
        const result = { ...target, baselined, count: entries.length, latestDate: tracked.latestDate, notified };
        report.identifiers.push(result);
        logger.log(`${target.type} ${target.value}: ${baselined ? 'baseline saved' : 'checked'}; ${entries.length} results; latest ${tracked.latestDate ?? 'none'}; ${notified} notifications`);
      } catch (error) {
        const message = `my.gov.ge check failed for ${target.type} ${target.value}: ${safeError(error, config.settings)}`;
        report.ok = false;
        report.identifiers.push({ ...target, error: message });
        const due = await recordCheckFailure({ target, message, store, logger, now });
        if (due) dueFailures.push(due);
      } finally { onFinished(target); }
    }
  } catch (error) {
    report.ok = false;
    logger.error(`my.gov.ge tracker failed: ${safeError(error, config.settings)}`);
    for (const target of active) {
      const targetMessage = `my.gov.ge check failed for ${target.type} ${target.value}: ${safeError(error, config.settings)}`;
      const due = await recordCheckFailure({ target, message: targetMessage, store, logger, now });
      if (due) dueFailures.push(due);
    }
  } finally {
    if (unlock) await unlock();
  }
  if (dueFailures.length) {
    try { await notify(combinedFailureMessage(dueFailures)); }
    catch (error) { logger.error(`Failure notification also failed: ${safeError(error)}`); }
  }
  return report;
}

// Aborting a Waker's signal ends the current sleep early (e.g. after the interval is changed in the UI).
export class Waker {
  constructor() { this.controller = new AbortController(); }
  get signal() { return this.controller.signal; }
  wake() { const old = this.controller; this.controller = new AbortController(); old.abort(); }
}

// `options` may be a function returning fresh options each cycle, so tracked identifiers,
// paused flags, Telegram settings and the interval changed in the UI apply without a restart.
export async function runLoop(options, { signal, sleep = delay, waker, logger = console } = {}) {
  let cycles = 0;
  let last;
  const load = async () => {
    if (typeof options !== 'function') return options;
    try { return last = await options(); }
    catch (error) {
      if (!last) throw error;
      logger.error(`Reloading settings failed; keeping the previous ones: ${safeError(error, last.config?.settings)}`);
      return last;
    }
  };
  while (!signal?.aborted) {
    const current = await load();
    await runOnce(current);
    cycles++;
    if (signal?.aborted) break;
    const endedAt = Date.now();
    let wait = current.config.intervalMinutes * 60000;
    while (!signal?.aborted && wait > 0) {
      const signals = [signal, waker?.signal].filter(Boolean);
      try {
        await sleep(wait, undefined, { signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0] });
        wait = 0;
      } catch (error) {
        if (error.name !== 'AbortError') throw error;
        if (signal?.aborted) break;
        wait = (await load()).config.intervalMinutes * 60000 - (Date.now() - endedAt);
      }
    }
  }
  return cycles;
}
