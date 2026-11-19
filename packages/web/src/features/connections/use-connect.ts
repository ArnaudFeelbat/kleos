import { kleosErrorCodes, type ConnectionInput, type SavedConnection } from '@kleos/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { api, ApiError, errorText, queryKeys } from '@/lib/api';
import { tabsStore } from '@/features/shell/tabs-store';
import { sessionRequest, targetOf, useCredentialPrompts, type Credentials } from './credential-flow';

export function isPasswordRequired(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401 && err.body.code === kleosErrorCodes.passwordRequired;
}

/**
 * PUT body that stores what the user asked to remember in a prompt and keeps every other
 * Keychain entry as it is (a false "save" flag would delete it).
 */
export function rememberInput(connection: SavedConnection, c: Credentials): ConnectionInput {
  const {
    id: _id,
    hasPassword,
    hasSshPassphrase,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    ...config
  } = connection;
  const passphrase = c.rememberSshPassphrase ? (c.sshPassphrase ?? null) : null;
  return {
    ...config,
    password: c.rememberPassword ? c.password : null,
    savePassword: c.rememberPassword === true || hasPassword,
    sshPassphrase: passphrase,
    saveSshPassphrase: passphrase !== null || hasSshPassphrase === true,
  };
}

/**
 * Connect flow: POST /sessions, asking what the server says is missing — trusting the SSH host
 * key, the SSH key passphrase, the Postgres password, in that order — then opens the server in
 * its own window tab. A favorite that already has a live tab is brought to front instead: one
 * tab per server. A restored tab still waiting to reconnect is replaced in place.
 */
export function useConnect() {
  const queryClient = useQueryClient();
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const prompts = useCredentialPrompts();
  const { start } = prompts;

  const remember = useCallback(
    async (connection: SavedConnection, c: Credentials) => {
      if (!c.rememberPassword && !c.rememberSshPassphrase) return;
      try {
        await api.updateConnection(connection.id, rememberInput(connection, c));
        await queryClient.invalidateQueries({ queryKey: queryKeys.connections });
      } catch (err) {
        const what = c.rememberPassword ? 'password' : 'passphrase';
        toast.error(`Connected, but the ${what} could not be saved`, { description: errorText(err) });
      }
    },
    [queryClient],
  );

  const connect = useCallback(
    async (connection: SavedConnection, password: string | null = null) => {
      const existing = tabsStore.findByConnection(connection.id);
      if (existing && !existing.restore) {
        tabsStore.activate(existing.sid);
        return;
      }
      setConnectingId(connection.id);
      try {
        await start({
          target: targetOf(connection),
          credentials: { password },
          attempt: async (c) => {
            const session = await api.openSession(sessionRequest(connection.id, c));
            const live = tabsStore.findByConnection(connection.id);
            if (live && !live.restore) {
              // A restored tab reconnected by itself meanwhile: keep that one, one tab per server.
              void api.closeSession(session.sid).catch(() => undefined);
              tabsStore.activate(live.sid);
            } else {
              tabsStore.open(session);
            }
            void remember(connection, c);
          },
          onFailure: (err) =>
            toast.error(`Could not connect to ${connection.nickname}`, { description: errorText(err) }),
        });
      } finally {
        setConnectingId(null);
      }
    },
    [start, remember],
  );

  return { connect, connectingId, prompts };
}
