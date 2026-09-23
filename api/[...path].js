/**
 * Catch-all Vercel serverless entry point for /api/*.
 *
 * Vercel routes /api/system/health, /api/agent/chat, etc. directly here.
 * Express still owns the route matching inside server/src/index.js.
 */
import { app } from '../server/src/index.js';

export default app;
