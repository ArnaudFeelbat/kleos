import { useId, useState, type FormEvent } from 'react';
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

type NameDialogProps = {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  description: string;
  initialName: string;
  submitLabel: string;
  pending?: boolean;
  onSubmit(name: string): void;
};

/** Small dialog asking for a name: save a query, rename a saved query. */
export function NameDialog({
  open,
  onOpenChange,
  title,
  description,
  initialName,
  submitLabel,
  pending,
  onSubmit,
}: NameDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        {open && (
          <NameForm
            title={title}
            description={description}
            initialName={initialName}
            submitLabel={submitLabel}
            pending={pending}
            onSubmit={onSubmit}
            onCancel={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function NameForm({
  title,
  description,
  initialName,
  submitLabel,
  pending,
  onSubmit,
  onCancel,
}: Omit<NameDialogProps, 'open' | 'onOpenChange'> & { onCancel(): void }) {
  const id = useId();
  const [name, setName] = useState(initialName);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) onSubmit(name.trim());
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={id}>Name</Label>
        <Input id={id} autoFocus value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!name.trim() || pending}>
          {submitLabel}
        </Button>
      </DialogFooter>
    </form>
  );
}
