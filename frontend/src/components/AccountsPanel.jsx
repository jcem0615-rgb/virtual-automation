// The marketplace and social accounts a business has connected. One platform
// can hold several — two Shopee shops, a Lazada seller account — and each is
// synced or paused on its own.
//
// Credentials are written here and never read back: the API returns which
// fields are set, never their values.
import { useCallback, useEffect, useState } from 'react';
import { api, Unauthorized } from './../api.js';

const PLATFORM_LABEL = {
  facebook: 'Facebook', instagram: 'Instagram', tiktok: 'TikTok',
  shopee: 'Shopee', lazada: 'Lazada', x: 'X',
};

const FIELD_LABEL = {
  partner_id: 'Partner ID', partner_key: 'Partner key', shop_id: 'Shop ID',
  access_token: 'Access token', app_key: 'App key', app_secret: 'App secret',
  shop_cipher: 'Shop cipher', page_access_token: 'Page access token',
  bearer_token: 'Bearer token',
};

const REGIONS = ['PH', 'SG', 'MY', 'TH', 'ID', 'VN'];

export default function AccountsPanel({ businessId, isOwner, onSignedOut }) {
  const [data, setData] = useState(null);
  const [filter, setFilter] = useState('all');
  const [connecting, setConnecting] = useState(false);
  const [form, setForm] = useState({ platform: 'shopee', label: '', region: 'PH', credentials: {} });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      setData(await api.accounts(businessId, filter));
      setError(null);
    } catch (err) {
      if (err instanceof Unauthorized) return onSignedOut();
      setError(err.message);
    }
  }, [businessId, filter, onSignedOut]);

  useEffect(() => { load(); }, [load]);

  const required = data?.required?.[form.platform] ?? [];

  const connect = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.connectAccount({
        business_id: businessId,
        platform: form.platform,
        label: form.label,
        region: form.region,
        credentials: form.credentials,
      });
      setForm({ platform: form.platform, label: '', region: 'PH', credentials: {} });
      setConnecting(false);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const toggleSync = async (account) => {
    setError(null);
    try {
      await api.updateAccount(account.id, { sync_enabled: !account.sync_enabled });
      await load();
    } catch (err) {
      setError(err.message);
    }
  };

  const accounts = data?.accounts ?? [];

  return (
    <div className="min-w-0 rounded-xl border border-slate-800 bg-slate-900">
      <div className="flex min-w-0 flex-col gap-2 border-b border-slate-800 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-sm font-medium text-slate-200">Connected accounts</h2>
        <div className="flex min-w-0 flex-wrap gap-1">
          {['all', ...(data?.platforms ?? [])].map((name) => (
            <button
              key={name}
              onClick={() => setFilter(name)}
              className={`rounded-full border px-2.5 py-1 text-[11px] ${
                filter === name
                  ? 'border-sky-700 bg-sky-950 text-sky-300'
                  : 'border-slate-700 text-slate-400 hover:bg-slate-800'
              }`}
            >
              {name === 'all' ? 'All' : PLATFORM_LABEL[name] ?? name}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="px-4 pt-3 text-sm text-red-300">{error}</p>}
      {data && !data.key_configured && (
        <p className="mx-4 mt-3 rounded-lg border border-amber-900 bg-amber-950/40 p-3 text-xs text-amber-200">
          CREDENTIALS_KEY is not set on the server, so credentials cannot be stored yet.
        </p>
      )}

      {accounts.length === 0 ? (
        <p className="p-4 text-sm text-slate-500">
          No accounts connected{filter !== 'all' ? ` for ${PLATFORM_LABEL[filter]}` : ''} yet.
        </p>
      ) : (
        <ul className="divide-y divide-slate-800">
          {accounts.map((account) => (
            <li key={account.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm text-slate-100">
                  {account.label}
                  <span className="ml-2 rounded-full bg-slate-800 px-2 py-0.5 font-mono text-[10px] text-slate-400">
                    {PLATFORM_LABEL[account.platform] ?? account.platform}
                  </span>
                </p>
                <p className="mt-0.5 font-mono text-[11px] text-slate-500">
                  {account.external_id ? `#${account.external_id} · ` : ''}
                  {account.region ?? '—'} ·{' '}
                  {account.credentials.configured
                    ? account.credentials.fields.map((f) => f.name).join(', ')
                    : 'no credentials'}
                </p>
                {account.last_error && (
                  <p className="mt-1 text-xs text-red-300">{account.last_error}</p>
                )}
              </div>
              {isOwner ? (
                <button
                  onClick={() => toggleSync(account)}
                  className={`shrink-0 rounded-full border px-3 py-1 text-[11px] ${
                    account.sync_enabled
                      ? 'border-emerald-800 bg-emerald-950 text-emerald-300'
                      : 'border-slate-700 text-slate-500'
                  }`}
                >
                  {account.sync_enabled ? 'Syncing' : 'Paused'}
                </button>
              ) : (
                <span className="shrink-0 text-[11px] text-slate-500">
                  {account.sync_enabled ? 'syncing' : 'paused'}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {isOwner && (
        <div className="border-t border-slate-800 p-4">
          {!connecting ? (
            <button
              onClick={() => setConnecting(true)}
              className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800"
            >
              Connect an account
            </button>
          ) : (
            <form onSubmit={connect} className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-3">
                <label className="block text-sm">
                  <span className="text-slate-400">Platform</span>
                  <select
                    id="acc-platform"
                    value={form.platform}
                    onChange={(e) => setForm({ ...form, platform: e.target.value, credentials: {} })}
                    className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                  >
                    {(data?.platforms ?? []).map((name) => (
                      <option key={name} value={name}>{PLATFORM_LABEL[name] ?? name}</option>
                    ))}
                  </select>
                </label>
                <label className="block text-sm sm:col-span-2">
                  <span className="text-slate-400">What you call it</span>
                  <input
                    id="acc-label"
                    required
                    value={form.label}
                    onChange={(e) => setForm({ ...form, label: e.target.value })}
                    placeholder="Elecfix main shop"
                    className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-sky-500"
                  />
                </label>
              </div>

              <label className="block text-sm">
                <span className="text-slate-400">Region</span>
                <select
                  id="acc-region"
                  value={form.region}
                  onChange={(e) => setForm({ ...form, region: e.target.value })}
                  className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 sm:w-32"
                >
                  {REGIONS.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </label>

              <div className="grid gap-3 sm:grid-cols-2">
                {required.map((field) => (
                  <label key={field} className="block text-sm">
                    <span className="text-slate-400">{FIELD_LABEL[field] ?? field}</span>
                    <input
                      id={`acc-${field}`}
                      required
                      type={field.includes('key') || field.includes('secret') || field.includes('token') || field.includes('cipher') ? 'password' : 'text'}
                      value={form.credentials[field] ?? ''}
                      onChange={(e) => setForm({
                        ...form,
                        credentials: { ...form.credentials, [field]: e.target.value },
                      })}
                      className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-slate-100 outline-none focus:border-sky-500"
                    />
                  </label>
                ))}
              </div>

              <p className="text-xs text-slate-500">
                These are encrypted before they are stored and are never sent back to a
                browser — only the automation reads them.
              </p>

              <div className="flex gap-2">
                <button
                  disabled={busy}
                  className="rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
                >
                  {busy ? 'Connecting…' : 'Connect'}
                </button>
                <button
                  type="button"
                  onClick={() => setConnecting(false)}
                  className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
