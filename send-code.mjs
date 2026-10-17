import { chromium } from 'playwright';
const context = await chromium.launchPersistentContext('auth/profile', {
  executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'],
  viewport: { width: 1440, height: 900 },
});
const page = context.pages()[0] ?? await context.newPage();
page.on('response', response => {
  if (['xhr', 'fetch'].includes(response.request().resourceType()) && response.url().includes('my.gov.ge')) {
    const url = new URL(response.url());
    console.log('API', response.status(), response.request().method(), url.origin + url.pathname);
  }
});
await page.goto('https://www.my.gov.ge/ka-ge/account/login/verification', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(2000);
console.log('BEFORE_URL', page.url());
console.log('BUTTONS', await page.locator('button').evaluateAll(els => els.map(e => ({ text: e.innerText.trim(), disabled: e.disabled })).filter(e => e.text)));
const send = page.locator('button').filter({ hasText: 'კოდის გაგზავნა' });
if (await send.count()) {
  await send.click({ timeout: 15000 });
  await page.waitForTimeout(2000);
}
console.log('AFTER_URL', page.url());
console.log('AFTER_TEXT', (await page.locator('body').innerText()).slice(-1300));
await context.close();
