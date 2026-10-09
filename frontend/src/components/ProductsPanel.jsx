// The business's catalogue, and where each product is listed.
//
// A product is written here once and listed on whichever connected accounts
// its owner picks — so the same item can sit on two Shopee shops and a Lazada
// account, each with its own listing id and its own state. Listing it is
// outbound work, so it waits for approval like everything else.
import { useCallback, useEffect, useState } from 'react';
import { api, Unauthorized } from './../api.js';

const PLATFORM_LABEL = {
  facebook: 'Facebook', instagram: 'Instagram', tiktok: 'TikTok',
  shopee: 'Shopee', lazada: 'Lazada', x: 'X',
};

const STATE_STYLE = {
  LISTED: 'border-emerald-900 bg-emerald-950 text-emerald-300',
  PUBLISH_PENDING: 'border-amber-900 bg-amber-950 text-amber-300',
  UPDATE_PENDING: 'border-amber-900 bg-amber-950 text-amber-300',
  FAILED: 'border-red-900 bg-red-950 text-red-300',
  NOT_LISTED: 'border-slate-700 bg-slate-800 text-slate-400',
};

const STATE_SUFFIX = {
  PUBLISH_PENDING: ' · sending',
  UPDATE_PENDING: ' · updating',
  FAILED: ' · failed',
  NOT_LISTED: ' · not listed',
};

const money = (value, currency) =>
  `${currency} ${Number(value).toLocaleString('en-PH', { minimumFractionDigits: 2 })}`;

const BLANK = {
  sku: '', name: '', description: '', price: '', stock: '0',
  weight_kg: '0.5', images: '', category_shopee: '', category_lazada: '', category_tiktok: '',
};

