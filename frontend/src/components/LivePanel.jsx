// Live selling: the stream, the basket pinned to it, what the room is doing,
// and the viewers shouting "mine".
//
// The two platforms are not the same, and pretending otherwise would be the
// one lie this panel could tell:
//
//   TikTok    real. Products attach to the LIVE room and a viewer taps the
//             basket — the yellow one in the corner — and checks out there.
//             The slot number is what the host calls out: "item three".
//   Facebook  gone. Meta retired Live Shopping; product tagging in a Facebook
//             Live ended on 1 October 2022 and Instagram's in March 2023.
//             There is no basket to tap. The list is the host's own running
//             order, and the comments are the till — which is exactly how
//             sellers here work anyway.
//
// The gate is armed once instead of per message, because a live room moves
// faster than anyone can click: a human reads the exact line the desk will
// send a claimer and approves that. Pausing withdraws it immediately.
import { useCallback, useEffect, useState } from 'react';
import { api, Unauthorized } from './../api.js';

const STATUS_STYLE = {
  SCHEDULED: 'border-slate-700 bg-slate-800 text-slate-400',
  ARMED: 'border-amber-900 bg-amber-950 text-amber-300',
  LIVE: 'border-red-800 bg-red-950 text-red-300',
  PAUSED: 'border-amber-900 bg-amber-950 text-amber-300',
  ENDED: 'border-slate-700 bg-slate-800 text-slate-500',
};

const BASKET_STYLE = {
  PINNED: 'border-emerald-900 bg-emerald-950 text-emerald-300',
  PIN_PENDING: 'border-amber-900 bg-amber-950 text-amber-300',
  UNPIN_PENDING: 'border-amber-900 bg-amber-950 text-amber-300',
  FAILED: 'border-red-900 bg-red-950 text-red-300',
  REMOVED: 'border-slate-700 bg-slate-800 text-slate-500',
};

const money = (value, currency = 'PHP') =>
  `${currency} ${Number(value ?? 0).toLocaleString('en-PH', { minimumFractionDigits: 2 })}`;

