import {
  connectionColors,
  sslModes,
  type SavedConnection,
  type SshConfig,
  type TestConnectionResult,
} from '@kleos/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CircleX, CopyPlus, Database, LoaderCircle, Lock, Plug, Slash, Trash, Waypoints, X } from 'lucide-react';
import { RadioGroup as RadioGroupPrimitive } from 'radix-ui';
import { useId, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Callout } from '@/features/common/callout';
import { kbdOnPrimary, segmentedItem, segmentedList } from '@/features/common/styles';
import { tabsStore } from '@/features/shell/tabs-store';
import { api, errorText, queryKeys } from '@/lib/api';
import { cn } from '@/lib/utils';
import { connectionColorLabel, connectionColorSwatch } from './colors';
import { useCredentialPrompts } from './credential-flow';
import { ColorDot } from './favorites-list';
import {
  applyConnectionUrl,
  connectionSubtitle,
  effectiveNickname,
  emptyForm,
  formFromSaved,
  nameForNewFavorite,
  pointsElsewhere,
  sameForm,
  sameServer,
  toConnectionInput,
  uniqueName,
  toTestRequest,
  usesCaCertificate,
  validateForm,
  type FormErrors,
  type FormState,
} from './form-model';
import { CredentialDialogs } from './ssh-dialogs';

/** A successful test also says how it got there: through which SSH server, over TLS or not. */
type TestOutcome = { ok: true; result: TestConnectionResult; ssh: SshConfig | null } | { ok: false; message: string };

type Props = {
  /** null for a new, unsaved connection. */
  saved: SavedConnection | null;
  /** Duplicate: a new connection starts from this favorite's settings (and, on the same server, its secrets). */
  template?: SavedConnection | null;
  connecting: boolean;
  onSaved(saved: SavedConnection): void;
  onDeleted(): void;
  onDuplicate(saved: SavedConnection): void;
  onConnect(connection: SavedConnection, password: string | null): Promise<void>;
};

/**
 * Login form for one favorite (keyed by id by the parent). Pasting a postgres:// URL into any
 * field fills the whole form. Connect on an unsaved or edited form saves it first, then connects.
 * Editing where a saved favorite points (server, database, user) makes a new favorite instead of
 * rewriting this one; "Update … instead" is the deliberate way to change it (0.7.2).
 */
