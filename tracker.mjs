import { parseArgs } from 'node:util';
import { loadEnvironment, loadTrackerConfig } from './config.mjs';
import { createNotifier, safeError } from './notifications.mjs';
import { searchRegistry } from './registry.mjs';
import { reportFailure, runLoop, runOnce } from './tracking.mjs';

let notify = async message => console.error(message);
let settings = {};
try {
  settings = await loadEnvironment();
  notify = createNotifier(settings);
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { config: { type: 'string' }, 'data-dir': { type: 'string' }, 'interval-minutes': { type: 'string' }, help: { type: 'boolean' } },
  });
  if (values.help) {
    console.log('Usage: node tracker.mjs once|loop [--config tracked.json] [--data-dir PATH] [--interval-minutes 60]');
  } else {
    const [mode] = positionals;
    if (positionals.length !== 1 || !['once', 'loop'].includes(mode)) throw new Error('Specify once or loop; use --help for usage');
    const config = await loadTrackerConfig({
      configPath: values.config, dataDir: values['data-dir'], intervalMinutes: values['interval-minutes'], settings,
    });
    const options = { config, notify, search: target => searchRegistry(target, config) };
    if (mode === 'once') {
      if (!(await runOnce(options)).ok) process.exitCode = 1;
    } else {
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      try { await runLoop(options, { signal: controller.signal }); }
      finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
    }
  }
} catch (error) {
  await reportFailure(`my.gov.ge tracker failed: ${safeError(error, settings)}`, { notify });
  process.exitCode = 1;
}
