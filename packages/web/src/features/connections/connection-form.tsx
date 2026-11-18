import { connectionColors, sslModes, type SavedConnection, type TestConnectionResult } from '@kleos/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, CircleX, Slash, Trash } from 'lucide-react';
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
import { api, errorText, queryKeys } from '@/lib/api';
import { cn } from '@/lib/utils';
import { connectionColorLabel, connectionColorSwatch } from './colors';
import {
  applyConnectionUrl,
  effectiveNickname,
  emptyForm,
  formFromSaved,
  sameForm,
  toConnectionInput,
  toTestRequest,
  validateForm,
  type FormErrors,
  type FormState,
} from './form-model';

type TestOutcome = { ok: true; result: TestConnectionResult } | { ok: false; message: string };

type Props = {
  /** null for a new, unsaved connection. */
  saved: SavedConnection | null;
  connecting: boolean;
  onSaved(saved: SavedConnection): void;
  onDeleted(): void;
  onConnect(connection: SavedConnection, password: string | null): Promise<void>;
};

/**
 * Login form for one favorite (keyed by id by the parent). Pasting a postgres:// URL into any
 * field fills the whole form. Connect on an unsaved or edited form saves it first, then connects.
 */
export function ConnectionForm({ saved, connecting, onSaved, onDeleted, onConnect }: Props) {
  const queryClient = useQueryClient();
  const initial = saved ? formFromSaved(saved) : emptyForm;
  const [form, setForm] = useState<FormState>(initial);
  const [baseline, setBaseline] = useState<FormState>(initial);
  const [errors, setErrors] = useState<FormErrors>({});
  const [test, setTest] = useState<TestOutcome | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const ids = useId();
  const id = (name: string) => `${ids}-${name}`;

  const dirty = !saved || !sameForm(form, baseline);

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

  const testMutation = useMutation({
    mutationFn: () => api.testConnection(toTestRequest(form, saved?.id ?? null)),
    onSuccess: (result) => setTest({ ok: true, result }),
    onError: (err) => setTest({ ok: false, message: errorText(err) }),
  });

  const saveMutation = useMutation({
    mutationFn: () => {
      const input = toConnectionInput(form);
      return saved ? api.updateConnection(saved.id, input) : api.createConnection(input);
    },
    onSuccess: async (result) => {
      setBaseline({ ...formFromSaved(result), password: form.password });
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

  async function save(): Promise<SavedConnection | null> {
    if (!check()) return null;
    try {
      return await saveMutation.mutateAsync();
    } catch (err) {
      toast.error('Could not save the favorite', { description: errorText(err) });
      return null;
    }
  }

  async function handleSave() {
    const result = await save();
    if (result) {
      toast.success(`Saved ${result.nickname}`);
      onSaved(result);
    }
  }

  async function handleConnect() {
    const password = form.password === '' ? null : form.password;
    let target = saved;
    if (dirty) {
      target = await save();
      if (!target) return;
      // A new favorite becomes the selection now, so a second Connect cannot create a duplicate.
      if (!saved) onSaved(target);
    }
    if (!target) return;
    await onConnect(target, password);
  }

  function handleTest() {
    if (check()) testMutation.mutate();
  }

  const busy = saveMutation.isPending || connecting;
  const title = effectiveNickname(form) || 'New connection';

  return (
    <form
      noValidate
      aria-label="Connection"
      className="bg-card w-full max-w-[620px] rounded-xl border shadow-[0_1px_3px_rgba(0,0,0,.06)]"
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
      <div className="flex flex-col gap-1.5 px-6 pt-6">
        <div className="flex items-center gap-2.5">
          <h1 className="truncate text-xl font-semibold tracking-[-0.01em]">{title}</h1>
          <Badge variant="secondary" className="h-5 text-[11px]">
            {!saved ? 'New' : dirty ? 'Edited' : 'Saved'}
          </Badge>
        </div>
        <p className="text-muted-foreground">
          Paste a <span className="font-mono">postgres://</span> URL into any field to fill the whole form.
        </p>
      </div>

      <div className="grid grid-cols-6 gap-x-4 gap-y-3.5 px-6 py-5">
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
            placeholder={saved?.hasPassword ? 'Saved in Keychain' : ''}
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
          <Select value={form.sslMode} onValueChange={(v) => update({ sslMode: v as FormState['sslMode'] })}>
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

        <fieldset className="col-span-6 flex flex-col gap-2">
          <legend className="mb-2 text-xs font-medium">Window color</legend>
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
                  className="ring-offset-background data-[state=checked]:ring-ring focus-visible:ring-ring/50 flex size-6 items-center justify-center rounded-full border ring-offset-2 outline-none focus-visible:ring-[3px] data-[state=checked]:ring-2"
                  style={color === 'none' ? undefined : { background: connectionColorSwatch[color] }}
                >
                  {color === 'none' && <Slash className="text-muted-foreground size-3.5" aria-hidden="true" />}
                </RadioGroupPrimitive.Item>
              ))}
            </RadioGroupPrimitive.Root>
            <span className="text-muted-foreground ml-1 text-xs">Tints the window header for this connection.</span>
          </div>
        </fieldset>

        <div className="col-span-6 flex items-center justify-between gap-4 rounded-lg border px-3.5 py-3">
          <div className="flex flex-col gap-0.5">
            <Label htmlFor={id('ro')} className="text-[13px]">
              Read-only
            </Label>
            <span id={id('ro-desc')} className="text-muted-foreground text-xs">
              Blocks edits and opens sessions with <span className="font-mono">default_transaction_read_only = on</span>
              .
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

      <div className="flex flex-wrap items-center gap-2 border-t px-6 py-4">
        {saved && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
            onClick={() => setConfirmDelete(true)}
          >
            <Trash aria-hidden="true" />
            Delete
          </Button>
        )}
        <span className="flex-1" />
        <Button type="button" variant="outline" size="sm" onClick={handleTest} disabled={testMutation.isPending}>
          {testMutation.isPending ? 'Testing…' : 'Test connection'}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => void handleSave()} disabled={busy || !dirty}>
          Save
        </Button>
        <Button type="submit" size="sm" disabled={busy} title={dirty ? 'Saves the favorite, then connects' : undefined}>
          {connecting ? 'Connecting…' : dirty ? 'Save & Connect' : 'Connect'}
          <kbd className="rounded border border-current/40 px-1 font-mono text-[11px] font-medium">↵</kbd>
        </Button>
      </div>

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
  );
}

