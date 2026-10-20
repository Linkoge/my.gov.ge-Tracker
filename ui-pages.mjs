import { identifierFormats } from './config.mjs';
import { maskSecret } from './ui-settings.mjs';

export const typeNames = Object.freeze({
  cadastral: { en: 'Cadastral code', ka: 'საკადასტრო კოდი', example: '82.01.44.932 or 01.14.16.007.381' },
  id: { en: 'Personal ID number', ka: 'პირადი ნომერი', example: '01234567890' },
  registration: { en: 'Application number', ka: 'განცხადების ნომერი', example: '882022123456' },
});

export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = n => String(n).padStart(2, '0');
// Compact "20 Oct 2026, 10:45" (UTC); date-only values omit the time, unparseable values are shown as given.
export function formatWhen(iso) {
  if (!iso) return '—';
  const text = String(iso);
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return escapeHtml(text);
  const day = `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? day : `${day}, ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}
const when = iso => iso ? `<time datetime="${escapeHtml(iso)}" title="UTC">${formatWhen(iso)}</time>` : '—';

const css = `
*,*::before,*::after{box-sizing:border-box}
:root{--accent:#1f55c4;--accent-dark:#173f94;--ink:#1a2233;--muted:#5a6475;--line:#dde2ea;--bg:#f3f5f9;--card:#fff;--ok:#146c2e;--ok-bg:#e1f4e7;--err:#a31c1c;--err-bg:#fdeaea;--warn:#7a5200;--warn-bg:#fff1d2;--shadow:0 1px 2px rgba(20,30,50,.06),0 4px 14px rgba(20,30,50,.07)}
html{-webkit-text-size-adjust:100%}
body{font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans","Noto Sans Georgian",sans-serif;margin:0;background:var(--bg);color:var(--ink);overflow-wrap:anywhere;padding-bottom:72px}
a{color:var(--accent)}
:focus-visible{outline:3px solid #f0a500;outline-offset:2px}
header{background:var(--accent-dark);color:#fff;padding:12px 16px}
header .bar{max-width:1100px;margin:0 auto;display:flex;align-items:center;gap:16px}
header h1{font-size:18px;line-height:1.2;margin:0;font-weight:700;letter-spacing:.2px}
nav.tabs{position:fixed;left:0;right:0;bottom:0;z-index:5;display:flex;background:var(--card);border-top:1px solid var(--line);box-shadow:0 -2px 10px rgba(20,30,50,.08);padding-bottom:env(safe-area-inset-bottom)}
nav.tabs a{flex:1 1 0;min-width:0;text-align:center;padding:14px 4px;min-height:48px;color:var(--muted);text-decoration:none;font-size:14px;font-weight:600;border-top:3px solid transparent}
nav.tabs a.on{color:var(--accent);border-top-color:var(--accent);background:#eef3fd}
main{max-width:1100px;margin:0 auto;padding:16px}
h2{font-size:22px;line-height:1.25;margin:4px 0 12px}h3{font-size:17px;margin:0 0 8px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;margin-bottom:16px;box-shadow:var(--shadow)}
.muted{color:var(--muted);font-size:14px}
.ok{color:var(--ok)}.err{color:var(--err)}
.pill{display:inline-block;padding:2px 10px;border-radius:999px;font-size:13px;font-weight:600;background:var(--ok-bg);color:var(--ok);white-space:nowrap}
.pill.test{background:#efe3ff;color:#5b21a6}.pill.paused{background:var(--warn-bg);color:var(--warn)}.pill.busy{background:#dbe8ff;color:var(--accent-dark)}
.flash{padding:12px 14px;border-radius:10px;margin-bottom:16px;font-weight:500;border:1px solid transparent}
.flash.ok{background:var(--ok-bg);color:var(--ok);border-color:#b6e2c3}.flash.error{background:var(--err-bg);color:var(--err);border-color:#f2bcbc}
.cards{display:grid;grid-template-columns:1fr;gap:16px}.cards .card{margin:0;display:flex;flex-direction:column;gap:12px}
.t-head{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}
.t-id{font-size:22px;font-weight:700;line-height:1.2;margin:0}
.t-type{margin-top:2px}
dl.facts{display:grid;grid-template-columns:auto 1fr;gap:6px 12px;margin:0}
dl.facts dt{color:var(--muted);font-size:14px}dl.facts dd{margin:0;text-align:right}
.actions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:auto}
.actions form{display:flex;margin:0}
button,.btn{font:inherit;font-weight:600;overflow-wrap:normal;word-break:normal;min-height:48px;padding:10px 6px;border:1px solid #9aa6bb;border-radius:10px;background:#fff;color:var(--ink);cursor:pointer;width:100%;text-align:center;text-decoration:none;display:inline-flex;align-items:center;justify-content:center}
button:hover,.btn:hover{background:#eef2f8}
button.primary{background:var(--accent);color:#fff;border-color:var(--accent)}button.primary:hover{background:var(--accent-dark)}
button.danger{background:#fff;color:var(--err);border-color:#e0a3a3}button.danger:hover{background:var(--err-bg)}
.stack{display:flex;flex-direction:column;gap:12px;align-items:stretch}
label{display:block;margin:14px 0 4px;font-weight:600}
input[type=text],input[type=password],input[type=number]{width:100%;padding:12px;min-height:48px;border:1px solid #9aa6bb;border-radius:10px;font:inherit;background:#fff;color:var(--ink)}
input.big{font-size:18px;min-height:56px}
label.check{display:flex;align-items:center;gap:10px;font-weight:500}
input[type=checkbox]{width:22px;height:22px;flex:none}
.form-actions{display:grid;grid-template-columns:1fr;gap:10px;margin-top:18px}
.seg-radio{position:absolute;opacity:0;width:1px;height:1px;pointer-events:none}
.seg{display:grid;grid-template-columns:repeat(3,1fr);gap:4px;background:#e4e9f1;padding:4px;border-radius:12px;margin-bottom:16px}
.seg label span{display:block;font-size:12px;opacity:.85}
.seg label{margin:0;padding:10px 4px;min-height:48px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;border-radius:9px;font-size:14px;line-height:1.25;color:var(--muted);cursor:pointer}
.pane{display:none}
${['cadastral', 'id', 'registration'].map(t => `#t-${t}:checked ~ .seg label[for=t-${t}]{background:var(--card);color:var(--accent);box-shadow:0 1px 3px rgba(20,30,50,.18)}#t-${t}:focus-visible ~ .seg label[for=t-${t}]{outline:3px solid #f0a500}#t-${t}:checked ~ .panes .pane-${t}{display:block}`).join('\n')}
.empty{text-align:center;padding:28px 16px}
@media (min-width:640px){
  body{padding-bottom:0}
  header .bar{gap:28px;padding:0 24px}
  nav.tabs{position:static;background:none;border:0;box-shadow:none;padding:0;display:flex;gap:4px;margin-left:auto}
  nav.tabs a{flex:none;padding:10px 16px;min-height:0;color:#d5e2ff;border:0;border-radius:8px}
  nav.tabs a.on{background:#fff;color:var(--accent-dark)}
  main{padding:24px}
  .cards{grid-template-columns:repeat(auto-fill,minmax(340px,1fr))}
  .form-actions{grid-template-columns:auto auto;justify-content:start}
  .form-actions button{width:auto;min-width:200px}
  .narrow{max-width:560px}
}
`;

export function layout({ title, active, body, flash, refresh = false }) {
  const link = (href, name, key) => `<a href="${href}"${active === key ? ' class="on" aria-current="page"' : ''}>${name}</a>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)} – my.gov.ge tracker</title>
