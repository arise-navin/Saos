import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hostingConfig } from '../src/config/hosting.js';

test('Render requires explicit frontend origin and API token', () => {
  assert.throws(() => hostingConfig({ RENDER: 'true' }), /Render requires/);
  const env = {
    RENDER: 'true',
    API_ACCESS_TOKEN: 'secret',
    FRONTEND_ORIGIN: 'https://saos.example',
  };
  assert.equal(hostingConfig(env).hosted, true);
  assert.throws(() => hostingConfig({ ...env, FRONTEND_ORIGIN: 'https://saos.example/' }), /without paths/);
  assert.equal(hostingConfig({}).hosted, false);
});
