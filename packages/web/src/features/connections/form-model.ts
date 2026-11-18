import {
  parseConnectionUrl,
  type ConnectionColor,
  type ConnectionInput,
  type SavedConnection,
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
  color: ConnectionColor;
  readOnly: boolean;
  savePassword: boolean;
};

export type FormField = keyof FormState;
export type FormErrors = Partial<Record<'host' | 'port' | 'user' | 'nickname', string>>;

/** Spec defaults. The browser cannot know the macOS user name, so User starts empty. */
export const emptyForm: FormState = {
  nickname: '',
  host: 'localhost',
  port: '5432',
  user: '',
  password: '',
  database: '',
  sslMode: 'prefer',
  color: 'none',
  readOnly: false,
  savePassword: true,
};

export function formFromSaved(saved: SavedConnection): FormState {
  return {
    nickname: saved.nickname,
    host: saved.host,
    port: String(saved.port),
    user: saved.user,
    // The stored password never leaves the Keychain; an empty field means "keep it".
    password: '',
    database: saved.database,
    sslMode: saved.sslMode,
    color: saved.color,
    readOnly: saved.readOnly,
    savePassword: saved.hasPassword,
  };
}

/**
 * Applies a pasted postgres:// URL to the whole form. Returns null when the text is not such a
 * URL (the paste then behaves normally). Connection fields absent from the URL fall back to the
 * defaults; color and read-only are kept. The nickname follows the host unless the user named it.
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

export function validateForm(form: FormState): FormErrors {
  const errors: FormErrors = {};
  if (!form.host.trim()) errors.host = 'Host is required.';
  const port = form.port.trim();
  if (!/^\d+$/.test(port)) errors.port = 'Port must be a number.';
  else if (Number(port) < 1 || Number(port) > 65535) errors.port = 'Port must be between 1 and 65535.';
  if (!form.user.trim()) errors.user = 'User is required.';
  if (form.nickname.trim().length > 120) errors.nickname = 'Nickname is at most 120 characters.';
  return errors;
}

/** Nickname defaults to the host; database defaults to the user, as in psql. */
export function effectiveNickname(form: FormState): string {
  return form.nickname.trim() || form.host.trim();
}

function configOf(form: FormState) {
  const user = form.user.trim();
  return {
    nickname: effectiveNickname(form),
    host: form.host.trim(),
    port: Number(form.port.trim()),
    user,
    database: form.database.trim() || user,
    sslMode: form.sslMode,
    color: form.color,
    readOnly: form.readOnly,
  };
}

/** Body for POST/PUT /connections. An empty password keeps the stored one (null). */
export function toConnectionInput(form: FormState): ConnectionInput {
  return { ...configOf(form), password: form.password === '' ? null : form.password, savePassword: form.savePassword };
}

/** Body for POST /connections/test; a saved favorite falls back to its Keychain password. */
export function toTestRequest(form: FormState, connectionId: string | null): TestConnectionRequest {
  return {
    ...configOf(form),
    password: form.password === '' ? null : form.password,
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
