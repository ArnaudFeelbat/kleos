import type { SavedConnection } from '@kleos/shared';
import { createContext, useContext, type ReactNode } from 'react';
import { PasswordDialog } from './password-dialog';
import { useConnect } from './use-connect';

type ConnectActions = {
  /** Opens the favorite in a window tab (or brings its tab back), prompting for a password when needed. */
  connect(connection: SavedConnection, password?: string | null): Promise<void>;
  /** Favorite whose session is being opened, for spinners. */
  connectingId: string | null;
};

const ConnectContext = createContext<ConnectActions | null>(null);

/**
 * Owns the connect flow for the whole window, so the Connections tab and the ⌘K palette
 * share one password prompt.
 */
export function ConnectProvider({ children }: { children: ReactNode }) {
  const { connect, connectingId, prompt, submitPassword, cancelPrompt } = useConnect();
  return (
    <ConnectContext.Provider value={{ connect, connectingId }}>
      {children}
      <PasswordDialog
        prompt={prompt}
        onSubmit={(password, remember) => void submitPassword(password, remember)}
        onCancel={cancelPrompt}
      />
    </ConnectContext.Provider>
  );
}

export function useConnectActions(): ConnectActions {
  const actions = useContext(ConnectContext);
  if (!actions) throw new Error('useConnectActions must be used inside ConnectProvider');
  return actions;
}
