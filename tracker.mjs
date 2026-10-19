import { parseArgs } from 'node:util';
import { loadEnvironment } from './config.mjs';
import { loadRuntime } from './runtime.mjs';
import { createNotifier, safeError } from './notifications.mjs';
import { searchRegistry } from './registry.mjs';
import { reportFailure, runLoop, runOnce } from './tracking.mjs';

let notify = async message => console.error(message);
let settings = {};
try {
  settings = await loadEnvironment();
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { config: { type: 'string' }, 'data-dir': { type: 'string' }, 'interval-minutes': { type: 'string' }, help: { type: 'boolean' } },
  });
  if (values.help) {
    console.log('Usage: node tracker.mjs once|loop [--config tracked.json] [--data-dir PATH] [--interval-minutes 60]');
  } else {
    const [mode] = positionals;
    if (positionals.length !== 1 || !['once', 'loop'].includes(mode)) throw new Error('Specify once or loop; use --help for usage');
    // Settings saved in the web UI override the environment; the loop re-reads them every cycle.
    // The first load is strict (missing/empty config is an error); later cycles may find everything deleted in the UI.
    let started = false;
    const load = async () => {
      const config = await loadRuntime({
        configPath: values.config, dataDir: values['data-dir'], intervalMinutes: values['interval-minutes'], allowEmpty: started,
      });
      started = true;
      settings = config.settings;
      notify = createNotifier(config.settings);
      return { config, notify, search: target => searchRegistry(target, config) };
    };
    if (mode === 'once') {
      if (!(await runOnce(await load())).ok) process.exitCode = 1;
    } else {
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      try { await runLoop(load, { signal: controller.signal }); }
      finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
    }
  }
} catch (error) {
  await reportFailure(`my.gov.ge tracker failed: ${safeError(error, settings)}`, { notify });
  process.exitCode = 1;
}
