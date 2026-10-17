import { resolve } from 'node:path';
import { loadEnvironment, loadTrackerConfig } from './config.mjs';
import { safeError } from './notifications.mjs';
import { loginWithCredentials, openBrowserContext, SERVICE_URL } from './registry.mjs';
import { StateStore } from './state-store.mjs';

// Shares the tracker's profile, selectors and data-directory lock. A one-time
// code can be entered interactively; unattended checks never wait for stdin.
let context;
let unlock;
let settings = {};
try {
  settings = await loadEnvironment();
  const config = await loadTrackerConfig({ configPath: process.argv[2] ? resolve(process.argv[2]) : undefined, settings });
  unlock = await new StateStore(config.dataDir).lock();
  context = await openBrowserContext(config);
  const page = context.pages()[0] ?? await context.newPage();
  await loginWithCredentials(page, {
    ...config,
    getCode: () => new Promise((resolveCode, reject) => {
      console.log('Enter verification code (60 second timeout):');
      const timer = setTimeout(() => { process.stdin.off('data', read); process.stdin.pause(); reject(new Error('Verification code input timed out')); }, 60000);
      const read = chunk => { clearTimeout(timer); process.stdin.pause(); resolveCode(String(chunk).trim()); };
      process.stdin.once('data', read);
      process.stdin.resume();
    }),
  });
  await page.goto(SERVICE_URL, { waitUntil: 'domcontentloaded' });
  console.log('Login completed; browser session saved in the configured data directory.');
} catch (error) {
  console.error(safeError(error, settings));
  process.exitCode = 1;
} finally {
  if (context) await context.close();
  if (unlock) await unlock();
}
