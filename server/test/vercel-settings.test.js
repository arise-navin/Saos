import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { test } from 'node:test';

test('Vercel handler initializes and saves settings without exposing secrets', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelp-vercel-test-'));
  process.env.VERCEL = '1';
  process.env.NOWHELPASSIST_DATA_DIR = dir;
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.TURSO_AUTH_TOKEN;
  const { default: handler } = await import('../../api/index.js');
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/system`;
  try {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).connected, false);
    const saved = await fetch(`${base}/settings`, {
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
