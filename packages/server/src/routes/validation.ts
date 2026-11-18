import type { Context } from 'hono';
import { z } from 'zod';
import { KleosError, isPgError } from '../errors';

/**
 * Reads the JSON body and parses it with a shared schema. A ZodError becomes a 400
 * in app.onError; a body that is not JSON at all is a 400 too.
 */
export async function jsonBody<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw KleosError.validation('Invalid request', 'Body must be JSON');
  }
  return schema.parse(raw);
}

/** Parses the query string (all values are strings; use z.coerce for numbers). */
export function queryOf<S extends z.ZodType>(c: Context, schema: S): z.output<S> {
  return schema.parse(c.req.query());
}

/** ?size= on GET /queries/:qid/page. */
export const PageQuery = z.object({ size: z.coerce.number().int().min(1).max(5000).default(500) });

/** ?limit= on GET /history/:connectionId. */
export const HistoryQuery = z.object({ limit: z.coerce.number().int().min(1).max(1000).default(200) });

/** ?connectionId= on GET /saved-queries. */
export const SavedQueriesQuery = z.object({ connectionId: z.string().min(1).optional() });

/** :pid on POST /backends/:pid/cancel. */
export const Pid = z.coerce.number().int().positive();

/** ?refresh=1 (or true). */
export function isRefresh(c: Context): boolean {
  const value = c.req.query('refresh');
  return value === '1' || value === 'true';
}

/** The SQLSTATE of a Postgres error, raw or already wrapped in a KleosError; null otherwise. */
export function sqlStateOf(err: unknown): string | null {
  if (isPgError(err)) return err.code;
  if (err instanceof KleosError && /^[0-9A-Z]{5}$/.test(err.body.code)) return err.body.code;
  return null;
}
