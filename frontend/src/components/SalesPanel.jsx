// Sales: the orders, and the money behind them.
//
// Those are two different events, days apart. The buyer pays the marketplace,
// which holds the money in escrow while the parcel travels and releases the
// seller's share later, minus its commission. This app never takes the money
// at any point — what it does is read where each order's money has got to,
// and say when a payout does not add up.
//
// Cash on delivery is the awkward one: an order can ship while it is still
// unpaid, and only becomes money when the courier hands it over. Whether this
// floor allows that, and up to what total, is a payment rule, so the buttons
// here obey the rule rather than guessing.
import { useCallback, useEffect, useState } from 'react';
import { api, Unauthorized } from './../api.js';

const STATUS_STYLE = {
  UNPAID: 'border-amber-900 bg-amber-950 text-amber-300',
  PAID: 'border-sky-800 bg-sky-950 text-sky-300',
  READY_TO_SHIP: 'border-indigo-900 bg-indigo-950 text-indigo-300',
  SHIPPED: 'border-cyan-900 bg-cyan-950 text-cyan-300',
  DELIVERED: 'border-emerald-900 bg-emerald-950 text-emerald-300',
  CANCELLED: 'border-slate-700 bg-slate-800 text-slate-400',
  RETURNED: 'border-red-900 bg-red-950 text-red-300',
};

const PAYMENT_WORD = {
  AWAITING: 'not paid',
  IN_ESCROW: 'paid — held by the platform',
  RELEASED: 'released to you',
  SHORT: 'paid out short',
  REFUNDED: 'refunded',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
  FAILED: 'failed',
};

const METHOD_WORD = {
  cod: 'cash on delivery', online: 'paid online', wallet: 'e-wallet',
  bank_transfer: 'bank transfer', installment: 'instalment',
  live_link: 'live checkout link', unknown: 'method unknown',
};

// What a human may move an order to from here. The rest comes from the
// marketplace; this is fulfilment, not invention.
const NEXT = {
  UNPAID: ['READY_TO_SHIP', 'CANCELLED'],
  PAID: ['READY_TO_SHIP', 'CANCELLED'],
  READY_TO_SHIP: ['SHIPPED', 'CANCELLED'],
  SHIPPED: ['DELIVERED', 'RETURNED'],
  DELIVERED: ['RETURNED'],
};

const money = (value, currency = 'PHP') =>
  `${currency} ${Number(value ?? 0).toLocaleString('en-PH', { minimumFractionDigits: 2 })}`;

const timeOf = (value) => new Date(value).toLocaleString('en-PH', {
  timeZone: 'Asia/Manila', month: 'short', day: 'numeric',
  hour: '2-digit', minute: '2-digit',
});