export default function LivePanel({ businessId, isOwner, refreshKey, onSignedOut }) {
  const [data, setData] = useState(null);
  const [products, setProducts] = useState([]);
  const [booking, setBooking] = useState(false);
  const [form, setForm] = useState({ platform: 'tiktok', title: '', hold_minutes: '15' });
  const [filling, setFilling] = useState(null);     // session id
  const [connecting, setConnecting] = useState(null); // session id
  const [room, setRoom] = useState('');             // the stream's id or link
  const [picked, setPicked] = useState([]);         // { product_id, slot, live_price, allocation }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);

  const load = useCallback(async () => {
    try {
      const [live, catalogue] = await Promise.all([
        api.live(businessId),
        api.products(businessId),
      ]);
      setData(live);
      setProducts(catalogue.products ?? []);
      setError(null);
    } catch (err) {
      if (err instanceof Unauthorized) return onSignedOut();
      setError(err.message);
    }
  }, [businessId, onSignedOut]);

  useEffect(() => { load(); }, [load, refreshKey]);

  const book = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.bookLive({
        business_id: businessId,
        platform: form.platform,
        title: form.title,
        hold_minutes: Number(form.hold_minutes),
      });
      setForm({ platform: 'tiktok', title: '', hold_minutes: '15' });
      setBooking(false);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const fill = async (session) => {
    setBusy(true);
    setError(null);
    try {
      await api.fillBasket(session.id, picked);
      setFilling(null);
      setPicked([]);
      setNote(session.basket_supported
        ? 'Filed. The items go in the basket once it is approved.'
        : 'Filed. Approve it and the list is the host’s running order.');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const run = async (fn, said) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setNote(said);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const sessions = data?.sessions ?? [];

  return (
    <div className="min-w-0 rounded-xl border border-slate-800 bg-slate-900">
      <div className="flex min-w-0 flex-col gap-2 border-b border-slate-800 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-sm font-medium text-slate-200">Live selling</h2>
        {isOwner && !booking && (
          <button
            onClick={() => setBooking(true)}
            className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800"
          >
            Book a stream
          </button>
        )}
      </div>

      {error && <p className="px-4 pt-3 text-sm text-red-300">{error}</p>}
      {note && <p className="px-4 pt-3 text-sm text-emerald-300">{note}</p>}

      {booking && (
        <form onSubmit={book} className="space-y-3 border-b border-slate-800 p-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block text-sm">
              <span className="text-slate-400">Where</span>
              <select
                id="live-platform"
                value={form.platform}
                onChange={(e) => setForm({ ...form, platform: e.target.value })}
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-sky-500"
              >
                {(data?.platforms ?? []).map((p) => (
                  <option key={p.platform} value={p.platform}>
                    {p.platform === 'tiktok' ? 'TikTok Live' : 'Facebook Live'}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm sm:col-span-2">
              <span className="text-slate-400">What you are calling it</span>
              <input
                id="live-title" required value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder="Friday night electricals"
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-sky-500"
              />
            </label>
          </div>
          <label className="block text-sm">
            <span className="text-slate-400">How long a claim holds an item (minutes)</span>
            <input
              id="live-hold" type="number" min="1" max="180" value={form.hold_minutes}
              onChange={(e) => setForm({ ...form, hold_minutes: e.target.value })}
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-sky-500"
            />
          </label>
          {/* Said before they book, not after. */}
          <p className="text-[11px] text-slate-500">
            {(data?.platforms ?? []).find((p) => p.platform === form.platform)?.note}
          </p>
          <div className="flex gap-2">
            <button
              disabled={busy}
              className="rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
            >
              {busy ? 'Booking…' : 'Book it'}
            </button>
            <button
              type="button" onClick={() => setBooking(false)}
              className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {sessions.length === 0 ? (
        <p className="p-4 text-sm text-slate-500">
          No streams yet. Book one, put items in its basket, and arm it before you go on.
        </p>
      ) : (
        <ul className="divide-y divide-slate-800">
          {sessions.map((session) => {
            const pinned = (session.basket ?? []).filter((b) => b.state === 'PINNED');
            const latest = session.latest ?? {};
            const totals = session.totals ?? {};
            return (
              <li key={session.id} className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="truncate text-sm text-slate-100">{session.title}</h3>
                    <p className="font-mono text-[11px] text-slate-500">
                      {session.platform === 'tiktok' ? 'TikTok Live' : 'Facebook Live'}
                      {session.account_label ? ` · ${session.account_label}` : ''}
                      {' · '}{session.hold_minutes}-minute holds
                    </p>
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      <span className={`rounded-full border px-2 py-0.5 font-mono text-[10px] ${STATUS_STYLE[session.status]}`}>
                        {session.status.toLowerCase()}
                      </span>
                      {session.open_claims > 0 && (
                        <span className="rounded-full border border-amber-900 bg-amber-950 px-2 py-0.5 font-mono text-[10px] text-amber-300">
                          {session.open_claims} holding
                        </span>
                      )}
                      {!session.basket_supported && (
                        <span className="rounded-full border border-slate-700 bg-slate-800 px-2 py-0.5 font-mono text-[10px] text-slate-400">
                          no basket on this platform
                        </span>
                      )}
                    </div>
                  </div>

                  {isOwner && session.status !== 'ENDED' && (
                    <div className="flex shrink-0 flex-wrap gap-1.5">
                      {filling !== session.id && (
                        <button
                          onClick={() => {
                            setFilling(session.id);
                            setPicked((session.basket ?? []).map((b) => ({
                              product_id: b.product_id, slot: b.slot,
                              live_price: b.live_price ?? '', allocation: b.allocation,
                            })));
                            setNote(null);
                          }}
                          className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800"
                        >
                          Basket
                        </button>
                      )}
                      {/* Going live on the platform happens in the platform's
                          own app. This is where you tell this one which room
                          is yours, and from then on the orders find their way
                          back by themselves. */}
                      {session.armed_approval_id
                        && ['ARMED', 'SCHEDULED', 'LIVE'].includes(session.status)
                        && connecting !== session.id && (
                        <button
                          disabled={busy}
                          onClick={() => {
                            setConnecting(session.id);
                            setRoom(session.external_id ?? '');
                            setNote(null);
                          }}
                          className="rounded-lg border border-sky-800 px-3 py-1.5 text-xs text-sky-300 hover:bg-sky-950/60 disabled:opacity-50"
                        >
                          {session.status === 'LIVE' ? 'Stream link' : "I'm live"}
                        </button>
                      )}
                      {pinned.length > 0 && ['SCHEDULED'].includes(session.status) && (
                        <button
                          disabled={busy}
                          onClick={() => run(() => api.armLive(session.id),
                            'Filed. Approve it and the desk may answer claims in this stream.')}
                          className="rounded-lg border border-emerald-800 px-3 py-1.5 text-xs text-emerald-300 hover:bg-emerald-950/60 disabled:opacity-50"
                        >
                          Arm it
                        </button>
                      )}
                      {['LIVE', 'ARMED'].includes(session.status) && (
                        <button
                          disabled={busy}
                          onClick={() => run(() => api.pauseLive(session.id, false),
                            'Paused. Nothing goes out until you resume it.')}
                          className="rounded-lg border border-amber-900 px-3 py-1.5 text-xs text-amber-300 hover:bg-amber-950/60 disabled:opacity-50"
                        >
                          Pause
                        </button>
                      )}
                      {session.status === 'PAUSED' && (
                        <button
                          disabled={busy}
                          onClick={() => run(() => api.pauseLive(session.id, true), 'Back on.')}
                          className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-50"
                        >
                          Resume
                        </button>
                      )}
                      <button
                        disabled={busy}
                        onClick={() => run(() => api.endLive(session.id),
                          'Ended. Anything still held went back on the shelf.')}
                        className="rounded-lg border border-red-900 px-3 py-1.5 text-xs text-red-300 hover:bg-red-950/60 disabled:opacity-50"
                      >
                        End
                      </button>
                    </div>
                  )}
                </div>

                {/* Connecting the stream. The room id is what lets an order
                    be filed against this session exactly; without one, an
                    order can only be matched while this shop has a single
                    stream open, and the panel says so rather than pretending. */}
                {connecting === session.id && (
                  <div className="mt-3 rounded-lg border border-sky-900 bg-slate-950 p-3">
                    <p className="text-xs text-slate-400">
                      Start the stream in {session.platform === 'tiktok' ? 'TikTok' : 'Facebook'},
                      then paste its link or room id here. Everything viewers buy in
                      the room lands in Sales by itself, and the basket counts down
                      as it goes.
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <input
                        id="live-room"
                        value={room}
                        onChange={(e) => setRoom(e.target.value)}
                        placeholder="Stream link, or the room id"
                        className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-xs text-slate-100 outline-none focus:border-sky-500"
                      />
                      <button
                        disabled={busy}
                        onClick={() => run(async () => {
                          const out = await api.goLive(session.id, room.trim());
                          setConnecting(null);
                          return out;
                        }, 'Connected. Orders from this room will land here.')}
                        className="rounded-lg bg-sky-600 px-3 py-2 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50"
                      >
                        Connect
                      </button>
                      <button
                        onClick={() => { setConnecting(null); setNote(null); }}
                        className="rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-300 hover:bg-slate-800"
                      >
                        Cancel
                      </button>
                    </div>
                    {session.external_id && (
                      <p className="mt-2 font-mono text-[11px] text-emerald-400">
                        connected to room {session.external_id}
                      </p>
                    )}
                  </div>
                )}

                {/* What the room actually took. These are the orders
                    themselves, not the monitor's sample of them, so the figure
                    agrees with the Sales tab and survives the stream ending. */}
                {Number(session.sales?.orders ?? 0) > 0 && (
                  <div className="mt-3 rounded-lg border border-emerald-900/60 bg-emerald-950/30 px-3 py-2">
                    <p className="text-xs text-emerald-300">
                      <span className="font-mono text-sm">{session.sales.orders}</span>
                      {' '}order{session.sales.orders === 1 ? '' : 's'} from this stream ·{' '}
                      <span className="font-mono">{money(session.sales.gross)}</span>
                      {Number(session.sales.unpaid) > 0 && (
                        <span className="text-amber-400">
                          {' '}· {session.sales.unpaid} still unpaid
                        </span>
                      )}
                      {Number(session.sales.cancelled) > 0 && (
                        <span className="text-slate-500">
                          {' '}· {session.sales.cancelled} cancelled
                        </span>
                      )}
                    </p>
                  </div>
                )}

                {/* The monitor. Drawn from live_metrics, so it survives the tab
                    being closed and matches what anyone else is looking at. */}
                {(session.status === 'LIVE' || Number(totals.samples) > 0) && (
                  <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-6">
                    {[
                      ['watching', latest.viewers ?? 0],
                      ['peak', totals.peak_viewers ?? 0],
                      ['comments', latest.comments ?? 0],
                      [session.basket_supported ? 'basket taps' : 'taps (n/a)',
                       session.basket_supported ? latest.basket_opens ?? 0 : '—'],
                      ['orders', totals.orders ?? 0],
                      ['sales', money(totals.revenue ?? 0)],
                    ].map(([label, value]) => (
                      <div key={label} className="rounded-lg bg-slate-950 px-2.5 py-2">
                        <span className="block font-mono text-sm text-slate-100">{value}</span>
                        <span className="block text-[10px] text-slate-500">{label}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* The yellow basket itself: numbered the way the host calls it. */}
                {(session.basket ?? []).length > 0 && (
                  <ul className="mt-3 space-y-1">
                    {session.basket.map((b) => (
                      <li
                        key={b.id}
                        className="flex flex-wrap items-center gap-2 rounded-lg bg-slate-950 px-3 py-2 text-xs"
                      >
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-amber-500 font-mono text-[11px] font-bold text-slate-950">
                          {b.slot}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-slate-200">{b.name}</span>
                        <span className="font-mono text-slate-400">
                          {money(b.live_price ?? b.shelf_price)}
                          {b.live_price && Number(b.live_price) !== Number(b.shelf_price) && (
                            <span className="ml-1 text-slate-600 line-through">
                              {money(b.shelf_price)}
                            </span>
                          )}
                        </span>
                        <span className="font-mono text-slate-500">
                          {b.sold} sold · {b.reserved} held · {Math.max(0, b.allocation - b.reserved - b.sold)} left
                        </span>
                        <span
                          title={b.last_error ?? b.state}
                          className={`rounded-full border px-2 py-0.5 font-mono text-[10px] ${BASKET_STYLE[b.state]}`}
                        >
                          {b.state.replace(/_/g, ' ').toLowerCase()}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}

                {!session.basket_supported && (session.basket ?? []).length > 0 && (
                  <p className="mt-2 text-[11px] text-slate-500">{session.basket_note}</p>
                )}

                {filling === session.id && (
                  <div className="mt-3 space-y-3 rounded-lg border border-slate-800 bg-slate-950 p-3">
                    <p className="text-xs text-slate-400">
                      Which items, in what order, at what price, and how many of each
                      this stream may sell.
                    </p>
                    <ul className="space-y-1.5">
                      {products.map((product) => {
                        const index = picked.findIndex((p) => p.product_id === product.id);
                        const chosen = index !== -1;
                        return (
                          <li key={product.id} className="flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              onClick={() => setPicked((current) => (chosen
                                ? current.filter((p) => p.product_id !== product.id)
                                : [...current, {
                                    product_id: product.id,
                                    slot: current.length + 1,
                                    live_price: '',
                                    allocation: product.stock,
                                  }]))}
                              className={`min-w-0 flex-1 truncate rounded-lg border px-2.5 py-1.5 text-left text-xs ${
                                chosen
                                  ? 'border-emerald-800 bg-emerald-950 text-emerald-300'
                                  : 'border-slate-700 text-slate-400 hover:bg-slate-800'
                              }`}
                            >
                              {product.name}
                              <span className="ml-2 text-slate-500">
                                {money(product.price, product.currency)} · {product.stock} on the shelf
                              </span>
                            </button>
                            {chosen && (
                              <>
                                <input
                                  aria-label={`slot for ${product.name}`}
                                  type="number" min="1" max="99" value={picked[index].slot}
                                  onChange={(e) => setPicked((current) => current.map((p, i) => (
                                    i === index ? { ...p, slot: Number(e.target.value) } : p)))}
                                  className="w-14 rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-center font-mono text-xs text-slate-100 outline-none focus:border-sky-500"
                                />
                                <input
                                  aria-label={`live price for ${product.name}`}
                                  type="number" min="0" step="0.01"
                                  placeholder={String(product.price)}
                                  value={picked[index].live_price}
                                  onChange={(e) => setPicked((current) => current.map((p, i) => (
                                    i === index ? { ...p, live_price: e.target.value } : p)))}
                                  className="w-24 rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 font-mono text-xs text-slate-100 outline-none focus:border-sky-500"
                                />
                                <input
                                  aria-label={`how many of ${product.name}`}
                                  type="number" min="0" max={product.stock}
                                  value={picked[index].allocation}
                                  onChange={(e) => setPicked((current) => current.map((p, i) => (
                                    i === index ? { ...p, allocation: Number(e.target.value) } : p)))}
                                  className="w-16 rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 font-mono text-xs text-slate-100 outline-none focus:border-sky-500"
                                />
                              </>
                            )}
                          </li>
                        );
                      })}
                      {products.length === 0 && (
                        <li className="text-xs text-slate-500">
                          Nothing in the catalogue to sell yet.
                        </li>
                      )}
                    </ul>
                    <div className="flex flex-wrap gap-2">
                      <button
                        disabled={busy || picked.length === 0}
                        onClick={() => fill(session, picked)}
                        className="rounded-lg bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
                      >
                        {busy ? 'Filing…' : 'Put them in'}
                      </button>
                      <button
                        onClick={() => { setFilling(null); setPicked([]); }}
                        className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800"
                      >
                        Cancel
                      </button>
                      <span className="self-center text-xs text-slate-500">
                        The basket waits for approval, like everything else that goes out.
                      </span>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
