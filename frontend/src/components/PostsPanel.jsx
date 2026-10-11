// Posts the business has put out, and where each one lives. Edits made here
// are the source of truth: saving one that is already live files an approval,
// and only approving it updates the copies on the platforms.
import { useCallback, useEffect, useState } from 'react';
import { api, Unauthorized } from './../api.js';

const PLATFORM_LABEL = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  shopee: 'Shopee',
  lazada: 'Lazada',
  x: 'X',
};

const STATE_STYLE = {
  PUBLISHED: 'bg-emerald-950 text-emerald-300 border-emerald-900',
  UPDATE_PENDING: 'bg-amber-950 text-amber-300 border-amber-900',
  PUBLISH_PENDING: 'bg-amber-950 text-amber-300 border-amber-900',
  FAILED: 'bg-red-950 text-red-300 border-red-900',
  NOT_PUBLISHED: 'bg-slate-800 text-slate-400 border-slate-700',
};

const STATE_SUFFIX = {
  UPDATE_PENDING: ' · updating',
  PUBLISH_PENDING: ' · sending',
  FAILED: ' · failed',
  NOT_PUBLISHED: ' · not sent',
};

export default function PostsPanel({ businessId, onSignedOut, refreshKey }) {
  const [platform, setPlatform] = useState('all');
  const [platforms, setPlatforms] = useState([]);
  const [posts, setPosts] = useState([]);
  const [editing, setEditing] = useState(null);   // post id
  const [draft, setDraft] = useState('');
  const [accounts, setAccounts] = useState([]);   // connected, to pick from
  const [targets, setTargets] = useState([]);     // account ids this post goes to
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);

  const load = useCallback(async () => {
    try {
      const [result, connected] = await Promise.all([
        api.posts(businessId, platform),
        api.accounts(businessId),
      ]);
      setPlatforms(result.platforms);
      setPosts(result.posts);
      // A post goes out on a page or a shop, not on a platform in the
      // abstract — the same reason a listing does — so these are what the
      // editor offers.
      setAccounts(connected.accounts ?? []);
      setError(null);
    } catch (err) {
      if (err instanceof Unauthorized) return onSignedOut();
      setError(err.message);
    }
  }, [businessId, platform, onSignedOut]);

  useEffect(() => { load(); }, [load, refreshKey]);

  const startEdit = (post) => {
    setEditing(post.id);
    setDraft(post.body);
    setTargets(post.targets.map((t) => t.account_id));
    setNote(null);
    setError(null);
  };

  const save = async (post) => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.editPost(post.id, { body: draft, account_ids: targets });
      setEditing(null);
      setNote(result.needs_approval
        ? 'Saved. The update is waiting for approval before it reaches the platforms.'
        : 'Saved.');
      await load();
    } catch (err) {
      if (err instanceof Unauthorized) return onSignedOut();
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  // Putting a post out for the first time is outbound work too, so it waits
  // for approval exactly like an edit does.
  const publish = async (post) => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.publishPost(post.id);
      setNote(`Queued for ${(result.accounts ?? []).map((a) => a.label).join(', ')}.`
        + ' It goes out once approved.');
      await load();
    } catch (err) {
      if (err instanceof Unauthorized) return onSignedOut();
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const toggleTarget = (id) => {
    setTargets((current) => (current.includes(id)
      ? current.filter((a) => a !== id)
      : [...current, id]));
  };

  return (
    <div className="min-w-0 rounded-xl border border-slate-800 bg-slate-900">
      {/* Stacks on a phone: a row of seven chips will not share a line with
          the heading at that width. */}
      <div className="flex min-w-0 flex-col gap-2 border-b border-slate-800 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-sm font-medium text-slate-200">Social posts</h2>
        {/* One channel at a time, so the list never mixes platforms up. */}
        <div className="flex min-w-0 flex-wrap gap-1">
          {['all', ...platforms].map((name) => (
            <button
              key={name}
              onClick={() => setPlatform(name)}
              className={`rounded-full border px-2.5 py-1 text-[11px] ${
                platform === name
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
      {note && <p className="px-4 pt-3 text-sm text-emerald-300">{note}</p>}

      {posts.length === 0 ? (
        <p className="p-4 text-sm text-slate-500">
          Nothing here yet. Posts appear once a platform is connected and synced in,
          or when an agent files one.
        </p>
      ) : (
        <ul className="divide-y divide-slate-800">
          {posts.map((post) => (
            <li key={post.id} className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate text-sm text-slate-100">{post.title}</h3>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {post.targets.map((t) => (
                      <span
                        key={t.account_id}
                        title={t.last_error ?? `${PLATFORM_LABEL[t.platform] ?? t.platform}`
                          + ` · ${t.state.toLowerCase().replaceAll('_', ' ')}`}
                        className={`rounded-full border px-2 py-0.5 font-mono text-[10px] ${STATE_STYLE[t.state]}`}
                      >
                        {t.label ?? PLATFORM_LABEL[t.platform] ?? t.platform}
                        {/* The platform too: "Elecfix page" on its own does not
                            say where the copy went. */}
                        {t.label && (
                          <span className="ml-1 opacity-60">
                            {PLATFORM_LABEL[t.platform] ?? t.platform}
                          </span>
                        )}
                        {STATE_SUFFIX[t.state] ?? ''}
                      </span>
                    ))}
                  </div>
                </div>
                {editing !== post.id && (
                  <div className="flex shrink-0 gap-2">
                    {post.targets.some((t) => ['NOT_PUBLISHED', 'FAILED'].includes(t.state)) && (
                      <button
                        disabled={busy}
                        onClick={() => publish(post)}
                        className="rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
                      >
                        Send it out
                      </button>
                    )}
                    <button
                      onClick={() => startEdit(post)}
                      className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800"
                    >
                      Edit
                    </button>
                  </div>
                )}
              </div>

              {editing === post.id ? (
                <div className="mt-3 space-y-3">
                  <textarea
                    id={`post-${post.id}`}
                    rows={4}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 p-3 text-sm text-slate-100 outline-none focus:border-sky-500"
                  />
                  <div>
                    <p className="text-xs text-slate-400">Put it on:</p>
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {accounts.map((account) => (
                        <button
                          key={account.id}
                          type="button"
                          onClick={() => toggleTarget(account.id)}
                          className={`rounded-full border px-2.5 py-1 text-[11px] ${
                            targets.includes(account.id)
                              ? 'border-emerald-800 bg-emerald-950 text-emerald-300'
                              : 'border-slate-700 text-slate-500 hover:bg-slate-800'
                          }`}
                        >
                          {account.label}
                          <span className="ml-1 text-slate-500">
                            {PLATFORM_LABEL[account.platform] ?? account.platform}
                          </span>
                        </button>
                      ))}
                      {accounts.length === 0 && (
                        <span className="text-[11px] text-slate-500">
                          No accounts connected yet — a post needs a page or a shop
                          to go out on.
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      disabled={busy || !draft.trim() || targets.length === 0}
                      onClick={() => save(post)}
                      className="rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
                    >
                      {busy ? 'Saving…' : 'Save changes'}
                    </button>
                    <button
                      onClick={() => setEditing(null)}
                      className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800"
                    >
                      Cancel
                    </button>
                    {post.targets.some((t) => t.state === 'PUBLISHED') && (
                      <span className="self-center text-xs text-slate-500">
                        Already live — saving files it for approval first.
                      </span>
                    )}
                  </div>
                </div>
              ) : (
                <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-sm text-slate-400">
                  {post.body}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
