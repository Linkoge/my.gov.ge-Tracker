import { loadEnvironment, loadTrackerConfig } from './config.mjs';
import { SettingsStore, applyUiSettings } from './ui-settings.mjs';

// Effective configuration: tracked.json / environment / .env, then values saved in the UI.
// Precedence for Telegram token, chat ID and interval: UI-saved > environment > .env > tracked.json > default.
export async function loadRuntime({ env = process.env, envPath, configPath, dataDir, intervalMinutes, allowEmpty = false } = {}) {
  const settings = await loadEnvironment(envPath ? { env, envPath } : { env });
  const config = await loadTrackerConfig({ configPath, dataDir, intervalMinutes, settings, allowEmpty });
  const ui = await new SettingsStore(config.dataDir).read();
  config.settings = applyUiSettings(settings, ui);
  if (ui.intervalMinutes) config.intervalMinutes = ui.intervalMinutes;
  config.ui = ui;
  config.baseSettings = settings;
  return config;
}

// What the settings page shows: the same values the scheduler uses, with their source.
export function describeSettings(config) {
  const { settings, ui } = config;
  const from = (uiValue, envValue) => uiValue ? 'saved in the UI' : envValue ? 'environment / .env' : 'not set';
  return {
    token: { value: settings.TELEGRAM_BOT_TOKEN || '', source: from(ui.telegramBotToken, settings.TELEGRAM_BOT_TOKEN) },
    chatId: { value: settings.TELEGRAM_CHAT_ID || '', source: from(ui.telegramChatId, settings.TELEGRAM_CHAT_ID) },
    intervalMinutes: {
      value: config.intervalMinutes,
      source: ui.intervalMinutes ? 'saved in the UI' : settings.TRACKER_INTERVAL_MINUTES ? 'environment / .env' : 'tracked.json / default',
    },
  };
}
