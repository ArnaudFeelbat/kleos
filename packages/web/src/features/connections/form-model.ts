import {
  parseConnectionUrl,
  type ConnectionColor,
  type ConnectionInput,
  type SavedConnection,
  type SshAuth,
  type SshConfig,
  type SslMode,
  type TestConnectionRequest,
} from '@kleos/shared';

/** Login form state; numbers stay strings until validation so the user can type freely. */
export type FormState = {
  nickname: string;
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
  sslMode: SslMode;
  /** PEM file of a private CA (sslrootcert); only sent when the SSL mode requires TLS. */
  sslRootCertPath: string;
  color: ConnectionColor;
  readOnly: boolean;
  savePassword: boolean;
  /** "Connect through SSH". The SSH fields are kept while it is off, but not sent. */
  sshEnabled: boolean;
  sshHost: string;
  sshPort: string;
  sshUser: string;
  sshAuth: SshAuth;
  sshKeyPath: string;
  /** Empty keeps the stored passphrase, as the password field does. */
  sshPassphrase: string;
  saveSshPassphrase: boolean;
};

export type FormField = keyof FormState;
export type FormErrors = Partial<
  Record<'host' | 'port' | 'user' | 'nickname' | 'sshHost' | 'sshPort' | 'sshUser' | 'sshKeyPath', string>
>;

/** Spec defaults. The browser cannot know the macOS user name, so User starts empty. */
export const emptyForm: FormState = {
  nickname: '',
  host: 'localhost',
  port: '5432',
  user: '',
  password: '',
  database: '',
  sslMode: 'prefer',
  sslRootCertPath: '',
  color: 'none',
  readOnly: false,
  savePassword: true,
  sshEnabled: false,
  sshHost: '',
  sshPort: '22',
  sshUser: '',
  sshAuth: 'agent',
  sshKeyPath: '',
  sshPassphrase: '',
  saveSshPassphrase: true,
};

/** The SSL modes that require TLS, where a private CA certificate can apply. */
export function usesCaCertificate(sslMode: SslMode): boolean {
  return sslMode === 'require' || sslMode === 'verify-full';
}

export function formFromSaved(saved: SavedConnection): FormState {
  const ssh = saved.ssh ?? null;
  return {
    nickname: saved.nickname,
    host: saved.host,
    port: String(saved.port),
    user: saved.user,
    // The stored password never leaves the Keychain; an empty field means "keep it".
    password: '',
    database: saved.database,
    sslMode: saved.sslMode,
    sslRootCertPath: saved.sslRootCertPath ?? '',
    color: saved.color,
    readOnly: saved.readOnly,
    savePassword: saved.hasPassword,
    sshEnabled: ssh !== null,
    sshHost: ssh?.host ?? '',
    sshPort: String(ssh?.port ?? 22),
    sshUser: ssh?.user ?? '',
    sshAuth: ssh?.auth ?? 'agent',
    sshKeyPath: ssh?.keyPath ?? '',
    sshPassphrase: '',
    // A new key file is remembered by default, like a new password; an existing favorite says what it has.
    saveSshPassphrase: ssh ? (saved.hasSshPassphrase ?? false) : true,
  };
}

/**
 * Applies a pasted postgres:// URL to the whole form. Returns null when the text is not such a
 * URL (the paste then behaves normally). Connection fields absent from the URL fall back to the
 * defaults; color, read-only, SSH and CA settings are kept. The nickname follows the host unless
 * the user named it.
 */
export function applyConnectionUrl(form: FormState, text: string): FormState | null {
  const parsed = parseConnectionUrl(text);
  if (!parsed) return null;
  const nicknameWasDefault = form.nickname.trim() === '' || form.nickname.trim() === form.host.trim();
  return {
    ...form,
    host: parsed.host ?? emptyForm.host,
    port: parsed.port ?? emptyForm.port,
    user: parsed.user ?? '',
    password: parsed.password ?? '',
    database: parsed.database ?? '',
    sslMode: parsed.sslMode ?? emptyForm.sslMode,
    nickname: nicknameWasDefault ? (parsed.nickname ?? '') : form.nickname,
  };
}

function portError(text: string): string | undefined {
  const port = text.trim();
  if (!/^\d+$/.test(port)) return 'Port must be a number.';
  if (Number(port) < 1 || Number(port) > 65535) return 'Port must be between 1 and 65535.';
  return undefined;
}

export function validateForm(form: FormState): FormErrors {
  const errors: FormErrors = {};
  if (!form.host.trim()) errors.host = 'Host is required.';
  const port = portError(form.port);
  if (port) errors.port = port;
  if (!form.user.trim()) errors.user = 'User is required.';
  if (form.nickname.trim().length > 120) errors.nickname = 'Nickname is at most 120 characters.';
  if (form.sshEnabled) {
    if (!form.sshHost.trim()) errors.sshHost = 'SSH host is required.';
    const sshPort = portError(form.sshPort);
    if (sshPort) errors.sshPort = sshPort;
    if (!form.sshUser.trim()) errors.sshUser = 'SSH user is required.';
    if (form.sshAuth === 'key' && !form.sshKeyPath.trim()) errors.sshKeyPath = 'Choose a private key file.';
  }
  return errors;
}

