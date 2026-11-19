import { z } from 'zod';

export const sslModes = ['disable', 'prefer', 'require', 'verify-full'] as const;
export const SslMode = z.enum(sslModes);
export type SslMode = z.infer<typeof SslMode>;

/** Window tint for a connection. `none` leaves the header neutral. */
export const connectionColors = ['none', 'red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const;
export const ConnectionColor = z.enum(connectionColors);
export type ConnectionColor = z.infer<typeof ConnectionColor>;

/** How the SSH tunnel authenticates: the macOS ssh-agent, or a private key file. */
export const SshAuth = z.enum(['agent', 'key']);
export type SshAuth = z.infer<typeof SshAuth>;

/**
 * An SSH tunnel (bastion) in front of the database. Kleos connects to the SSH host and
 * forwards each Postgres connection to `host:port` of the favorite as seen from there.
 */
export const SshConfig = z.object({
  host: z.string().trim().min(1),
  port: z.number().int().min(1).max(65535),
  user: z.string().trim().min(1),
  auth: SshAuth,
  /** Private key file for auth "key", e.g. ~/.ssh/id_ed25519. Its passphrase, if any, is in the Keychain. */
  keyPath: z.string().nullable(),
});
export type SshConfig = z.infer<typeof SshConfig>;

/** Every field of a favorite except the password, which lives in the Keychain. */
export const ConnectionConfig = z.object({
  nickname: z.string().trim().min(1).max(120),
  host: z.string().trim().min(1),
  port: z.number().int().min(1).max(65535),
  user: z.string().trim().min(1),
  database: z.string().trim().min(1),
  sslMode: SslMode,
  color: ConnectionColor,
  readOnly: z.boolean(),
  /** SSH tunnel, or null/absent to connect directly. (0.4) */
  ssh: SshConfig.nullable().optional(),
  /** PEM file of a private CA to trust for SSL (sslrootcert), or null/absent for the system CAs. (0.4) */
  sslRootCertPath: z.string().nullable().optional(),
});
export type ConnectionConfig = z.infer<typeof ConnectionConfig>;

/** Body of POST /connections and PUT /connections/:id. */
export const ConnectionInput = ConnectionConfig.extend({
  /** null keeps the stored password unchanged on update and stores none on create. */
  password: z.string().nullable(),
  /** When false, any stored Keychain entry is removed. */
  savePassword: z.boolean(),
  /** SSH key passphrase: null keeps the stored one; same Keychain rules as the password. (0.4) */
  sshPassphrase: z.string().nullable().optional(),
  saveSshPassphrase: z.boolean().optional(),
});
export type ConnectionInput = z.infer<typeof ConnectionInput>;

export const SavedConnection = ConnectionConfig.extend({
  id: z.string(),
  hasPassword: z.boolean(),
  /** Whether the Keychain holds an SSH key passphrase for this favorite. (0.4) */
  hasSshPassphrase: z.boolean().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SavedConnection = z.infer<typeof SavedConnection>;

/** Body of POST /connections/test: form values, nothing saved. */
export const TestConnectionRequest = ConnectionConfig.extend({
  password: z.string().nullable(),
  /** When set and password is null, the stored Keychain password of this favorite is used. */
  connectionId: z.string().optional(),
  sshPassphrase: z.string().nullable().optional(),
  /** Accept and remember this SSH host key fingerprint (after KLEOS_SSH_HOST_UNKNOWN). */
  trustSshFingerprint: z.string().optional(),
});
export type TestConnectionRequest = z.infer<typeof TestConnectionRequest>;

export const TestConnectionResult = z.object({
  version: z.string(),
  elapsedMs: z.number(),
});
export type TestConnectionResult = z.infer<typeof TestConnectionResult>;

/** Body of POST /sessions. */
export const OpenSessionRequest = z.object({
  connectionId: z.string(),
  /** Used instead of the Keychain when the favorite has no saved password. */
  password: z.string().nullable().optional(),
  sshPassphrase: z.string().nullable().optional(),
  /** Accept and remember this SSH host key fingerprint (after KLEOS_SSH_HOST_UNKNOWN). */
  trustSshFingerprint: z.string().optional(),
});
export type OpenSessionRequest = z.infer<typeof OpenSessionRequest>;

export const SessionInfo = z.object({
  sid: z.string(),
  connection: SavedConnection,
  serverVersion: z.string(),
  /** e.g. "16.4" */
  serverVersionShort: z.string(),
  /**
   * Things the user should know about this session, e.g. READ_ONLY_DBLINK: dblink is
   * installed, and dblink_exec writes through its own connection, which read-only can't cover. (0.4)
   */
  notices: z.array(z.object({ code: z.string(), message: z.string() })).optional(),
});
export type SessionInfo = z.infer<typeof SessionInfo>;

export type ConnectionFormValues = {
  nickname: string;
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
  sslMode: SslMode;
};

/**
 * Parses a postgres:// or postgresql:// URL into form values.
 * Returns null when the text is not such a URL, so a paste of plain text behaves normally.
 */
export function parseConnectionUrl(text: string): Partial<ConnectionFormValues> | null {
  const trimmed = text.trim();
  if (!/^postgres(ql)?:\/\//i.test(trimmed)) return null;
  let url: URL;
  try {
    // URL only parses special schemes reliably, so swap in http and keep the rest.
    url = new URL(trimmed.replace(/^postgres(ql)?:\/\//i, 'http://'));
  } catch {
    return null;
  }
  const values: Partial<ConnectionFormValues> = {};
  if (url.hostname) {
    values.host = decodeURIComponent(url.hostname.replace(/^\[(.*)\]$/, '$1'));
    values.nickname = values.host;
  }
  values.port = url.port || '5432';
  if (url.username) values.user = decodeURIComponent(url.username);
  if (url.password) values.password = decodeURIComponent(url.password);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (database) values.database = database;
  const sslmode = url.searchParams.get('sslmode');
  if (sslmode) {
    const normalized = sslmode === 'verify-ca' ? 'verify-full' : sslmode === 'allow' ? 'prefer' : sslmode;
    const parsed = SslMode.safeParse(normalized);
    if (parsed.success) values.sslMode = parsed.data;
  }
  return values;
}
