import { z } from 'zod';

/**
 * Every error response body. `code` is the Postgres SQLSTATE when the database raised it
 * (e.g. "42703"), otherwise one of Kleos's own codes below.
 */
export const ApiErrorBody = z.object({
  code: z.string(),
  message: z.string(),
  detail: z.string().optional(),
  hint: z.string().optional(),
  /** 1-based character position in the submitted SQL, from Postgres. */
  position: z.number().optional(),
  /** For POST /edits: index of the failing edit and the column at fault, when known. */
  editIndex: z.number().optional(),
  column: z.string().optional(),
  /** For POST /ddl: index of the statement (and change) that failed; nothing was applied. (0.6) */
  statementIndex: z.number().optional(),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBody>;

export const kleosErrorCodes = {
  unauthorized: 'KLEOS_UNAUTHORIZED',
  validation: 'KLEOS_VALIDATION',
  notFound: 'KLEOS_NOT_FOUND',
  sessionNotFound: 'KLEOS_SESSION_NOT_FOUND',
  queryNotFound: 'KLEOS_QUERY_NOT_FOUND',
  readOnly: 'KLEOS_READ_ONLY',
  noPrimaryKey: 'KLEOS_NO_PRIMARY_KEY',
  /** An edit affected a number of rows other than one. */
  rowCountMismatch: 'KLEOS_ROW_COUNT_MISMATCH',
  passwordRequired: 'KLEOS_PASSWORD_REQUIRED',
  connection: 'KLEOS_CONNECTION',
  /** The SSH host key isn't trusted yet; `detail` holds its SHA256 fingerprint. (0.4) */
  sshHostUnknown: 'KLEOS_SSH_HOST_UNKNOWN',
  /** The SSH host key differs from the trusted one; never connect. (0.4) */
  sshHostChanged: 'KLEOS_SSH_HOST_CHANGED',
  /** The SSH key is encrypted and no passphrase is available. (0.4) */
  sshPassphraseRequired: 'KLEOS_SSH_PASSPHRASE_REQUIRED',
  /** SSH could not connect or authenticate; the message is the library's. (0.4) */
  ssh: 'KLEOS_SSH',
  /** A file could not be read or written (export/import). (0.4) */
  file: 'KLEOS_FILE',
  jobNotFound: 'KLEOS_JOB_NOT_FOUND',
  internal: 'KLEOS_INTERNAL',
} as const;
