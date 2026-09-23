/**
 * Vercel serverless entry point.
 *
 * Vercel only detects Node serverless functions from the root api/ directory.
 * The actual Express app stays in server/src/index.js so local development
 * and tests keep their existing structure.
 */
import { app } from '../server/src/index.js';

export default app;
