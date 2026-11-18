import type {
  ConnectionConfig,
  HistoryEntry,
  LayoutPositions,
  NewHistoryEntry,
  SavedConnection,
  SavedQuery,
  SavedQueryInput,
} from '@kleos/shared';

/**
 * The app's own data, in one SQLite file (~/Library/Application Support/Kleos/app.db).
 * It never holds a password; `hasPassword` only records whether the Keychain has one.
 */
export interface AppStore {
  listConnections(): SavedConnection[];
  getConnection(id: string): SavedConnection | null;
  createConnection(config: ConnectionConfig, hasPassword: boolean): SavedConnection;
  updateConnection(id: string, config: ConnectionConfig, hasPassword: boolean): SavedConnection;
  /** Also removes the connection's history, layouts and saved queries. */
  deleteConnection(id: string): void;

  getLayout(connectionId: string, schema: string): LayoutPositions;
  saveLayout(connectionId: string, schema: string, layout: LayoutPositions): void;

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

/** Passwords, kept in the macOS Keychain under service "kleos", account = connection id. */
export interface SecretStore {
  get(connectionId: string): Promise<string | null>;
  set(connectionId: string, password: string): Promise<void>;
  delete(connectionId: string): Promise<void>;
}
