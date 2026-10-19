import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateTargets } from './config.mjs';

// The tracked identifiers stay in tracked.json (the existing configuration file);
// the UI only edits its `identifiers` list and keeps all other keys.
export class TargetsStore {
  constructor(path) { this.path = path; this.queue = Promise.resolve(); }

  async readRaw() {
    let input;
    try { input = JSON.parse(await readFile(this.path, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return { identifiers: [] };
      throw new Error('Unable to read tracker configuration JSON');
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Tracker configuration must be an object');
    return input;
  }

  async list() { return validateTargets((await this.readRaw()).identifiers ?? [], { allowEmpty: true }); }

  // Serialized read-modify-write; `change` receives and returns the identifier list.
  update(change) {
    const run = this.queue.then(async () => {
      const raw = await this.readRaw();
      const identifiers = validateTargets(change(validateTargets(raw.identifiers ?? [], { allowEmpty: true })), { allowEmpty: true });
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = join(dirname(this.path), `.tracked-${randomUUID()}.tmp`);
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({ ...raw, identifiers }, null, 2)}\n`);
        await handle.sync();
      } finally { await handle.close(); }
      try { await rename(temporary, this.path); }
      finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      return identifiers;
    });
    this.queue = run.catch(() => {});
    return run;
  }
}