/** Nickname defaults to the host; database defaults to the user, as in psql. */
export function effectiveNickname(form: FormState): string {
  return form.nickname.trim() || form.host.trim();
}

function sshOf(form: FormState): SshConfig | null {
  if (!form.sshEnabled) return null;
  return {
    host: form.sshHost.trim(),
    port: Number(form.sshPort.trim()),
    user: form.sshUser.trim(),
    auth: form.sshAuth,
    keyPath: form.sshAuth === 'key' ? form.sshKeyPath.trim() : null,
  };
}

/** Whether the form's SSH tunnel authenticates with a key file, whose passphrase may matter. */
function usesKeyFile(form: FormState): boolean {
  return form.sshEnabled && form.sshAuth === 'key';
}

function configOf(form: FormState) {
  const user = form.user.trim();
  const caPath = form.sslRootCertPath.trim();
  return {
    nickname: effectiveNickname(form),
    host: form.host.trim(),
    port: Number(form.port.trim()),
    user,
    database: form.database.trim() || user,
    sslMode: form.sslMode,
    color: form.color,
    readOnly: form.readOnly,
    ssh: sshOf(form),
    // A CA only means something when TLS is required; otherwise drop it rather than store a dead path.
    sslRootCertPath: usesCaCertificate(form.sslMode) && caPath ? caPath : null,
  };
}

/**
 * Body for POST/PUT /connections. An empty password or passphrase keeps the stored one (null).
 * Without a key file there is no passphrase to keep, so its Keychain entry is dropped.
 */
export function toConnectionInput(form: FormState): ConnectionInput {
  const keyFile = usesKeyFile(form);
  return {
    ...configOf(form),
    password: form.password === '' ? null : form.password,
    savePassword: form.savePassword,
    sshPassphrase: keyFile && form.sshPassphrase !== '' ? form.sshPassphrase : null,
    saveSshPassphrase: keyFile && form.saveSshPassphrase,
  };
}

/** Body for POST /connections/test; a saved favorite falls back to its Keychain password and passphrase. */
export function toTestRequest(form: FormState, connectionId: string | null): TestConnectionRequest {
  return {
    ...configOf(form),
    password: form.password === '' ? null : form.password,
    ...(usesKeyFile(form) && form.sshPassphrase !== '' ? { sshPassphrase: form.sshPassphrase } : {}),
    ...(connectionId ? { connectionId } : {}),
  };
}

/** "user@host:port/db", the favorites list subtitle. */
export function connectionSubtitle(c: Pick<SavedConnection, 'user' | 'host' | 'port' | 'database'>): string {
  return `${c.user}@${c.host}:${c.port}/${c.database}`;
}

export function sameForm(a: FormState, b: FormState): boolean {
  return (Object.keys(a) as FormField[]).every((k) => a[k] === b[k]);
}

/** Host, port and SSH tunnel as they will be saved: the way the server is reached. */
function serverOf(form: FormState) {
  const config = configOf(form);
  const ssh = config.ssh;
  return {
    host: config.host.toLowerCase(),
    port: config.port,
    tunnel: ssh ? `${ssh.user}@${ssh.host}:${ssh.port}` : null,
  };
}

/**
 * Whether both forms reach the same Postgres server the same way (host, port, SSH tunnel). The
 * server applies the same rule before it copies a stored password to a new favorite, and Test
 * only falls back to a favorite's stored password under it: a password never goes to another host.
 */
export function sameServer(a: FormState, b: FormState): boolean {
  const x = serverOf(a);
  const y = serverOf(b);
  return x.host === y.host && x.port === y.port && x.tunnel === y.tunnel;
}

/**
 * Whether an edited favorite now points somewhere else: another server (host, port, SSH tunnel),
 * database or user. Typing another server's details over a saved favorite is a reflex for
 * "connect to that one", so Kleos makes a new favorite then, instead of rewriting this one (0.7.2).
 * The nickname, color, read-only, password and SSL settings only adjust the same favorite.
 */
export function pointsElsewhere(form: FormState, saved: FormState): boolean {
  const a = configOf(form);
  const b = configOf(saved);
  return !sameServer(form, saved) || a.user !== b.user || a.database !== b.database;
}

/** `name`, or `name 2`, `name 3`… — the first one no other favorite has (ignoring case). */
export function uniqueName(name: string, taken: readonly string[]): string {
  const used = new Set(taken.map((t) => t.trim().toLowerCase()));
  if (!used.has(name.toLowerCase())) return name;
  for (let n = 2; ; n += 1) {
    const candidate = `${name} ${n}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * The nickname of a favorite made from `saved`: the one the user typed if they renamed it, else
 * "<database> on <host>" (what changed is usually one of those), never a name already taken.
 */
export function nameForNewFavorite(form: FormState, saved: FormState, taken: readonly string[]): string {
  const typed = form.nickname.trim();
  if (typed !== '' && typed !== saved.nickname.trim()) return typed;
  const config = configOf(form);
  return uniqueName(`${config.database} on ${config.host}`, taken);
}
