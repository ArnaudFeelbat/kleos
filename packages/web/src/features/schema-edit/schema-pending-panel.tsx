import { tableKey, type DdlChange, type TableRef } from '@kleos/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CircleExclamationPoint, Code, ListChecks, LoaderCircle, Minus, Pencil, Plus, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Callout } from '@/features/common/callout';
import { kbdOnPrimary, sectionLabel } from '@/features/common/styles';
import { useWorkspace } from '@/features/workspace/context';
import { api, ApiError, errorText } from '@/lib/api';
import { cn } from '@/lib/utils';
import { tokenizeDdl } from './ddl-sql';
import { changeCounts, describeChange, isDestructive } from './describe';
import { NewTableDialog } from './new-table-dialog';
import { useSchemaEdit, type StagedDdl } from './store';
import { useDdlPreview } from './use-ddl-preview';

const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);

const badge =
  'inline-flex h-5 items-center gap-1 rounded-full px-2 text-[11px] font-medium tabular shadow-[inset_0_0_0_1px_color-mix(in_srgb,currentColor_22%,transparent)]';

const plural = (n: number) => `${n} change${n === 1 ? '' : 's'}`;

/** Where the selected table ends up once the applied list has renamed it (null if dropped). */
function finalRef(ref: TableRef, changes: readonly DdlChange[]): TableRef | null {
  let current: TableRef | null = ref;
  for (const c of changes) {
    if (!current) break;
    if (c.op === 'renameTable' && tableKey(c.table) === tableKey(current)) {
      current = { schema: current.schema, name: c.newName };
    } else if (c.op === 'dropTable' && tableKey(c.table) === tableKey(current)) {
      current = null;
    }
  }
  return current;
}

/**
 * Review panel of the schema tab, in the data tab's look: the staged changes in plain words,
 * the exact SQL from the server's preview, Discard and Apply (⌘S while the schema tab is in front).
 * Renders nothing while no change is staged.
 */
