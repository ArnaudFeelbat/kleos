import { createContext, useContext } from 'react';
import type { SavedConnection, SchemaModel, SessionInfo, TableRef } from '@kleos/shared';

export type WorkspaceTab = 'schema' | 'data' | 'query' | 'monitor';

/**
 * Shared state of one workspace window (one connection, one session).
 * Owned and provided by WorkspaceScreen; read by every tab.
 */
export type WorkspaceState = {
  sid: string;
  session: SessionInfo;
  connection: SavedConnection;
  /** Read-only connections never offer editing; the session also refuses writes. */
  readOnly: boolean;
  /**
   * True while this connection's window tab is in front. Several workspaces stay mounted
   * (one per connection tab); anything window-wide — keyboard shortcuts, polling — must
   * also require `visible`, not only its own `activeTab`.
   */
  visible: boolean;

  /** Introspected schema; undefined while the first introspection runs. */
  schemaModel: SchemaModel | undefined;
  /** Re-reads pg_catalog (GET /schema?refresh=1). */
  refreshSchema(): Promise<void>;

  /** Schema picked in the sidebar picker, e.g. "public". */
  currentSchema: string;
  setCurrentSchema(schema: string): void;

  /** Table or view selected in the sidebar / diagram. */
  selectedTable: TableRef | null;
  /** Selects a table and, when given, switches to that tab. */
  openTable(ref: TableRef, tab?: WorkspaceTab): void;

  activeTab: WorkspaceTab;
  setActiveTab(tab: WorkspaceTab): void;

  /**
   * SQL handed to the Query tab from elsewhere ("Open in query"). The Query tab opens
   * it in a new query tab when `nonce` changes, then ignores it.
   */
  queryDraft: { sql: string; nonce: number } | null;
  openInQuery(sql: string): void;
};

export const WorkspaceContext = createContext<WorkspaceState | null>(null);

export function useWorkspace(): WorkspaceState {
  const state = useContext(WorkspaceContext);
  if (!state) throw new Error('useWorkspace must be used inside WorkspaceContext');
  return state;
}
