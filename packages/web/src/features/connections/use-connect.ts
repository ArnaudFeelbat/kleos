import { kleosErrorCodes, type SavedConnection } from '@kleos/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { api, ApiError, errorText, queryKeys } from '@/lib/api';
import { tabsStore } from '@/features/shell/tabs-store';

export type PasswordPrompt = {
  connection: SavedConnection;
  /** Error of the last attempt with a typed password, e.g. "28P01 password authentication failed". */
  error: string | null;
  submitting: boolean;
};

export function isPasswordRequired(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401 && err.body.code === kleosErrorCodes.passwordRequired;
}

/**
 * Connect flow: POST /sessions, prompting for a password when the favorite has none saved
 * (401 KLEOS_PASSWORD_REQUIRED), then opens the server in its own window tab. A favorite that
 * already has a tab is brought to front instead: one tab per server.
 */
export function useConnect() {
  const queryClient = useQueryClient();
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<PasswordPrompt | null>(null);

  const open = useCallback(async (connection: SavedConnection, password: string | null) => {
    const session = await api.openSession({ connectionId: connection.id, password });
    tabsStore.open(session);
  }, []);

  const connect = useCallback(
    async (connection: SavedConnection, password: string | null = null) => {
      const existing = tabsStore.findByConnection(connection.id);
      if (existing) {
        tabsStore.activate(existing.sid);
        return;
      }
      setConnectingId(connection.id);
      try {
        await open(connection, password);
      } catch (err) {
        if (isPasswordRequired(err)) {
          setPrompt({ connection, error: null, submitting: false });
        } else {
          toast.error(`Could not connect to ${connection.nickname}`, { description: errorText(err) });
        }
      } finally {
        setConnectingId(null);
      }
    },
    [open],
  );

  const submitPassword = useCallback(
    async (password: string, remember: boolean) => {
      if (!prompt) return;
      const { connection } = prompt;
      setPrompt({ ...prompt, submitting: true, error: null });
      try {
        await open(connection, password);
      } catch (err) {
        setPrompt({ connection, submitting: false, error: errorText(err) });
        return;
      }
      setPrompt(null);
      if (remember) {
        try {
          const { id: _id, hasPassword: _h, createdAt: _c, updatedAt: _u, ...config } = connection;
          await api.updateConnection(connection.id, { ...config, password, savePassword: true });
          await queryClient.invalidateQueries({ queryKey: queryKeys.connections });
        } catch (err) {
          toast.error('Connected, but the password could not be saved', { description: errorText(err) });
        }
      }
    },
    [open, prompt, queryClient],
  );

  const cancelPrompt = useCallback(() => setPrompt(null), []);

  return { connect, connectingId, prompt, submitPassword, cancelPrompt };
}
