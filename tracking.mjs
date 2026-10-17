import { setTimeout as delay } from 'node:timers/promises';
import { StateStore, targetKey } from './state-store.mjs';
import { entryMessage, safeError } from './notifications.mjs';

export async function reportFailure(message, { notify, logger = console }) {
  logger.error(message);
  try { await notify(message); }
  catch (error) { logger.error(`Failure notification also failed: ${safeError(error)}`); }
}

export async function runOnce({ config, search, notify, logger = console, store = new StateStore(config.dataDir), now = () => new Date() }) {
  const report = { ok: true, identifiers: [] };
  let unlock;
  try {
    unlock = await store.lock();
    const state = await store.read();
    for (const target of config.identifiers) {
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
        const result = { ...target, baselined, count: entries.length, latestDate: tracked.latestDate, notified };
        report.identifiers.push(result);
        logger.log(`${target.type} ${target.value}: ${baselined ? 'baseline saved' : 'checked'}; ${entries.length} results; latest ${tracked.latestDate ?? 'none'}; ${notified} notifications`);
      } catch (error) {
        const message = `my.gov.ge check failed for ${target.type} ${target.value}: ${safeError(error, config.settings)}`;
        report.ok = false;
        report.identifiers.push({ ...target, error: message });
        await reportFailure(message, { notify, logger });
      }
    }
  } catch (error) {
    report.ok = false;
    await reportFailure(`my.gov.ge tracker failed: ${safeError(error, config.settings)}`, { notify, logger });
  } finally {
    if (unlock) await unlock();
  }
  return report;
}

export async function runLoop(options, { signal, sleep = delay } = {}) {
  let cycles = 0;
  while (!signal?.aborted) {
    await runOnce(options);
    cycles++;
    if (signal?.aborted) break;
    try { await sleep(options.config.intervalMinutes * 60000, undefined, { signal }); }
    catch (error) { if (error.name !== 'AbortError') throw error; }
  }
  return cycles;
}
