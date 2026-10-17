import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { identifierFields } from '../config.mjs';
import { openBrowserContext, searchRegistry, SEARCH_URL, SERVICE_URL } from '../registry.mjs';

const fixture = JSON.parse(await readFile(new URL('./fixtures/search.json', import.meta.url), 'utf8'));

async function offlineSearch(t, target, { failPageTwo = false } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'mygov-browser-test-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const config = { dataDir, chromePath: '/usr/bin/google-chrome', timeoutMs: 5000, settings: {} };
  const requests = [];
  const result = searchRegistry(target, config, {
    openContext: async config => {
      const context = await openBrowserContext(config);
      // All browser traffic is intercepted; no government requests or real
      // credentials are used. APIRequestContext pagination is stubbed too.
      await context.route('**/*', async route => {
        const url = route.request().url();
        if (url === SERVICE_URL) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<iframe src="https://naprweb.reestri.gov.ge/_dea/"></iframe>' });
        if (url === SEARCH_URL) {
          requests.push(route.request().postDataJSON());
          return route.fulfill({ json: { ...fixture, applist: [fixture.applist[0]], lastpage: 2 } });
        }
        if (url === 'https://naprweb.reestri.gov.ge/_dea/') {
          return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `
            <form>
              ${['regno', 'person', 'address', 'cadcode'].map(name => `<input ng-model="searchForm.${name}" name="${name}" value="stale-filter">`).join('')}
              <button type="button" onclick="document.querySelectorAll('input').forEach(input => input.value='')">refresh თავიდან</button>
              <button type="submit">search</button>
            </form>
            <script>
              document.querySelector('form').onsubmit = async event => {
                event.preventDefault();
                const payload = {page: 1, search:'', datefrom:null, dateto:null};
                document.querySelectorAll('input').forEach(input => payload[input.name] = input.value);
                await fetch('/api/search', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(payload)});
              };
            </script>` });
        }
        return route.abort();
      });
      context.request.post = async (url, options) => {
        assert.equal(url, SEARCH_URL);
        requests.push(options.data);
        return { ok: () => true, json: async () => failPageTwo ? { message: 'fixture failure' } :
          ({ ...fixture, applist: [fixture.applist[1]], page: 2, lastpage: 2 }) };
      };
      return context;
    },
  });
  return { result, requests };
}

for (const type of ['cadastral', 'id', 'registration']) {
  test(`browser search submits only the ${type} identifier, resets old filters and reads every page`, { timeout: 30000 }, async t => {
    const target = { type, value: type === 'cadastral' ? '01.14.16.007.381' : '000000000001' };
    const { result, requests } = await offlineSearch(t, target);
    assert.equal((await result).length, 2);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests.map(r => r.page), [1, 2]);
    for (const request of requests) {
      for (const field of Object.values(identifierFields)) assert.equal(request[field], field === identifierFields[type] ? target.value : '');
      assert.equal(request.address, '');
    }
  });
}

test('a malformed later page fails the entire browser search', { timeout: 30000 }, async t => {
  const { result } = await offlineSearch(t, { type: 'cadastral', value: '01.14.16.007.381' }, { failPageTwo: true });
  await assert.rejects(result, /expected applist array/);
});
