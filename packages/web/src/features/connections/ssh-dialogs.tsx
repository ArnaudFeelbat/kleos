import { KeySquare, LoaderCircle, ShieldExclamationPoint, ShieldQuestionMark } from 'lucide-react';
import { useState } from 'react';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Callout } from '@/features/common/callout';
import type { CredentialPrompt, CredentialPrompts, PromptTarget } from './credential-flow';
import { Mono, PasswordDialog, SecretDialog } from './password-dialog';

/** "bastion.example.com:22", or the favorite's name when the prompt has no SSH hop (should not happen). */
function sshAddress(target: PromptTarget): string {
  return target.ssh ? `${target.ssh.host}:${target.ssh.port}` : target.name;
}

/**
 * Every question a connection attempt can raise, in one place: the SSH host key (unknown or
 * changed), the SSH key passphrase and the Postgres password. Used by the connect flow and by
 * the form's Test button.
 */
export function CredentialDialogs({ prompts }: { prompts: CredentialPrompts }) {
  const { prompt, submitPassword, submitPassphrase, trustHost, replaceHostKey, cancel } = prompts;
  return (
    <>
      <SshTrustDialog prompt={prompt} onTrust={() => void trustHost()} onCancel={cancel} />
      <SshHostChangedDialog prompt={prompt} onReplace={() => void replaceHostKey()} onClose={cancel} />
      <SshPassphraseDialog
        prompt={prompt}
        onSubmit={(passphrase, remember) => void submitPassphrase(passphrase, remember)}
        onCancel={cancel}
      />
      <PasswordDialog
        prompt={prompt}
        onSubmit={(password, remember) => void submitPassword(password, remember)}
        onCancel={cancel}
      />
    </>
  );
}

function Fingerprint({ value, label }: { value: string | null; label: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-foreground/80 text-xs font-medium">{label}</span>
      <code
        aria-label={label}
        className="bg-muted/70 text-foreground block rounded-md px-2.5 py-2 font-mono text-[12px] leading-relaxed break-all shadow-[inset_0_0_0_1px_var(--edge)] select-all"
      >
        {value ?? 'Not reported by the server'}
      </code>
    </div>
  );
}

