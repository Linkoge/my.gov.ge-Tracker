import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseInterval } from './config.mjs';

// Settings saved from the web UI live in the (git-ignored) data directory.
// When present they take precedence over environment variables and .env.
const BOT = /^[A-Za-z0-9:_-]{5,200}$/;
const CHAT = /^(?:-?\d{1,20}|@[A-Za-z0-9_]{5,32})$/;

export function validateUiSettings(input) {
  const result = {};
  if (input.telegramBotToken) {
    if (!BOT.test(input.telegramBotToken)) throw new Error('Telegram bot token has an invalid format');
    result.telegramBotToken = input.telegramBotToken;
  }
  if (input.telegramChatId) {
    if (!CHAT.test(input.telegramChatId)) throw new Error('Telegram chat ID must be a number (or @channelname)');
    result.telegramChatId = input.telegramChatId;
  }
  if (input.intervalMinutes !== undefined && input.intervalMinutes !== null && input.intervalMinutes !== '') {
    const minutes = Number(input.intervalMinutes);
    if (!Number.isInteger(minutes)) throw new Error('Check interval must be a whole number of minutes');
    result.intervalMinutes = parseInterval(minutes);
  }
  return result;
}

export class SettingsStore {
  constructor(dataDir) { this.dataDir = dataDir; this.path = join(dataDir, 'ui-settings.json'); }

  async read() {
    let input;
    try { input = JSON.parse(await readFile(this.path, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return {};
      throw new Error('Cannot read saved UI settings file; fix or remove it in the data directory');
    }
    return validateUiSettings(input ?? {});
  }

  async write(settings) {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const temporary = join(this.dataDir, `.ui-settings-${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify({ version: 1, ...validateUiSettings(settings) }, null, 2)}\n`);
      await handle.sync();
    } finally { await handle.close(); }
    try { await rename(temporary, this.path); }
    finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
}

// Environment-style settings with UI-saved values layered on top.
export function applyUiSettings(settings, ui = {}) {
  const merged = { ...settings };
  if (ui.telegramBotToken) merged.TELEGRAM_BOT_TOKEN = ui.telegramBotToken;
  if (ui.telegramChatId) merged.TELEGRAM_CHAT_ID = ui.telegramChatId;
  if (ui.intervalMinutes) merged.TRACKER_INTERVAL_MINUTES = String(ui.intervalMinutes);
  return merged;
}

export function maskSecret(value) {
  if (!value) return '';
  return value.length >= 12 ? `${'•'.repeat(8)}${value.slice(-4)}` : '•'.repeat(8);
}
