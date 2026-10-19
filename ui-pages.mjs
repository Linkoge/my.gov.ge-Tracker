import { identifierFormats } from './config.mjs';
import { maskSecret } from './ui-settings.mjs';

export const typeNames = Object.freeze({
  cadastral: { en: 'Cadastral code', ka: 'საკადასტრო კოდი', example: '01.14.16.007.381' },
  id: { en: 'Personal ID number', ka: 'პირადი ნომერი', example: '01234567890' },
  registration: { en: 'Application number', ka: 'განცხადების ნომერი', example: '882022123456' },
});

export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const when = iso => iso ? escapeHtml(String(iso).replace('T', ' ').replace(/(?::\d{2})?(?:\.\d+)?Z$/, ' UTC')) : '—';

const css = `
body{font:15px/1.5 system-ui,sans-serif;margin:0;background:#f5f6f8;color:#1c2330}
header{background:#1c2b45;color:#fff;padding:12px 24px;display:flex;gap:24px;align-items:baseline}
header h1{font-size:18px;margin:0}header a{color:#cfe0ff;text-decoration:none}header a.on{color:#fff;font-weight:600;text-decoration:underline}
main{max-width:1100px;margin:24px auto;padding:0 16px}
.card{background:#fff;border:1px solid #d9dde4;border-radius:8px;padding:16px;margin-bottom:16px}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px;border-bottom:1px solid #e6e9ee;vertical-align:top}
th{font-size:12px;text-transform:uppercase;color:#5b6577}
.badge{padding:2px 8px;border-radius:10px;font-size:12px;background:#dff3e4;color:#17602b}.badge.paused{background:#fff0cf;color:#7a5200}.badge.busy{background:#dbe8ff;color:#1f4a99}
.err{color:#a11d1d}.ok{color:#17602b}.muted{color:#5b6577;font-size:13px}
.flash{padding:10px 14px;border-radius:6px;margin-bottom:16px}.flash.ok{background:#dff3e4}.flash.error{background:#fde3e3;color:#a11d1d}
form.inline{display:inline}button{font:inherit;padding:4px 10px;border:1px solid #9aa4b5;border-radius:5px;background:#fff;cursor:pointer}
button.primary{background:#1f4a99;color:#fff;border-color:#1f4a99}button.danger{color:#a11d1d;border-color:#d99}
label{display:block;margin:10px 0 2px;font-weight:600}input[type=text],input[type=password],input[type=number]{width:100%;max-width:420px;padding:6px 8px;border:1px solid #9aa4b5;border-radius:5px;font:inherit;box-sizing:border-box}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px}.grid .card{margin:0}
`;

export function layout({ title, active, body, flash, refresh = false }) {
  const link = (href, name, key) => `<a href="${href}"${active === key ? ' class="on"' : ''}>${name}</a>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)} – my.gov.ge tracker</title>
<meta name="viewport" content="width=device-width,initial-scale=1">${refresh ? '<meta http-equiv="refresh" content="3">' : ''}
<style>${css}</style></head><body><header><h1>my.gov.ge tracker</h1>${link('/', 'Trackings', 'list')}${link('/new', 'New tracking', 'new')}${link('/settings', 'Settings', 'settings')}</header>
<main>${flash ? `<div class="flash ${flash.kind}">${escapeHtml(flash.text)}</div>` : ''}${body}</main></body></html>`;
}

const post = (csrf, action, fields, label, cls = '') =>
  `<form class="inline" method="post" action="${action}"><input type="hidden" name="_csrf" value="${csrf}">` +
  Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(v)}">`).join('') +
  `<button${cls ? ` class="${cls}"` : ''}>${label}</button></form>`;

