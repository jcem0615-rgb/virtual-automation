// The server room: what each desk has learnt, and what it takes into the
// next job.
//
// This is the one screen that shows why a draft came out the way it did.
// Everywhere else in this app you read what a desk wrote; here you read what
// it was thinking with. Nothing in here is outbound — a memory is read into
// a prompt and never sent — so there is no publish, no approval and no
// dispatch, exactly like the book.
//
// The cap is on screen on purpose. Every line here goes into every prompt
// that desk builds, so a desk at the limit is one that will start dropping
// the oldest thing it knows, and that is worth seeing before it bites.
import { useCallback, useEffect, useState } from 'react';
import { api, Unauthorized } from './../api.js';

const KIND_LABEL = {
  fact: 'Fact',
  preference: 'Preference',
  correction: 'Correction',
};

const KIND_STYLE = {
  fact: 'border-slate-700 bg-slate-800 text-slate-300',
  preference: 'border-sky-900 bg-sky-950 text-sky-300',
  correction: 'border-amber-900 bg-amber-950 text-amber-300',
};

const KIND_HINT = {
  fact: 'Something true about this business.',
  preference: 'How the people here want the work done.',
  correction: 'What a reviewer said when they turned a draft down.',
};

const timeOf = (value) => (value ? new Date(value).toLocaleString('en-PH', {
  timeZone: 'Asia/Manila', month: 'short', day: 'numeric',
  hour: '2-digit', minute: '2-digit',
}) : null);