export default function SalesPanel({ businessId, isOwner, refreshKey, onSignedOut }) {
  const [data, setData] = useState(null);
  const [payouts, setPayouts] = useState([]);
  const [rules, setRules] = useState([]);
  const [status, setStatus] = useState('all');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);

  const load = useCallback(async () => {
    try {
      const [orders, paid, rule] = await Promise.all([
        api.orders(businessId, { status }),
        api.payouts(businessId),
        api.paymentRules(businessId),
      ]);
      setData(orders);
      setPayouts(paid.payouts ?? []);
      setRules(rule.rules ?? []);
      setError(null);
    } catch (err) {
      if (err instanceof Unauthorized) return onSignedOut();
      setError(err.message);
    }
  }, [businessId, status, onSignedOut]);

  useEffect(() => { load(); }, [load, refreshKey]);

  const move = async (order, next) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const result = await api.moveOrder(order.id, next);
      setNote(`${order.order_no ?? order.external_id} is now ${next.replace(/_/g, ' ').toLowerCase()}`
        + (result.stock && result.stock !== 'already taken' ? ` — stock ${result.stock}.` : '.'));
      await load();
    } catch (err) {
      // The rule's own words, so a refusal explains itself.
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const chase = async (order) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await api.chaseOrder(order.id);
      setNote('A nudge is drafted and waiting for approval.');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const orders = data?.orders ?? [];
  const totals = data?.totals ?? [];
  const short = payouts.filter((p) => p.state === 'SHORT');

  return (
    <div className="min-w-0 rounded-xl border border-slate-800 bg-slate-900">
      <div className="flex min-w-0 flex-col gap-2 border-b border-slate-800 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-sm font-medium text-slate-200">Sales</h2>
        <div className="flex min-w-0 flex-wrap gap-1">
          <button
            onClick={() => setStatus('all')}
            className={`rounded-full border px-2.5 py-1 text-[11px] ${
              status === 'all'
                ? 'border-sky-700 bg-sky-950 text-sky-300'
                : 'border-slate-700 text-slate-400 hover:bg-slate-800'
            }`}
          >
            All
          </button>
          {(data?.statuses ?? []).map((name) => (
            <button
              key={name}
              onClick={() => setStatus(name)}
              className={`rounded-full border px-2.5 py-1 text-[11px] ${
                status === name
                  ? 'border-sky-700 bg-sky-950 text-sky-300'
                  : 'border-slate-700 text-slate-400 hover:bg-slate-800'
              }`}
            >
              {name.replace(/_/g, ' ').toLowerCase()}
            </button>
          ))}
        </div>
      </div>

      {/* The numbers, read out of the database rather than added up from a
          filtered page. */}
      {totals.length > 0 && (
        <div className="flex flex-wrap gap-2 border-b border-slate-800 px-4 py-2">
          {totals.map((t) => (
            <span key={t.status} className="rounded-lg bg-slate-950 px-2.5 py-1 text-[11px] text-slate-400">
              {t.status.replace(/_/g, ' ').toLowerCase()}
              <span className="ml-1.5 font-mono text-slate-200">{t.orders}</span>
              <span className="ml-1.5 text-slate-500">{money(t.value)}</span>
            </span>
          ))}
        </div>
      )}

      {short.length > 0 && (
        <p className="border-b border-slate-800 bg-red-950/30 px-4 py-2 text-xs text-red-200">
          {short.length} payout{short.length === 1 ? '' : 's'} came in under what
          the orders inside add up to:{' '}
          {short.map((p) => `${p.account_label} ${money(p.variance, p.currency)}`).join(', ')}.
        </p>
      )}

      {error && <p className="px-4 pt-3 text-sm text-red-300">{error}</p>}
      {note && <p className="px-4 pt-3 text-sm text-emerald-300">{note}</p>}

      {orders.length === 0 ? (
        <p className="p-4 text-sm text-slate-500">
          No orders here yet. They arrive with the next sweep of your shops.
        </p>
      ) : (
        <ul className="divide-y divide-slate-800">
          {orders.map((order) => (
            <li key={order.id} className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate text-sm text-slate-100">
                    {order.order_no ?? order.external_id}
                    <span className="ml-2 text-slate-400">{order.buyer_name}</span>
                  </h3>
                  <p className="font-mono text-[11px] text-slate-500">
                    {money(order.total, order.currency)} · {order.account_label ?? 'direct'}
                    {order.source === 'live' && ' · from a live'} · {timeOf(order.placed_at)}
                  </p>
                  <p className="mt-0.5 text-[11px] text-slate-500">
                    {(order.items ?? []).map((i) => `${i.qty}× ${i.name}`).join(', ') || 'no lines yet'}
                  </p>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    <span className={`rounded-full border px-2 py-0.5 font-mono text-[10px] ${STATUS_STYLE[order.status]}`}>
                      {order.status.replace(/_/g, ' ').toLowerCase()}
                    </span>
                    {order.payment && (
                      <span className="rounded-full border border-slate-700 bg-slate-800 px-2 py-0.5 font-mono text-[10px] text-slate-400">
                        {METHOD_WORD[order.payment.method] ?? order.payment.method}
                        {' · '}{PAYMENT_WORD[order.payment.state] ?? order.payment.state}
                      </span>
                    )}
                    {order.stock_taken_at && (
                      <span className="rounded-full border border-slate-700 bg-slate-800 px-2 py-0.5 font-mono text-[10px] text-slate-500">
                        stock taken
                      </span>
                    )}
                  </div>
                  {order.payment && Number(order.payment.net) > 0 && (
                    <p className="mt-1 font-mono text-[10px] text-slate-600">
                      {money(order.payment.gross, order.currency)} gross −{' '}
                      {money(Number(order.payment.commission_fee)
                        + Number(order.payment.transaction_fee)
                        + Number(order.payment.shipping_fee)
                        + Number(order.payment.other_fee), order.currency)} fees ={' '}
                      {money(order.payment.net, order.currency)} to you
                    </p>
                  )}
                </div>

                <div className="flex shrink-0 flex-wrap gap-1.5">
                  {isOwner && (NEXT[order.status] ?? []).map((next) => (
                    <button
                      key={next}
                      disabled={busy}
                      onClick={() => move(order, next)}
                      className={`rounded-lg border px-3 py-1.5 text-xs disabled:opacity-50 ${
                        next === 'CANCELLED' || next === 'RETURNED'
                          ? 'border-red-900 text-red-300 hover:bg-red-950/60'
                          : 'border-slate-700 text-slate-300 hover:bg-slate-800'
                      }`}
                    >
                      {next.replace(/_/g, ' ').toLowerCase()}
                    </button>
                  ))}
                  {order.status === 'UNPAID' && (
                    <button
                      disabled={busy}
                      onClick={() => chase(order)}
                      className="rounded-lg border border-amber-900 px-3 py-1.5 text-xs text-amber-300 hover:bg-amber-950/60 disabled:opacity-50"
                    >
                      Chase it
                    </button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* The rules the Payments desk applies. Read-only here; changing one is
          an owner's decision made against a real number, not a toggle. */}
      {rules.length > 0 && (
        <div className="border-t border-slate-800 px-4 py-3">
          <h3 className="text-xs font-medium text-slate-400">
            What this floor does about money
          </h3>
          <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
            {rules.map((rule) => (
              <li key={rule.id} className="rounded-lg bg-slate-950 px-3 py-2 text-[11px] text-slate-400">
                <span className="font-mono text-slate-300">{rule.platform}</span>
                {' · '}
                {rule.allow_cod
                  ? `COD up to ${money(rule.cod_limit)}`
                  : 'no cash on delivery'}
                {' · stock leaves on '}
                {rule.release_stock_on === 'order' ? 'the order'
                  : rule.release_stock_on === 'release' ? 'the payout'
                  : 'payment'}
                {' · chase after '}
                {Math.round(rule.chase_unpaid_after_minutes / 60)}h
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
