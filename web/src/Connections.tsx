// Settings → Connections: each connector's status, its fields and its buttons.
// Secret fields are password boxes that never show a saved value again: once
// saved they read "Saved ✓ · Replace". The page only ever gets status.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, CircleSlash, FileUp, FlaskConical, RefreshCw, XCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  connectConnector,
  disconnectConnector,
  fetchCalendarDefaults,
  fetchConnectors,
  importConnectorFile,
  saveCalendarDefaults,
  type CalendarDefaults,
  removeConnectorField,
  saveConnectorFields,
  syncConnector,
  type ConnectorStatus,
  type FieldStatus,
} from './api.ts';
import { ago, Card, Pill, PrimaryButton, SoftButton } from './ui.tsx';

/** The status pill: words and an icon, never colour alone. */
export function ConnectorPill({ s }: { s: Pick<ConnectorStatus, 'state' | 'sample'> }) {
  if (s.sample && s.state === 'not-set-up')
    return (
      <Pill tone="accent" data-testid="connector-state" data-state="sample">
        <FlaskConical size={11} aria-hidden /> Sample data
      </Pill>
    );
  switch (s.state) {
    case 'connected':
      return (
        <Pill tone="live" data-testid="connector-state" data-state="connected">
          <Check size={11} aria-hidden /> Connected
        </Pill>
      );
    case 'needs-reconnect':
      return (
        <Pill tone="warn" data-testid="connector-state" data-state="needs-reconnect">
          <AlertTriangle size={11} aria-hidden /> Needs reconnect
        </Pill>
      );
    case 'error':
      return (
        <Pill tone="danger" data-testid="connector-state" data-state="error">
          <XCircle size={11} aria-hidden /> Sync failed
        </Pill>
      );
    default:
      return (
        <Pill tone="neutral" data-testid="connector-state" data-state="not-set-up">
          <CircleSlash size={11} aria-hidden /> Not set up
        </Pill>
      );
  }
}

const inputClass =
  'h-8 w-full min-w-0 rounded-btn border border-control bg-card px-2.5 text-[13px] text-ink placeholder:text-muted focus-visible:border-accent sm:w-80';

export function ConnectionsSection() {
  const q = useQuery({ queryKey: ['connectors'], queryFn: fetchConnectors });
  return (
    <section id="connections" aria-labelledby="connections-h" className="scroll-mt-20 space-y-3" data-testid="connections">
      <div>
        <h2 id="connections-h" className="text-[15px] font-semibold text-ink">
          Connections
        </h2>
        <p className="mt-0.5 text-[13px] text-muted">
          Outside services the hub can use. Each one is off until you connect it, and makes no requests before that. Keys and sign-ins are kept in the macOS Keychain, never
          in the hub's files, and this page never shows them again.
        </p>
      </div>
      {q.error && <p className="text-[13px] text-red-700 dark:text-red-300">{(q.error as Error).message}</p>}
      {q.data?.map((s) => <ConnectorCard key={s.id} s={s} />)}
      {q.data?.length === 0 && <p className="text-[13px] text-muted">No connectors yet.</p>}
    </section>
  );
}

/** After a sign-in, the service sends you back with ?connected=<id>&ok=1|0; show it once, then tidy the URL. */
function useReturnFromSignIn(id: string): string | null {
  const [flash, setFlash] = useState<string | null>(null);
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    if (q.get('connected') !== id) return;
    setFlash(q.get('ok') === '1' ? 'Connected.' : null);
    history.replaceState(null, '', location.pathname + location.hash);
    document.getElementById('connections')?.scrollIntoView();
  }, [id]);
  return flash;
}

