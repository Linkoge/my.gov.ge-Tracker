import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

await mkdir('auth/profile', { recursive: true, mode: 0o700 });
const context = await chromium.launchPersistentContext('auth/profile', {
  executablePath: '/usr/bin/google-chrome',
  headless: true,
  args: ['--no-sandbox'],
  viewport: { width: 1440, height: 900 },
});
const page = context.pages()[0] ?? await context.newPage();
page.on('response', response => {
  const request = response.request();
  if (['xhr', 'fetch'].includes(request.resourceType())) {
    console.log('API', response.status(), request.method(), new URL(response.url()).origin + new URL(response.url()).pathname);
  }
});
await page.goto(process.argv[2] ?? 'https://www.my.gov.ge/ka-ge/services/10/service/176', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(12000);
console.log('URL', page.url());
console.log('TITLE', await page.title());
console.log('TEXT', (await page.locator('body').innerText()).slice(0, 5000));
console.log('FIELDS', await page.locator('input').evaluateAll(els => els.map(e => ({ type: e.type, name: e.name, id: e.id, placeholder: e.placeholder }))));
console.log('BUTTONS', await page.locator('button').evaluateAll(els => els.map(e => ({ text: e.innerText.slice(0, 100), type: e.type }))));
console.log('LINKS', await page.locator('a').evaluateAll(els => els.map(e => ({ text: e.innerText.trim().slice(0, 70), href: e.href })).filter(e => e.text).slice(0, 50)));
console.log('FRAMES', page.frames().map(f => f.url()));
for (const frame of page.frames()) {
  if (frame.url().includes('naprweb.reestri.gov.ge')) {
    console.log('SERVICE_TEXT', (await frame.locator('body').innerText().catch(() => '')).slice(0, 8000));
    console.log('SERVICE_FIELDS', await frame.locator('input').evaluateAll(els => els.map(e => ({ type: e.type, name: e.name, id: e.id, placeholder: e.placeholder }))));
    console.log('SERVICE_BUTTONS', await frame.locator('button').evaluateAll(els => els.map(e => ({ text: e.innerText.slice(0, 100), type: e.type }))));
    console.log('SERVICE_INPUT_HTML', await frame.locator('input').evaluateAll(els => els.map(e => e.parentElement?.outerHTML.slice(0, 1000))));
    console.log('SERVICE_SCRIPTS', await frame.locator('script[src]').evaluateAll(els => els.map(e => e.src)));
  }
}
await page.screenshot({ path: '/tmp/document-tracker-page.png', fullPage: true });
await context.close();
