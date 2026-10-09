// The platform operator's floor: every business this deployment runs, how busy
// each one is, and the controls to open a new one.
//
// What is deliberately NOT here: draft text, approval payloads, feedback,
// customer names. The API never sends them to this view. Running the platform
// means watching the lights, not reading your customers' mail.
import { useCallback, useEffect, useState } from 'react';
import { api, Unauthorized } from './api.js';

const TYPE_LABEL = {
  electrical: 'Electrical',
  it_services: 'IT services',
  retail: 'Retail',
  food: 'Food & beverage',
  construction: 'Construction',
  logistics: 'Logistics',
  professional_services: 'Professional services',
  general: 'General',
};

const DESK_COLOUR = {
  IDLE: 'bg-slate-600',
  WORKING: 'bg-cyan-400',
  AWAITING_APPROVAL: 'bg-amber-400',
  PAUSED: 'bg-red-500',
};

const since = (value) => {
  if (!value) return 'never';
  const minutes = Math.round((Date.now() - new Date(value).getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};

function Tile({ label, value, tone = 'text-stone-100' }) {
  return (
    <div className="rounded-xl border border-[#2a2622] bg-[#141110] px-4 py-3">
      <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-stone-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${tone}`}>{value}</p>
    </div>
  );
}

/** Nine dots in the shape of the floor: activity, with no content attached. */
function DeskGrid({ desks }) {
  return (
    <div className="grid w-fit grid-cols-3 gap-1.5" aria-hidden="true">
      {desks.map((desk, i) => (
        <span
          key={desk.department + i}
          title={`${desk.department}: ${desk.status.toLowerCase().replace('_', ' ')}`}
          className={`h-2.5 w-2.5 rounded-sm ${DESK_COLOUR[desk.status] ?? 'bg-slate-700'}`}
        />
      ))}
    </div>
  );
}

export default function ControlRoom({ user, onSignOut, onEnterFloor, floors }) {
  const [data, setData] = useState(null);
  const [users, setUsers] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [newAccount, setNewAccount] = useState(null);
  const [form, setForm] = useState({ code: '', name: '', business_type: 'general' });
  const [accountForm, setAccountForm] = useState({ email: '', display_name: '', business_id: '', role: 'owner' });

  const load = useCallback(async () => {
    try {
      const [overview, accounts] = await Promise.all([api.platform.overview(), api.platform.users()]);
      setData(overview);
      setUsers(accounts);
      setError(null);
    } catch (err) {
      if (err instanceof Unauthorized) return onSignOut();
      setError(err.message);
    }
  }, [onSignOut]);

  useEffect(() => { load(); }, [load]);

  // The portal reads the database rather than the socket, so refresh it.
  useEffect(() => {
    const timer = setInterval(load, 15000);
    return () => clearInterval(timer);
  }, [load]);

  const createBusiness = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.platform.addBusiness(form);
      setForm({ code: '', name: '', business_type: 'general' });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const createAccount = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.platform.addUser(accountForm);
      setNewAccount(result);
      setAccountForm({ email: '', display_name: '', business_id: '', role: 'owner' });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (business) => {
    setError(null);
    try {
      await api.platform.setActive(business.id, !business.is_active);
      await load();
    } catch (err) {
      setError(err.message);
    }
  };

  const businesses = data?.businesses ?? [];
  const totals = businesses.reduce((acc, b) => ({
    live: acc.live + (b.is_active ? 1 : 0),
    working: acc.working + b.desks.filter((d) => d.status === 'WORKING').length,
    waiting: acc.waiting + b.pending,
    paused: acc.paused + b.desks.filter((d) => d.status === 'PAUSED').length,
    actions: acc.actions + b.actions_24h,
  }), { live: 0, working: 0, waiting: 0, paused: 0, actions: 0 });

  return (
    <div className="min-h-full bg-[#0b0908] text-stone-200">
      {/* The executive floor gets its own identity: warm charcoal and brass,
          so it never looks like a tenant's dashboard. */}
      <header className="border-b border-[#2a2622] bg-gradient-to-b from-[#16120f] to-[#0b0908]">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-4 px-4 py-5">
          <div className="min-w-0">
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-[#c9a227]">
              Platform operator
            </p>
            <h1 className="text-2xl font-semibold tracking-tight text-stone-50">Control Room</h1>
          </div>
          <span className="flex-1" />
          {floors.length > 0 && (
            <select
              onChange={(e) => e.target.value && onEnterFloor(e.target.value)}
              value=""
              className="rounded-lg border border-[#3a332c] bg-[#161210] px-3 py-1.5 text-sm text-stone-200"
            >
              <option value="">Enter a floor…</option>
              {floors.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          )}
          <span className="hidden text-xs text-stone-500 sm:inline">{user.email}</span>
          <button
            onClick={onSignOut}
            className="rounded-lg border border-[#3a332c] px-3 py-1.5 text-xs text-stone-300 hover:bg-[#1b1613]"
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-6 px-4 py-6">
        {error && (
          <p className="rounded-lg border border-red-900 bg-red-950/40 p-3 text-sm text-red-200">{error}</p>
        )}

        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Tile label="Businesses" value={`${totals.live}/${businesses.length}`} />
          <Tile label="Working now" value={totals.working} tone="text-cyan-300" />
          <Tile label="Drafts waiting" value={totals.waiting} tone="text-amber-300" />
          <Tile label="Agents paused" value={totals.paused} tone={totals.paused ? 'text-red-300' : 'text-stone-100'} />
          <Tile label="Actions / 24h" value={totals.actions} />
        </section>

        <p className="rounded-xl border border-[#2a2622] bg-[#120f0e] px-4 py-3 text-sm text-stone-400">
          You can see <span className="text-stone-200">what each office is doing</span> — never what
          it is saying. Drafts, feedback and customer details stay inside the business. To read
          those you need an account there, granted by its owner.
        </p>

        <section className="space-y-3">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.14em] text-stone-500">
            Floors
          </h2>
          {businesses.length === 0 && (
            <p className="rounded-xl border border-dashed border-[#2a2622] p-6 text-center text-sm text-stone-500">
              No businesses yet. Open the first one below.
            </p>
          )}
          <div className="grid gap-3 lg:grid-cols-2">
            {businesses.map((b) => (
              <article
                key={b.id}
                className={`rounded-xl border bg-[#131010] p-4 ${
                  b.is_active ? 'border-[#2a2622]' : 'border-red-950 opacity-70'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="truncate font-medium text-stone-100">{b.name}</h3>
                    <p className="font-mono text-xs text-stone-500">
                      {b.code} · {TYPE_LABEL[b.business_type] ?? b.business_type} · {b.currency}
                    </p>
                  </div>
                  <DeskGrid desks={b.desks} />
                </div>

                <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-4">
                  {[
                    ['Waiting', b.pending, b.pending ? 'text-amber-300' : 'text-stone-300'],
                    ['Approved 24h', b.approved_24h, 'text-stone-300'],
                    ['Sent back 24h', b.rejected_24h, 'text-stone-300'],
                    ['Accounts', b.member_count, 'text-stone-300'],
                  ].map(([label, value, tone]) => (
                    <div key={label}>
                      <dt className="text-stone-500">{label}</dt>
                      <dd className={`tabular-nums ${tone}`}>{value}</dd>
                    </div>
                  ))}
                </dl>

                <div className="mt-4 flex items-center justify-between gap-2 border-t border-[#211d1a] pt-3">
                  <span className="font-mono text-[11px] text-stone-500">
                    last activity {since(b.last_action_at)}
                  </span>
                  <button
                    onClick={() => toggle(b)}
                    className={`rounded-lg px-3 py-1.5 text-xs ${
                      b.is_active
                        ? 'border border-[#3a332c] text-stone-300 hover:bg-[#1b1613]'
                        : 'bg-[#c9a227] font-medium text-[#1a1409] hover:bg-[#dab43a]'
                    }`}
                  >
                    {b.is_active ? 'Suspend' : 'Restore'}
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-2">
          <form onSubmit={createBusiness} className="space-y-3 rounded-xl border border-[#2a2622] bg-[#131010] p-4">
            <h2 className="font-mono text-[11px] uppercase tracking-[0.14em] text-stone-500">
              Open a new floor
            </h2>
            <label className="block text-sm">
              <span className="text-stone-400">Business name</span>
              <input
                id="biz-name"
                required
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Sampaguita Catering"
                className="mt-1 w-full rounded-lg border border-[#3a332c] bg-[#0d0b0a] px-3 py-2 text-stone-100 outline-none focus:border-[#c9a227]"
              />
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-sm">
                <span className="text-stone-400">Code</span>
                <input
                  id="biz-code"
                  required
                  value={form.code}
                  onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
                  placeholder="BIZ_CATER"
                  className="mt-1 w-full rounded-lg border border-[#3a332c] bg-[#0d0b0a] px-3 py-2 font-mono text-sm text-stone-100 outline-none focus:border-[#c9a227]"
                />
              </label>
              <label className="block text-sm">
                <span className="text-stone-400">Type</span>
                <select
                  id="biz-type"
                  value={form.business_type}
                  onChange={(e) => setForm({ ...form, business_type: e.target.value })}
                  className="mt-1 w-full rounded-lg border border-[#3a332c] bg-[#0d0b0a] px-3 py-2 text-stone-100"
                >
                  {(data?.businessTypes ?? []).map((t) => (
                    <option key={t} value={t}>{TYPE_LABEL[t] ?? t}</option>
                  ))}
                </select>
              </label>
            </div>
            <button
              disabled={busy}
              className="w-full rounded-lg bg-[#c9a227] px-4 py-2 font-medium text-[#1a1409] hover:bg-[#dab43a] disabled:opacity-50"
            >
              Open the floor
            </button>
            <p className="text-xs text-stone-500">
              Creates the business and its nine desks, laid out like every other floor.
            </p>
          </form>

          <form onSubmit={createAccount} className="space-y-3 rounded-xl border border-[#2a2622] bg-[#131010] p-4">
            <h2 className="font-mono text-[11px] uppercase tracking-[0.14em] text-stone-500">
              Hand over an account
            </h2>
            <label className="block text-sm">
              <span className="text-stone-400">Email</span>
              <input
                id="acct-email"
                type="email"
                required
                value={accountForm.email}
                onChange={(e) => setAccountForm({ ...accountForm, email: e.target.value })}
                placeholder="owner@example.com"
                className="mt-1 w-full rounded-lg border border-[#3a332c] bg-[#0d0b0a] px-3 py-2 text-stone-100 outline-none focus:border-[#c9a227]"
              />
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-sm">
                <span className="text-stone-400">Business</span>
                <select
                  id="acct-biz"
                  required
                  value={accountForm.business_id}
                  onChange={(e) => setAccountForm({ ...accountForm, business_id: e.target.value })}
                  className="mt-1 w-full rounded-lg border border-[#3a332c] bg-[#0d0b0a] px-3 py-2 text-stone-100"
                >
                  <option value="">Choose…</option>
                  {businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </label>
              <label className="block text-sm">
                <span className="text-stone-400">Role</span>
                <select
                  id="acct-role"
                  value={accountForm.role}
                  onChange={(e) => setAccountForm({ ...accountForm, role: e.target.value })}
                  className="mt-1 w-full rounded-lg border border-[#3a332c] bg-[#0d0b0a] px-3 py-2 text-stone-100"
                >
                  <option value="owner">Owner — can pause agents</option>
                  <option value="reviewer">Reviewer — approve and reject only</option>
                </select>
              </label>
            </div>
            <button
              disabled={busy}
              className="w-full rounded-lg border border-[#3a332c] px-4 py-2 text-stone-200 hover:bg-[#1b1613] disabled:opacity-50"
            >
              Create the account
            </button>
            {newAccount && (
              <div className="rounded-lg border border-[#c9a227]/40 bg-[#1a1409] p-3 text-sm">
                <p className="text-stone-200">{newAccount.user.email} is ready.</p>
                <p className="mt-1 text-stone-400">
                  Password: <code className="font-mono text-[#e7c35a]">{newAccount.password}</code>
                </p>
                <p className="mt-1 text-xs text-stone-500">
                  Shown once. Pass it on, then close this.
                </p>
                <button
                  type="button"
                  onClick={() => setNewAccount(null)}
                  className="mt-2 text-xs text-stone-400 underline"
                >
                  Done
                </button>
              </div>
            )}
          </form>
        </section>

        <section className="space-y-3">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.14em] text-stone-500">Accounts</h2>
          <div className="overflow-x-auto rounded-xl border border-[#2a2622]">
            <table className="w-full min-w-[520px] text-left text-sm">
              <thead className="bg-[#141110] font-mono text-[11px] uppercase tracking-wide text-stone-500">
                <tr>
                  <th className="px-4 py-2.5 font-normal">Email</th>
                  <th className="px-4 py-2.5 font-normal">Access</th>
                  <th className="px-4 py-2.5 font-normal">Last signed in</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className="border-t border-[#211d1a]">
                    <td className="px-4 py-2.5">
                      <span className="text-stone-200">{u.email}</span>
                      {u.is_platform_owner && (
                        <span className="ml-2 rounded-full bg-[#1a1409] px-2 py-0.5 text-[11px] text-[#c9a227]">
                          operator
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-stone-400">
                      {u.access.length
                        ? u.access.map((a) => `${a.code}:${a.role}`).join('  ')
                        : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-stone-500">{since(u.last_login_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}