function ConnectorCard({ s }: { s: ConnectorStatus }) {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const flash = useReturnFromSignIn(s.id);
  const fileInput = useRef<HTMLInputElement>(null);
  const upload = useMutation({
    mutationFn: async (f: File) => {
      if (f.size > 16_000) throw new Error("That file is too big to be a Google client JSON.");
      let json: unknown;
      try {
        json = JSON.parse(await f.text());
      } catch {
        throw new Error("That file isn't JSON.");
      }
      return { status: await importConnectorFile(s.id, json), name: f.name };
    },
    onMutate: () => {
      setMessage(null);
      setNote(null);
    },
    onSuccess: ({ status, name }) => {
      done(status);
      setNote(`Saved the client ID, and the secret to the Keychain. Nothing else from the file was kept, so you can delete ${name} from your Downloads now.`);
    },
    onError: (e: Error) => setMessage(e.message),
  });
  const done = (next?: ConnectorStatus) => {
    if (next) queryClient.setQueryData<ConnectorStatus[]>(['connectors'], (all) => all?.map((x) => (x.id === next.id ? next : x)));
    void queryClient.invalidateQueries();
  };
  const onError = (e: Error) => setMessage(e.message);
  const connect = useMutation({
    mutationFn: () => connectConnector(s.id, '/settings#connections'),
    onMutate: () => setMessage(null),
    onSuccess: (r) => {
      // OAuth: off to the service's sign-in page, which sends you back here.
      if (r.redirect) location.assign(r.redirect);
      else done(r.status);
    },
    onError,
  });
  const disconnect = useMutation({ mutationFn: () => disconnectConnector(s.id), onMutate: () => setMessage(null), onSuccess: (r) => done(r.status), onError });
  const sync = useMutation({ mutationFn: () => syncConnector(s.id), onMutate: () => setMessage(null), onSuccess: (r) => done(r.status), onError });
  const busy = connect.isPending || disconnect.isPending || sync.isPending;
  const connected = s.state !== 'not-set-up';

  return (
    <Card as="article" className="p-4" data-testid={`connector-${s.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[14px] font-semibold text-ink">{s.name}</h3>
        <ConnectorPill s={s} />
        {s.account && connected && <span className="text-[12px] text-muted">as {s.account}</span>}
        {s.lastSyncAt && <span className="text-[12px] text-muted">· synced {ago(s.lastSyncAt)}</span>}
      </div>
      <p className="mt-1 text-[13px] text-muted">{s.description}</p>
      <p className="mt-1 text-[12px] text-muted">
        <span className="font-medium text-ink">What it sends: </span>
        {s.sends}
      </p>
      {s.sample && <p className="mt-1 text-[12px] text-muted">Running on sample data: this is a local stand-in and makes no outside requests.</p>}

      {s.error && (
        <p className="mt-2 text-[13px] text-warn" data-testid="connector-error">
          {s.error}
        </p>
      )}

      {s.acceptsFile && (
        <div className="mt-3">
          <input
            ref={fileInput}
            type="file"
            accept=".json,application/json"
            className="sr-only"
            aria-hidden
            tabIndex={-1}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) upload.mutate(f);
              e.target.value = '';
            }}
          />
          <SoftButton onClick={() => fileInput.current?.click()} disabled={upload.isPending}>
            <FileUp size={13} aria-hidden /> {upload.isPending ? 'Reading…' : 'Upload client JSON'}
          </SoftButton>
          <p className="mt-1 text-[12px] text-muted">The file Google Cloud gives you for a Desktop app client. Only its client ID and secret are kept; or type them below.</p>
        </div>
      )}

      {s.fields.length > 0 && (
        <div className="mt-3 space-y-2.5">
          {s.fields.map((f) => (
            <FieldRow key={f.key} id={s.id} f={f} onSaved={done} onError={onError} />
          ))}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {s.state === 'not-set-up' && (
          <PrimaryButton onClick={() => connect.mutate()} disabled={busy || !s.canConnect} testId={`connect-${s.id}`} title={s.canConnect ? undefined : 'Save the fields above first'}>
            {connect.isPending ? 'Connecting…' : 'Connect'}
          </PrimaryButton>
        )}
        {s.state === 'needs-reconnect' && (
          <PrimaryButton onClick={() => connect.mutate()} disabled={busy || !s.canConnect} testId={`reconnect-${s.id}`}>
            {connect.isPending ? 'Connecting…' : 'Reconnect'}
          </PrimaryButton>
        )}
        {s.canSync && (
          <SoftButton onClick={() => sync.mutate()} disabled={busy}>
            <RefreshCw size={13} aria-hidden className={sync.isPending ? 'hub-busy' : ''} /> {sync.isPending ? 'Syncing…' : 'Sync now'}
          </SoftButton>
        )}
        {connected && (
          <SoftButton onClick={() => disconnect.mutate()} disabled={busy}>
            Disconnect
          </SoftButton>
        )}
      </div>
      {(note || flash) && (
        <p role="status" className="mt-2 text-[13px] text-live" data-testid="connector-note">
          <Check size={13} aria-hidden className="mr-1 inline" />
          {note ?? flash}
        </p>
      )}
      {message && (
        <p role="alert" className="mt-2 text-[13px] text-red-700 dark:text-red-300" data-testid="connector-message">
          {message}
        </p>
      )}
    </Card>
  );
}

function FieldRow({ id, f, onSaved, onError }: { id: string; f: FieldStatus; onSaved: (s: ConnectorStatus) => void; onError: (e: Error) => void }) {
  const [value, setValue] = useState(f.secret ? '' : (f.value ?? ''));
  const [replacing, setReplacing] = useState(false);
  const save = useMutation({
    mutationFn: () => saveConnectorFields(id, { [f.key]: value }),
    onSuccess: (s) => {
      if (f.secret) setValue('');
      setReplacing(false);
      onSaved(s);
    },
    onError,
  });
  const remove = useMutation({ mutationFn: () => removeConnectorField(id, f.key), onSuccess: onSaved, onError });
  const inputId = `field-${id}-${f.key}`;
  const dirty = f.secret ? value.trim() !== '' : value.trim() !== (f.value ?? '');

  const showSaved = f.secret && f.saved && !replacing;
  return (
    <div data-testid={`field-${f.key}`}>
      <label htmlFor={inputId} className="block text-[12px] font-medium text-ink">
        {f.label}
      </label>
      {showSaved ? (
        <p className="mt-1 flex items-center gap-2 text-[13px] text-ink">
          <span data-testid="field-saved">
            Saved <Check size={13} aria-label="saved" className="inline text-live" />
          </span>
          <span className="text-muted" aria-hidden>
            ·
          </span>
          <button type="button" className="text-accent hover:underline" onClick={() => setReplacing(true)} id={inputId}>
            Replace
          </button>
          <span className="text-muted" aria-hidden>
            ·
          </span>
          <button type="button" className="text-muted hover:text-ink hover:underline" onClick={() => remove.mutate()} disabled={remove.isPending}>
            Remove
          </button>
        </p>
      ) : (
        <form
          className="mt-1 flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (dirty) save.mutate();
          }}
        >
          <input
            id={inputId}
            className={inputClass}
            type={f.secret ? 'password' : 'text'}
            autoComplete="off"
            spellCheck={false}
            placeholder={f.placeholder}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <SoftButton disabled={!dirty || save.isPending} onClick={() => dirty && save.mutate()}>
            {save.isPending ? 'Saving…' : 'Save'}
          </SoftButton>
          {replacing && (
            <button
              type="button"
              className="text-[13px] text-muted hover:text-ink hover:underline"
              onClick={() => {
                setReplacing(false);
                setValue('');
              }}
            >
              Cancel
            </button>
          )}
        </form>
      )}
      {f.help && <p className="mt-0.5 text-[12px] text-muted">{f.help}</p>}
    </div>
  );
}

/** Settings → Reminders: the defaults createEvent uses when a reminder doesn't say. */
export function CalendarDefaultsSection() {
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ['calendar-defaults'], queryFn: fetchCalendarDefaults });
  const [draft, setDraft] = useState<Partial<Record<keyof CalendarDefaults, string>>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const save = useMutation({
    mutationFn: () => saveCalendarDefaults(Object.fromEntries(Object.entries(draft).map(([k, v]) => [k, Number(v)]))),
    onSuccess: (d) => {
      queryClient.setQueryData(['calendar-defaults'], d);
      setDraft({});
      setMsg({ ok: true, text: 'Saved.' });
    },
    onError: (e: Error) => setMsg({ ok: false, text: e.message }),
  });
  if (!q.data) return null;
  const rows: { key: keyof CalendarDefaults; label: string; help: string }[] = [
    { key: 'eventMinutes', label: 'Event length (minutes)', help: 'When a reminder gives a start time but no end.' },
    { key: 'reminderMinutes', label: 'Reminder (minutes before)', help: 'A popup this long before a timed event.' },
    { key: 'allDayReminderMinutes', label: 'All-day reminder (minutes before midnight)', help: 'Google counts all-day reminders back from midnight at the start of the day: 900 is 9:00 AM the day before.' },
  ];
  const dirty = Object.keys(draft).length > 0;
  return (
    <section aria-labelledby="reminders-h" className="space-y-3" data-testid="calendar-defaults">
      <h2 id="reminders-h" className="text-[15px] font-semibold text-ink">
        Reminder defaults
      </h2>
      <Card className="p-4">
        <form
          className="space-y-2.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (dirty) save.mutate();
          }}
        >
          {rows.map((r) => (
            <div key={r.key}>
              <label htmlFor={`def-${r.key}`} className="block text-[12px] font-medium text-ink">
                {r.label}
              </label>
              <input
                id={`def-${r.key}`}
                type="number"
                min={0}
                inputMode="numeric"
                className={`${inputClass} mt-1 sm:w-32`}
                value={draft[r.key] ?? String(q.data[r.key])}
                onChange={(e) => setDraft({ ...draft, [r.key]: e.target.value })}
              />
              <p className="mt-0.5 text-[12px] text-muted">{r.help}</p>
            </div>
          ))}
          <SoftButton disabled={!dirty || save.isPending} onClick={() => dirty && save.mutate()}>
            {save.isPending ? 'Saving…' : 'Save'}
          </SoftButton>
          {msg && (
            <p role={msg.ok ? 'status' : 'alert'} className={`text-[13px] ${msg.ok ? 'text-live' : 'text-red-700 dark:text-red-300'}`}>
              {msg.text}
            </p>
          )}
        </form>
      </Card>
    </section>
  );
}
