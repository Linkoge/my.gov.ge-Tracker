export function safeError(error, settings = {}) {
  let message = String(error?.message ?? error).split('\n')[0];
  for (const name of ['MYGOV_LOGIN_ID', 'MYGOV_PASSWORD', 'MYGOV_VERIFICATION_CODE', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']) {
    if (settings[name]) message = message.split(settings[name]).join('[redacted]');
  }
  return message;
}

export function createNotifier(settings = {}, { fetchImpl = fetch, logger = console, timeoutMs = 15000 } = {}) {
  const token = settings.TELEGRAM_BOT_TOKEN;
  const chat = settings.TELEGRAM_CHAT_ID;
  if (Boolean(token) !== Boolean(chat)) throw new Error('Set both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID, or leave both empty');
  return async message => {
    if (!token && !chat) { logger.log(message); return; }
    // Plain text avoids Telegram interpreting registry content as formatting.
    try {
      const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text: message.slice(0, 4000) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if ((await response.json()).ok !== true) throw new Error('API rejected message');
    } catch (error) {
      throw new Error(`Telegram notification failed: ${safeError(error, settings)}`);
    }
  };
}

export function entryMessage(target, entry) {
  return `my.gov.ge update: ${target.type} ${target.value}\n${entry.date}\n${entry.description}\n${entry.status}\n` +
    `Application: ${entry.registrationNumber ?? entry.applicationId ?? 'unknown'}` +
    (entry.documentId ? `\nDocument: ${entry.documentId}` : '') +
    '\nhttps://www.my.gov.ge/ka-ge/services/10/service/176';
}
