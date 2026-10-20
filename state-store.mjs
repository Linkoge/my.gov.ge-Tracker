import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Latest date stored when a rewind leaves no entries at all.
export const REWIND_EMPTY_DATE = '2012-01-01T00:00:00.000Z';

export const targetKey = target => JSON.stringify([target.type, target.value]);

export class StateStore {
  constructor(dataDir) { this.dataDir = dataDir; this.path = join(dataDir, 'tracker-state.json'); }

  async lock() {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const path = join(this.dataDir, 'tracker.lock');
    let handle;
    try { handle = await open(path, 'wx', 0o600); }
    catch (error) {
      if (error.code === 'EEXIST') throw new Error('Tracker data directory is locked; another check may be running (see README for stale locks)');
      throw error;
    }
    try { await handle.writeFile(`${process.pid}\n`); }
    catch (error) { await handle.close(); await unlink(path); throw error; }
    return async () => { await handle.close(); await unlink(path); };
  }

  async read() {
    let state;
    try { state = JSON.parse(await readFile(this.path, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return { version: 1, targets: {} };
      throw new Error('Cannot read tracker state; restore the data file instead of resetting the baseline');
    }
    if (state?.version !== 1 || !isMap(state.targets) || Object.values(state.targets).some(t =>
      !t || !validDate(t.baselineAt) || !nullableDate(t.baselineDate) || !nullableDate(t.latestDate) ||
      !isMap(t.seen) || !isMap(t.pending) || [...Object.entries(t.seen), ...Object.entries(t.pending)].some(([k, e]) =>
        !e || e.key !== k || !validDate(e.date)))) {
      throw new Error('Invalid tracker state; restore the data file instead of resetting the baseline');
    }
    return state;
  }

  async write(state) { await this.writeJson(this.path, state); }

  async writeJson(path, data) {
    const temporary = join(this.dataDir, `.tracker-${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`);
      await handle.sync();
    } finally { await handle.close(); }
    try { await rename(temporary, path); }
    finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }

  // Drops a deleted identifier's baseline and last-check record; the caller holds the lock.
  async forget(key) {
    const state = await this.read();
    if (Object.hasOwn(state.targets, key)) { delete state.targets[key]; await this.write(state); }
    const status = await this.readStatus();
    if (Object.hasOwn(status, key)) { delete status[key]; await this.writeJson(join(this.dataDir, 'check-status.json'), status); }
  }

  // Test mode: forgets the newest saved entry(ies) (all sharing the newest date) so the next check sees them as new
  // and sends the normal notification. Never re-captures a baseline; the caller holds the lock.
  // Returns { status: 'ok'|'no-baseline'|'already-pending'|'nothing-saved', removed, latestDate }.
  async rewindBaseline(key) {
    const state = await this.read();
    const tracked = state.targets[key];
    if (!tracked) return { status: 'no-baseline', removed: 0 };
    if (tracked.testPending) return { status: 'already-pending', removed: 0 };
    const newest = Object.values(tracked.seen).map(e => e.date).sort().at(-1);
    if (!newest) return { status: 'nothing-saved', removed: 0 };
    let removed = 0;
    for (const [k, e] of Object.entries(tracked.seen)) {
      if (e.date === newest) { delete tracked.seen[k]; removed++; }
    }
    const remaining = [...Object.values(tracked.seen), ...Object.values(tracked.pending)].map(e => e.date).sort().at(-1);
    tracked.latestDate = remaining ?? REWIND_EMPTY_DATE;
    tracked.testPending = true;
    await this.write(state);
    return { status: 'ok', removed, latestDate: tracked.latestDate };
  }

  // Display-only record of the latest check per identifier (time, result count, error).
  // Kept apart from the baseline history so a failed check never touches tracker-state.json.
  async readStatus() {
    try {
      const status = JSON.parse(await readFile(join(this.dataDir, 'check-status.json'), 'utf8'));
      return isMap(status) ? status : {};
    } catch { return {}; }
  }

  async recordStatus(key, entry) {
    const status = await this.readStatus();
    status[key] = entry;
    await this.writeJson(join(this.dataDir, 'check-status.json'), status);
  }
}

const isMap = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
const nullableDate = value => value === null || validDate(value);
