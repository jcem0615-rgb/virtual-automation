// The Secretary desk's book: what happened, what was agreed, what somebody
// wants remembered.
//
// Nothing here is outbound, which is why there is no "send for approval"
// anywhere in this panel. Every other panel in this app drafts something on
// its way to a customer; a note is for the people who run the floor, so
// writing it is the whole action. The daily record is the desk's own,
// compiled from what the floor actually did rather than written by the model,
// so the numbers in it are numbers and not a guess.
import { useCallback, useEffect, useState } from 'react';
import { api, Unauthorized } from './../api.js';

const KIND_LABEL = {
  note: 'Note',
  minute: 'Minutes',
  handover: 'Handover',
  daily: 'Daily record',
};

const KIND_STYLE = {
  note: 'border-slate-700 bg-slate-800 text-slate-300',
  minute: 'border-sky-900 bg-sky-950 text-sky-300',
  handover: 'border-violet-900 bg-violet-950 text-violet-300',
  daily: 'border-cyan-900 bg-cyan-950 text-cyan-300',
};

const timeOf = (value) => new Date(value).toLocaleString('en-PH', {
  timeZone: 'Asia/Manila', month: 'short', day: 'numeric',
  hour: '2-digit', minute: '2-digit',
});

export default function NotesPanel({ businessId, refreshKey, isOwner, onSignedOut }) {
  const [data, setData] = useState(null);
  const [kind, setKind] = useState('all');
  const [search, setSearch] = useState('');
  const [writing, setWriting] = useState(false);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [newKind, setNewKind] = useState('note');
  const [editing, setEditing] = useState(null);
  const [editBody, setEditBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);

  const load = useCallback(async () => {
    try {
      setData(await api.notes(businessId, { kind, q: search.trim() || undefined }));
      setError(null);
    } catch (err) {
      if (err instanceof Unauthorized) return onSignedOut();
      setError(err.message);
    }
  }, [businessId, kind, search, onSignedOut]);

  useEffect(() => { load(); }, [load, refreshKey]);

  const write = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.writeNote({
        business_id: businessId,
        kind: newKind,
        subject: subject.trim(),
        body: body.trim(),
      });
      setWriting(false);
      setSubject(''); setBody(''); setNewKind('note');
      setNote('Written down.');
      await load();
    } catch (err) {
      if (err instanceof Unauthorized) return onSignedOut();
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const save = async (row) => {
    setBusy(true);
    setError(null);
    try {
      await api.editNote(row.id, { body: editBody.trim() });
      setEditing(null);
      setNote('Saved.');
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
      await api.editNote(row.id, { pinned: !row.pinned });
      await load();
    } catch (err) {
      if (err instanceof Unauthorized) return onSignedOut();
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (row) => {
    setBusy(true);
    setError(null);
    try {
      await api.deleteNote(row.id);
      setNote('Thrown away. The log keeps that it existed.');
      await load();
    } catch (err) {
      if (err instanceof Unauthorized) return onSignedOut();
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const notes = data?.notes ?? [];
  const oneFloor = businessId && businessId !== 'all';

  return (
    <div className="min-w-0 rounded-xl border border-slate-800 bg-slate-900">
      <div className="flex min-w-0 flex-col gap-2 border-b border-slate-800 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-medium text-slate-200">The book</h2>
          {oneFloor && (
            <button
              id="write-note"
              onClick={() => { setWriting((open) => !open); setNote(null); setError(null); }}
              className="rounded-lg border border-slate-700 px-2.5 py-1 text-[11px] text-slate-300 hover:bg-slate-800"
            >
              {writing ? 'Close' : 'Write a note'}
            </button>
          )}
        </div>
        <div className="flex min-w-0 flex-wrap gap-1">
          {['all', ...(data?.kinds ?? [])].map((name) => (
            <button
              key={name}
              onClick={() => setKind(name)}
              className={`rounded-full border px-2.5 py-1 text-[11px] ${
                kind === name
                  ? 'border-sky-700 bg-sky-950 text-sky-300'
                  : 'border-slate-700 text-slate-400 hover:bg-slate-800'
              }`}
            >
              {name === 'all' ? 'All' : KIND_LABEL[name] ?? name}
            </button>
          ))}
        </div>
      </div>

      <div className="border-b border-slate-800 px-4 py-2">
        <input
          id="search-notes"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Look something up…"
          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs text-slate-100 outline-none focus:border-sky-500"
        />
      </div>

      {error && <p className="px-4 pt-3 text-sm text-red-300">{error}</p>}
      {note && <p className="px-4 pt-3 text-sm text-emerald-300">{note}</p>}

      {writing && (
        <form onSubmit={write} className="space-y-2 border-b border-slate-800 bg-slate-950/40 p-4">
          <div className="flex flex-wrap gap-1">
            {(data?.kinds ?? []).filter((k) => k !== 'daily').map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setNewKind(k)}
                className={`rounded-full border px-2.5 py-1 text-[11px] ${
                  newKind === k
                    ? 'border-emerald-800 bg-emerald-950 text-emerald-300'
                    : 'border-slate-700 text-slate-500 hover:bg-slate-800'
                }`}
              >
                {KIND_LABEL[k] ?? k}
              </button>
            ))}
            {/* The desk writes the daily record itself, from what the floor
                did. Letting a person hand-write one would put a number in the
                book that nothing stands behind. */}
            <span className="self-center text-[11px] text-slate-500">
              the daily record is the desk's own
            </span>
          </div>
          <input
            id="note-subject"
            required
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="What is this about?"
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-sky-500"
          />
          <textarea
            id="note-body"
            required
            rows={4}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Supplier rang — galvanised pipe goes up 8% in March. Quote before then."
            className="w-full rounded-lg border border-slate-700 bg-slate-950 p-3 text-sm text-slate-100 outline-none focus:border-sky-500"
          />
          <div className="flex flex-wrap gap-2">
            <button
              id="save-note"
              disabled={busy || !subject.trim() || !body.trim()}
              className="rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
            >
              {busy ? 'Writing…' : 'Write it down'}
            </button>
            <span className="self-center text-xs text-slate-500">
              Stays on this floor. Nothing here is ever sent anywhere.
            </span>
          </div>
        </form>
      )}

      {notes.length === 0 ? (
        <p className="p-4 text-sm text-slate-500">
          {search.trim()
            ? 'Nothing in the book matches that.'
            : 'The book is empty. The Secretary writes the day down by itself;'
              + ' anything else worth remembering you write here.'}
        </p>
      ) : (
        <ul className="divide-y divide-slate-800">
          {notes.map((row) => (
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
                    {row.author} · {timeOf(row.created_at)}
                    {row.agent_role_title ? ` · ${row.agent_role_title}` : ''}
                  </p>
                  {/* What it is about, when it is about something. */}
                  {(row.order_no || row.product_name || row.buyer_name || row.account_label) && (
                    <p className="mt-1 flex flex-wrap gap-1">
                      {row.order_no && (
                        <span className="rounded-full border border-slate-700 px-2 py-0.5 font-mono text-[10px] text-slate-400">
                          order {row.order_no}
                        </span>
                      )}
                      {row.product_name && (
                        <span className="rounded-full border border-slate-700 px-2 py-0.5 text-[10px] text-slate-400">
                          {row.product_name}
                        </span>
                      )}
                      {row.buyer_name && (
                        <span className="rounded-full border border-slate-700 px-2 py-0.5 text-[10px] text-slate-400">
                          {row.buyer_name}
                        </span>
                      )}
                      {row.account_label && (
                        <span className="rounded-full border border-slate-700 px-2 py-0.5 text-[10px] text-slate-400">
                          {row.account_label}
                        </span>
                      )}
                    </p>
                  )}
                </div>
                {editing !== row.id && (
                  <div className="flex shrink-0 flex-wrap gap-2">
                    <button
                      onClick={() => pin(row)}
                      disabled={busy}
                      className="rounded-lg border border-slate-700 px-2.5 py-1 text-[11px] text-slate-300 hover:bg-slate-800 disabled:opacity-50"
                    >
                      {row.pinned ? 'Unpin' : 'Pin'}
                    </button>
                    <button
                      onClick={() => { setEditing(row.id); setEditBody(row.body); setNote(null); }}
                      className="rounded-lg border border-slate-700 px-2.5 py-1 text-[11px] text-slate-300 hover:bg-slate-800"
                    >
                      Edit
                    </button>
                    {isOwner && (
                      <button
                        onClick={() => remove(row)}
                        disabled={busy}
                        className="rounded-lg border border-slate-700 px-2.5 py-1 text-[11px] text-slate-400 hover:bg-slate-800 disabled:opacity-50"
                      >
                        Throw away
                      </button>
                    )}
                  </div>
                )}
              </div>

              {editing === row.id ? (
                <div className="mt-3 space-y-2">
                  <textarea
                    id={`edit-note-${row.id}`}
                    rows={5}
                    value={editBody}
                    onChange={(e) => setEditBody(e.target.value)}
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 p-3 text-sm text-slate-100 outline-none focus:border-sky-500"
                  />
                  <div className="flex flex-wrap gap-2">
                    <button
                      disabled={busy || !editBody.trim()}
                      onClick={() => save(row)}
                      className="rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
                    >
                      {busy ? 'Saving…' : 'Save'}
                    </button>
                    <button
                      onClick={() => setEditing(null)}
                      className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <p className="mt-2 whitespace-pre-wrap text-sm text-slate-300">{row.body}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