export function SchemaPendingPanel() {
  const ws = useWorkspace();
  const { sid, visible, activeTab, selectedTable, openTable, refreshSchema } = ws;
  const queryClient = useQueryClient();
  const [state, actions] = useSchemaEdit(sid);
  const changes = state.changes.map((s) => s.change);
  const preview = useDdlPreview(sid, changes);
  const [editing, setEditing] = useState<StagedDdl | null>(null);

  const apply = useMutation({
    mutationFn: (list: StagedDdl[]) => api.applyDdl(sid, { changes: list.map((s) => s.change) }),
    onSuccess: async (_result, list) => {
      actions.discard();
      toast.success(`Applied ${plural(list.length)}`);
      void queryClient.invalidateQueries({ queryKey: ['rows', sid] });
      void queryClient.invalidateQueries({ queryKey: ['count', sid] });
      // Follow the selected table through a rename, so its panel stays open on the new name.
      if (selectedTable) {
        const next = finalRef(
          selectedTable,
          list.map((s) => s.change),
        );
        if (next && next.name !== selectedTable.name) openTable(next);
      }
      try {
        await refreshSchema();
      } catch (err) {
        toast.error('Could not refresh the schema', { description: errorText(err) });
      }
    },
    onError: (err, list) => {
      const body = err instanceof ApiError ? err.body : { code: 'KLEOS_HTTP', message: errorText(err) };
      const index = body.statementIndex;
      const failing = index === undefined ? undefined : list[index];
      actions.fail({
        changeId: failing?.id ?? null,
        statement: index !== undefined && preview.current ? (preview.statements?.[index] ?? null) : null,
        code: body.code,
        message: body.message,
        detail: body.detail,
        hint: body.hint,
      });
    },
  });
  const applying = apply.isPending;
  const mutate = apply.mutate;
  const staged = state.changes;
  const total = staged.length;
  const applyNow = () => {
    if (total > 0 && !applying) mutate(staged);
  };

  // ⌘S belongs to the tab in front: the data tab commits rows, the schema tab applies changes.
  const active = visible && activeTab === 'schema';
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (staged.length > 0 && !applying) mutate(staged);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, applying, mutate, staged]);

  if (total === 0 && !state.failure) return null;

  const counts = changeCounts(changes);
  const failure = state.failure;
  const failingIndex = failure?.changeId ? state.changes.findIndex((s) => s.id === failure.changeId) : -1;

  return (
    <section
      aria-label="Pending schema changes"
      className="bg-sidebar animate-in fade-in-0 slide-in-from-bottom-2 max-h-[45%] shrink-0 overflow-auto border-t shadow-[0_-6px_16px_-10px_rgb(15_15_30/0.18)] duration-200 dark:shadow-[0_-8px_20px_-10px_rgb(0_0_0/0.6)]"
    >
      <div className="flex flex-wrap items-center gap-2.5 px-4 py-2.5">
        <span className="bg-staged-update-line size-2 rounded-full" aria-hidden="true" />
        <b className="font-semibold tracking-[-0.01em]">Pending schema changes</b>
        {counts.added > 0 && (
          <span className={cn(badge, 'bg-staged-insert text-staged-insert-foreground')}>
            <Plus className="size-2.5" aria-hidden="true" />
            {counts.added} added
          </span>
        )}
        {counts.altered > 0 && (
          <span className={cn(badge, 'bg-staged-update text-staged-update-foreground')}>
            <Pencil className="size-2.5" aria-hidden="true" />
            {counts.altered} changed
          </span>
        )}
        {counts.dropped > 0 && (
          <span className={cn(badge, 'bg-staged-delete text-staged-delete-foreground')}>
            <Minus className="size-2.5" aria-hidden="true" />
            {counts.dropped} dropped
          </span>
        )}
        <span className="text-muted-foreground ml-1 text-xs">
          Applied in one transaction — if any statement fails, nothing is applied.
        </span>
        <span className="flex-1" />
        <Button type="button" variant="outline" size="sm" onClick={actions.discard} disabled={applying}>
          Discard
        </Button>
        <Button type="button" size="sm" onClick={applyNow} disabled={applying || total === 0}>
          {applying && <LoaderCircle className="animate-spin" aria-hidden="true" />}
          Apply {plural(total)}
          <kbd className={kbdOnPrimary}>{isMac ? '⌘S' : 'Ctrl+S'}</kbd>
        </Button>
      </div>

      {failure && (
        <Callout
          role="alert"
          tone="error"
          icon={CircleExclamationPoint}
          title="Apply failed. Nothing was applied."
          className="mx-4 mb-3"
        >
          <span className="text-xs">
            {failingIndex >= 0 && <span className="font-medium">Change {failingIndex + 1}: </span>}
            <span className="font-mono">{failure.code}</span> {failure.message}. The transaction was rolled back; your{' '}
            {total === 1 ? 'change is' : `${total} changes are`} still staged.
          </span>
          {failure.detail && <span className="text-muted-foreground text-xs">{failure.detail}</span>}
          {failure.hint && <span className="text-muted-foreground text-xs">Hint: {failure.hint}</span>}
          {failure.statement && (
            <code className="bg-background/70 selectable mt-1 rounded-md px-2 py-1 font-mono text-[11px] break-all whitespace-pre-wrap">
              {failure.statement}
            </code>
          )}
        </Callout>
      )}

      <div className="grid gap-x-4 px-4 pb-3 md:grid-cols-2">
        <div className="flex min-w-0 flex-col">
          <div className={cn(sectionLabel, 'mb-1.5 flex items-center gap-1.5')}>
            <ListChecks className="size-3" aria-hidden="true" />
            Changes
          </div>
          <ol aria-label="Staged changes" className="flex flex-col gap-1">
            {state.changes.map((s, i) => {
              const failed = s.id === failure?.changeId;
              const previewError = preview.error?.index === i ? preview.error.text : null;
              return (
                <li
                  key={s.id}
                  aria-invalid={failed || !!previewError || undefined}
                  className={cn(
                    'bg-background group flex items-start gap-2 rounded-lg px-2.5 py-1.5 text-xs shadow-[0_0_0_1px_var(--edge)]',
                    (failed || previewError) && 'bg-error-bg shadow-[0_0_0_1px_var(--error-line)]',
                  )}
                >
                  <span className="text-muted-foreground tabular w-4 shrink-0 pt-px text-right font-mono text-[11px]">
                    {i + 1}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className={cn('break-words', isDestructive(s.change) && 'text-destructive')}>
                      {describeChange(s.change)}
                    </span>
                    {previewError && <span className="text-destructive text-[11px]">{previewError}</span>}
                    {failed && <span className="text-destructive text-[11px]">This statement failed.</span>}
                  </span>
                  {s.change.op === 'createTable' && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="text-muted-foreground -my-0.5"
                      aria-label={`Edit change ${i + 1}`}
                      title="Edit"
                      disabled={applying}
                      onClick={() => setEditing(s)}
                    >
                      <Pencil aria-hidden="true" />
                    </Button>
                  )}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="text-muted-foreground -my-0.5"
                        aria-label={`Remove change ${i + 1}`}
                        disabled={applying}
                        onClick={() => actions.remove(s.id)}
                      >
                        <X aria-hidden="true" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Remove from the list</TooltipContent>
                  </Tooltip>
                </li>
              );
            })}
          </ol>
        </div>

        <div className="flex min-w-0 flex-col">
          <div className={cn(sectionLabel, 'mt-3 mb-1.5 flex items-center gap-1.5 md:mt-0')}>
            <Code className="size-3" aria-hidden="true" />
            SQL
            {preview.loading && (
              <LoaderCircle className="size-3 animate-spin" aria-label="Updating the preview" role="img" />
            )}
          </div>
          {preview.error && preview.error.index === null && (
            <p role="alert" className="text-destructive mb-1.5 text-xs">
              Couldn’t preview the SQL: {preview.error.text}
            </p>
          )}
          <pre
            aria-label="SQL that will run"
            aria-busy={preview.loading || undefined}
            className={cn(
              'bg-background selectable overflow-x-auto rounded-lg px-3.5 py-3 font-mono text-xs leading-[1.7] shadow-[0_0_0_1px_var(--edge),var(--elev-1)] transition-opacity',
              (preview.loading || !preview.current) && 'opacity-55',
            )}
          >
            {preview.statements ? (
              <>
                <SqlLine sql="BEGIN;" />
                {preview.statements.map((stmt, i) => (
                  <SqlLine
                    key={i}
                    sql={/;\s*$/.test(stmt) ? stmt : `${stmt};`}
                    failed={preview.current && (i === failingIndex || (preview.error?.index === i && !preview.loading))}
                  />
                ))}
                <SqlLine sql="COMMIT;" />
              </>
            ) : (
              <span className="text-muted-foreground">{preview.error ? '—' : 'Preparing the SQL…'}</span>
            )}
          </pre>
        </div>
      </div>

      {editing?.change.op === 'createTable' && (
        <NewTableDialog
          open
          onOpenChange={(open) => !open && setEditing(null)}
          initial={editing.change}
          onSubmit={(change) => {
            actions.update(editing.id, change);
            setEditing(null);
          }}
        />
      )}
    </section>
  );
}

function SqlLine({ sql, failed }: { sql: string; failed?: boolean }) {
  return (
    <span
      data-failed={failed || undefined}
      className={cn('-mx-1.5 block rounded px-1.5 whitespace-pre-wrap', failed && 'bg-error-bg')}
    >
      {tokenizeDdl(sql).map((t, i) => (
        <span
          key={i}
          className={cn(
            t.kind === 'keyword' && 'text-code-keyword',
            t.kind === 'string' && 'text-code-string',
            t.kind === 'number' && 'text-code-number',
            t.kind === 'comment' && 'text-muted-foreground',
          )}
        >
          {t.text}
        </span>
      ))}
    </span>
  );
}
