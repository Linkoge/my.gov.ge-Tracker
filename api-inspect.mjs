import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext();
const page = await context.newPage();
await page.goto('https://naprweb.reestri.gov.ge/_dea/#/search', { waitUntil: 'domcontentloaded', timeout: 60000 });
const script = await page.request.get('https://naprweb.reestri.gov.ge/_dea/naprweb.min.js?v=v2');
await writeFile('/tmp/naprweb.min.js', await script.body());
const response = await page.request.post('https://naprweb.reestri.gov.ge/api/search', {
  data: { page: 1, search: '', regno: '', datefrom: null, dateto: null, person: '00000000000', address: '', cadcode: '' },
});
const json = await response.json();
console.log('STATUS', response.status(), 'KEYS', Object.keys(json), 'COUNT', json.applist?.length);
console.log('OTHER', Object.fromEntries(Object.entries(json).filter(([key]) => key !== 'applist')));
console.log('ITEM_KEYS', Object.keys(json.applist?.[0] ?? {}));
await browser.close();
