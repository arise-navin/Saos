import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('Turso settings survive process restart and do not use settings.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saos-cloud-settings-'));
  const cwd = fileURLToPath(new URL('../../', import.meta.url));
  const localEnv = { ...process.env, NOWHELPASSIST_DATA_DIR: dir, TURSO_DATABASE_URL: '', TURSO_AUTH_TOKEN: '' };
  const run = (code, env) => {
    const result = spawnSync(process.execPath, ['-e', `(async () => { ${code} })().catch(e => { console.error(e); process.exitCode = 1; });`], {
      cwd, env, encoding: 'utf8', timeout: 120_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  try {
    // Exercise first-start migrations and persistence through the libSQL bridge.
    const env = { ...localEnv, TURSO_DATABASE_URL: pathToFileURL(path.join(dir, 'nowhelpassist.db')).href, TURSO_AUTH_TOKEN: 'test-only' };
    run(`const {saveSettings}=await import('./server/src/config/store.js');
      saveSettings({connection:{username:'cloud-user',password:'test-password'},llm:{baseUrl:'https://example.test/v1'}});`, env);
    assert.equal(fs.existsSync(path.join(dir, 'settings.json')), false);
    const read = run(`const assert=(await import('node:assert/strict')).default;
      const {getSettings,publicSettings}=await import('./server/src/config/store.js');
      assert.equal(getSettings().connection.username,'cloud-user');
      assert.equal(getSettings().connection.password,'test-password');
      assert.equal(publicSettings().connection.password,undefined);
      console.log('persistent settings verified');`, env);
    assert.match(read, /persistent settings verified/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
