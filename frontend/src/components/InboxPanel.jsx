// Buyer conversations, from every channel the business is on.
//
// Shopee, Lazada and TikTok Shop give a seller a chat thread and an order
// feed, and no phone line — there is no voice-call API on any of the three.
// So this panel never offers to ring anybody, and says why once at the top
// rather than leaving a seller hunting for a call button that cannot exist.
//
// A reply is drafted here and filed. It reaches the buyer only after someone
// has approved it, which is why the composer says "Send for approval".
import { useCallback, useEffect, useState } from 'react';
import { api, Unauthorized } from './../api.js';

const CHANNEL_LABEL = {
  shopee_chat: 'Shopee chat',
  lazada_chat: 'Lazada chat',
  tiktok_dm: 'TikTok DM',
  meta_dm: 'Messenger',
  instagram_dm: 'Instagram DM',
  email: 'Email',
};

const STATUS_STYLE = {
  OPEN: 'border-sky-800 bg-sky-950 text-sky-300',
  AWAITING_APPROVAL: 'border-amber-900 bg-amber-950 text-amber-300',
  ANSWERED: 'border-emerald-900 bg-emerald-950 text-emerald-300',
  CLOSED: 'border-slate-700 bg-slate-800 text-slate-400',
};

const STATUS_WORD = {
  OPEN: 'waiting',
  AWAITING_APPROVAL: 'reply waiting for approval',
  ANSWERED: 'answered',
  CLOSED: 'closed',
};

const timeOf = (value) => new Date(value).toLocaleString('en-PH', {
  timeZone: 'Asia/Manila', month: 'short', day: 'numeric',
  hour: '2-digit', minute: '2-digit',
});

