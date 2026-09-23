import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { test } from 'node:test';

test('Hosted API requires authentication and saves settings without exposing secrets', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelp-vercel-test-'));
  process.env.VERCEL = '1';
  process.env.NOWHELPASSIST_DATA_DIR = dir;
  process.env.API_ACCESS_TOKEN = 'test-access-token';
  process.env.FRONTEND_ORIGIN = 'https://frontend.example';
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.TURSO_AUTH_TOKEN;
  const { app } = await import('../src/index.js');
  const server = http.createServer(app);
  const fetch = (url, options = {}) => globalThis.fetch(url, {
    ...options, headers: { ...options.headers, Authorization: 'Bearer test-access-token' },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/system`;
  try {
    assert.equal((await globalThis.fetch(`${base}/settings`)).status, 401);
    const preflight = await globalThis.fetch(`${base}/settings`, {
      method: 'OPTIONS', headers: { Origin: 'https://frontend.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' },
    });
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://frontend.example');
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).connected, false);
    const saved = await fetch(`${base}/settings`, {
      signal: AbortSignal.timeout(3000),
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connection: {
        instanceUrl: 'https://example.service-now.com/',
        username: 'test-user', password: 'test-only-password',
      } }),
    });
    assert.equal(saved.status, 200);
    const result = await saved.json();
    assert.equal(result.connection.hasPassword, true);
    assert.equal(result.connection.password, undefined);
    const read = await fetch(`${base}/settings`);
    assert.equal((await read.json()).connection.username, 'test-user');
    const stored = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    assert.equal(stored.connection.password, 'test-only-password');
    const { autoBootstrapSdkWorkspace } = await import('../src/servicenow/fluent.js');
    assert.equal((await autoBootstrapSdkWorkspace()).attempted, false);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    const { getDb } = await import('../src/memory/db.js');
    getDb().close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