<meta name="viewport" content="width=device-width,initial-scale=1">${refresh ? '<meta http-equiv="refresh" content="3">' : ''}
<style>${css}</style></head><body><header><div class="bar"><h1>my.gov.ge tracker</h1><nav class="tabs" aria-label="Main">${link('/', 'Trackings', 'list')}${link('/new', 'New tracking', 'new')}${link('/settings', 'Settings', 'settings')}</nav></div></header>
<main>${flash ? `<div class="flash ${flash.kind}" role="status">${escapeHtml(flash.text)}</div>` : ''}${body}</main></body></html>`;
}

const post = (csrf, action, fields, label, cls = '') =>
  `<form method="post" action="${action}"><input type="hidden" name="_csrf" value="${csrf}">` +
  Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(v)}">`).join('') +
  `<button${cls ? ` class="${cls}"` : ''}>${label}</button></form>`;

export function trackingsPage({ rows, csrf, problem }) {
  const cards = rows.map(r => {
    const names = typeNames[r.type];
    const fields = { type: r.type, value: r.value };
    const state = (r.running ? '<span class="pill busy">checking…</span>' : r.paused ? '<span class="pill paused">paused</span>' : '<span class="pill">active</span>') +
      (r.testPending ? ' <span class="pill test">Test pending</span>' : '');
    const result = !r.check ? '<span class="muted">not checked yet</span>'
      : r.check.ok ? '<span class="ok">OK</span>' : `<span class="err">${escapeHtml(r.check.error)}</span>`;
    return `<article class="card tracking">
<div class="t-head"><div><p class="t-id">${escapeHtml(r.label || r.value)}</p><div class="muted t-type">${names.en} (${names.ka})${r.label ? `<br>${escapeHtml(r.value)}` : ''}</div></div>${state}</div>
<dl class="facts"><dt>Last check</dt><dd>${when(r.check?.checkedAt)}</dd><dt>Last result</dt><dd>${result}</dd><dt>Latest entry</dt><dd>${when(r.latestDate)}</dd><dt>Results</dt><dd>${r.count ?? '—'}</dd></dl>
<div class="actions">${post(csrf, '/track/check', fields, 'Check now')}${post(csrf, r.paused ? '/track/resume' : '/track/pause', fields, r.paused ? 'Resume' : 'Pause')}
<form method="get" action="/track/test-alert"><input type="hidden" name="type" value="${r.type}"><input type="hidden" name="value" value="${escapeHtml(r.value)}"><button>Test alert</button></form>
<form method="get" action="/track/delete"><input type="hidden" name="type" value="${r.type}"><input type="hidden" name="value" value="${escapeHtml(r.value)}"><button class="danger">Delete</button></form></div>
</article>`;
  }).join('');
  const body = rows.length ? `<div class="cards">${cards}</div>` : '<div class="card empty">Nothing is tracked yet.<p><a class="btn primary" href="/new">Add a tracking</a></p></div>';
  return `${problem ? `<div class="flash error">${escapeHtml(problem)}</div>` : ''}<h2>Current trackings</h2>${body}
<p class="muted">Paused items are skipped by the scheduler. “Check now” also works on paused items. “Test alert” and Delete ask for confirmation.</p>`;
}

