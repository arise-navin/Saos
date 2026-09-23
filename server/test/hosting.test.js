import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hostingConfig } from '../src/config/hosting.js';

test('Render refuses to expose credentials without authentication and cloud storage', () => {
  assert.throws(() => hostingConfig({ RENDER: 'true' }), /Render requires/);
  const env = { RENDER: 'true', API_ACCESS_TOKEN: 'secret', FRONTEND_ORIGIN: 'https://saos.example', TURSO_DATABASE_URL: 'libsql://example', TURSO_AUTH_TOKEN: 'secret' };
  assert.equal(hostingConfig(env).hosted, true);
  assert.throws(() => hostingConfig({ ...env, FRONTEND_ORIGIN: 'https://saos.example/' }), /without paths/);
  assert.equal(hostingConfig({}).hosted, false);
});