function Field({
  label,
  htmlFor,
  error,
  className,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <Label htmlFor={htmlFor} className="text-xs">
        {label}
      </Label>
      {children}
      {error && (
        <span id={`${htmlFor}-error`} className="text-destructive text-xs">
          {error}
        </span>
      )}
    </div>
  );
}

function TestResult({ outcome }: { outcome: TestOutcome }) {
  if (outcome.ok) {
    return (
      <div
        role="status"
        className="bg-success-bg border-success-line col-span-6 flex items-start gap-2.5 rounded-lg border px-3.5 py-3"
      >
        <CircleCheck className="text-success mt-px size-4 shrink-0" aria-hidden="true" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <b className="font-semibold">Connection works · {Math.round(outcome.result.elapsedMs)} ms</b>
          <span className="text-muted-foreground font-mono text-xs break-words">{outcome.result.version}</span>
        </div>
      </div>
    );
  }
  return (
    <div
      role="alert"
      className="bg-error-bg border-error-line col-span-6 flex items-start gap-2.5 rounded-lg border px-3.5 py-3"
    >
      <CircleX className="text-destructive mt-px size-4 shrink-0" aria-hidden="true" />
      <div className="flex min-w-0 flex-col gap-0.5">
        <b className="font-semibold">Connection failed</b>
        <span className="font-mono text-xs break-words">{outcome.message}</span>
      </div>
    </div>
  );
}
