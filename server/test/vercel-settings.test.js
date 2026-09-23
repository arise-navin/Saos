import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

test('Vercel handler initializes and saves settings without exposing secrets', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelp-vercel-test-'));
  process.env.VERCEL = '1';
  process.env.NOWHELPASSIST_DATA_DIR = dir;
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.TURSO_AUTH_TOKEN;
  const { default: handler } = await import('../../api/index.js');
  const config = JSON.parse(fs.readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8'));
  const nodeBuild = config.builds.find((build) => build.src === 'api/index.js');
  const server = http.createServer(async (req, res) => {
    // Model Vercel's helpers: consume the body, then replay data/end events.
    if (nodeBuild.config?.helpers !== false && req.headers['content-type']) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const replay = new PassThrough();
      const originalOn = req.on.bind(req);
      req.read = replay.read.bind(replay);
      req.on = req.addListener = (event, listener) =>
        ['data', 'end'].includes(event) ? replay.on(event, listener) : originalOn(event, listener);
      replay.end(body);
      req.body = JSON.parse(body.toString());
    }
    return handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/system`;
  try {
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
