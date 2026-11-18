import { timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { kleosErrorCodes } from '@kleos/shared';

/**
 * The server holds live database sessions, so it binds to 127.0.0.1 and every /api
 * request must carry the random per-launch token. The Host check stops DNS-rebinding
 * pages from reaching the port through a hostile domain name.
 */
export function requireToken(token: string, getPort: () => number): MiddlewareHandler {
  const expected = Buffer.from(token);
  return async (c, next) => {
    if (c.req.method === 'OPTIONS') return next();
    const host = c.req.header('host') ?? '';
    const port = getPort();
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      return c.json({ code: kleosErrorCodes.unauthorized, message: 'Unexpected Host header' }, 403);
    }
    const header = c.req.header('authorization') ?? '';
    const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return c.json({ code: kleosErrorCodes.unauthorized, message: 'Missing or invalid token' }, 401);
    }
    return next();
  };
}
