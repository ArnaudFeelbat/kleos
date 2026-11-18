import type { SavedConnection, SessionInfo } from '@kleos/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { WorkspaceContext, type WorkspaceState } from './context';

/** Test-only fixtures and providers for components that read WorkspaceContext. */
export const savedConnection: SavedConnection = {
  id: 'c1',
  nickname: 'shop_dev',
  host: 'localhost',
  port: 5432,
  user: 'kleos',
  database: 'shop_dev',
  sslMode: 'prefer',
  color: 'none',
  readOnly: false,
  hasPassword: true,
  createdAt: '2026-11-18T10:00:00Z',
  updatedAt: '2026-11-18T10:00:00Z',
};

export const sessionInfo: SessionInfo = {
  sid: 's1',
  connection: savedConnection,
  serverVersion: 'PostgreSQL 16.4 on aarch64-apple-darwin23',
  serverVersionShort: '16.4',
};

export function workspaceState(patch: Partial<WorkspaceState> = {}): WorkspaceState {
  return {
    sid: 's1',
    session: sessionInfo,
    connection: savedConnection,
    readOnly: false,
    visible: true,
    schemaModel: undefined,
    refreshSchema: vi.fn(async () => {}),
    currentSchema: 'public',
    setCurrentSchema: vi.fn(),
    selectedTable: null,
    openTable: vi.fn(),
    activeTab: 'schema',
    setActiveTab: vi.fn(),
    queryDraft: null,
    openInQuery: vi.fn(),
    ...patch,
  };
}

export function newQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

export function Providers({
  children,
  state,
  client = newQueryClient(),
}: {
  children: ReactNode;
  state?: WorkspaceState;
  client?: QueryClient;
}) {
  const inner = state ? <WorkspaceContext.Provider value={state}>{children}</WorkspaceContext.Provider> : children;
  return (
    <QueryClientProvider client={client}>
      <TooltipProvider>{inner}</TooltipProvider>
    </QueryClientProvider>
  );
}
