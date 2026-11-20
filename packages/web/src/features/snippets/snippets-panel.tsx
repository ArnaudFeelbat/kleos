import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Braces, Ellipsis, Plus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { Snippet } from '@kleos/shared';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Callout } from '@/features/common/callout';
import { EmptyState } from '@/features/common/empty-state';
import { SkeletonList } from '@/features/common/skeletons';
import { requestWorkspace } from '@/features/shell/workspace-intents';
import { useWorkspace } from '@/features/workspace/context';
import { api, errorText, queryKeys } from '@/lib/api';
import { firstLine } from './first-line';
import { SnippetDialog } from './snippet-dialog';

/**
 * Snippets tab of the query side panel: reusable SQL shared by every server. Insert (or a
 * double-click) puts the body at the cursor of the query tab in front.
 */
export function SnippetsPanel() {
  const { sid } = useWorkspace();
  const queryClient = useQueryClient();
  const snippets = useQuery({ queryKey: queryKeys.snippets, queryFn: () => api.snippets() });
  // undefined: closed; null: a new snippet; a snippet: editing it.
  const [editing, setEditing] = useState<Snippet | null | undefined>(undefined);
  const [deleting, setDeleting] = useState<Snippet | null>(null);

  const insert = (s: Snippet) => requestWorkspace(sid, { kind: 'insert-sql', text: s.body });
  const remove = useMutation({
    mutationFn: (s: Snippet) => api.deleteSnippet(s.id),
    onSuccess: () => {
      setDeleting(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.snippets });
    },
    onError: (err) => toast.error(`Couldn’t delete the snippet: ${errorText(err)}`),
  });

  return (
    <>
      <div className="flex items-center justify-end border-b px-3 py-1.5">
        <Button type="button" variant="ghost" size="xs" onClick={() => setEditing(null)}>
          <Plus aria-hidden="true" />
          New snippet
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {snippets.isPending && <SkeletonList rows={4} rowClassName="h-10 w-full" className="p-3" />}
        {snippets.isError && (
          <Callout tone="error" title="Couldn’t load snippets" className="m-3 px-3 py-2.5">
            <span className="text-xs break-words">{errorText(snippets.error)}</span>
          </Callout>
        )}
        {snippets.data?.length === 0 && (
          <EmptyState
            size="sm"
            icon={Braces}
            title="No snippets yet"
            hint="Keep SQL you write often and insert it at the cursor, on any server."
          />
        )}
        {snippets.data && snippets.data.length > 0 && (
          <ul aria-label="Snippets" className="m-0 list-none p-0">
            {snippets.data.map((s) => (
              <li
                key={s.id}
                className="group hover:bg-foreground/[0.03] flex items-start gap-1 border-b py-2 pr-2 pl-3 dark:hover:bg-white/[0.03]"
                title="Double-click to insert at the cursor"
                onDoubleClick={() => insert(s)}
              >
                <div className="flex min-w-0 flex-1 flex-col gap-1 py-0.5 select-none">
                  <b className="truncate font-semibold">{s.name}</b>
                  <span className="text-muted-foreground truncate font-mono text-xs">{firstLine(s.body)}</span>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100"
                  aria-label={`Insert ${s.name}`}
                  onClick={() => insert(s)}
                >
                  Insert
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
                      aria-label={`Actions for ${s.name}`}
                    >
                      <Ellipsis />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => insert(s)}>Insert at cursor</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setEditing(s)}>Edit…</DropdownMenuItem>
                    <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(s)}>
                      Delete…
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="bg-sidebar/60 text-muted-foreground m-0 border-t px-3 py-2.5 text-[11px]">
        Shared by every server. Double-click to insert.
      </p>
      <SnippetDialog
        open={editing !== undefined}
        onOpenChange={(o) => !o && setEditing(undefined)}
        snippet={editing ?? null}
      />
      <AlertDialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleting?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The snippet is removed for every server. SQL already inserted stays where it is.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => deleting && remove.mutate(deleting)}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
