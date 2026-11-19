import { kleosErrorCodes, type OpenSessionRequest, type SavedConnection, type SshConfig } from '@kleos/shared';
import { useCallback, useRef, useState } from 'react';
import { ApiError, api, errorText } from '@/lib/api';
import { connectionSubtitle } from './form-model';

/** What a prompt names: the favorite (or the unsaved form) and its SSH hop, if any. */
export type PromptTarget = {
  name: string;
  /** "user@host:port/db" */
  subtitle: string;
  ssh: SshConfig | null;
};

/** Credentials gathered across prompts; every retry sends all of them. */
export type Credentials = {
  password: string | null;
  sshPassphrase?: string;
  /** SHA256 fingerprint the user accepted in "Trust this server?". */
  trustSshFingerprint?: string;
  /** "Save … in Keychain" ticked in the password or passphrase prompt. */
  rememberPassword?: boolean;
  rememberSshPassphrase?: boolean;
};

/**
 * The questions a connection attempt can raise, in the order they come up: the SSH host key
 * (unknown or changed), the SSH key passphrase, then the Postgres password.
 */
export type CredentialPromptKind = 'ssh-trust' | 'ssh-changed' | 'ssh-passphrase' | 'password';

export type CredentialPrompt = {
  kind: CredentialPromptKind;
  target: PromptTarget;
  /** SHA256 fingerprint of the SSH host key, for ssh-trust and ssh-changed. */
  fingerprint: string | null;
  /** Error of the last attempt made from this prompt, e.g. a wrong passphrase. */
  error: string | null;
  submitting: boolean;
};

/** The prompt an API error asks for, or null when it is a plain failure. */
export function credentialPromptFor(err: unknown): CredentialPromptKind | null {
  if (!(err instanceof ApiError)) return null;
  switch (err.body.code) {
    case kleosErrorCodes.sshHostUnknown:
      return 'ssh-trust';
    case kleosErrorCodes.sshHostChanged:
      return 'ssh-changed';
    case kleosErrorCodes.sshPassphraseRequired:
      return 'ssh-passphrase';
    case kleosErrorCodes.passwordRequired:
      return 'password';
    default:
      return null;
  }
}

export function targetOf(connection: SavedConnection): PromptTarget {
  return { name: connection.nickname, subtitle: connectionSubtitle(connection), ssh: connection.ssh ?? null };
}

/** POST /sessions body: only the credentials gathered so far, nothing else. */
export function sessionRequest(connectionId: string, c: Credentials): OpenSessionRequest {
  return {
    connectionId,
    password: c.password,
    ...(c.sshPassphrase !== undefined ? { sshPassphrase: c.sshPassphrase } : {}),
    ...(c.trustSshFingerprint ? { trustSshFingerprint: c.trustSshFingerprint } : {}),
  };
}

export type FlowOptions = {
  target: PromptTarget;
  credentials: Credentials;
  /** One try with these credentials; throws the API error on failure. */
  attempt(credentials: Credentials): Promise<void>;
  /** A failure no prompt can fix (the caller shows it its own way: a toast, the test result). */
  onFailure(err: unknown): void;
  /** Prompts this flow may raise; any other prompt-worthy error is a plain failure. */
  kinds?: readonly CredentialPromptKind[];
};

const allKinds: readonly CredentialPromptKind[] = ['ssh-trust', 'ssh-changed', 'ssh-passphrase', 'password'];

/**
 * Whether a failed retry belongs in the prompt it came from, so the user can type again: any
 * failure after a password (e.g. 28P01), an SSH failure after a passphrase (a wrong one).
 * Anything else — e.g. Postgres refusing after the host key was trusted — is a plain failure.
 */
function staysInPrompt(kind: CredentialPromptKind, err: unknown): boolean {
  if (kind === 'password') return true;
  if (kind === 'ssh-passphrase') return err instanceof ApiError && err.body.code === kleosErrorCodes.ssh;
  return false;
}

/**
 * Runs an attempt (open a session, test a connection) and asks the user whatever the server
 * says is missing, then retries with everything gathered so far. A retry may raise the next
 * question (e.g. trusting the host key, then the password): the prompts chain until it works,
 * fails plainly, or the user cancels.
 */
export function useCredentialPrompts() {
  const [prompt, setPrompt] = useState<CredentialPrompt | null>(null);
  const flow = useRef<FlowOptions | null>(null);

  /** Resolves true when the attempt worked; false when it is waiting on a prompt or failed. */
  const run = useCallback(async (next: FlowOptions, from: CredentialPrompt | null): Promise<boolean> => {
    flow.current = next;
    try {
      await next.attempt(next.credentials);
    } catch (err) {
      // Cancelled while the attempt was in flight: the user no longer wants an answer.
      if (flow.current !== next) return false;
      const kind = credentialPromptFor(err);
      if (kind && (next.kinds ?? allKinds).includes(kind) && kind !== from?.kind) {
        const detail = err instanceof ApiError ? (err.body.detail ?? null) : null;
        setPrompt({ kind, target: next.target, fingerprint: detail, error: null, submitting: false });
        return false;
      }
      if (from && staysInPrompt(from.kind, err)) {
        setPrompt({ ...from, submitting: false, error: errorText(err) });
        return false;
      }
      flow.current = null;
      setPrompt(null);
      next.onFailure(err);
      return false;
    }
    if (flow.current === next) {
      flow.current = null;
      setPrompt(null);
    }
    return true;
  }, []);

  /** First try; prompts and failures are handled as described on the hook. */
  const start = useCallback((options: FlowOptions) => run(options, null), [run]);

  const retry = useCallback(
    async (patch: Partial<Credentials>) => {
      const current = flow.current;
      if (!current || !prompt) return;
      setPrompt({ ...prompt, submitting: true, error: null });
      await run({ ...current, credentials: { ...current.credentials, ...patch } }, prompt);
    },
    [prompt, run],
  );

  const submitPassword = useCallback(
    (password: string, remember: boolean) => retry({ password, rememberPassword: remember }),
    [retry],
  );
  const submitPassphrase = useCallback(
    (sshPassphrase: string, remember: boolean) => retry({ sshPassphrase, rememberSshPassphrase: remember }),
    [retry],
  );
  const trustHost = useCallback(
    () => (prompt?.fingerprint ? retry({ trustSshFingerprint: prompt.fingerprint }) : Promise.resolve()),
    [prompt, retry],
  );
  /**
   * After the user confirmed the SSH server's key really changed (reinstall, new host): forget
   * the old key, then retry trusting the new one — what `ssh-keygen -R` + reconnect does.
   */
  const replaceHostKey = useCallback(async () => {
    const ssh = prompt?.target.ssh;
    const fingerprint = prompt?.fingerprint;
    if (!prompt || prompt.kind !== 'ssh-changed' || !ssh || !fingerprint) return;
    setPrompt({ ...prompt, submitting: true, error: null });
    try {
      await api.forgetSshHost(ssh.host, ssh.port);
    } catch (err) {
      setPrompt({ ...prompt, submitting: false, error: errorText(err) });
      return;
    }
    await retry({ trustSshFingerprint: fingerprint });
  }, [prompt, retry]);
  const cancel = useCallback(() => {
    flow.current = null;
    setPrompt(null);
  }, []);

  return { prompt, start, submitPassword, submitPassphrase, trustHost, replaceHostKey, cancel };
}

export type CredentialPrompts = ReturnType<typeof useCredentialPrompts>;
