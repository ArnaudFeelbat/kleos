import { kleosErrorCodes, type ApiErrorBody } from '@kleos/shared';

/** An error with a chosen HTTP status and body. Throw it anywhere; the app's onError serializes it. */
export class KleosError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiErrorBody,
  ) {
    super(body.message);
    this.name = 'KleosError';
  }

  static notFound(message: string) {
    return new KleosError(404, { code: kleosErrorCodes.notFound, message });
  }
  static validation(message: string, detail?: string) {
    return new KleosError(400, { code: kleosErrorCodes.validation, message, ...(detail ? { detail } : {}) });
  }
}

type PgLikeError = {
  code?: unknown;
  message?: unknown;
  detail?: unknown;
  hint?: unknown;
  position?: unknown;
  severity?: unknown;
};

/** True for errors raised by Postgres itself (they carry a 5-character SQLSTATE). */
export function isPgError(err: unknown): err is PgLikeError & { code: string; message: string } {
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as PgLikeError).code === 'string' &&
    /^[0-9A-Z]{5}$/.test((err as PgLikeError).code as string) &&
    typeof (err as PgLikeError).message === 'string'
  );
}

/** Builds the API body from a Postgres error, keeping code, detail, hint and position. */
export function pgErrorBody(err: PgLikeError & { code: string; message: string }): ApiErrorBody {
  const body: ApiErrorBody = { code: err.code, message: err.message };
  if (typeof err.detail === 'string' && err.detail) body.detail = err.detail;
  if (typeof err.hint === 'string' && err.hint) body.hint = err.hint;
  const position = typeof err.position === 'string' ? Number.parseInt(err.position, 10) : err.position;
  if (typeof position === 'number' && Number.isFinite(position)) body.position = position;
  return body;
}

/**
 * Network and protocol failures from the driver (no SQLSTATE): host unreachable,
 * SSL required, connection refused. Message kept as the driver wrote it.
 */
export function connectionErrorBody(err: unknown): ApiErrorBody {
  const message = err instanceof Error ? err.message : String(err);
  const code = typeof (err as { code?: unknown })?.code === 'string' ? (err as { code: string }).code : undefined;
  return { code: kleosErrorCodes.connection, message, ...(code ? { detail: code } : {}) };
}
