/**
 * Vercel serverless entry point.
 *
 * Vercel's @vercel/node builder looks for a default export that is a Node.js
 * http.IncomingMessage handler (i.e., (req, res) => void), which is exactly
 * what an Express app instance is.
 *
 * process.env.VERCEL is set by Vercel automatically, so src/index.js skips
 * app.listen() and the meetings queue when it detects that flag.
 */
import { app } from '../src/index.js';

export default app;
