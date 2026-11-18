import { CircleX } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import { connectionSubtitle } from './form-model';
import type { PasswordPrompt } from './use-connect';

type Props = {
  prompt: PasswordPrompt | null;
  onSubmit(password: string, remember: boolean): void;
  onCancel(): void;
};

/** Asked when the server answers 401 KLEOS_PASSWORD_REQUIRED on Connect. */
export function PasswordDialog({ prompt, onSubmit, onCancel }: Props) {
  return (
    <Dialog open={prompt !== null} onOpenChange={(open) => !open && onCancel()}>
      {prompt && <PasswordForm key={prompt.connection.id} prompt={prompt} onSubmit={onSubmit} onCancel={onCancel} />}
    </Dialog>
  );
}

function PasswordForm({ prompt, onSubmit, onCancel }: Props & { prompt: PasswordPrompt }) {
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const { connection } = prompt;
  return (
    <DialogContent className="sm:max-w-md">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(password, remember);
        }}
      >
        <DialogHeader>
          <DialogTitle>Password for {connection.nickname}</DialogTitle>
          <DialogDescription>
            <span className="font-mono text-xs">{connectionSubtitle(connection)}</span> needs a password. None is saved
            for this favorite.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="prompt-password" className="text-xs">
            Password
          </Label>
          <Input
            id="prompt-password"
            type="password"
            autoFocus
            autoComplete="off"
            className="h-8"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <Label className="flex items-center gap-2 text-xs font-normal">
            <Checkbox checked={remember} onCheckedChange={(v) => setRemember(v === true)} />
            Save password in Keychain
          </Label>
        </div>
        {prompt.error && (
          <div role="alert" className="bg-error-bg border-error-line flex items-start gap-2.5 rounded-lg border p-3">
            <CircleX className="text-destructive mt-px size-4 shrink-0" aria-hidden="true" />
            <div className="flex flex-col gap-0.5">
              <b className="font-semibold">Connection failed</b>
              <span className="font-mono text-xs break-words">{prompt.error}</span>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={prompt.submitting}>
            {prompt.submitting ? 'Connecting…' : 'Connect'}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
