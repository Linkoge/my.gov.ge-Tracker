import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function loadEnvironment({ env = process.env, envPath = env.TRACKER_ENV_FILE || new URL('./.env', import.meta.url) } = {}) {
  let local = {};
  try {
    local = parseEnv(await readFile(envPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Unable to read local .env configuration');
  }
  return { ...local, ...env };
}

// Resolve beside the application so invocation from another directory is safe.
export async function loadLoginConfig({
  env = process.env,
  envPath = env.TRACKER_ENV_FILE || new URL('./.env', import.meta.url),
} = {}) {
  const settings = await loadEnvironment({ env, envPath });
  const loginId = settings.MYGOV_LOGIN_ID;
  const password = settings['MYGOV_PASSWORD'];
  const missing = [
    !loginId && 'MYGOV_LOGIN_ID',
    !password && 'MYGOV_PASSWORD',
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(`Set ${missing.join(', ')} in the environment or local .env`);
  }
  return { loginId, password };
}

const root = dirname(fileURLToPath(import.meta.url));
export const identifierFields = Object.freeze({ cadastral: 'cadcode', id: 'person', registration: 'regno' });

export function validateTargets(targets) {
  if (!Array.isArray(targets) || !targets.length) throw new Error('identifiers must be a nonempty array');
  const keys = new Set();
  return targets.map(target => {
    if (!target || !Object.hasOwn(identifierFields, target.type) || typeof target.value !== 'string' || !target.value.trim()) {
      throw new Error('Each identifier needs type cadastral, id or registration and a nonempty string value');
    }
    const result = { type: target.type, value: target.value.trim() };
    const key = JSON.stringify([result.type, result.value]);
    if (keys.has(key)) throw new Error('Duplicate tracked identifier');
    keys.add(key);
    return result;
  });
}

export async function loadTrackerConfig({ configPath = resolve(root, 'tracked.json'), settings, dataDir, intervalMinutes } = {}) {
  settings ??= await loadEnvironment();
  let input;
  try { input = JSON.parse(await readFile(configPath, 'utf8')); }
  catch { throw new Error('Unable to read tracker configuration JSON; use --config tracked.example.json or create tracked.json'); }
  if (!input || typeof input !== 'object') throw new Error('Tracker configuration must be an object');
  const interval = Number(intervalMinutes ?? (settings.TRACKER_INTERVAL_MINUTES || (input.intervalMinutes ?? 60)));
  const timeoutMs = Number(settings.TRACKER_TIMEOUT_MS || (input.timeoutMs ?? 15000));
  if (!Number.isFinite(interval) || interval <= 0 || interval > 10080) throw new Error('intervalMinutes must be > 0 and <= 10080');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error('timeoutMs must be > 0 and <= 60000');
  return {
    identifiers: validateTargets(input.identifiers), intervalMinutes: interval, timeoutMs,
    dataDir: resolve(dataDir ?? (settings.TRACKER_DATA_DIR || input.dataDir || resolve(root, 'data'))),
    chromePath: settings.CHROME_PATH || '/usr/bin/google-chrome', settings,
  };
}
