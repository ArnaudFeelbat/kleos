import { kleosErrorCodes, type SessionInfo, type TableRef } from '@kleos/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, Code, Lock, Network, Table2, Unplug } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DataTab } from '@/features/data/data-tab';
import { MonitorTab } from '@/features/monitor/monitor-tab';
import { QueryTab } from '@/features/query/query-tab';
import { SchemaTab } from '@/features/schema/schema-tab';
import { api, ApiError, errorText, queryKeys } from '@/lib/api';
import { WorkspaceContext, type WorkspaceState, type WorkspaceTab } from './context';
import { SchemaSidebar } from './schema-sidebar';
import { defaultSchema } from './sidebar-model';
import { TabToolbarSlotContext } from './tab-toolbar';

export function isSessionGone(err: unknown): boolean {
  return err instanceof ApiError && (err.body.code === kleosErrorCodes.sessionNotFound || err.status === 404);
}

/**
 * Workspace window for one session: title bar tinted by connection color, schema sidebar, and
 * the Schema / Data / Query / Monitor tabs. Provides WorkspaceContext.
 */
export function WorkspaceScreen({ sid }: { sid: string }) {
  const session = useQuery({
    queryKey: queryKeys.session(sid),
    queryFn: () => api.getSession(sid),
    staleTime: Infinity,
  });

  if (session.isPending) {
    return (
      <Frame>
        <p className="text-muted-foreground m-auto">Opening the session…</p>
      </Frame>
    );
  }
  if (session.isError) {
    const gone = isSessionGone(session.error);
    return (
      <Frame>
        <div role="alert" className="m-auto flex max-w-md flex-col items-center gap-3 text-center">
          <Unplug className="text-muted-foreground size-8" aria-hidden="true" />
          <h1 className="text-[15px] font-semibold">
            {gone ? 'This session has ended' : 'Could not open the session'}
          </h1>
          <p className="text-muted-foreground">
            {gone
              ? 'The database session behind this window no longer exists, usually because Kleos was restarted. Close this window and connect again from the start window.'
              : errorText(session.error)}
          </p>
          <div className="flex gap-2">
            {!gone && (
              <Button variant="outline" size="sm" onClick={() => void session.refetch()}>
                Retry
              </Button>
            )}
            <Button size="sm" onClick={() => window.close()}>
              Close window
            </Button>
          </div>
        </div>
      </Frame>
    );
  }
  return <Workspace sid={sid} session={session.data} />;
}

/** Title bar + body used while the session loads or failed. */
function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col">
      <header className="app-drag bg-chrome flex h-10 shrink-0 items-center border-b pl-20 font-semibold">
        <span className="flex-1 pr-20 text-center">Kleos</span>
      </header>
      <div className="flex min-h-0 flex-1 p-6">{children}</div>
    </div>
  );
}

const tabs: { value: WorkspaceTab; label: string; icon: ReactNode }[] = [
  { value: 'schema', label: 'Schema', icon: <Network aria-hidden="true" /> },
  { value: 'data', label: 'Data', icon: <Table2 aria-hidden="true" /> },
  { value: 'query', label: 'Query', icon: <Code aria-hidden="true" /> },
  { value: 'monitor', label: 'Monitor', icon: <Activity aria-hidden="true" /> },
];

