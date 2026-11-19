import { KeyRound, LoaderCircle, type LucideIcon } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
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
import type { CredentialPrompt } from './credential-flow';

type Props = {
  prompt: CredentialPrompt | null;
  onSubmit(secret: string, remember: boolean): void;
  onCancel(): void;
};

type SecretCopy = {
  icon: LucideIcon;
  title: ReactNode;
  description: ReactNode;
  label: string;
  rememberLabel: string;
};

/** Asked when the server answers 401 KLEOS_PASSWORD_REQUIRED on Connect. */
export function PasswordDialog({ prompt, onSubmit, onCancel }: Props) {
  const shown = prompt?.kind === 'password' ? prompt : null;
  return (
    <SecretDialog
      prompt={shown}
      icon={KeyRound}
      title={shown && `Password for ${shown.target.name}`}
      description={
        shown && (
          <>
            <Mono>{shown.target.subtitle}</Mono> needs a password. None is saved for this favorite.
          </>
        )
      }
      label="Password"
      rememberLabel="Save password in Keychain"
      onSubmit={onSubmit}
      onCancel={onCancel}
    />
  );
}

/** Inline code chip used in prompt descriptions. */
export function Mono({ children }: { children: ReactNode }) {
  return <span className="bg-muted text-foreground/80 rounded px-1 py-px font-mono text-[11.5px]">{children}</span>;
}

/**
 * A dialog asking for one secret (a password, an SSH key passphrase) with "Save in Keychain".
 * Shown while `prompt` is set; the error of the last try stays under the field.
 */
export function SecretDialog({ prompt, onSubmit, onCancel, ...copy }: Props & SecretCopy) {
  return (
    <Dialog open={prompt !== null} onOpenChange={(open) => !open && onCancel()}>
      {prompt && (
        <SecretForm
          key={`${prompt.kind}:${prompt.target.subtitle}`}
          prompt={prompt}
          onSubmit={onSubmit}
          onCancel={onCancel}
          {...copy}
        />
      )}
    </Dialog>
  );
}

function SecretForm({
  prompt,
  onSubmit,
  onCancel,
  icon: Icon,
  title,
  description,
  label,
  rememberLabel,
}: Props & SecretCopy & { prompt: CredentialPrompt }) {
  const [secret, setSecret] = useState('');
  const [remember, setRemember] = useState(false);
  const fieldId = useId();
  return (
    <DialogContent className="sm:max-w-md">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          // Portalled, but React events still bubble to an enclosing form (the connection form).
          e.stopPropagation();
          onSubmit(secret, remember);
        }}
      >
        <DialogHeader className="flex-row items-start gap-3.5">
          <span
            aria-hidden="true"
            className="surface-raised flex size-10 shrink-0 items-center justify-center rounded-xl"
          >
            <Icon className="text-brand-text size-[18px]" />
          </span>
          <div className="flex min-w-0 flex-col gap-1.5">
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription className="text-[12.5px] leading-relaxed">{description}</DialogDescription>
          </div>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Label htmlFor={fieldId} className="text-foreground/80 text-xs">
            {label}
          </Label>
          <Input
            id={fieldId}
            type="password"
            autoFocus
            autoComplete="off"
            className="h-8"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
          <Label className="flex items-center gap-2 text-xs font-normal">
            <Checkbox checked={remember} onCheckedChange={(v) => setRemember(v === true)} />
            {rememberLabel}
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
