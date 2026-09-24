import { timingSafeEqual } from 'node:crypto';

export function hostingConfig(env = process.env) {
  const hosted = env.RENDER === 'true';
  const token = env.API_ACCESS_TOKEN || '';
  const origins = (env.FRONTEND_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);

  if (hosted && (!token || !origins.length)) {
    throw new Error('Render requires API_ACCESS_TOKEN and FRONTEND_ORIGIN.');
  }
  for (const origin of origins) {
    if (new URL(origin).origin !== origin) {
      throw new Error('FRONTEND_ORIGIN must contain origins without paths or trailing slashes.');
    }
  }
  return { hosted, token, origins };
}

export function accessGuard(token, { sessionUser = null } = {}) {
  return (req, res, next) => {
    if (!token) return next();
    if (req.path.startsWith('/system/auth/')) return next();
    if (sessionUser?.(req.get('x-saos-session') || '')) return next();
    const actual = Buffer.from(req.get('authorization') || '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (actual.length === expected.length && timingSafeEqual(actual, expected)) return next();
    res.status(401).json({ message: 'Enter a valid backend access token.' });
  };
}