function Workspace({ sid, session }: { sid: string; session: SessionInfo }) {
  const state = useWorkspaceState(sid, session);
  const [visited, setVisited] = useState<ReadonlySet<WorkspaceTab>>(() => new Set([state.activeTab]));
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  const { connection } = session;

  if (!visited.has(state.activeTab)) setVisited(new Set([...visited, state.activeTab]));

  useEffect(() => {
    window.kleos?.setTitle(connection.nickname);
  }, [connection.nickname]);

  const content: Record<WorkspaceTab, ReactNode> = {
    schema: <SchemaTab />,
    data: <DataTab />,
    query: <QueryTab />,
    monitor: <MonitorTab />,
  };

  return (
    <WorkspaceContext.Provider value={state.value}>
      <TabToolbarSlotContext.Provider value={slot}>
        <div className="flex h-full flex-col">
          <header
            data-tint={connection.color === 'none' ? undefined : connection.color}
            className="app-drag bg-chrome flex h-10 shrink-0 items-center gap-3 border-b pr-3.5 pl-20"
          >
            <div className="min-w-0 flex-1 truncate text-center font-semibold">
              {connection.nickname}{' '}
              <span className="text-muted-foreground font-normal">
                — {connection.user}@{connection.host}:{connection.port}
              </span>
            </div>
            {connection.readOnly && (
              <Badge variant="outline" className="bg-background h-5 text-[11px]">
                <Lock aria-hidden="true" />
                Read-only
              </Badge>
            )}
            <Badge variant="outline" className="bg-background h-5 font-mono text-[11px]" title={session.serverVersion}>
              PG {session.serverVersionShort}
            </Badge>
          </header>

          <div className="flex min-h-0 flex-1">
            <SchemaSidebar schemaError={state.schemaError} />
            <Tabs
              value={state.value.activeTab}
              onValueChange={(v) => state.value.setActiveTab(v as WorkspaceTab)}
              className="flex min-w-0 flex-1 flex-col gap-0"
            >
              <div className="bg-background flex flex-wrap items-center gap-3 border-b px-4 py-2.5">
                <TabsList aria-label="Workspace" className="h-[34px]">
                  {tabs.map((t) => (
                    <TabsTrigger
                      key={t.value}
                      value={t.value}
                      className="h-7 flex-none px-3 text-[13px] [&_svg:not([class*='size-'])]:size-3.5"
                    >
                      {t.icon}
                      {t.label}
                    </TabsTrigger>
                  ))}
                </TabsList>
                <span className="flex-1" />
                <div ref={setSlot} className="flex flex-wrap items-center gap-3" />
              </div>
              {tabs.map((t) =>
                visited.has(t.value) ? (
                  <TabsContent
                    key={t.value}
                    value={t.value}
                    forceMount
                    className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
                  >
                    {content[t.value]}
                  </TabsContent>
                ) : null,
              )}
            </Tabs>
          </div>
        </div>
      </TabToolbarSlotContext.Provider>
    </WorkspaceContext.Provider>
  );
}

/** Builds the WorkspaceState shared by every tab. */
export function useWorkspaceState(sid: string, session: SessionInfo) {
  const queryClient = useQueryClient();
  const schema = useQuery({
    queryKey: queryKeys.schema(sid),
    queryFn: () => api.schema(sid),
    staleTime: Infinity,
  });
  const [pickedSchema, setPickedSchema] = useState<string | null>(null);
  const [selectedTable, setSelectedTable] = useState<TableRef | null>(null);
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('schema');
  const [queryDraft, setQueryDraft] = useState<{ sql: string; nonce: number } | null>(null);
  const nonce = useRef(0);

  const schemaModel = schema.data;
  // Until the user picks one, follow the model: "public" when present, else the first schema.
  const currentSchema =
    pickedSchema && (!schemaModel || schemaModel.schemas.includes(pickedSchema))
      ? pickedSchema
      : defaultSchema(schemaModel?.schemas ?? []);

  const refreshSchema = useCallback(async () => {
    const fresh = await api.schema(sid, true);
    queryClient.setQueryData(queryKeys.schema(sid), fresh);
  }, [queryClient, sid]);

  const openTable = useCallback((ref: TableRef, tab?: WorkspaceTab) => {
    setSelectedTable(ref);
    setPickedSchema(ref.schema);
    if (tab) setActiveTab(tab);
  }, []);

  const openInQuery = useCallback((sql: string) => {
    nonce.current += 1;
    setQueryDraft({ sql, nonce: nonce.current });
    setActiveTab('query');
  }, []);

  const value = useMemo<WorkspaceState>(
    () => ({
      sid,
      session,
      connection: session.connection,
      readOnly: session.connection.readOnly,
      schemaModel,
      refreshSchema,
      currentSchema,
      setCurrentSchema: setPickedSchema,
      selectedTable,
      openTable,
      activeTab,
      setActiveTab,
      queryDraft,
      openInQuery,
    }),
    [
      sid,
      session,
      schemaModel,
      refreshSchema,
      currentSchema,
      selectedTable,
      openTable,
      activeTab,
      queryDraft,
      openInQuery,
    ],
  );

  return {
    value,
    activeTab,
    schemaError: schema.isError ? errorText(schema.error) : null,
  };
}
