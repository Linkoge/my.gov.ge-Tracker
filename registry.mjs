import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { identifierFields, loadLoginConfig, validateTargets } from './config.mjs';
import { completeResults, parseResultPage } from './results.mjs';
import { safeError } from './notifications.mjs';

export const SERVICE_URL = 'https://www.my.gov.ge/ka-ge/services/10/service/176';
export const SEARCH_URL = 'https://naprweb.reestri.gov.ge/api/search';
const iframe = 'iframe[src*="naprweb.reestri.gov.ge"]';

export async function openBrowserContext(config, profileDir = join(config.dataDir, 'browser')) {
  // Loaded on demand so configuration, the UI and tests that stub the browser work without Playwright installed.
  const { chromium } = await import('playwright');
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath: config.chromePath, headless: true, args: ['--no-sandbox'],
    viewport: { width: 1440, height: 900 }, timeout: config.timeoutMs,
  });
  context.setDefaultTimeout(config.timeoutMs);
  context.setDefaultNavigationTimeout(config.timeoutMs);
  return context;
}

// Uses the prototype's username/password and verification selectors. Unattended
// checks never wait on stdin or repeatedly request SMS codes.
export async function loginWithCredentials(page, { settings, timeoutMs, getCode } = {}) {
  const { loginId, password } = await loadLoginConfig({ env: settings });
  await page.goto('https://www.my.gov.ge/ka-ge/account/login/username', { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  await page.locator('input[name="username"]').fill(loginId);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('button[type="submit"]').filter({ hasText: 'შესვლა' }).click();
  try { await page.waitForURL(url => !url.pathname.endsWith('/login/username'), { timeout: timeoutMs }); }
  catch { throw new Error('Login failed: username/password submission did not leave the login page'); }
  if (page.url().includes('/verification')) {
    let code = settings?.MYGOV_VERIFICATION_CODE;
    if (!code && getCode) {
      const send = page.locator('button').filter({ hasText: 'კოდის გაგზავნა' });
      if (await send.count()) await send.click();
      code = await getCode();
    }
    if (!code) throw new Error('Login requires a verification code; run node login.mjs to establish a session');
    await page.locator('input[type="text"]').last().fill(code);
    await page.locator('button[type="submit"]').filter({ hasText: 'გაგრძელება' }).click();
    try { await page.waitForURL(url => !url.pathname.includes('/account/login'), { timeout: timeoutMs }); }
    catch { throw new Error('Login failed: verification was not accepted'); }
  }
  if (page.url().includes('/account/login')) throw new Error('Login failed: authentication did not complete');
}

async function openSearch(page, target, config) {
  const field = `input[ng-model="searchForm.${identifierFields[target.type]}"]`;
  const navigate = async () => {
    const response = await page.goto(SERVICE_URL, { waitUntil: 'domcontentloaded' });
    if (response && !response.ok()) throw new Error(`Service page returned HTTP ${response.status()}`);
    return page.frameLocator(iframe).locator(field).waitFor();
  };
  try { await navigate(); }
  catch (error) {
    if (!page.url().includes('/account/login') && !(await page.locator('input[name="password"]').count())) throw error;
    await loginWithCredentials(page, config);
    await navigate();
  }
  const frame = page.frameLocator(iframe);
  await frame.locator('button').filter({ hasText: 'თავიდან' }).click();
  // Clear restored Angular search filters so exactly ONE identifier is submitted.
  for (const name of ['regno', 'person', 'address', 'cadcode']) {
    await frame.locator(`input[ng-model="searchForm.${name}"]`).fill(name === identifierFields[target.type] ? target.value : '');
  }
  const pending = page.waitForResponse(response => response.url().split('?')[0] === SEARCH_URL && response.request().method() === 'POST');
  // Await both promises so a failed click cannot leave an unhandled waiter.
  const [response] = await Promise.all([pending, frame.locator('button[type="submit"]').click()]);
  const payload = response.request().postDataJSON();
  if (payload?.[identifierFields[target.type]] !== target.value || ['regno', 'person', 'address', 'cadcode'].some(name =>
    name !== identifierFields[target.type] && payload[name]) || payload.datefrom || payload.dateto || payload.search || payload.page !== 1) {
    throw new Error('Search failed: form did not submit exactly the configured identifier on page one');
  }
  return { response, payload };
}

export async function readSearchResponse(response, page) {
  if (!response.ok()) throw new Error(`Search failed: registry returned HTTP ${response.status()}`);
  let json;
  try { json = await response.json(); }
  catch { throw new Error('Search failed: registry returned non-JSON data (possible login, CAPTCHA or upstream error)'); }
  return parseResultPage(json, page);
}

export async function searchRegistry(target, config, { openContext = openBrowserContext } = {}) {
  validateTargets([target]);
  let context;
  let phase = 'browser startup';
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void context?.close().catch(() => {}); }, 55000);
  try {
    context = await openContext(config);
    const page = context.pages()[0] ?? await context.newPage();
    phase = 'service/login/search submission';
    const { response, payload } = await openSearch(page, target, config);
    phase = 'result parsing';
    const pages = [await readSearchResponse(response, 1)];
    if (pages[0].lastPage > 1000) throw new Error('Search failed: more than 1000 pages; refusing an incomplete baseline');
    for (let number = 2; number <= pages[0].lastPage; number++) {
      phase = `search page ${number}`;
      const next = await context.request.post(SEARCH_URL, { data: { ...payload, page: number }, timeout: config.timeoutMs });
      pages.push(await readSearchResponse(next, number));
    }
    return completeResults(pages);
  } catch (error) {
    if (timedOut) throw new Error(`Search timed out after 55 seconds during ${phase}`);
    throw new Error(`${phase}: ${safeError(error, config.settings)}`);
  } finally {
    clearTimeout(timer);
    if (context) await context.close();
  }
}
