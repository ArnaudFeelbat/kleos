import type { SavedConnection } from '@kleos/shared';
import { createContext, useContext, type ReactNode } from 'react';
import { CredentialDialogs } from './ssh-dialogs';
import { useConnect } from './use-connect';

type ConnectActions = {
  /**
   * Opens the favorite in a window tab (or brings its tab back), asking for whatever the
   * server needs first: trust in the SSH host key, the SSH key passphrase, the password.
   */
  connect(connection: SavedConnection, password?: string | null): Promise<void>;
  /** Favorite whose session is being opened, for spinners. */
  connectingId: string | null;
};

const ConnectContext = createContext<ConnectActions | null>(null);

/**
 * Owns the connect flow for the whole window, so the Connections tab, the ⌘K palette and a
 * restored tab's Connect button share one set of prompts.
 */
export function ConnectProvider({ children }: { children: ReactNode }) {
  const { connect, connectingId, prompts } = useConnect();
  return (
    <ConnectContext.Provider value={{ connect, connectingId }}>
      {children}
      <CredentialDialogs prompts={prompts} />
    </ConnectContext.Provider>
  );
}

export function useConnectActions(): ConnectActions {
  const actions = useContext(ConnectContext);
  if (!actions) throw new Error('useConnectActions must be used inside ConnectProvider');
  return actions;
}
