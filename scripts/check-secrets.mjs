import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export function isSecretPath(path) {
  const parts = path.toLowerCase().split('/');
  const name = parts.at(-1);
  if (path === '.env.example') return false;
  return parts.some(part => ['auth', 'credentials', 'cookies', 'tokens', 'sessions'].includes(part))
    || name === '.env' || name.startsWith('.env.')
    || /\.(pem|key|p12|pfx)$/.test(name)
    || /^id_(rsa|ed25519)/.test(name)
    || /credential|cookie|token|session|storage[-_]?state/.test(name)
    || name === 'state.json';
}

// Inspect the index, including force-added ignored paths; filesystem globs miss these.
export function trackedSecretPaths(cwd) {
  const paths = execFileSync('git', ['ls-files', '-z'], {
    cwd, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
  }).split('\0').filter(Boolean);
  return paths.filter(isSecretPath);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const paths = trackedSecretPaths(process.cwd());
  for (const path of paths) console.error(`Sensitive tracked path: ${path}`);
  if (paths.length) process.exitCode = 1;
}