export default function ProductsPanel({ businessId, isOwner, onSignedOut }) {
  const [data, setData] = useState(null);
  const [filter, setFilter] = useState({ platform: 'all', accountId: null });
  const [form, setForm] = useState(BLANK);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);       // product id
  const [edit, setEdit] = useState({ price: '', stock: '' });
  const [confirming, setConfirming] = useState(null); // product id
  const [choosing, setChoosing] = useState(null);     // product id
  const [chosen, setChosen] = useState([]);           // account ids
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);

  const load = useCallback(async () => {
    try {
      setData(await api.products(businessId, filter));
      setError(null);
    } catch (err) {
      if (err instanceof Unauthorized) return onSignedOut();
      setError(err.message);
    }
  }, [businessId, filter, onSignedOut]);

  useEffect(() => { load(); }, [load]);

  const accounts = data?.accounts ?? [];
  const sellable = accounts.filter((a) => ['shopee', 'lazada', 'tiktok'].includes(a.platform));

  const create = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const platformMeta = {};
      for (const [platform, value] of [
        ['shopee', form.category_shopee], ['lazada', form.category_lazada],
        ['tiktok', form.category_tiktok],
      ]) {
        if (value.trim()) platformMeta[platform] = { category_id: value.trim() };
      }
      await api.createProduct({
        business_id: businessId,
        sku: form.sku,
        name: form.name,
        description: form.description,
        price: Number(form.price),
        stock: Number(form.stock),
        weight_kg: Number(form.weight_kg),
        images: form.images.split(/[\s,]+/).filter(Boolean),
        platform_meta: platformMeta,
      });
      setForm(BLANK);
      setAdding(false);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  // Price and stock. If the product is live on a shop, changing either is
  // something those shops have to be told, so the backend files it for
  // approval and the shop sits at "updating" until a human says yes.
  const save = async (product) => {
    setBusy(true);
    setError(null);
    try {
      const patch = {};
      if (edit.price !== '' && Number(edit.price) !== Number(product.price)) {
        patch.price = Number(edit.price);
      }
      if (edit.stock !== '' && Number(edit.stock) !== Number(product.stock)) {
        patch.stock = Number(edit.stock);
      }
      if (!Object.keys(patch).length) { setEditing(null); return; }
      const result = await api.editProduct(product.id, patch);
      setEditing(null);
      setNote(result.needs_approval
        ? `Saved here. ${product.listings.filter((l) => l.state !== 'NOT_LISTED').length} `
          + 'shop(s) get the new figures once it is approved.'
        : 'Saved. It is not listed anywhere yet, so nothing had to be told.');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (product) => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.deleteProduct(product.id);
      setConfirming(null);
      setNote(result.deleted
        ? `${product.name} is gone.`
        : `It comes down from ${product.listings.filter((l) => l.state !== 'NOT_LISTED').length} `
          + 'shop(s) first. Approve that and it is deleted when they confirm.');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const list = async (product) => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.listProduct(product.id, chosen);
      setChoosing(null);
      setChosen([]);
      setNote(`Queued for ${result.accounts.map((a) => a.label).join(', ')}. It goes live once approved.`);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const products = data?.products ?? [];

  return (
    <div className="min-w-0 rounded-xl border border-slate-800 bg-slate-900">
      <div className="flex min-w-0 flex-col gap-2 border-b border-slate-800 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-sm font-medium text-slate-200">Products</h2>
        {/* Filter by platform, or down to one account when a business has
            more than one shop on the same platform. */}
        <div className="flex min-w-0 flex-wrap gap-1">
          <button
            onClick={() => setFilter({ platform: 'all', accountId: null })}
            className={`rounded-full border px-2.5 py-1 text-[11px] ${
              filter.platform === 'all' && !filter.accountId
                ? 'border-sky-700 bg-sky-950 text-sky-300'
                : 'border-slate-700 text-slate-400 hover:bg-slate-800'
            }`}
          >
            All
          </button>
          {(data?.platforms ?? []).map((name) => (
            <button
              key={name}
              onClick={() => setFilter({ platform: name, accountId: null })}
              className={`rounded-full border px-2.5 py-1 text-[11px] ${
                filter.platform === name && !filter.accountId
                  ? 'border-sky-700 bg-sky-950 text-sky-300'
                  : 'border-slate-700 text-slate-400 hover:bg-slate-800'
              }`}
            >
              {PLATFORM_LABEL[name] ?? name}
            </button>
          ))}
          {accounts.map((account) => (
            <button
              key={account.id}
              onClick={() => setFilter({ platform: 'all', accountId: account.id })}
              className={`rounded-full border px-2.5 py-1 text-[11px] ${
                filter.accountId === account.id
                  ? 'border-emerald-800 bg-emerald-950 text-emerald-300'
                  : 'border-slate-700 text-slate-500 hover:bg-slate-800'
              }`}
            >
              {account.label}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="px-4 pt-3 text-sm text-red-300">{error}</p>}
      {note && <p className="px-4 pt-3 text-sm text-emerald-300">{note}</p>}

      {products.length === 0 ? (
        <p className="p-4 text-sm text-slate-500">
          No products here yet. Add one below, then choose which shops it goes on.
        </p>
      ) : (
        <ul className="divide-y divide-slate-800">
          {products.map((product) => (
            <li key={product.id} className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate text-sm text-slate-100">{product.name}</h3>
                  <p className="font-mono text-[11px] text-slate-500">
                    {product.sku} · {money(product.price, product.currency)} ·{' '}
                    {product.stock} in stock
                  </p>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {product.listings.length === 0 && (
                      <span className="rounded-full border border-slate-700 bg-slate-800 px-2 py-0.5 font-mono text-[10px] text-slate-400">
                        not listed anywhere
                      </span>
                    )}
                    {product.listings.map((listing) => (
                      <span
                        key={listing.account_id}
                        title={listing.last_error ?? listing.state}
                        className={`rounded-full border px-2 py-0.5 font-mono text-[10px] ${STATE_STYLE[listing.state]}`}
                      >
                        {listing.label}{STATE_SUFFIX[listing.state] ?? ''}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap gap-1.5">
                  {/* The catalogue is the owner's to write: what it sells and
                      what it sells it for. A reviewer sees all of it. */}
                  {isOwner && editing !== product.id && (
                    <button
                      onClick={() => {
                        setEditing(product.id);
                        setConfirming(null);
                        setEdit({ price: String(product.price), stock: String(product.stock) });
                        setNote(null);
                      }}
                      className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800"
                    >
                      Price &amp; stock
                    </button>
                  )}
                  {choosing !== product.id && sellable.length > 0 && (
                    <button
                      onClick={() => {
                        setChoosing(product.id);
                        setChosen(product.listings
                          .filter((l) => l.state === 'LISTED')
                          .map((l) => l.account_id));
                        setNote(null);
                      }}
                      className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800"
                    >
                      Choose shops
                    </button>
                  )}
                  {isOwner && confirming !== product.id && (
                    <button
                      onClick={() => { setConfirming(product.id); setEditing(null); setNote(null); }}
                      className="rounded-lg border border-red-900 px-3 py-1.5 text-xs text-red-300 hover:bg-red-950/60"
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>

              {editing === product.id && (
                <div className="mt-3 space-y-3 rounded-lg border border-slate-800 bg-slate-950 p-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="block text-sm">
                      <span className="text-slate-400">Price ({product.currency})</span>
                      <input
                        id={`pr-price-${product.id}`}
                        type="number" min="0" step="0.01" value={edit.price}
                        onChange={(e) => setEdit({ ...edit, price: e.target.value })}
                        className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 outline-none focus:border-sky-500" />
                    </label>
                    <label className="block text-sm">
                      <span className="text-slate-400">Stock</span>
                      <input
                        id={`pr-stock-${product.id}`}
                        type="number" min="0" value={edit.stock}
                        onChange={(e) => setEdit({ ...edit, stock: e.target.value })}
                        className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 outline-none focus:border-sky-500" />
                    </label>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      disabled={busy}
                      onClick={() => save(product)}
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
                    <span className="self-center text-xs text-slate-500">
                      {product.listings.some((l) => l.state !== 'NOT_LISTED')
                        ? 'It is live somewhere, so the new figures wait for approval before the shops are told.'
                        : 'It is not listed anywhere yet, so this saves straight away.'}
                    </span>
                  </div>
                </div>
              )}

              {confirming === product.id && (
                <div className="mt-3 space-y-3 rounded-lg border border-red-900/60 bg-red-950/30 p-3">
                  <p className="text-xs text-red-200">
                    Delete {product.name}?{' '}
                    {product.listings.some((l) => l.state !== 'NOT_LISTED')
                      ? 'It is live on a shop, so it comes down there first — that waits for approval, '
                        + 'and the product is deleted here once every shop has confirmed.'
                      : 'It is not listed anywhere, so it goes now.'}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      disabled={busy}
                      onClick={() => remove(product)}
                      className="rounded-lg bg-red-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-600 disabled:opacity-50"
                    >
                      {busy ? 'Working…' : 'Yes, delete it'}
                    </button>
                    <button
                      onClick={() => setConfirming(null)}
                      className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800"
                    >
                      Keep it
                    </button>
                  </div>
                </div>
              )}

              {choosing === product.id && (
                <div className="mt-3 space-y-3 rounded-lg border border-slate-800 bg-slate-950 p-3">
                  <p className="text-xs text-slate-400">
                    Which of your shops should carry this?
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {sellable.map((account) => (
                      <button
                        key={account.id}
                        type="button"
                        disabled={!account.sync_enabled}
                        onClick={() => setChosen((current) => (current.includes(account.id)
                          ? current.filter((id) => id !== account.id)
                          : [...current, account.id]))}
                        className={`rounded-full border px-2.5 py-1 text-[11px] disabled:opacity-40 ${
                          chosen.includes(account.id)
                            ? 'border-emerald-800 bg-emerald-950 text-emerald-300'
                            : 'border-slate-700 text-slate-400 hover:bg-slate-800'
                        }`}
                      >
                        {account.label}
                        <span className="ml-1 text-slate-500">
                          {PLATFORM_LABEL[account.platform]}
                        </span>
                      </button>
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      disabled={busy || chosen.length === 0}
                      onClick={() => list(product)}
                      className="rounded-lg bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
                    >
                      {busy ? 'Queueing…' : 'List it'}
                    </button>
                    <button
                      onClick={() => { setChoosing(null); setChosen([]); }}
                      className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800"
                    >
                      Cancel
                    </button>
                    <span className="self-center text-xs text-slate-500">
                      Nothing reaches a marketplace until it is approved.
                    </span>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="border-t border-slate-800 p-4">
        {!isOwner ? (
          <p className="text-xs text-slate-500">
            The catalogue is the owner&rsquo;s to write. You can see every product and
            every shop it is on, and you approve what goes out.
          </p>
        ) : !adding ? (
          <button
            onClick={() => setAdding(true)}
            className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800"
          >
            Add a product
          </button>
        ) : (
          <form onSubmit={create} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-sm">
                <span className="text-slate-400">Name</span>
                <input id="pr-name" required value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="30W LED floodlight"
                  className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-sky-500" />
              </label>
              <label className="block text-sm">
                <span className="text-slate-400">SKU</span>
                <input id="pr-sku" required value={form.sku}
                  onChange={(e) => setForm({ ...form, sku: e.target.value })}
                  placeholder="LED-FL-30W"
                  className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-sm text-slate-100 outline-none focus:border-sky-500" />
              </label>
            </div>
            <label className="block text-sm">
              <span className="text-slate-400">Description</span>
              <textarea id="pr-desc" rows={2} value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-sky-500" />
            </label>
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="block text-sm">
                <span className="text-slate-400">Price (PHP)</span>
                <input id="pr-price" required type="number" min="0" step="0.01" value={form.price}
                  onChange={(e) => setForm({ ...form, price: e.target.value })}
                  className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-sky-500" />
              </label>
              <label className="block text-sm">
                <span className="text-slate-400">Stock</span>
                <input id="pr-stock" type="number" min="0" value={form.stock}
                  onChange={(e) => setForm({ ...form, stock: e.target.value })}
                  className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-sky-500" />
              </label>
              <label className="block text-sm">
                <span className="text-slate-400">Weight (kg)</span>
                <input id="pr-weight" type="number" min="0.001" step="0.001" value={form.weight_kg}
                  onChange={(e) => setForm({ ...form, weight_kg: e.target.value })}
                  className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-sky-500" />
              </label>
            </div>
            <label className="block text-sm">
              <span className="text-slate-400">Image urls</span>
              <input id="pr-images" value={form.images}
                onChange={(e) => setForm({ ...form, images: e.target.value })}
                placeholder="https://… https://…"
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100 outline-none focus:border-sky-500" />
            </label>
            {/* Every marketplace insists on its own category id before it will
                take a listing, so they are asked for here rather than failing
                halfway out. */}
            <div className="grid gap-3 sm:grid-cols-3">
              {[['shopee', 'Shopee'], ['lazada', 'Lazada'], ['tiktok', 'TikTok Shop']].map(([key, label]) => (
                <label key={key} className="block text-sm">
                  <span className="text-slate-400">{label} category id</span>
                  <input
                    id={`pr-cat-${key}`}
                    value={form[`category_${key}`]}
                    onChange={(e) => setForm({ ...form, [`category_${key}`]: e.target.value })}
                    className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-slate-100 outline-none focus:border-sky-500" />
                </label>
              ))}
            </div>
            <div className="flex gap-2">
              <button disabled={busy}
                className="rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50">
                {busy ? 'Saving…' : 'Add it'}
              </button>
              <button type="button" onClick={() => setAdding(false)}
                className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800">
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