export function newPage({ csrf, values = {}, error }) {
  const types = Object.keys(typeNames);
  const selected = types.includes(values.type) ? values.type : 'cadastral';
  const radios = types.map(t => `<input class="seg-radio" type="radio" name="kind" id="t-${t}" value="${t}"${t === selected ? ' checked' : ''}>`).join('');
  const tabs = types.map(t => `<label for="t-${t}">${typeNames[t].en}<span>${typeNames[t].ka}</span></label>`).join('');
  const panes = Object.entries(typeNames).map(([type, n]) => `<section class="pane pane-${type}"><div class="card narrow"><h3>${n.en} <span class="muted">${n.ka}</span></h3>
<form method="post" action="/track/add"><input type="hidden" name="_csrf" value="${csrf}"><input type="hidden" name="type" value="${type}">
<label for="v-${type}">${n.en}</label><input class="big" type="text" id="v-${type}" name="value" required${type === 'cadastral' ? '' : ' maxlength="40"'} placeholder="${n.example}" value="${escapeHtml(values.type === type ? values.value : '')}" autocomplete="off" inputmode="${type === 'cadastral' ? 'text' : 'numeric'}">
${identifierFormats[type] ? `<div class="muted">Expected: ${identifierFormats[type].hint}</div>` : ''}
<label for="l-${type}">Label (optional)</label><input type="text" id="l-${type}" name="label" maxlength="100" value="${escapeHtml(values.type === type ? values.label : '')}">
<div class="form-actions"><button class="primary">Add and run baseline check</button></div></form></div></section>`).join('');
  return `${error ? `<div class="flash error">${escapeHtml(error)}</div>` : ''}<h2>New tracking</h2>
<p class="muted">Choose what to track. The first check saves the current results as the baseline without sending an alert.</p>
<div class="chooser">${radios}<div class="seg" role="group" aria-label="Identifier type">${tabs}</div><div class="panes">${panes}</div></div>`;
}

