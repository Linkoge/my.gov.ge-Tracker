import { setTimeout as delay } from 'node:timers/promises';
import { StateStore, targetKey } from './state-store.mjs';
import { entryMessage, safeError } from './notifications.mjs';

export async function reportFailure(message, { notify, logger = console }) {
  logger.error(message);
  try { await notify(message); }
  catch (error) { logger.error(`Failure notification also failed: ${safeError(error)}`); }
}

const FAILURE_DELAY_MS = 24 * 60 * 60 * 1000;

async function recordCheckFailure({ target, message, store, notify, logger, now }) {
  const key = targetKey(target);
  const time = now().toISOString();
  const previous = (await store.readStatus())[key];
  const failureSince = previous?.failureSince ?? time;
  const lastFailureNotifiedAt = previous?.lastFailureNotifiedAt;
  const due = Date.parse(time) - Date.parse(failureSince) >= FAILURE_DELAY_MS &&
    (!lastFailureNotifiedAt || Date.parse(time) - Date.parse(lastFailureNotifiedAt) >= FAILURE_DELAY_MS);
  await store.recordStatus(key, {
    checkedAt: time, ok: false, count: previous?.count ?? null, error: message,
    failureSince, ...(lastFailureNotifiedAt ? { lastFailureNotifiedAt } : {}),
    ...(due ? { lastFailureNotifiedAt: time } : {}),
  }).catch(() => {});
  logger.error(message);
  if (due) {
    try { await notify(message); }
    catch (error) { logger.error(`Failure notification also failed: ${safeError(error)}`); }
  }
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
export function runOnce(options) {
  return serialize(options.config.dataDir, () => checkTargets(options));
}

async function checkTargets({ config, search, notify, targets, logger = console, store = new StateStore(config.dataDir), now = () => new Date() }) {
  const report = { ok: true, identifiers: [] };
  const active = targets ?? config.identifiers.filter(target => !target.paused);
  if (!active.length) return report;
  let unlock;
  try {
    unlock = await store.lock();
    const state = await store.read();
    for (const target of active) {
      try {
        // Search must finish and validate EVERY page before state can change.
        const entries = await search(target);
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
        await store.recordStatus(key, { checkedAt: tracked.lastCheckedAt, ok: true, count: entries.length, error: null }).catch(() => {});
        const result = { ...target, baselined, count: entries.length, latestDate: tracked.latestDate, notified };
        report.identifiers.push(result);
        logger.log(`${target.type} ${target.value}: ${baselined ? 'baseline saved' : 'checked'}; ${entries.length} results; latest ${tracked.latestDate ?? 'none'}; ${notified} notifications`);
      } catch (error) {
        const message = `my.gov.ge check failed for ${target.type} ${target.value}: ${safeError(error, config.settings)}`;
        report.ok = false;
        report.identifiers.push({ ...target, error: message });
        await recordCheckFailure({ target, message, store, notify, logger, now });
      }
    }
  } catch (error) {
    report.ok = false;
    const message = `my.gov.ge tracker failed: ${safeError(error, config.settings)}`;
    report.ok = false;
    for (const target of active) {
      const targetMessage = `my.gov.ge check failed for ${target.type} ${target.value}: ${safeError(error, config.settings)}`;
      await recordCheckFailure({ target, message: targetMessage, store, notify, logger, now });
    }
  } finally {
    if (unlock) await unlock();
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