/** KLEOS_SSH_HOST_UNKNOWN: first connection to this SSH server; the user checks and trusts its key. */
export function SshTrustDialog({
  prompt,
  onTrust,
  onCancel,
}: {
  prompt: CredentialPrompt | null;
  onTrust(): void;
  onCancel(): void;
}) {
  const shown = prompt?.kind === 'ssh-trust' ? prompt : null;
  return (
    <Dialog open={shown !== null} onOpenChange={(open) => !open && onCancel()}>
      {shown && (
        <DialogContent className="sm:max-w-md">
          <DialogHeader className="flex-row items-start gap-3.5">
            <span
              aria-hidden="true"
              className="surface-raised flex size-10 shrink-0 items-center justify-center rounded-xl"
            >
              <ShieldQuestionMark className="text-brand-text size-[18px]" />
            </span>
            <div className="flex min-w-0 flex-col gap-1.5">
              <DialogTitle>Trust this server?</DialogTitle>
              <DialogDescription className="text-[12.5px] leading-relaxed">
                This is the first connection to the SSH server <Mono>{sshAddress(shown.target)}</Mono>. Check that its
                host key fingerprint matches the one its administrator gave you. Kleos remembers it and refuses to
                connect if it ever changes.
              </DialogDescription>
            </div>
          </DialogHeader>
          <Fingerprint label="Host key fingerprint (SHA256)" value={shown.fingerprint} />
          {shown.error && (
            <Callout role="alert" tone="error" title="Connection failed">
              <span className="font-mono text-xs break-words">{shown.error}</span>
            </Callout>
          )}
          <DialogFooter className="pt-1">
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="button" disabled={shown.submitting || !shown.fingerprint} onClick={onTrust}>
              {shown.submitting && <LoaderCircle className="animate-spin" aria-hidden="true" />}
              {shown.submitting ? 'Connecting…' : 'Trust and connect'}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}

/**
 * KLEOS_SSH_HOST_CHANGED: the SSH server shows another key than the trusted one. Kleos never
 * connects on its own; replacing the trusted key takes a deliberate second confirmation, like
 * running `ssh-keygen -R` by hand.
 */
export function SshHostChangedDialog({
  prompt,
  onReplace,
  onClose,
}: {
  prompt: CredentialPrompt | null;
  onReplace(): void;
  onClose(): void;
}) {
  const shown = prompt?.kind === 'ssh-changed' ? prompt : null;
  return (
    <AlertDialog open={shown !== null} onOpenChange={(open) => !open && onClose()}>
      {shown && <HostChangedContent key={shown.fingerprint ?? ''} shown={shown} onReplace={onReplace} />}
    </AlertDialog>
  );
}

function HostChangedContent({ shown, onReplace }: { shown: CredentialPrompt; onReplace(): void }) {
  const [confirming, setConfirming] = useState(false);
  const canReplace = Boolean(shown.fingerprint && shown.target.ssh);
  return (
    <AlertDialogContent>
      <AlertDialogHeader className="flex flex-row items-start gap-3.5 text-left">
        <span
          aria-hidden="true"
          className="bg-error-bg flex size-10 shrink-0 items-center justify-center rounded-xl shadow-[inset_0_0_0_1px_var(--edge)]"
        >
          <ShieldExclamationPoint className="text-destructive size-[18px]" />
        </span>
        <div className="flex min-w-0 flex-col gap-1.5 text-left">
          <AlertDialogTitle className="text-base">The SSH host key has changed</AlertDialogTitle>
          <AlertDialogDescription className="text-[12.5px] leading-relaxed">
            <Mono>{sshAddress(shown.target)}</Mono> presented a different host key from the one Kleos trusted for{' '}
            {shown.target.name}. The server may have been reinstalled, or someone may be intercepting the connection.
            Kleos won’t connect.
          </AlertDialogDescription>
        </div>
      </AlertDialogHeader>
      <Fingerprint label="New fingerprint (SHA256)" value={shown.fingerprint} />
      {confirming && (
        <Callout tone="warning" title="Only if you know why it changed">
          Replace the trusted key only when the server’s administrator confirms this new fingerprint. Kleos then trusts
          it from now on.
        </Callout>
      )}
      {shown.error && (
        <Callout role="alert" tone="error" title="Connection failed">
          <span className="font-mono text-xs break-words">{shown.error}</span>
        </Callout>
      )}
      <AlertDialogFooter>
        {canReplace &&
          (confirming ? (
            <Button type="button" size="sm" variant="destructive" disabled={shown.submitting} onClick={onReplace}>
              {shown.submitting && <LoaderCircle className="animate-spin" aria-hidden="true" />}
              {shown.submitting ? 'Connecting…' : 'Trust the new key and connect'}
            </Button>
          ) : (
            <Button type="button" size="sm" variant="ghost" onClick={() => setConfirming(true)}>
              Replace the trusted key…
            </Button>
          ))}
        <AlertDialogCancel size="sm">Close</AlertDialogCancel>
      </AlertDialogFooter>
    </AlertDialogContent>
  );
}

/** KLEOS_SSH_PASSPHRASE_REQUIRED: the private key is encrypted and no passphrase is saved. */
export function SshPassphraseDialog({
  prompt,
  onSubmit,
  onCancel,
}: {
  prompt: CredentialPrompt | null;
  onSubmit(passphrase: string, remember: boolean): void;
  onCancel(): void;
}) {
  const shown = prompt?.kind === 'ssh-passphrase' ? prompt : null;
  const keyPath = shown?.target.ssh?.keyPath ?? null;
  return (
    <SecretDialog
      prompt={shown}
      icon={KeySquare}
      title={shown && `SSH key passphrase for ${shown.target.name}`}
      description={
        shown && (
          <>
            {keyPath ? <Mono>{keyPath}</Mono> : 'The SSH private key'} is encrypted. Its passphrase unlocks it for the
            tunnel to <Mono>{sshAddress(shown.target)}</Mono>.
          </>
        )
      }
      label="Passphrase"
      rememberLabel="Remember in Keychain"
      onSubmit={onSubmit}
      onCancel={onCancel}
    />
  );
}
