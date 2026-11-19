import { z } from 'zod';
import { ChartSettings } from './query';

/**
 * What the window restores on relaunch: the servers that were open (by favorite, never by
 * session) and each server's query tabs with their SQL. Stored in app.db; no passwords.
 */
export const RestoredQueryTab = z.object({
  title: z.string(),
  sql: z.string(),
  chart: ChartSettings.nullable(),
  /** Saved query this tab came from, if any (reconnected to it when it still exists). */
  savedQueryId: z.string().nullable(),
});
export type RestoredQueryTab = z.infer<typeof RestoredQueryTab>;

export const RestoredServer = z.object({
  connectionId: z.string(),
  queryTabs: z.array(RestoredQueryTab),
  activeQueryTab: z.number().int().min(0),
  /** Workspace tab that was in front: schema, data, query or monitor. */
  workspaceTab: z.enum(['schema', 'data', 'query', 'monitor']),
});
export type RestoredServer = z.infer<typeof RestoredServer>;

export const WindowState = z.object({
  servers: z.array(RestoredServer),
  /** Favorite whose tab was in front, or null for Connections. */
  activeConnectionId: z.string().nullable(),
});
export type WindowState = z.infer<typeof WindowState>;

export const emptyWindowState: WindowState = { servers: [], activeConnectionId: null };
