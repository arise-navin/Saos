import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

test('Turso loads its server dependency from the repository root and reports invalid configuration promptly', () => {
  const result = spawnSync(process.execPath, ['-e', `
    (async () => {
    const { getDb } = await import('./server/src/memory/db.js');
    try { getDb(); process.exitCode = 1; }
    catch (error) {
      if (!/URL_SCHEME_NOT_SUPPORTED/.test(error.message)) throw error;
      console.log('configuration error reported');
    }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    env: { ...process.env, TURSO_DATABASE_URL: 'invalid://test', TURSO_AUTH_TOKEN: 'test' },
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /configuration error reported/);
});