export function trackingsPage({ rows, csrf, problem }) {
  const body = rows.length ? `<div class="card"><table><thead><tr><th>Identifier</th><th>Status</th><th>Last check</th><th>Last result</th><th>Latest entry</th><th>Results</th><th>Actions</th></tr></thead><tbody>${rows.map(r => {
    const names = typeNames[r.type];
    const fields = { type: r.type, value: r.value };
    const state = r.running ? '<span class="badge busy">checking…</span>' : r.paused ? '<span class="badge paused">paused</span>' : '<span class="badge">active</span>';
    const result = !r.check ? '<span class="muted">not checked yet</span>'
      : r.check.ok ? '<span class="ok">OK</span>' : `<span class="err">${escapeHtml(r.check.error)}</span>`;
    return `<tr><td><strong>${escapeHtml(r.label || r.value)}</strong><div class="muted">${names.en} (${names.ka})<br>${r.label ? escapeHtml(r.value) : ''}</div></td>
<td>${state}</td><td>${when(r.check?.checkedAt)}</td><td>${result}</td><td>${when(r.latestDate)}</td><td>${r.count ?? '—'}</td>
<td>${post(csrf, '/track/check', fields, 'Check now')} ${post(csrf, r.paused ? '/track/resume' : '/track/pause', fields, r.paused ? 'Resume' : 'Pause')}
<form class="inline" method="get" action="/track/delete"><input type="hidden" name="type" value="${r.type}"><input type="hidden" name="value" value="${escapeHtml(r.value)}"><button class="danger">Delete</button></form></td></tr>`;
  }).join('')}</tbody></table></div>` : '<div class="card">Nothing is tracked yet. <a href="/new">Add a tracking</a>.</div>';
  return `${problem ? `<div class="flash error">${escapeHtml(problem)}</div>` : ''}<h2>Current trackings</h2>${body}
<p class="muted">Paused items are skipped by the scheduler. “Check now” also works on paused items.</p>`;
}

export function newPage({ csrf, values = {}, error }) {
  const forms = Object.entries(typeNames).map(([type, n]) => `<div class="card"><h3>${n.en}<br><span class="muted">${n.ka}</span></h3>
<form method="post" action="/track/add"><input type="hidden" name="_csrf" value="${csrf}"><input type="hidden" name="type" value="${type}">
<label for="v-${type}">${n.en}</label><input type="text" id="v-${type}" name="value" required maxlength="40" placeholder="${n.example}" value="${escapeHtml(values.type === type ? values.value : '')}" autocomplete="off">
<div class="muted">Expected: ${identifierFormats[type].hint}</div>
<label for="l-${type}">Label (optional)</label><input type="text" id="l-${type}" name="label" maxlength="100" value="${escapeHtml(values.type === type ? values.label : '')}">
<p><button class="primary">Add and run baseline check</button></p></form></div>`).join('');
  return `${error ? `<div class="flash error">${escapeHtml(error)}</div>` : ''}<h2>New tracking</h2>
<p class="muted">The first check saves the current results as the baseline without sending an alert.</p><div class="grid">${forms}</div>`;
}

export function deletePage({ csrf, target }) {
  const n = typeNames[target.type];
  return `<h2>Delete tracking?</h2><div class="card"><p><strong>${escapeHtml(target.label || target.value)}</strong> — ${n.en} ${escapeHtml(target.value)}</p>
<p>Its saved baseline and history are removed. Adding it again later starts a new silent baseline.</p>
${post(csrf, '/track/delete', { type: target.type, value: target.value }, 'Delete permanently', 'danger')} <a href="/">Cancel</a></div>`;
}

export function settingsPage({ csrf, view }) {
  const token = view.token.value;
  return `<h2>Settings</h2><div class="card"><form method="post" action="/settings"><input type="hidden" name="_csrf" value="${csrf}">
<label for="tg">Telegram bot token</label><input type="password" id="tg" name="telegramBotToken" autocomplete="off" placeholder="${token ? 'leave empty to keep the current token' : 'not set'}">
<div class="muted">Current: ${token ? `${escapeHtml(maskSecret(token))} (${view.token.source})` : 'not set'}</div>
<label for="chat">Telegram chat ID</label><input type="text" id="chat" name="telegramChatId" autocomplete="off" value="${escapeHtml(view.chatId.value)}">
<div class="muted">Source: ${view.chatId.source}. Set both token and chat ID, or neither (alerts then go to the console).</div>
<label for="iv">Check interval (minutes)</label><input type="number" id="iv" name="intervalMinutes" min="1" max="10080" step="1" value="${escapeHtml(view.intervalMinutes.value)}">
<div class="muted">Source: ${view.intervalMinutes.source}. Applied by the running scheduler without a restart.</div>
<label><input type="checkbox" name="clearTelegram" value="1"> Remove Telegram values saved in the UI</label>
<p><button class="primary">Save settings</button></p></form></div>
<div class="card"><h3>Telegram test</h3><p class="muted">Sends a message using the saved settings.</p>${post(csrf, '/settings/test', {}, 'Send test message')}</div>`;
}
