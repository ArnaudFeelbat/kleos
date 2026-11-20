import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import type { Snippet } from '@kleos/shared';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Callout } from '@/features/common/callout';
import { api, ApiError, errorText, queryKeys } from '@/lib/api';
import { SnippetEditor } from './snippet-editor';

type SnippetDialogProps = {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** The snippet to edit; null creates a new one. */
  snippet: Snippet | null;
};

/** New snippet / Edit snippet: a name and a SQL body, shared by every server. */
export function SnippetDialog({ open, onOpenChange, snippet }: SnippetDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {open && <SnippetForm snippet={snippet} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function SnippetForm({ snippet, onDone }: { snippet: Snippet | null; onDone(): void }) {
  const id = useId();
  const queryClient = useQueryClient();
  const [name, setName] = useState(snippet?.name ?? '');
  const [body, setBody] = useState(snippet?.body ?? '');
  const save = useMutation({
    mutationFn: () => {
      const input = { name: name.trim(), body };
      return snippet ? api.updateSnippet(snippet.id, input) : api.createSnippet(input);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.snippets });
      onDone();
    },
  });
  // A taken name (409) belongs under the name field; anything else under the form.
  const nameTaken = save.error instanceof ApiError && save.error.status === 409;
  const canSave = name.trim() !== '' && body.trim() !== '' && !save.isPending;
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (canSave) save.mutate();
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>{snippet ? 'Edit snippet' : 'New snippet'}</DialogTitle>
        <DialogDescription>
          Shared by every server. Insert it at the cursor from the side panel or ⌘K.
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-name`}>Name</Label>
        <Input
          id={`${id}-name`}
          autoFocus
          value={name}
          maxLength={200}
          aria-invalid={nameTaken || undefined}
          aria-describedby={nameTaken ? `${id}-name-error` : undefined}
          onChange={(e) => {
            setName(e.target.value);
            if (nameTaken) save.reset();
          }}
        />
        {nameTaken && (
          <p id={`${id}-name-error`} className="text-destructive m-0 text-xs">
            {errorText(save.error)}
          </p>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <Label asChild>
          <span>SQL</span>
        </Label>
        <SnippetEditor value={body} onChange={setBody} onSubmit={() => submit()} label="Snippet SQL" />
      </div>
      {save.isError && !nameTaken && (
        <Callout tone="error" title="Couldn’t save the snippet" className="px-3 py-2.5">
          <span className="text-xs break-words">{errorText(save.error)}</span>
        </Callout>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" size="sm" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!canSave}>
          {snippet ? 'Save' : 'Create snippet'}
        </Button>
      </DialogFooter>
    </form>
  );
}
