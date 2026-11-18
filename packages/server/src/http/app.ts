import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { ZodError } from 'zod';
import { kleosErrorCodes, type ApiErrorBody, type Health } from '@kleos/shared';
import { KleosError, isPgError, pgErrorBody } from '../errors';
import { registerRoutes } from '../routes';
import type { ServerDeps } from './deps';
import { requireToken } from './security';

export type AppOptions = {
  token: string;
  /** Returns the port the server listens on, for the Host check. */
  getPort: () => number;
  /** Origins allowed to call /api cross-origin (the Vite dev server in development). */
  allowedOrigins?: string[];
};

export function createApp(deps: ServerDeps, options: AppOptions): Hono {
  const app = new Hono();

  if (options.allowedOrigins?.length) {
    app.use(
      '/api/*',
      cors({
        origin: options.allowedOrigins,
        allowHeaders: ['Authorization', 'Content-Type'],
        allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      }),
    );
  }
  app.use('/api/*', requireToken(options.token, options.getPort));

  app.get('/api/health', (c) => c.json<Health>({ ok: true, version: deps.version }));

  const api = new Hono();
  registerRoutes(api, deps);
  app.route('/api', api);

  app.notFound((c) => c.json<ApiErrorBody>({ code: kleosErrorCodes.notFound, message: 'Not found' }, 404));
  app.onError((err, c) => {
    const { status, body } = toErrorResponse(err);
    if (status >= 500) console.error('[kleos] unhandled error', err);
    return c.json(body, status as 400);
  });

  return app;
}

/** Maps any thrown value to the { code, message, detail?, position? } body and a status. */
export function toErrorResponse(err: unknown): { status: number; body: ApiErrorBody } {
  if (err instanceof KleosError) return { status: err.status, body: err.body };
  if (err instanceof ZodError) {
    return {
      status: 400,
      body: {
        code: kleosErrorCodes.validation,
        message: 'Invalid request',
        detail: err.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`).join('; '),
      },
    };
  }
  if (isPgError(err)) return { status: 400, body: pgErrorBody(err) };
  if (err instanceof HTTPException) {
    return { status: err.status, body: { code: kleosErrorCodes.validation, message: err.message } };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { status: 500, body: { code: kleosErrorCodes.internal, message } };
}
