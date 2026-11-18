import { KeyRound, LoaderCircle } from 'lucide-react';
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
import { Callout } from '@/features/common/callout';
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
        <DialogHeader className="flex-row items-start gap-3.5">
          <span
            aria-hidden="true"
            className="surface-raised flex size-10 shrink-0 items-center justify-center rounded-xl"
          >
            <KeyRound className="text-brand-text size-[18px]" />
          </span>
          <div className="flex min-w-0 flex-col gap-1.5">
            <DialogTitle>Password for {connection.nickname}</DialogTitle>
            <DialogDescription className="text-[12.5px] leading-relaxed">
              <span className="bg-muted text-foreground/80 rounded px-1 py-px font-mono text-[11.5px]">
                {connectionSubtitle(connection)}
              </span>{' '}
              needs a password. None is saved for this favorite.
            </DialogDescription>
          </div>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Label htmlFor="prompt-password" className="text-foreground/80 text-xs">
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
          <Callout role="alert" tone="error" title="Connection failed">
            <span className="font-mono text-xs break-words">{prompt.error}</span>
          </Callout>
        )}
        <DialogFooter className="pt-1">
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" disabled={prompt.submitting}>
            {prompt.submitting && <LoaderCircle className="animate-spin" aria-hidden="true" />}
            {prompt.submitting ? 'Connecting…' : 'Connect'}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
