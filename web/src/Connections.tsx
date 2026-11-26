// Settings → Connections: each connector's status, its fields and its buttons.
// Secret fields are password boxes that never show a saved value again: once
// saved they read "Saved ✓ · Replace". The page only ever gets status.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, CircleSlash, FlaskConical, RefreshCw, XCircle } from 'lucide-react';
import { useState } from 'react';
import {
  connectConnector,
  disconnectConnector,
  fetchConnectors,
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

function ConnectorCard({ s }: { s: ConnectorStatus }) {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const done = (next?: ConnectorStatus) => {
    if (next) queryClient.setQueryData<ConnectorStatus[]>(['connectors'], (all) => all?.map((x) => (x.id === next.id ? next : x)));
    void queryClient.invalidateQueries();
  };
  const onError = (e: Error) => setMessage(e.message);
  const connect = useMutation({
    mutationFn: () => connectConnector(s.id),
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

      {s.error && (s.state === 'error' || s.state === 'needs-reconnect') && (
        <p className="mt-2 text-[13px] text-warn" data-testid="connector-error">
          {s.error}
        </p>
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