export function deletePage({ csrf, target }) {
  const n = typeNames[target.type];
  return `<h2>Delete tracking?</h2><div class="card narrow"><p><strong>${escapeHtml(target.label || target.value)}</strong> — ${n.en} ${escapeHtml(target.value)}</p>
<p>Its saved baseline and history are removed. Adding it again later starts a new silent baseline.</p>
<div class="stack">${post(csrf, '/track/delete', { type: target.type, value: target.value }, 'Delete permanently', 'danger')}<a class="btn" href="/">Cancel</a></div></div>`;
}

export function testAlertPage({ csrf, target }) {
  const n = typeNames[target.type];
  return `<h2>Send a test alert?</h2><div class="card narrow"><p><strong>${escapeHtml(target.label || target.value)}</strong> — ${n.en} ${escapeHtml(target.value)}</p>
<p>This fakes an older saved baseline: the newest saved entry is forgotten, so the next check (scheduled or “Check now”) sees it as new and sends a real Telegram notification. Only the newest entry is re-alerted; afterwards the baseline is real again.</p>
<div class="stack">${post(csrf, '/track/test-alert', { type: target.type, value: target.value }, 'Simulate old baseline', 'primary')}<a class="btn" href="/">Cancel</a></div></div>`;
}

export function settingsPage({ csrf, view }) {
  const token = view.token.value;
  return `<h2>Settings</h2><div class="card narrow"><form method="post" action="/settings"><input type="hidden" name="_csrf" value="${csrf}">
<label for="tg">Telegram bot token</label><input type="password" id="tg" name="telegramBotToken" autocomplete="off" placeholder="${token ? 'leave empty to keep the current token' : 'not set'}">
<div class="muted">Current: ${token ? `${escapeHtml(maskSecret(token))} (${view.token.source})` : 'not set'}</div>
<label for="chat">Telegram chat ID</label><input type="text" id="chat" name="telegramChatId" autocomplete="off" value="${escapeHtml(view.chatId.value)}">
<div class="muted">Source: ${view.chatId.source}. Set both token and chat ID, or neither (alerts then go to the console).</div>
<label for="iv">Check interval (minutes)</label><input type="number" id="iv" name="intervalMinutes" min="1" max="10080" step="1" inputmode="numeric" value="${escapeHtml(view.intervalMinutes.value)}">
<div class="muted">Source: ${view.intervalMinutes.source}. Applied by the running scheduler without a restart.</div>
<label class="check"><input type="checkbox" name="clearTelegram" value="1"> Remove Telegram values saved in the UI</label>
<div class="form-actions"><button class="primary">Save settings</button></div></form></div>
<div class="card narrow"><h3>Telegram test</h3><p class="muted">Sends a message using the saved settings.</p><div class="stack">${post(csrf, '/settings/test', {}, 'Send test message')}</div></div>`;
}
