// Buyer conversations, from every channel the business is on.
//
// Shopee, Lazada and TikTok Shop give a seller a chat thread and an order
// feed, and no phone line — there is no voice-call API on any of the three.
// So this panel never offers to ring anybody, and says why once at the top
// rather than leaving a seller hunting for a call button that cannot exist.
//
// A reply written here is drafted and filed: it reaches the buyer only after
// someone has approved it, which is why the composer says "Send for approval".
//
// The CRM desk's own replies are the one exception in the whole application,
// and only where an owner has switched it on for that channel — the switches
// at the top of this panel. Even on, a draft that promises something, that the
// desk was unsure of, or that answers a buyer who used one of the escalate
// words still waits in the queue. A reply that did go out by itself is marked
// as such in the thread, so the two are never confused on screen.
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

export default function InboxPanel({ businessId, refreshKey, isOwner, onSignedOut }) {
  const [data, setData] = useState(null);
  const [channel, setChannel] = useState('all');
  const [openId, setOpenId] = useState(null);
  const [thread, setThread] = useState(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);
  const [rules, setRules] = useState([]);
  // Which channel's escalate words are open, and the list as it is being
  // edited. Kept out of `rules` so cancelling really does cancel.
  const [wordsFor, setWordsFor] = useState(null);
  const [words, setWords] = useState([]);
  const [newWords, setNewWords] = useState('');
  // Held as text, not a number: an input you can clear while typing has to be
  // allowed to be empty for a moment without becoming NaN.
  const [maxRow, setMaxRow] = useState('3');

  const load = useCallback(async () => {
    try {
      const [inbox, replyRules] = await Promise.all([
        api.inbox(businessId, channel),
        // One floor at a time: a switch that answers buyers is not something
        // to flip across several businesses at once from one row of chips.
        businessId && businessId !== 'all'
          ? api.replyRules(businessId).catch(() => ({ rules: [] }))
          : Promise.resolve({ rules: [] }),
      ]);
      setData(inbox);
      setRules(replyRules.rules ?? []);
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

  const toggleAuto = async (rule) => {
    setBusy(true);
    setError(null);
    try {
      await api.setReplyRule(rule.id, { auto_reply: !rule.auto_reply });
      setNote(rule.auto_reply
        ? `${CHANNEL_LABEL[rule.channel] ?? rule.channel}: replies wait for you again.`
        : `${CHANNEL_LABEL[rule.channel] ?? rule.channel}: the desk will answer buyers`
          + ' itself. Anything it is unsure of still comes to you.');
      await load();
    } catch (err) {
      if (err instanceof Unauthorized) return onSignedOut();
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const openWords = (rule) => {
    setNote(null);
    setError(null);
    if (wordsFor === rule.id) { setWordsFor(null); return; }
    setWordsFor(rule.id);
    setWords(rule.escalate_words ?? []);
    setNewWords('');
    setMaxRow(String(rule.max_in_a_row ?? 3));
  };

  // A comma or a newline separates them, so a seller can paste a list in one
  // go instead of adding thirty words one at a time.
  const addWords = () => {
    const added = newWords.split(/[,\n]/).map((w) => w.toLowerCase().trim()).filter(Boolean);
    if (!added.length) return;
    setWords((current) => [...new Set([...current, ...added])]);
    setNewWords('');
  };

  const saveWords = async (rule, { reset = false } = {}) => {
    setBusy(true);
    setError(null);
    try {
      // Reset puts the shipped words back; the cap is this seller's choice
      // either way, so it rides along rather than being reset with them.
      const capped = Math.max(0, Math.min(20, Math.round(Number(maxRow) || 0)));
      const saved = await api.setReplyRule(rule.id, {
        ...(reset ? { reset_escalate_words: true } : { escalate_words: words }),
        ...(capped === rule.max_in_a_row ? {} : { max_in_a_row: capped }),
      });
      setWords(saved.rule.escalate_words ?? []);
      setMaxRow(String(saved.rule.max_in_a_row));
      setNote(reset
        ? `${CHANNEL_LABEL[rule.channel] ?? rule.channel}: the words are back to the`
          + ` ones it came with (${saved.rule.escalate_words.length}).`
        : `${CHANNEL_LABEL[rule.channel] ?? rule.channel}: ${saved.rule.escalate_words.length}`
          + ` words will fetch a person, and so will the ${saved.rule.max_in_a_row + 1}`
          + ' answer in a row.');
      await load();
    } catch (err) {
      if (err instanceof Unauthorized) return onSignedOut();
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const conversations = data?.conversations ?? [];
  const waiting = conversations.filter((c) => c.status === 'OPEN').length;
  const answering = rules.filter((r) => r.auto_reply);
  const editing = rules.find((r) => r.id === wordsFor) ?? null;

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

      {/* Who answers. Off everywhere until an owner says otherwise. */}
      {rules.length > 0 && (
        <div className="border-b border-slate-800 px-4 py-3">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <p className="text-xs text-slate-300">Let the desk answer by itself</p>
            <p className="text-[11px] text-slate-500">
              {answering.length === 0
                ? 'off everywhere — every reply waits for you'
                : `on for ${answering.map((r) => CHANNEL_LABEL[r.channel] ?? r.channel).join(', ')}`}
            </p>
          </div>
          <div className="mt-2 flex flex-wrap gap-1">
            {rules.map((rule) => (
              /* The switch, and the words that override it. Two controls, not
                 one: turning a channel on and deciding what always fetches a
                 person are different decisions. */
              <span
                key={rule.id}
                className={`inline-flex items-stretch overflow-hidden rounded-full border ${
                  rule.auto_reply
                    ? 'border-emerald-800 bg-emerald-950'
                    : 'border-slate-700'
                }`}
              >
                <button
                  id={`auto-${rule.channel}`}
                  type="button"
                  disabled={!isOwner || busy}
                  title={isOwner
                    ? 'An owner decides this. Replies the desk is unsure of still wait for you.'
                    : 'Only an owner can change this.'}
                  onClick={() => toggleAuto(rule)}
                  className={`px-2.5 py-1 text-[11px] ${
                    rule.auto_reply ? 'text-emerald-300' : 'text-slate-500'
                  } ${isOwner ? 'hover:bg-slate-800' : 'cursor-not-allowed opacity-70'}`}
                >
                  {CHANNEL_LABEL[rule.channel] ?? rule.channel}
                  <span className="ml-1 font-mono opacity-70">
                    {rule.auto_reply ? 'auto' : 'off'}
                  </span>
                </button>
                <button
                  id={`words-${rule.channel}`}
                  type="button"
                  onClick={() => openWords(rule)}
                  title="The words that always fetch a person, whatever the desk thought"
                  className={`border-l px-2 py-1 font-mono text-[10px] hover:bg-slate-800 ${
                    rule.auto_reply
                      ? 'border-emerald-900 text-emerald-400'
                      : 'border-slate-700 text-slate-500'
                  } ${wordsFor === rule.id ? 'bg-slate-800' : ''}`}
                >
                  {(rule.escalate_words ?? []).length} words
                </button>
              </span>
            ))}
          </div>

          {editing && (
            <div className="mt-3 rounded-lg border border-slate-800 bg-slate-950 p-3">
              <p className="text-xs text-slate-300">
                {CHANNEL_LABEL[editing.channel] ?? editing.channel} — a buyer who writes
                any of these gets you, not the desk
              </p>
              <p className="mt-1 text-[11px] text-slate-500">
                Matched whole: <span className="font-mono">bot</span> will not fire on
                “bother”. Put a space in one and it matches as a phrase.
              </p>

              {/* The other thing that stops the desk, and the only one that is
                  a number rather than a word. */}
              <div className="mt-3 flex flex-wrap items-center gap-2 border-b border-slate-800 pb-3">
                <label htmlFor="max-in-a-row" className="text-[11px] text-slate-400">
                  Stop and ask after
                </label>
                <input
                  id="max-in-a-row"
                  type="number"
                  min="0"
                  max="20"
                  disabled={!isOwner}
                  value={maxRow}
                  onChange={(e) => setMaxRow(e.target.value)}
                  className="w-16 rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-center font-mono text-xs text-slate-100 outline-none focus:border-sky-500 disabled:opacity-60"
                />
                <span className="text-[11px] text-slate-400">
                  answers in a row that nobody has read
                </span>
                <span className="text-[11px] text-slate-500">
                  {Number(maxRow) === 0
                    ? '— nought means every reply waits for you, like the switch being off'
                    : `— the ${Number(maxRow) + 1}${Number(maxRow) + 1 === 2 ? 'nd'
                      : (Number(maxRow) + 1 === 3 ? 'rd' : 'th')} waits.`
                      + ' A reply you approve yourself resets the count.'}
                </span>
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                {words.map((word) => (
                  <span
                    key={word}
                    className="inline-flex items-center gap-1 rounded-full border border-slate-700 bg-slate-900 px-2 py-0.5 font-mono text-[11px] text-slate-300"
                  >
                    {word}
                    {isOwner && (
                      <button
                        type="button"
                        aria-label={`remove ${word}`}
                        onClick={() => setWords((c) => c.filter((w) => w !== word))}
                        className="text-slate-500 hover:text-red-300"
                      >
                        ×
                      </button>
                    )}
                  </span>
                ))}
                {words.length === 0 && (
                  <span className="text-[11px] text-amber-300">
                    Nothing here. No word will fetch a person on this channel — only the
                    desk being unsure, a reply that promises something, or the run of
                    unread answers will.
                  </span>
                )}
              </div>

              {isOwner ? (
                <>
                  <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                    <input
                      id="new-escalate-words"
                      value={newWords}
                      onChange={(e) => setNewWords(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); addWords(); }
                      }}
                      placeholder="reklamo, sira, hindi pa dumating"
                      className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-slate-100 outline-none focus:border-sky-500"
                    />
                    <button
                      id="add-escalate-words"
                      type="button"
                      disabled={!newWords.trim()}
                      onClick={addWords}
                      className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-50"
                    >
                      Add
                    </button>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      id="save-escalate-words"
                      type="button"
                      disabled={busy}
                      onClick={() => saveWords(editing)}
                      className="rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
                    >
                      {busy ? 'Saving…' : 'Save words'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setWordsFor(null)}
                      className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800"
                    >
                      Cancel
                    </button>
                    {/* Deleting the word for "refund" is otherwise one-way:
                        there is nowhere to read the original set back from. */}
                    <button
                      id="reset-escalate-words"
                      type="button"
                      disabled={busy}
                      onClick={() => saveWords(editing, { reset: true })}
                      className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-400 hover:bg-slate-800 disabled:opacity-50"
                    >
                      Put the defaults back
                    </button>
                  </div>
                </>
              ) : (
                <p className="mt-3 text-[11px] text-slate-500">
                  Only an owner can change this list.
                </p>
              )}
            </div>
          )}
          {answering.length > 0 && (
            <p className="mt-2 text-[11px] text-amber-300">
              Replies on those channels go to the buyer without you reading them first.
              A draft that promises anything, that the desk was unsure of, or that answers
              a complaint still waits here. Pausing the CRM desk stops all of it.
            </p>
          )}
        </div>
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
                          {/* Which of the two kinds of outbound line this is. */}
                          {m.direction === 'OUT' && m.sent_at && (
                            m.sent_automatically
                              ? <span className="ml-1 text-emerald-400">· answered by the desk</span>
                              : <span className="ml-1 text-slate-600">· approved by you</span>
                          )}
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
