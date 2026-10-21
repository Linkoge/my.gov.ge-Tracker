import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { identifierFields, loadLoginConfig, validateTargets } from './config.mjs';
import { completeResults, parseResultPage } from './results.mjs';
import { safeError } from './notifications.mjs';

export const SERVICE_URL = 'https://www.my.gov.ge/ka-ge/services/10/service/176';
export const SEARCH_URL = 'https://naprweb.reestri.gov.ge/api/search';
export const SEARCH_BUDGET_MS = 90000;
const SEARCH_RESPONSE_MS = 30000;
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

export async function openSearch(page, target, config, deadline = Date.now() + SEARCH_BUDGET_MS) {
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
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await navigate();
    const frame = page.frameLocator(iframe);
    await frame.locator('button').filter({ hasText: 'თავიდან' }).click();
    // Clear restored Angular search filters so exactly ONE identifier is submitted.
    for (const name of ['regno', 'person', 'address', 'cadcode']) {
      const input = frame.locator(`input[ng-model="searchForm.${name}"]`);
      await input.fill(name === identifierFields[target.type] ? target.value : '');
      // Commit Angular updateOn: blur models, including cleared filters and person.
      await input.blur();
    }
    // Playwright's click waits for the submit button to become enabled after validation.
    let response;
    try {
      const pending = page.waitForResponse(response => response.url().split('?')[0] === SEARCH_URL && response.request().method() === 'POST',
        { timeout: Math.max(1, Math.min(SEARCH_RESPONSE_MS, deadline - Date.now())) });
      [response] = await Promise.all([pending, frame.locator('button[type="submit"]').click()]);
    } catch (error) {
      if (attempt === 0 && error.name === 'TimeoutError' && Date.now() < deadline) continue;
      throw error;
    }
    const payload = response.request().postDataJSON();
    if (payload?.[identifierFields[target.type]] !== target.value || ['regno', 'person', 'address', 'cadcode'].some(name =>
      name !== identifierFields[target.type] && payload[name]) || payload.datefrom || payload.dateto || payload.search || payload.page !== 1) {
      throw new Error('Search failed: form did not submit exactly the configured identifier on page one');
    }
    return { response, payload };
  }
}

export async function readSearchResponse(response, page) {
  if (!response.ok()) throw new Error(`Search failed: registry returned HTTP ${response.status()}`);
  let json;
  try { json = await response.json(); }
  catch { throw new Error('Search failed: registry returned non-JSON data (possible login, CAPTCHA or upstream error)'); }
  return parseResultPage(json, page);
}

export async function searchRegistry(target, config, { openContext = openBrowserContext, budgetMs = SEARCH_BUDGET_MS } = {}) {
  validateTargets([target]);
  let context;
  let phase = 'browser startup';
  const deadline = Date.now() + budgetMs;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Search timed out after ${budgetMs / 1000} seconds during ${phase}`)), budgetMs);
  });
  const work = async () => {
    context = await openContext(config);
    if (Date.now() >= deadline) { void context.close().catch(() => {}); throw new Error('Search deadline expired'); }
    const page = context.pages()[0] ?? await context.newPage();
    phase = 'service/login/search submission';
    const { response, payload } = await openSearch(page, target, config, deadline);
    phase = 'result parsing';
    const pages = [await readSearchResponse(response, 1)];
    if (pages[0].lastPage > 1000) throw new Error('Search failed: more than 1000 pages; refusing an incomplete baseline');
    for (let number = 2; number <= pages[0].lastPage; number++) {
      phase = `search page ${number}`;
      const next = await context.request.post(SEARCH_URL, { data: { ...payload, page: number }, timeout: Math.max(1, Math.min(SEARCH_RESPONSE_MS, deadline - Date.now())) });
      pages.push(await readSearchResponse(next, number));
    }
    return completeResults(pages);
  };
  try {
    return await Promise.race([work(), timeout]);
  } catch (error) {
    throw new Error(`${phase}: ${safeError(error, config.settings)}`);
  } finally {
    clearTimeout(timer);
    // Browser cleanup must not keep the queue blocked.
    if (context) {
      let cleanupTimer;
      try {
        await Promise.race([context.close().catch(() => {}), new Promise(resolve => {
          cleanupTimer = setTimeout(resolve, 2000);
        })]);
      } finally { clearTimeout(cleanupTimer); }
    }
  }
}