export default function MemoryPanel({ businessId, agents, refreshKey, isOwner, onSignedOut }) {
  const [data, setData] = useState(null);
  const [kind, setKind] = useState('all');
  const [deskId, setDeskId] = useState(null);
  const [search, setSearch] = useState('');
  const [teaching, setTeaching] = useState(false);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [newKind, setNewKind] = useState('fact');
  const [newDesk, setNewDesk] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);

  const load = useCallback(async () => {
    try {
      setData(await api.memory(businessId, {
        agentId: deskId ?? undefined,
        kind,
        q: search.trim() || undefined,
      }));
      setError(null);
    } catch (err) {
      if (err instanceof Unauthorized) return onSignedOut();
      setError(err.message);
    }
  }, [businessId, deskId, kind, search, onSignedOut]);

  useEffect(() => { load(); }, [load, refreshKey]);

  const teach = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.teach({
        business_id: businessId,
        agent_id: newDesk,
        kind: newKind,
        subject: subject.trim(),
        body: body.trim(),
      });
      setTeaching(false);
      setSubject(''); setBody(''); setNewKind('fact');
      setNote('Learnt. The desk takes it into its next job.');
      await load();
    } catch (err) {
      if (err instanceof Unauthorized) return onSignedOut();
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const pin = async (row) => {
    setBusy(true);
    setError(null);
    try {
      await api.editMemory(row.id, { pinned: !row.pinned });
      await load();
    } catch (err) {
      if (err instanceof Unauthorized) return onSignedOut();
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const forget = async (row) => {
    setBusy(true);
    setError(null);
    try {
      await api.forget(row.id);
      setNote('Forgotten. The log keeps that the desk once knew it.');
      await load();
    } catch (err) {
      if (err instanceof Unauthorized) return onSignedOut();
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const memories = data?.memories ?? [];
  const desks = data?.desks ?? [];
  const limit = data?.limit ?? 40;
  const oneFloor = businessId && businessId !== 'all';
  const onFloor = (agents ?? []).filter((a) => a.business_id === businessId);
  const full = desks.filter((d) => d.held >= limit);

  return (
    <div className="min-w-0 rounded-xl border border-slate-800 bg-slate-900">
      <div className="flex min-w-0 flex-col gap-2 border-b border-slate-800 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <h2 className="flex items-center gap-2 text-sm font-medium text-slate-200">
            <span className="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-cyan-400" />
            The server
          </h2>
          {oneFloor && onFloor.length > 0 && (
            <button
              id="teach-desk"
              onClick={() => {
                setTeaching((open) => !open);
                setNewDesk((d) => d || onFloor[0].id);
                setNote(null); setError(null);
              }}
              className="rounded-lg border border-slate-700 px-2.5 py-1 text-[11px] text-slate-300 hover:bg-slate-800"
            >
              {teaching ? 'Close' : 'Teach a desk'}
            </button>
          )}
        </div>
        <div className="flex min-w-0 flex-wrap gap-1">
          {['all', ...(data?.kinds ?? [])].map((name) => (
            <button
              key={name}
              onClick={() => setKind(name)}
              title={KIND_HINT[name]}
              className={`rounded-full border px-2.5 py-1 text-[11px] ${
                kind === name
                  ? 'border-cyan-700 bg-cyan-950 text-cyan-300'
                  : 'border-slate-700 text-slate-400 hover:bg-slate-800'
              }`}
            >
              {name === 'all' ? 'All' : KIND_LABEL[name] ?? name}
            </button>
          ))}
        </div>
      </div>

      <p className="px-4 pt-3 text-xs text-slate-500">
        What the desks carry into a job, on top of their skills. A rejection
        with a reason lands here by itself. Nothing here is ever sent anywhere —
        it is read into the prompt, and whatever the desk writes next still
        goes through the queue.
      </p>

      {/* Which desk, and how full it is. A desk at the cap drops its oldest
          memory on the next run, so the number is on screen rather than in
          a log nobody reads. */}
      {desks.length > 0 && (
        <div className="flex min-w-0 flex-wrap gap-1 px-4 pt-3">
          <button
            onClick={() => setDeskId(null)}
            className={`rounded-full border px-2.5 py-1 text-[11px] ${
              deskId === null
                ? 'border-cyan-700 bg-cyan-950 text-cyan-300'
                : 'border-slate-700 text-slate-400 hover:bg-slate-800'
            }`}
          >
            Every desk
          </button>
          {desks.map((d) => (
            <button
              key={d.agent_id}
              onClick={() => setDeskId(deskId === d.agent_id ? null : d.agent_id)}
              className={`rounded-full border px-2.5 py-1 text-[11px] ${
                deskId === d.agent_id
                  ? 'border-cyan-700 bg-cyan-950 text-cyan-300'
                  : 'border-slate-700 text-slate-400 hover:bg-slate-800'
              }`}
            >
              {d.department}
              <span className={`ml-1.5 font-mono ${
                d.held >= limit ? 'text-amber-400' : 'text-slate-500'
              }`}>
                {d.held}/{limit}
              </span>
            </button>
          ))}
        </div>
      )}

      {full.length > 0 && (
        <p className="mx-4 mt-3 rounded-lg border border-amber-900 bg-amber-950/40 px-3 py-2 text-xs text-amber-300">
          {full.map((d) => d.department).join(', ')}{' '}
          {full.length === 1 ? 'is' : 'are'} holding more than the {limit} a prompt
          carries. Nothing is deleted — what is past the cap simply stops being read
          into the next job, least recently used first. Pin what has to stay, and
          forget what does not.
        </p>
      )}

      <div className="px-4 py-2">
        <input
          id="search-memory"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Look something up…"
          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs text-slate-100 outline-none focus:border-cyan-500"
        />
      </div>

      {error && <p className="px-4 pb-2 text-sm text-red-300">{error}</p>}
      {note && <p className="px-4 pb-2 text-sm text-emerald-300">{note}</p>}

      {teaching && (
        <form onSubmit={teach} className="space-y-2 border-y border-slate-800 bg-slate-950/40 p-4">
          <div className="flex flex-wrap gap-1">
            {(data?.kinds ?? []).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setNewKind(k)}
                title={KIND_HINT[k]}
                className={`rounded-full border px-2.5 py-1 text-[11px] ${
                  newKind === k
                    ? 'border-emerald-800 bg-emerald-950 text-emerald-300'
                    : 'border-slate-700 text-slate-500 hover:bg-slate-800'
                }`}
              >
                {KIND_LABEL[k] ?? k}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-slate-500">{KIND_HINT[newKind]}</p>
          <select
            id="teach-which-desk"
            value={newDesk}
            onChange={(e) => setNewDesk(e.target.value)}
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-500"
          >
            {onFloor.map((a) => (
              <option key={a.id} value={a.id}>{a.department} — {a.name}</option>
            ))}
          </select>
          <input
            id="memory-subject"
            required
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="What is this about? (telling it twice replaces it)"
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-500"
          />
          <textarea
            id="memory-body"
            required
            rows={3}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Delivery is two working days to Metro Manila. Never promise same-day."
            className="w-full rounded-lg border border-slate-700 bg-slate-950 p-3 text-sm text-slate-100 outline-none focus:border-cyan-500"
          />
          <div className="flex flex-wrap gap-2">
            <button
              id="save-memory"
              disabled={busy || !subject.trim() || !body.trim() || !newDesk}
              className="rounded-lg bg-cyan-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-cyan-500 disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Put it on the server'}
            </button>
            <span className="self-center text-xs text-slate-500">
              Goes into every draft this desk writes from now on.
            </span>
          </div>
        </form>
      )}

      {memories.length === 0 ? (
        <p className="p-4 text-sm text-slate-500">
          {search.trim()
            ? 'Nothing on the server matches that.'
            : 'The desks have learnt nothing yet. Turn a draft down with a reason'
              + ' and that reason lands here, or teach one something directly.'}
        </p>
      ) : (
        <ul className="divide-y divide-slate-800 border-t border-slate-800">
          {memories.map((row) => (
            <li key={row.id} className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm text-slate-100">
                    {row.pinned && <span className="mr-1 text-amber-400" aria-label="pinned">★</span>}
                    {row.subject}
                  </h3>
                  <p className="mt-1 flex flex-wrap items-center gap-1.5 font-mono text-[11px] text-slate-500">
                    <span className={`rounded-full border px-2 py-0.5 ${KIND_STYLE[row.kind]}`}>
                      {KIND_LABEL[row.kind] ?? row.kind}
                    </span>
                    <span className="rounded-full border border-slate-700 px-2 py-0.5 text-slate-400">
                      {row.agent_department}
                    </span>
                    learnt from {row.learned_from}
                    {/* How often a prompt has actually carried this. A row
                        that never moves off zero is one nobody needed. */}
                    {' · '}
                    {row.used_count === 0
                      ? 'not used yet'
                      : `used ${row.used_count}×${row.last_used_at ? `, last ${timeOf(row.last_used_at)}` : ''}`}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <button
                    onClick={() => pin(row)}
                    disabled={busy}
                    title="Kept past the cap, however old it gets."
                    className="rounded-lg border border-slate-700 px-2.5 py-1 text-[11px] text-slate-300 hover:bg-slate-800 disabled:opacity-50"
                  >
                    {row.pinned ? 'Unpin' : 'Pin'}
                  </button>
                  {isOwner && (
                    <button
                      onClick={() => forget(row)}
                      disabled={busy}
                      className="rounded-lg border border-slate-700 px-2.5 py-1 text-[11px] text-slate-400 hover:bg-slate-800 disabled:opacity-50"
                    >
                      Forget
                    </button>
                  )}
                </div>
              </div>
              <p className="mt-2 whitespace-pre-wrap text-sm text-slate-300">{row.body}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
