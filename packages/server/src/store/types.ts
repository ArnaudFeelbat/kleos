import type {
  ConnectionConfig,
  GridLayout,
  HistoryEntry,
  HistorySearch,
  LayoutPositions,
  NewHistoryEntry,
  SavedConnection,
  SavedQuery,
  SavedQueryInput,
  Snippet,
  SnippetInput,
  WindowState,
} from '@kleos/shared';
import type { z } from 'zod';

/** GET /history?… after zod defaults: limit is always set. */
export type HistorySearchQuery = z.output<typeof HistorySearch>;

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
  /** Forgets the trusted key for host:port (like ssh-keygen -R); no-op when none. */
  forgetKnownHost(host: string, port: number): void;

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
  /**
   * Full-text search across servers (0.7), newest first: every word of `q` must match the SQL
   * or the error text as a prefix, ignoring case and punctuation. Outcome ok = no error and not
   * cancelled; error = has an error (a cancelled run carries its 57014); cancelled = cancelled.
   */
  searchHistory(search: HistorySearchQuery): HistoryEntry[];

  listSavedQueries(connectionId?: string): SavedQuery[];
  getSavedQuery(id: string): SavedQuery | null;
  /** paramValues absent is stored as null. */
  createSavedQuery(input: SavedQueryInput): SavedQuery;
  /** paramValues absent keeps the stored values, null clears them, an object replaces them. */
  updateSavedQuery(id: string, input: SavedQueryInput): SavedQuery;
  deleteSavedQuery(id: string): void;

  /** Every snippet, by name ignoring case. (0.7) */
  listSnippets(): Snippet[];
  /** A name already used, whatever its case, is a 409 KLEOS_VALIDATION. */
  createSnippet(input: SnippetInput): Snippet;
  /** Unknown id: 404. A name used by another snippet, whatever its case: 409 KLEOS_VALIDATION. */
  updateSnippet(id: string, input: SnippetInput): Snippet;
  /** Unknown ids are a no-op. */
  deleteSnippet(id: string): void;

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
