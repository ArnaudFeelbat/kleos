import { kleosErrorCodes, type SessionInfo, type TableRef } from '@kleos/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, Code, LoaderCircle, Lock, Network, Table2, Unplug } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DataTab } from '@/features/data/data-tab';
import { MonitorTab } from '@/features/monitor/monitor-tab';
import { QueryTab } from '@/features/query/query-tab';
import { SchemaTab } from '@/features/schema/schema-tab';
import { openSavedQuery } from '@/features/query/store';
import { useWorkspaceIntent } from '@/features/shell/workspace-intents';
import { api, ApiError, errorText, queryKeys } from '@/lib/api';
import { WorkspaceContext, type WorkspaceState, type WorkspaceTab } from './context';
import { SchemaSidebar } from './schema-sidebar';
import { defaultSchema } from './sidebar-model';
import { TabToolbarSlotContext } from './tab-toolbar';

export function isSessionGone(err: unknown): boolean {
  return err instanceof ApiError && (err.body.code === kleosErrorCodes.sessionNotFound || err.status === 404);
}

type Props = {
  sid: string;
  /** False while another connection tab (or the Connections home) is in front. */
  visible?: boolean;
  /** Closes this connection tab, e.g. after its session ended. */
  onClose?: () => void;
};

/**
 * One connection's workspace, shown in its window tab: translucent schema sidebar and a
 * raised content panel with the Schema / Data / Query / Monitor tabs. Provides WorkspaceContext.
 */
export function WorkspaceScreen({ sid, visible = true, onClose }: Props) {
  const session = useQuery({
    queryKey: queryKeys.session(sid),
    queryFn: () => api.getSession(sid),
    staleTime: Infinity,
  });

  if (session.isPending) {
    return (
      <Centered>
        <LoaderCircle className="text-muted-foreground size-5 animate-spin" aria-hidden="true" />
        <p className="text-muted-foreground">Opening the session…</p>
      </Centered>
    );
  }
  if (session.isError) {
    const gone = isSessionGone(session.error);
    return (
      <Centered>
        <div role="alert" className="flex max-w-md flex-col items-center gap-3 text-center">
          <span className="surface-raised flex size-11 items-center justify-center rounded-xl">
            <Unplug className="text-muted-foreground size-5" aria-hidden="true" />
          </span>
          <h1 className="text-[15px] font-semibold">
            {gone ? 'This session has ended' : 'Could not open the session'}
          </h1>
          <p className="text-muted-foreground">
            {gone
              ? 'The database session behind this tab no longer exists. Close the tab and connect again.'
              : errorText(session.error)}
          </p>
          <div className="flex gap-2">
            {!gone && (
              <Button variant="outline" size="sm" onClick={() => void session.refetch()}>
                Retry
              </Button>
            )}
            {onClose && (
              <Button size="sm" onClick={onClose}>
                Close tab
              </Button>
            )}
          </div>
        </div>
      </Centered>
    );
  }
  return <Workspace sid={sid} session={session.data} visible={visible} />;
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="bg-background flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6">{children}</div>
  );
}

const tabs: { value: WorkspaceTab; label: string; icon: ReactNode }[] = [
  { value: 'schema', label: 'Schema', icon: <Network aria-hidden="true" /> },
  { value: 'data', label: 'Data', icon: <Table2 aria-hidden="true" /> },
  { value: 'query', label: 'Query', icon: <Code aria-hidden="true" /> },
  { value: 'monitor', label: 'Monitor', icon: <Activity aria-hidden="true" /> },
];

function Workspace({ sid, session, visible }: { sid: string; session: SessionInfo; visible: boolean }) {
  const state = useWorkspaceState(sid, session, visible);
  const [visited, setVisited] = useState<ReadonlySet<WorkspaceTab>>(() => new Set([state.activeTab]));
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  const { connection } = session;

  if (!visited.has(state.activeTab)) setVisited(new Set([...visited, state.activeTab]));

  // Requests from the ⌘K palette (open a table, switch tab, refresh the schema), applied once each.
  const intent = useWorkspaceIntent(sid);
  const applied = useRef(0);
  const { openTable, setActiveTab, refreshSchema } = state.value;
  useEffect(() => {
    if (!intent || intent.nonce === applied.current) return;
    applied.current = intent.nonce;
    const { intent: i } = intent;
    if (i.kind === 'open-table') openTable(i.ref, i.tab);
    else if (i.kind === 'tab') setActiveTab(i.tab);
    else if (i.kind === 'open-saved') {
      openSavedQuery(sid, i.query);
      setActiveTab('query');
    } else
      refreshSchema().then(
        () => toast.success('Schema refreshed'),
        (err: unknown) => toast.error('Could not refresh the schema', { description: errorText(err) }),
      );
  }, [intent, sid, openTable, setActiveTab, refreshSchema]);

  const content: Record<WorkspaceTab, ReactNode> = {
    schema: <SchemaTab />,
    data: <DataTab />,
    query: <QueryTab />,
    monitor: <MonitorTab />,
  };

  return (
    <WorkspaceContext.Provider value={state.value}>
      <TabToolbarSlotContext.Provider value={slot}>
        <div className="flex min-h-0 flex-1">
          <SchemaSidebar schemaError={state.schemaError} />
          <Tabs
            value={state.value.activeTab}
            onValueChange={(v) => state.value.setActiveTab(v as WorkspaceTab)}
            className="bg-background flex min-w-0 flex-1 flex-col gap-0 overflow-hidden rounded-tl-[10px] shadow-[0_0_0_1px_var(--edge),var(--elev-1)]"
          >
            <div
              data-tint={connection.color === 'none' ? undefined : connection.color}
              className="bg-chrome flex min-h-12 flex-wrap items-center gap-3 border-b px-3 py-2"
            >
              <TabsList aria-label="Workspace" className="h-8">
                {tabs.map((t) => (
                  <TabsTrigger
                    key={t.value}
                    value={t.value}
                    className="h-[26px] flex-none px-2.5 text-[12.5px] [&_svg:not([class*='size-'])]:size-3.5"
                  >
                    {t.icon}
                    {t.label}
                  </TabsTrigger>
                ))}
              </TabsList>
              <span className="flex-1" />
              <div ref={setSlot} className="flex flex-wrap items-center gap-2" />
              {connection.readOnly && (
                <Badge
                  variant="outline"
                  className="border-warning-line bg-warning-bg text-warning h-5"
                  title="Edits are blocked and sessions start read-only"
                >
                  <Lock aria-hidden="true" />
                  Read-only
                </Badge>
              )}
              <Badge variant="outline" className="h-5 font-mono" title={session.serverVersion}>
                PG {session.serverVersionShort}
              </Badge>
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
      </TabToolbarSlotContext.Provider>
    </WorkspaceContext.Provider>
  );
}

/** Builds the WorkspaceState shared by every tab. */
export function useWorkspaceState(sid: string, session: SessionInfo, visible = true) {
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
  // Until the user picks one, follow the model: "public" when it has tables, else the busiest schema.
  const currentSchema =
    pickedSchema && (!schemaModel || schemaModel.schemas.includes(pickedSchema))
      ? pickedSchema
      : defaultSchema(schemaModel);

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
      visible,
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
      visible,
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
