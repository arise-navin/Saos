/**
 * Vercel serverless entry point.
 *
 * Vercel only detects Node serverless functions from the root api/ directory.
 * The actual Express app stays in server/src/index.js so local development
 * and tests keep their existing structure.
 */
let appPromise;

export default async function handler(req, res) {
  try {
    // Catch initialization failures too, before Express can install its middleware.
    if (!appPromise) {
      const started = Date.now();
      console.info('API initialization started', {
        node: process.version,
        storage: process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN ? 'turso' : 'local',
      });
      appPromise = import('../server/src/index.js').then(({ app }) => {
        console.info('API initialization completed', { durationMs: Date.now() - started });
        return app;
      });
    }
    const app = await appPromise;
    return app(req, res);
  } catch (error) {
    console.error('API initialization failed', error);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({
      code: 'API_INITIALIZATION_FAILED',
      message: 'API startup failed. Check this deployment\'s Vercel Runtime Logs for "API initialization failed".',
    }));
  }
}
