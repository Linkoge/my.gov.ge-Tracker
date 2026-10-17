import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { loadLoginConfig } from '../config.mjs';
import { isSecretPath, trackedSecretPaths } from '../scripts/check-secrets.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const sensitivePaths = [
  '.env', '.env.local', 'nested/.env.production', 'server.pem', 'client.key',
  'client.p12', 'client.pfx', 'id_rsa', 'id_ed25519.pub', 'credentials.json',
  'service-account-credentials.json', 'cookies.txt', 'access-token.json',
  'session.json', 'storage-state.json', 'storageState.json', 'state.json',
  'auth/profile/Default/Cookies', 'auth/state.json', 'cookies/site.json',
  'credentials/service.json',
  'auth/.env.example',
];

test('tracked files exclude all sensitive paths', () => {
  assert.deepEqual(trackedSecretPaths(root), []);
});

test('path policy blocks secret files and permits application code and empty template', async () => {
  for (const path of sensitivePaths) assert.equal(isSecretPath(path), true, path);
  for (const path of ['.env.example', 'README.md', 'config.mjs', 'login.mjs', 'package-lock.json']) {
    assert.equal(isSecretPath(path), false, path);
  }
  const template = await readFile(join(root, '.env.example'), 'utf8');
  for (const line of template.split('\n').filter(line => line && !line.startsWith('#'))) {
    assert.ok(/^[A-Z_]+=$/.test(line), '.env.example must contain empty assignments only');
  }
});

test('ignore rules block new sensitive artifacts while permitting the template', () => {
  for (const path of sensitivePaths) {
    const ignored = execFileSync('git', ['check-ignore', '--no-index', '--stdin'], {
      cwd: root, input: `${path}\n`, encoding: 'utf8', timeout: 10_000,
    }).trim();
    assert.equal(ignored, path);
  }
  assert.equal(execFileSync('git', ['check-ignore', '--no-index', '--verbose', '.env.example'], {
    cwd: root, encoding: 'utf8', timeout: 10_000,
  }).includes('!.env.example'), true);
});

test('guard detects force-added ignored secret files in a disposable repository', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'tracker-git-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, timeout: 10_000, stdio: 'pipe' });
  git('init');
  await writeFile(join(cwd, '.gitignore'), '.env\n*.key\n');
  await writeFile(join(cwd, '.env'), 'MYGOV_PASSWORD=fake-test-only\n');
  await writeFile(join(cwd, 'client.key'), 'fake-test-only\n');
  git('add', '--force', '.env', 'client.key');
  assert.deepEqual(trackedSecretPaths(cwd), ['.env', 'client.key']);
  git('rm', '--cached', '.env', 'client.key');
  assert.deepEqual(trackedSecretPaths(cwd), []);
  assert.equal(await readFile(join(cwd, 'client.key'), 'utf8'), 'fake-test-only\n');
});

test('login loads local values and environment overrides without requiring a local file', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'tracker-config-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const envPath = join(cwd, '.env');
  await writeFile(envPath, '# Test configuration\nMYGOV_LOGIN_ID=fake-id\nMYGOV_PASSWORD="fake # = password"\n');
  assert.deepEqual(await loadLoginConfig({ env: {}, envPath }), {
    loginId: 'fake-id', password: 'fake # = password',
  });
  assert.deepEqual(await loadLoginConfig({ env: { MYGOV_PASSWORD: 'test-pass-1' }, envPath }), {
    loginId: 'fake-id', password: 'test-pass-1',
  });
  await rm(envPath);
  assert.deepEqual(await loadLoginConfig({
    env: { MYGOV_LOGIN_ID: 'fake-env-id', MYGOV_PASSWORD: 'test-pass-2' }, envPath,
  }), { loginId: 'fake-env-id', password: 'test-pass-2' });
  await assert.rejects(loadLoginConfig({ env: {}, envPath }), /Set MYGOV_LOGIN_ID, MYGOV_PASSWORD/);
  await assert.rejects(loadLoginConfig({
    env: { MYGOV_LOGIN_ID: 'fake-id', MYGOV_PASSWORD: '' }, envPath,
  }), /Set MYGOV_PASSWORD/);
  await assert.rejects(loadLoginConfig({ env: {}, envPath: cwd }), {
    message: 'Unable to read local .env configuration',
  });
});