export function ConnectionForm({
  saved,
  template = null,
  connecting,
  onSaved,
  onDeleted,
  onDuplicate,
  onConnect,
}: Props) {
  const queryClient = useQueryClient();
  const takenNames = (queryClient.getQueryData<SavedConnection[]>(queryKeys.connections) ?? []).map((f) => f.nickname);
  const [templateForm] = useState(() => (template ? formFromSaved(template) : null));
  const initial = saved
    ? formFromSaved(saved)
    : templateForm && template
      ? { ...templateForm, nickname: uniqueName(`${template.nickname} copy`, takenNames) }
      : emptyForm;
  const [form, setForm] = useState<FormState>(initial);
  const [baseline, setBaseline] = useState<FormState>(initial);
  const [errors, setErrors] = useState<FormErrors>({});
  const [test, setTest] = useState<TestOutcome | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmUpdate, setConfirmUpdate] = useState(false);
  const ids = useId();
  const id = (name: string) => `${ids}-${name}`;

  const dirty = !saved || !sameForm(form, baseline);
  // Another server, database or user typed over a saved favorite: Connect and Save make a new one.
  const fork = saved !== null && pointsElsewhere(form, baseline);
  const forkName = fork ? nameForNewFavorite(form, baseline, takenNames) : null;
  // The favorite this form started from, whose stored secrets a new favorite may reuse (same server only).
  const source = saved ?? template;
  const sourceForm = saved ? baseline : templateForm;
  const onSourceServer = source !== null && sourceForm !== null && sameServer(form, sourceForm);
  const creating = !saved || fork;

  function update(patch: Partial<FormState>) {
    setForm((f) => ({ ...f, ...patch }));
    setTest(null);
    setErrors((e) => {
      const next = { ...e };
      for (const key of Object.keys(patch)) delete next[key as keyof FormErrors];
      return next;
    });
  }

  function check(): boolean {
    const found = validateForm(form);
    setErrors(found);
    return Object.keys(found).length === 0;
  }

  // Test can raise the SSH questions too (trust the host key, the key passphrase). The password
  // is the form's: a missing one is a plain failure here, not a prompt.
  const testPrompts = useCredentialPrompts();
  const [testing, setTesting] = useState(false);

  async function runTest() {
    // The stored password is only tried on the server it was saved for.
    const request = toTestRequest(form, onSourceServer ? source.id : null);
    const ssh = request.ssh ?? null;
    setTest(null);
    setTesting(true);
    try {
      await testPrompts.start({
        target: { name: effectiveNickname(form), subtitle: connectionSubtitle(request), ssh },
        credentials: { password: request.password },
        kinds: ['ssh-trust', 'ssh-changed', 'ssh-passphrase'],
        attempt: async (c) => {
          const result = await api.testConnection({
            ...request,
            ...(c.sshPassphrase !== undefined ? { sshPassphrase: c.sshPassphrase } : {}),
            ...(c.trustSshFingerprint ? { trustSshFingerprint: c.trustSshFingerprint } : {}),
          });
          setTest({ ok: true, result, ssh });
          // A passphrase typed in the prompt goes into the form, so Save keeps it as asked there.
          const passphrase = c.sshPassphrase;
          if (passphrase !== undefined) {
            setForm((f) => ({ ...f, sshPassphrase: passphrase, saveSshPassphrase: c.rememberSshPassphrase === true }));
          }
        },
        onFailure: (err) => setTest({ ok: false, message: errorText(err) }),
      });
    } finally {
      setTesting(false);
    }
  }

  const saveMutation = useMutation({
    mutationFn: (mode: 'create' | 'update') => {
      const input = toConnectionInput(form);
      if (mode === 'update' && saved) return api.updateConnection(saved.id, input);
      return api.createConnection({
        ...input,
        ...(forkName ? { nickname: forkName } : {}),
        // The server copies the source's Keychain entries only if it is the same server.
        copySecretsFrom: source?.id ?? null,
      });
    },
    onSuccess: async (result) => {
      // Secrets never come back, and the Keychain choices are the user's: keep them as typed.
      setBaseline({
        ...formFromSaved(result),
        password: form.password,
        savePassword: form.savePassword,
        sshPassphrase: form.sshPassphrase,
        saveSshPassphrase: form.saveSshPassphrase,
      });
      setForm((f) => ({ ...f, nickname: result.nickname, database: result.database }));
      await queryClient.invalidateQueries({ queryKey: queryKeys.connections });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (connectionId: string) => api.deleteConnection(connectionId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.connections });
      toast.success(`Deleted ${saved?.nickname ?? 'favorite'}`);
      onDeleted();
    },
    onError: (err) => toast.error('Could not delete the favorite', { description: errorText(err) }),
  });

  async function save(mode: 'create' | 'update'): Promise<SavedConnection | null> {
    if (!check()) return null;
    try {
      return await saveMutation.mutateAsync(mode);
    } catch (err) {
      toast.error('Could not save the favorite', { description: errorText(err) });
      return null;
    }
  }

  async function handleSave() {
    const result = await save(creating ? 'create' : 'update');
    if (result) {
      toast.success(fork ? `Saved ${result.nickname} as a new favorite` : `Saved ${result.nickname}`);
      onSaved(result);
    }
  }

  async function handleConnect() {
    const password = form.password === '' ? null : form.password;
    let target = saved;
    if (dirty) {
      target = await save(creating ? 'create' : 'update');
      if (!target) return;
      // A new favorite becomes the selection now, so a second Connect cannot create a duplicate.
      if (creating) onSaved(target);
    }
    if (!target) return;
    await onConnect(target, password);
  }

  function handleTest() {
    if (check()) void runTest();
  }

  /** "Update … instead": rewrite this favorite on purpose — asked first while a tab is open on it. */
  async function updateInstead(confirmed = false) {
    if (!saved) return;
    const tab = tabsStore.findByConnection(saved.id);
    if (!confirmed && tab && !tab.restore) {
      setConfirmUpdate(true);
      return;
    }
    const result = await save('update');
    if (result) toast.success(`Updated ${result.nickname}`);
  }

  async function choose(kind: 'key' | 'cert') {
    try {
      const path = await window.kleos?.openFileDialog(kind);
      if (path) update(kind === 'key' ? { sshKeyPath: path } : { sslRootCertPath: path });
    } catch (err) {
      toast.error('Could not open the file dialog', { description: errorText(err) });
    }
  }

  const busy = saveMutation.isPending || connecting;
  const title = forkName ?? (effectiveNickname(form) || 'New connection');
  const passwordPlaceholder =
    saved && !fork
      ? saved.hasPassword
        ? 'Saved in Keychain'
        : ''
      : onSourceServer && source.hasPassword
        ? `Same as ${source.nickname}`
        : '';

  return (
    <>
      <form
        noValidate
        aria-label="Connection"
        className="surface-raised animate-in fade-in-0 slide-in-from-bottom-1 w-full max-w-[620px] rounded-xl duration-200"
        onSubmit={(e) => {
          e.preventDefault();
          void handleConnect();
        }}
        onPaste={(e) => {
          const next = applyConnectionUrl(form, e.clipboardData.getData('text'));
          if (!next) return;
          e.preventDefault();
          setForm(next);
          setTest(null);
          setErrors({});
        }}
      >
        <div className="flex items-start gap-3.5 px-6 pt-6">
          <span
            aria-hidden="true"
            className="surface-raised relative flex size-10 shrink-0 items-center justify-center rounded-xl"
          >
            <Database className="text-brand-text size-[18px]" />
            <ColorDot color={form.color} className="ring-card absolute -right-0.5 -bottom-0.5 size-2.5 ring-2" />
          </span>
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex items-center gap-2.5">
              <h1 className="truncate text-lg leading-tight font-semibold tracking-[-0.015em]">{title}</h1>
              <Badge
                variant="outline"
                className={cn(
                  'h-5 text-[11px]',
                  creating && 'border-brand-line bg-brand-soft text-brand-text',
                  !creating && dirty && 'border-warning-line bg-warning-bg text-warning',
                )}
              >
                {creating ? 'New' : dirty ? 'Edited' : 'Saved'}
              </Badge>
            </div>
            {fork && saved ? (
              <p className="text-muted-foreground text-[12.5px]">
                A new favorite. <span className="text-foreground/80">{saved.nickname}</span> stays as it is.{' '}
                <button
                  type="button"
                  className="text-brand-text font-medium underline-offset-2 hover:underline"
                  onClick={() => void updateInstead()}
                >
                  Update {saved.nickname} instead
                </button>
              </p>
            ) : (
              <p className="text-muted-foreground text-[12.5px]">
                {template && <>A copy of {template.nickname}. </>}
                Paste a <span className="text-foreground/80 font-mono">postgres://</span> URL into any field to fill the
                whole form.
              </p>
            )}
          </div>
        </div>

        <div className="grid grid-cols-6 gap-x-4 gap-y-4 px-6 pt-6 pb-6">
          <Field className="col-span-6" label="Nickname" htmlFor={id('nick')} error={errors.nickname}>
            <Input
              id={id('nick')}
              className="h-8"
              value={form.nickname}
              placeholder={form.host.trim() || 'Same as host'}
              onChange={(e) => update({ nickname: e.target.value })}
            />
          </Field>
          <Field className="col-span-4" label="Host" htmlFor={id('host')} error={errors.host}>
            <Input
              id={id('host')}
              className="h-8 font-mono"
              value={form.host}
              spellCheck={false}
              aria-invalid={errors.host ? true : undefined}
              onChange={(e) => update({ host: e.target.value })}
            />
          </Field>
          <Field className="col-span-2" label="Port" htmlFor={id('port')} error={errors.port}>
            <Input
              id={id('port')}
              className="h-8 font-mono"
              inputMode="numeric"
              value={form.port}
              aria-invalid={errors.port ? true : undefined}
              onChange={(e) => update({ port: e.target.value })}
            />
          </Field>
          <Field className="col-span-3" label="User" htmlFor={id('user')} error={errors.user}>
            <Input
              id={id('user')}
              className="h-8 font-mono"
              value={form.user}
              spellCheck={false}
              placeholder="user name"
              aria-invalid={errors.user ? true : undefined}
              onChange={(e) => update({ user: e.target.value })}
            />
          </Field>
          <Field className="col-span-3" label="Password" htmlFor={id('pass')}>
            <Input
              id={id('pass')}
              type="password"
              className="h-8"
              autoComplete="off"
              value={form.password}
              placeholder={passwordPlaceholder}
              onChange={(e) => update({ password: e.target.value })}
            />
            <Label className="flex items-center gap-2 text-xs font-normal">
              <Checkbox
                checked={form.savePassword}
                onCheckedChange={(v) => update({ savePassword: v === true })}
                className="size-3.5"
              />
              Save password in Keychain
            </Label>
          </Field>
          <Field className="col-span-3" label="Database" htmlFor={id('db')}>
            <Input
              id={id('db')}
              className="h-8 font-mono"
              value={form.database}
              spellCheck={false}
              placeholder="same as user"
              onChange={(e) => update({ database: e.target.value })}
            />
          </Field>
          <Field className="col-span-3" label="SSL mode" htmlFor={id('ssl')}>
            <Select
              value={form.sslMode}
              onValueChange={(v) => {
                const sslMode = v as FormState['sslMode'];
                // The CA only applies when TLS is required; don't keep a hidden path that won't be saved.
                update(usesCaCertificate(sslMode) ? { sslMode } : { sslMode, sslRootCertPath: '' });
              }}
            >
              <SelectTrigger id={id('ssl')} size="sm" className="w-full font-mono">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {sslModes.map((mode) => (
                  <SelectItem key={mode} value={mode} className="font-mono">
                    {mode}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          {usesCaCertificate(form.sslMode) && (
            <Field
              className="col-span-6"
              label="CA certificate"
              htmlFor={id('ca')}
              hint="Optional. A PEM file to trust instead of the system certificates, for a private CA."
            >
              <PathPicker
                id={id('ca')}
                value={form.sslRootCertPath}
                placeholder="System certificates"
                clearLabel="Clear CA certificate"
                onChoose={() => void choose('cert')}
                onClear={() => update({ sslRootCertPath: '' })}
              />
            </Field>
          )}

          <SshSection
            form={form}
            errors={errors}
            hasSavedPassphrase={saved?.hasSshPassphrase === true}
            id={id}
            update={update}
            onChooseKey={() => void choose('key')}
          />

          <fieldset className="col-span-6 flex flex-col gap-2">
            <legend className="text-foreground/80 mb-2 text-xs font-medium">Window color</legend>
            <div className="flex flex-wrap items-center gap-2.5">
              <RadioGroupPrimitive.Root
                aria-label="Window color"
                orientation="horizontal"
                className="flex items-center gap-2.5"
                value={form.color}
                onValueChange={(v) => update({ color: v as FormState['color'] })}
              >
                {connectionColors.map((color) => (
                  <RadioGroupPrimitive.Item
                    key={color}
                    value={color}
                    aria-label={connectionColorLabel[color]}
                    className="ring-offset-card data-[state=checked]:ring-brand focus-visible:ring-ring/30 flex size-6 items-center justify-center rounded-full shadow-[inset_0_0_0_1px_rgb(0_0_0/0.12)] ring-offset-2 outline-none hover:scale-110 focus-visible:ring-[3px] data-[state=checked]:ring-2 dark:shadow-[inset_0_0_0_1px_rgb(255_255_255/0.14)]"
                    style={color === 'none' ? undefined : { background: connectionColorSwatch[color] }}
                  >
                    {color === 'none' && <Slash className="text-muted-foreground size-3.5" aria-hidden="true" />}
                  </RadioGroupPrimitive.Item>
                ))}
              </RadioGroupPrimitive.Root>
              <span className="text-muted-foreground ml-1 text-xs">Tints the window header for this connection.</span>
            </div>
          </fieldset>

          <div className="bg-muted/45 col-span-6 flex items-center justify-between gap-4 rounded-lg px-3.5 py-3 shadow-[inset_0_0_0_1px_var(--edge)] dark:bg-white/[0.03]">
            <div className="flex flex-col gap-0.5">
              <Label htmlFor={id('ro')} className="flex items-center gap-1.5 text-[13px]">
                <Lock className="text-muted-foreground size-3.5" aria-hidden="true" />
                Read-only
              </Label>
              <span id={id('ro-desc')} className="text-muted-foreground text-xs">
                Blocks edits and opens sessions with{' '}
                <span className="font-mono">default_transaction_read_only = on</span>.
              </span>
            </div>
            <Switch
              id={id('ro')}
              aria-describedby={id('ro-desc')}
              checked={form.readOnly}
              onCheckedChange={(v) => update({ readOnly: v })}
            />
          </div>

          {test && <TestResult outcome={test} />}
        </div>

        <div className="bg-muted/40 flex flex-wrap items-center gap-2 rounded-b-xl border-t px-6 py-3.5 dark:bg-white/[0.02]">
          {saved && (
            <Button
              type="button"
              variant="ghost"
              className="text-destructive hover:text-destructive hover:bg-error-bg -ml-2.5 dark:hover:bg-[color-mix(in_srgb,var(--destructive)_14%,transparent)]"
              onClick={() => setConfirmDelete(true)}
            >
              <Trash aria-hidden="true" />
              Delete
            </Button>
          )}
          {saved && !dirty && (
            <Button type="button" variant="ghost" onClick={() => onDuplicate(saved)}>
              <CopyPlus aria-hidden="true" />
              Duplicate
            </Button>
          )}
          <span className="flex-1" />
          <Button type="button" variant="outline" onClick={handleTest} disabled={testing}>
            {testing ? (
              <LoaderCircle className="animate-spin" aria-hidden="true" />
            ) : (
              <Plug className="size-3.5" aria-hidden="true" />
            )}
            {testing ? 'Testing…' : 'Test connection'}
          </Button>
          <Button type="button" variant="outline" onClick={() => void handleSave()} disabled={busy || !dirty}>
            {fork ? 'Save as new' : 'Save'}
          </Button>
          <Button
            type="submit"
            disabled={busy}
            title={
              fork && saved
                ? `Saves a new favorite, then connects. ${saved.nickname} is kept.`
                : dirty
                  ? 'Saves the favorite, then connects'
                  : undefined
            }
          >
            {connecting && <LoaderCircle className="animate-spin" aria-hidden="true" />}
            {connecting ? 'Connecting…' : fork ? 'Connect as new' : dirty ? 'Save & Connect' : 'Connect'}
            <kbd className={kbdOnPrimary}>↵</kbd>
          </Button>
        </div>

        {saved && (
          <AlertDialog open={confirmUpdate} onOpenChange={setConfirmUpdate}>
            <AlertDialogContent size="sm">
              <AlertDialogHeader>
                <AlertDialogTitle>Update {saved.nickname}?</AlertDialogTitle>
                <AlertDialogDescription>
                  It is open in a tab, connected to {connectionSubtitle(saved)}. That tab stays on it until you close
                  it; the favorite opens {connectionSubtitle(toConnectionInput(form))} from now on.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel size="sm">Keep it</AlertDialogCancel>
                <AlertDialogAction size="sm" onClick={() => void updateInstead(true)}>
                  Update
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
        {saved && (
          <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
            <AlertDialogContent size="sm">
              <AlertDialogHeader>
                <AlertDialogTitle>Delete {saved.nickname}?</AlertDialogTitle>
                <AlertDialogDescription>
                  Removes the favorite and its Keychain password. Open workspace windows stay connected.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel size="sm">Keep it</AlertDialogCancel>
                <AlertDialogAction variant="destructive" size="sm" onClick={() => deleteMutation.mutate(saved.id)}>
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </form>
      {/* Outside the form: dialogs are portalled, but their submit and paste events would still bubble into it. */}
      <CredentialDialogs prompts={testPrompts} />
    </>
  );
}

function Field({
  label,
  htmlFor,
  error,
  hint,
  className,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string;
  /** Quiet help line under the control. */
  hint?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <Label htmlFor={htmlFor} className="text-foreground/80 text-xs">
        {label}
      </Label>
      {children}
      {hint && !error && <span className="text-muted-foreground text-xs">{hint}</span>}
      {error && (
        <span id={`${htmlFor}-error`} className="text-destructive inline-flex items-center gap-1 text-xs">
          <CircleX className="size-3 shrink-0" aria-hidden="true" />
          {error}
        </span>
      )}
    </div>
  );
}

/** A file path chosen in the native dialog: read-only field, "Choose…", and a clear button once set. */
function PathPicker({
  id,
  value,
  placeholder,
  clearLabel,
  invalid,
  onChoose,
  onClear,
}: {
  id: string;
  value: string;
  placeholder: string;
  clearLabel?: string;
  invalid?: boolean;
  onChoose(): void;
  onClear?: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <Input
        id={id}
        readOnly
        className="h-8 min-w-0 flex-1 font-mono text-xs"
        value={value}
        placeholder={placeholder}
        title={value || undefined}
        aria-invalid={invalid ? true : undefined}
        onDoubleClick={onChoose}
      />
      {onClear && value && (
        <Button type="button" variant="ghost" size="icon-sm" aria-label={clearLabel} onClick={onClear}>
          <X aria-hidden="true" />
        </Button>
      )}
      <Button type="button" variant="outline" size="sm" className="h-8" onClick={onChoose}>
        Choose…
      </Button>
    </div>
  );
}

/**
 * "Connect through SSH": collapsed behind a switch. Host and port above then mean the
 * database as seen from the SSH server, which the description says plainly.
 */
function SshSection({
  form,
  errors,
  hasSavedPassphrase,
  id,
  update,
  onChooseKey,
}: {
  form: FormState;
  errors: FormErrors;
  hasSavedPassphrase: boolean;
  id(name: string): string;
  update(patch: Partial<FormState>): void;
  onChooseKey(): void;
}) {
  return (
    <div className="bg-muted/45 col-span-6 flex flex-col rounded-lg shadow-[inset_0_0_0_1px_var(--edge)] dark:bg-white/[0.03]">
      <div className="flex items-center justify-between gap-4 px-3.5 py-3">
        <div className="flex flex-col gap-0.5">
          <Label htmlFor={id('ssh')} className="flex items-center gap-1.5 text-[13px]">
            <Waypoints className="text-muted-foreground size-3.5" aria-hidden="true" />
            Connect through SSH
          </Label>
          <span id={id('ssh-desc')} className="text-muted-foreground text-xs">
            Reaches the database from an SSH server; Host and Port are then as seen from that server.
          </span>
        </div>
        <Switch
          id={id('ssh')}
          aria-describedby={id('ssh-desc')}
          checked={form.sshEnabled}
          onCheckedChange={(v) => update({ sshEnabled: v })}
        />
      </div>
      {form.sshEnabled && (
        <div className="animate-in fade-in-0 grid grid-cols-6 gap-x-4 gap-y-4 border-t px-3.5 pt-3.5 pb-4 duration-150">
          <Field className="col-span-4" label="SSH host" htmlFor={id('ssh-host')} error={errors.sshHost}>
            <Input
              id={id('ssh-host')}
              className="h-8 font-mono"
              value={form.sshHost}
              spellCheck={false}
              placeholder="bastion.example.com"
              aria-invalid={errors.sshHost ? true : undefined}
              onChange={(e) => update({ sshHost: e.target.value })}
            />
          </Field>
          <Field className="col-span-2" label="SSH port" htmlFor={id('ssh-port')} error={errors.sshPort}>
            <Input
              id={id('ssh-port')}
              className="h-8 font-mono"
              inputMode="numeric"
              value={form.sshPort}
              aria-invalid={errors.sshPort ? true : undefined}
              onChange={(e) => update({ sshPort: e.target.value })}
            />
          </Field>
          <Field className="col-span-3" label="SSH user" htmlFor={id('ssh-user')} error={errors.sshUser}>
            <Input
              id={id('ssh-user')}
              className="h-8 font-mono"
              value={form.sshUser}
              spellCheck={false}
              placeholder="user name"
              aria-invalid={errors.sshUser ? true : undefined}
              onChange={(e) => update({ sshUser: e.target.value })}
            />
          </Field>
          <div className="col-span-3 flex flex-col gap-1.5">
            <span id={id('ssh-auth')} className="text-foreground/80 text-xs font-medium">
              Authentication
            </span>
            <ToggleGroup
              type="single"
              value={form.sshAuth}
              onValueChange={(v) => v && update({ sshAuth: v as FormState['sshAuth'] })}
              aria-labelledby={id('ssh-auth')}
              className={cn(segmentedList, 'h-8 w-full')}
            >
              <ToggleGroupItem value="agent" className={cn(segmentedItem, 'flex-1 rounded-md! hover:bg-transparent')}>
                SSH agent
              </ToggleGroupItem>
              <ToggleGroupItem value="key" className={cn(segmentedItem, 'flex-1 rounded-md! hover:bg-transparent')}>
                Key file
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
          {form.sshAuth === 'key' && (
            <>
              <Field className="col-span-6" label="Private key" htmlFor={id('ssh-key')} error={errors.sshKeyPath}>
                <PathPicker
                  id={id('ssh-key')}
                  value={form.sshKeyPath}
                  placeholder="e.g. ~/.ssh/id_ed25519"
                  invalid={errors.sshKeyPath !== undefined}
                  onChoose={onChooseKey}
                />
              </Field>
              <Field className="col-span-6" label="Key passphrase" htmlFor={id('ssh-pass')}>
                <Input
                  id={id('ssh-pass')}
                  type="password"
                  className="h-8"
                  autoComplete="off"
                  value={form.sshPassphrase}
                  placeholder={hasSavedPassphrase ? 'Saved in Keychain' : 'None, or asked when connecting'}
                  onChange={(e) => update({ sshPassphrase: e.target.value })}
                />
                <Label className="flex items-center gap-2 text-xs font-normal">
                  <Checkbox
                    checked={form.saveSshPassphrase}
                    onCheckedChange={(v) => update({ saveSshPassphrase: v === true })}
                    className="size-3.5"
                  />
                  Remember in Keychain
                </Label>
              </Field>
            </>
          )}
          {form.sshAuth === 'agent' && (
            <p className="text-muted-foreground col-span-6 -mt-1 text-xs">
              Uses the keys loaded in the macOS SSH agent (<span className="font-mono">ssh-add</span>).
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function TestResult({ outcome }: { outcome: TestOutcome }) {
  if (outcome.ok) {
    const { result, ssh } = outcome;
    // `tls` is reported by servers from 0.4 on; older answers simply don't say.
    const route = [
      ssh ? `through SSH ${ssh.user}@${ssh.host}:${ssh.port}` : null,
      result.tls === true ? 'over TLS' : result.tls === false ? 'without TLS' : null,
    ].filter((part) => part !== null);
    return (
      <Callout
        role="status"
        tone="success"
        className="col-span-6"
        title={
          <>
            Connection works · <span className="tabular">{Math.round(result.elapsedMs)} ms</span>
          </>
        }
      >
        <span className="text-muted-foreground font-mono text-xs break-words">{result.version}</span>
        {route.length > 0 && <span className="text-muted-foreground text-xs">Connected {route.join(', ')}.</span>}
      </Callout>
    );
  }
  return (
    <Callout role="alert" tone="error" className="col-span-6" title="Connection failed">
      <span className="font-mono text-xs break-words">{outcome.message}</span>
    </Callout>
  );
}