export default function InboxPanel({ businessId, refreshKey, onSignedOut }) {
  const [data, setData] = useState(null);
  const [channel, setChannel] = useState('all');
  const [openId, setOpenId] = useState(null);
  const [thread, setThread] = useState(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);

  const load = useCallback(async () => {
    try {
      setData(await api.inbox(businessId, channel));
      setError(null);
    } catch (err) {
      if (err instanceof Unauthorized) return onSignedOut();
      setError(err.message);
    }
  }, [businessId, channel, onSignedOut]);

  useEffect(() => { load(); }, [load, refreshKey]);

  const open = async (conversation) => {
    setOpenId(conversation.id);
    setDraft('');
    setNote(null);
    try {
      setThread(await api.thread(conversation.id));
    } catch (err) {
      if (err instanceof Unauthorized) return onSignedOut();
      setError(err.message);
    }
  };

  const send = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.replyToThread(openId, draft);
      setDraft('');
      setNote('Filed. It reaches the buyer once somebody approves it.');
      setThread(await api.thread(openId));
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const close = async (id) => {
    try {
      await api.closeThread(id);
      if (openId === id) { setOpenId(null); setThread(null); }
      await load();
    } catch (err) {
      setError(err.message);
    }
  };

  const conversations = data?.conversations ?? [];
  const waiting = conversations.filter((c) => c.status === 'OPEN').length;

  return (
    <div className="min-w-0 rounded-xl border border-slate-800 bg-slate-900">
      <div className="flex min-w-0 flex-col gap-2 border-b border-slate-800 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-sm font-medium text-slate-200">
          Inbox
          {waiting > 0 && (
            <span className="ml-2 rounded-full bg-sky-950 px-2 py-0.5 text-[11px] text-sky-300">
              {waiting} waiting
            </span>
          )}
        </h2>
        <div className="flex min-w-0 flex-wrap gap-1">
          <button
            onClick={() => setChannel('all')}
            className={`rounded-full border px-2.5 py-1 text-[11px] ${
              channel === 'all'
                ? 'border-sky-700 bg-sky-950 text-sky-300'
                : 'border-slate-700 text-slate-400 hover:bg-slate-800'
            }`}
          >
            All
          </button>
          {(data?.channels ?? []).map((name) => (
            <button
              key={name}
              onClick={() => setChannel(name)}
              className={`rounded-full border px-2.5 py-1 text-[11px] ${
                channel === name
                  ? 'border-sky-700 bg-sky-950 text-sky-300'
                  : 'border-slate-700 text-slate-400 hover:bg-slate-800'
              }`}
            >
              {CHANNEL_LABEL[name] ?? name}
            </button>
          ))}
        </div>
      </div>

      {/* The question every seller asks, answered before they go looking. */}
      {data?.calls?.supported === false && (
        <p className="border-b border-slate-800 bg-slate-950/60 px-4 py-2 text-[11px] text-slate-500">
          {data.calls.note}
        </p>
      )}

      {error && <p className="px-4 pt-3 text-sm text-red-300">{error}</p>}
      {note && <p className="px-4 pt-3 text-sm text-emerald-300">{note}</p>}

      {conversations.length === 0 ? (
        <p className="p-4 text-sm text-slate-500">
          No buyer messages here. They land the moment the chat sweep picks one up.
        </p>
      ) : (
        <ul className="divide-y divide-slate-800">
          {conversations.map((c) => (
            <li key={c.id} className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <button onClick={() => open(c)} className="min-w-0 flex-1 text-left">
                  <h3 className="truncate text-sm text-slate-100">
                    {c.buyer_name}
                    {c.unread > 0 && (
                      <span className="ml-2 rounded-full bg-sky-900 px-1.5 text-[10px] text-sky-200">
                        {c.unread}
                      </span>
                    )}
                  </h3>
                  <p className="truncate text-xs text-slate-400">
                    {c.last_direction === 'OUT' ? 'You: ' : ''}{c.last_body ?? '—'}
                  </p>
                  <p className="mt-1 font-mono text-[11px] text-slate-500">
                    {CHANNEL_LABEL[c.channel] ?? c.channel}
                    {c.account_label ? ` · ${c.account_label}` : ''} · {timeOf(c.last_message_at)}
                  </p>
                </button>
                <span className={`shrink-0 rounded-full border px-2 py-0.5 font-mono text-[10px] ${STATUS_STYLE[c.status]}`}>
                  {STATUS_WORD[c.status]}
                </span>
              </div>

              {openId === c.id && thread && (
                <div className="mt-3 space-y-3 rounded-lg border border-slate-800 bg-slate-950 p-3">
                  <ul className="max-h-56 space-y-2 overflow-y-auto">
                    {thread.messages.map((m) => (
                      <li
                        key={m.id}
                        className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                          m.direction === 'IN'
                            ? 'bg-slate-800 text-slate-200'
                            : 'ml-auto bg-sky-950 text-sky-100'
                        }`}
                      >
                        {m.body}
                        <span className="mt-1 block font-mono text-[10px] text-slate-500">
                          {m.direction === 'OUT' && !m.sent_at ? 'not sent' : timeOf(m.created_at)}
                        </span>
                      </li>
                    ))}
                    {thread.messages.length === 0 && (
                      <li className="text-xs text-slate-500">Nothing in this thread yet.</li>
                    )}
                  </ul>

                  {c.status === 'AWAITING_APPROVAL' ? (
                    <p className="text-xs text-amber-300">
                      A reply is already drafted and waiting in the approval queue.
                    </p>
                  ) : (
                    <form onSubmit={send} className="space-y-2">
                      <textarea
                        id={`reply-${c.id}`}
                        rows={2}
                        required
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        placeholder="Write the reply…"
                        className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-sky-500"
                      />
                      <div className="flex flex-wrap gap-2">
                        <button
                          disabled={busy}
                          className="rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
                        >
                          {busy ? 'Filing…' : 'Send for approval'}
                        </button>
                        <button
                          type="button"
                          onClick={() => close(c.id)}
                          className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800"
                        >
                          Close thread
                        </button>
                        <span className="self-center text-xs text-slate-500">
                          Nothing reaches the buyer until it is approved.
                        </span>
                      </div>
                    </form>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
