import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useWorkspace } from '@/features/workspace/context';
import { NewTableDialog } from './new-table-dialog';
import { useSchemaEdit } from './store';

export const readOnlyReason = 'Read-only connection: schema changes are off.';

/** Schema tab toolbar: "New table…", or on a read-only session the same button, off, saying why. */
export function NewTableButton({ schema }: { schema: string }) {
  const { sid, readOnly } = useWorkspace();
  const [, actions] = useSchemaEdit(sid);
  const [open, setOpen] = useState(false);

  if (readOnly) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          {/* A disabled button gets no pointer events; the wrapper carries the tooltip. */}
          <span tabIndex={0} className="inline-flex rounded-md" aria-label={`New table: ${readOnlyReason}`}>
            <Button type="button" variant="outline" size="sm" disabled tabIndex={-1}>
              <Plus aria-hidden="true" />
              New table…
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{readOnlyReason}</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Plus aria-hidden="true" />
        New table…
      </Button>
      <NewTableDialog
        open={open}
        onOpenChange={setOpen}
        defaultSchema={schema}
        onSubmit={(change) => {
          actions.stage(change);
          setOpen(false);
        }}
      />
    </>
  );
}
