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

export const defaultConfigPath = resolve(root, 'tracked.json');

// Basic per-type shapes enforced when the UI adds an identifier. tracked.json stays lenient.
export const identifierFormats = Object.freeze({
  cadastral: { pattern: /^\d{2}\.\d{2}\.\d{2}\.\d{3}\.\d{3}(?:\.\d{2,3}){0,2}$/, hint: 'like 01.14.16.007.381' },
  id: { pattern: /^(?:\d{9}|\d{11})$/, hint: '11 digits (9 for an organization)' },
  registration: { pattern: /^[0-9A-Za-z][0-9A-Za-z/-]{4,24}$/, hint: '5-25 letters, digits, "-" or "/"' },
});

export function validateIdentifierInput(type, value) {
  if (!Object.hasOwn(identifierFormats, type)) throw new Error('Unknown identifier type');
  const text = typeof value === 'string' ? value.trim() : '';
  if (!identifierFormats[type].pattern.test(text)) throw new Error(`Invalid ${type} value; expected ${identifierFormats[type].hint}`);
  return text;
}

export function parseInterval(value) {
  const interval = Number(value);
  if (!Number.isFinite(interval) || interval <= 0 || interval > 10080) throw new Error('intervalMinutes must be > 0 and <= 10080');
  return interval;
}

export function validateTargets(targets, { allowEmpty = false } = {}) {
  if (!Array.isArray(targets) || (!targets.length && !allowEmpty)) throw new Error('identifiers must be a nonempty array');
  const keys = new Set();
  return targets.map(target => {
    if (!target || !Object.hasOwn(identifierFields, target.type) || typeof target.value !== 'string' || !target.value.trim()) {
      throw new Error('Each identifier needs type cadastral, id or registration and a nonempty string value');
    }
    const result = { type: target.type, value: target.value.trim() };
    if (target.label !== undefined && target.label !== '') {
      if (typeof target.label !== 'string' || target.label.length > 100) throw new Error('label must be a string of at most 100 characters');
      if (target.label.trim()) result.label = target.label.trim();
    }
    if (target.paused !== undefined) {
      if (typeof target.paused !== 'boolean') throw new Error('paused must be true or false');
      if (target.paused) result.paused = true;
    }
    const key = JSON.stringify([result.type, result.value]);
    if (keys.has(key)) throw new Error('Duplicate tracked identifier');
    keys.add(key);
    return result;
  });
}

export async function loadTrackerConfig({ configPath = defaultConfigPath, settings, dataDir, intervalMinutes, allowEmpty = false } = {}) {
  settings ??= await loadEnvironment();
  let input;
  try { input = JSON.parse(await readFile(configPath, 'utf8')); }
  catch (error) {
    // The UI creates tracked.json on first use, so a missing file just means nothing is tracked yet.
    if (allowEmpty && error.code === 'ENOENT') input = { identifiers: [] };
    else throw new Error('Unable to read tracker configuration JSON; use --config tracked.example.json or create tracked.json');
  }
  if (!input || typeof input !== 'object') throw new Error('Tracker configuration must be an object');
  const interval = parseInterval(intervalMinutes ?? (settings.TRACKER_INTERVAL_MINUTES || (input.intervalMinutes ?? 60)));
  const timeoutMs = Number(settings.TRACKER_TIMEOUT_MS || (input.timeoutMs ?? 15000));
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error('timeoutMs must be > 0 and <= 60000');
  return {
    identifiers: validateTargets(input.identifiers, { allowEmpty }), intervalMinutes: interval, timeoutMs,
    dataDir: resolve(dataDir ?? (settings.TRACKER_DATA_DIR || input.dataDir || resolve(root, 'data'))),
    chromePath: settings.CHROME_PATH || '/usr/bin/google-chrome', settings,
  };
}
