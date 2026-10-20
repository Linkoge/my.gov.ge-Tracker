import { parseArgs } from 'node:util';
import { DEFAULT_UI_PORT, createApp } from './ui-server.mjs';
import { loadEnvironment } from './config.mjs';
import { safeError } from './notifications.mjs';

const usage = 'Usage: node ui.mjs [--port 8790] [--host 127.0.0.1] [--public-origin https://host:port] [--config tracked.json] [--data-dir PATH] [--no-scheduler]';
try {
  const { values } = parseArgs({ options: {
    port: { type: 'string' }, host: { type: 'string' }, config: { type: 'string' }, 'data-dir': { type: 'string' }, 'public-origin': { type: 'string' },
    'no-scheduler': { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) { console.log(usage); }
  else {
    const env = await loadEnvironment();
    const port = Number(values.port ?? (env.TRACKER_UI_PORT || DEFAULT_UI_PORT));
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');
    // Playwright is only needed for real searches, so load the registry module lazily.
    const { searchRegistry } = await import('./registry.mjs');
    const app = createApp({
      search: searchRegistry, host: values.host ?? (env.TRACKER_UI_HOST || '127.0.0.1'), port,
      configPath: values.config, dataDir: values['data-dir'],
      publicOrigin: values['public-origin'] ?? env.TRACKER_PUBLIC_ORIGIN,
    });
    await app.listen();
    console.log(`my.gov.ge tracker UI: ${app.url}`);
    if (app.publicOrigin) console.log(`Also accepting the private proxy origin ${app.publicOrigin}`);
    const controller = new AbortController();
    const stop = () => { controller.abort(); app.close(); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    if (values['no-scheduler']) console.log('Scheduler disabled; only manual "Check now" runs checks.');
    else await app.startScheduler(controller.signal);
  }
} catch (error) {
  console.error(`my.gov.ge tracker UI failed: ${safeError(error)}`);
  process.exitCode = 1;
}
