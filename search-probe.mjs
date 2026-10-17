import { chromium } from 'playwright';
const context = await chromium.launchPersistentContext('auth/profile', {
  executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'],
  viewport: { width: 1440, height: 900 },
});
const page = context.pages()[0] ?? await context.newPage();
page.on('response', async response => {
  const request = response.request();
  if (!['xhr', 'fetch'].includes(request.resourceType()) || !response.url().includes('reestri.gov.ge')) return;
  const url = new URL(response.url());
  const body = request.postData();
  console.log('REQUEST', response.status(), request.method(), url.origin + url.pathname, body?.slice(0, 500) ?? '');
  try {
    const json = await response.json();
    console.log('RESPONSE', JSON.stringify(json).slice(0, 1200));
  } catch {}
});
await page.goto('https://www.my.gov.ge/ka-ge/services/10/service/176', { waitUntil: 'domcontentloaded', timeout: 60000 });
const frame = page.frameLocator('iframe[src*="naprweb.reestri.gov.ge"]');
await frame.locator('input[ng-model="searchForm.person"]').fill('00000000000');
await frame.locator('button[type="submit"]').click();
await page.waitForTimeout(10000);
console.log('RESULT_TEXT', (await frame.locator('body').innerText()).slice(0, 2500));
await context.close();
