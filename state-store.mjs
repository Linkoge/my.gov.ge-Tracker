import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

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

  async write(state) {
    const temporary = join(this.dataDir, `.tracker-${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`);
      await handle.sync();
    } finally { await handle.close(); }
    try { await rename(temporary, this.path); }
    finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
}

const isMap = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
const nullableDate = value => value === null || validDate(value);
