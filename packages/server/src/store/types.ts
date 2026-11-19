import type {
  ConnectionConfig,
  GridLayout,
  HistoryEntry,
  LayoutPositions,
  NewHistoryEntry,
  SavedConnection,
  SavedQuery,
  SavedQueryInput,
  WindowState,
} from '@kleos/shared';

/**
 * The app's own data, in one SQLite file (~/Library/Application Support/Kleos/app.db).
 * It never holds a password; `hasPassword` only records whether the Keychain has one.
 */
export interface AppStore {
  listConnections(): SavedConnection[];
  getConnection(id: string): SavedConnection | null;
  /** `ssh` and `sslRootCertPath` absent are stored as null; hasSshPassphrase defaults to false. */
  createConnection(config: ConnectionConfig, hasPassword: boolean, hasSshPassphrase?: boolean): SavedConnection;
  /** hasSshPassphrase undefined keeps the stored flag. */
  updateConnection(
    id: string,
    config: ConnectionConfig,
    hasPassword: boolean,
    hasSshPassphrase?: boolean,
  ): SavedConnection;
  /** Also removes the connection's history, layouts, grid layouts and saved queries. */
  deleteConnection(id: string): void;

  /** SSH host keys trusted on first use, by SSH host and port. */
  getKnownHost(host: string, port: number): string | null;
  /** Records the fingerprint for host:port, replacing any previous one. */
  trustKnownHost(host: string, port: number, fingerprint: string): void;

  /**
   * The window to restore (emptyWindowState when none is saved or the saved JSON is no longer
   * valid). Servers whose favorite was deleted since are left out.
   */
  getWindowState(): WindowState;
  saveWindowState(state: WindowState): void;

  getLayout(connectionId: string, schema: string): LayoutPositions;
  saveLayout(connectionId: string, schema: string, layout: LayoutPositions): void;

  /** A table's column order and widths in the Data tab; emptyGridLayout when none is saved. */
  getGridLayout(connectionId: string, schema: string, table: string): GridLayout;
  /** Replaces the saved layout; an unknown connection is a 404. */
  saveGridLayout(connectionId: string, schema: string, table: string, layout: GridLayout): void;

  /** Newest first. */
  listHistory(connectionId: string, limit?: number): HistoryEntry[];
  /** Keeps only the latest 1,000 entries per connection. */
  addHistory(connectionId: string, entry: NewHistoryEntry): HistoryEntry;

  listSavedQueries(connectionId?: string): SavedQuery[];
  getSavedQuery(id: string): SavedQuery | null;
  createSavedQuery(input: SavedQueryInput): SavedQuery;
  updateSavedQuery(id: string, input: SavedQueryInput): SavedQuery;
  deleteSavedQuery(id: string): void;

  close(): void;
}

/**
 * Passwords, kept in the macOS Keychain under service "kleos", account = connection id. The SSH
 * key passphrase of a favorite uses the account sshSecretAccount(connection id).
 */
export interface SecretStore {
  get(connectionId: string): Promise<string | null>;
  set(connectionId: string, password: string): Promise<void>;
  delete(connectionId: string): Promise<void>;
}

/** Keychain account of a favorite's SSH key passphrase. */
export function sshSecretAccount(connectionId: string): string {
  return `${connectionId}:ssh`;
}
