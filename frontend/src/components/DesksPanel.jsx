// Which desks this floor has, and which it could have back.
//
// Ten is the layout, not the law. A business that sells nothing on a
// marketplace has no use for a Payments desk; one that subcontracts every job
// has no use for Production. Taking a desk away is done from that agent's own
// panel — you are looking at the person you are removing — and this is where
// you put one back.
//
// Removing is never a delete: approvals, action logs and conversations all
// name an agent, so the row stays and only the floor stops showing it. Which
// is why putting it back brings its skills and its history with it.
import { useCallback, useEffect, useState } from 'react';
import { api, Unauthorized } from './../api.js';

export default function DesksPanel({ businessId, isOwner, refreshKey, onSignedOut, onChanged }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      setData(await api.departments(businessId));
      setError(null);
    } catch (err) {
      if (err instanceof Unauthorized) return onSignedOut();
      setError(err.message);
    }
  }, [businessId, onSignedOut]);

  useEffect(() => { load(); }, [load, refreshKey]);

  const add = async (department) => {
    setBusy(department);
    setError(null);
    try {
      await api.addDesk(businessId, department);
      await load();
      onChanged?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  const off = data?.off_floor ?? [];
  const on = data?.on_floor ?? [];

  // Nothing to say to a reviewer when the floor is complete.
  if (!isOwner && off.length === 0) return null;

  return (
    <div className="min-w-0 rounded-xl border border-slate-800 bg-slate-900">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 px-4 py-3">
        <h2 className="text-sm font-medium text-slate-200">Desks</h2>
        <span className="text-[11px] text-slate-500">
          {on.length} on the floor{off.length ? `, ${off.length} off` : ''}
        </span>
      </div>

      {error && <p className="px-4 pt-3 text-sm text-red-300">{error}</p>}

      {off.length === 0 ? (
        <p className="p-4 text-sm text-slate-500">
          Every desk is on the floor. To take one off, open that agent and use the
          line at the bottom of its panel.
        </p>
      ) : (
        <div className="p-4">
          <p className="text-xs text-slate-400">
            Off the floor. Putting one back brings its skills and everything it did
            before with it.
          </p>
          <ul className="mt-3 space-y-1.5">
            {off.map((desk) => (
              <li
                key={desk.department}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-950 px-3 py-2"
              >
                <span className="min-w-0">
                  <span className="block text-sm text-slate-200">{desk.department}</span>
                  <span className="block text-[11px] text-slate-500">
                    {desk.role_title}
                    {desk.name ? ` · was ${desk.name}` : ' · never opened here'}
                  </span>
                </span>
                {isOwner ? (
                  <button
                    disabled={busy !== null}
                    onClick={() => add(desk.department)}
                    className="shrink-0 rounded-lg border border-emerald-800 px-3 py-1.5 text-xs text-emerald-300 hover:bg-emerald-950/60 disabled:opacity-50"
                  >
                    {busy === desk.department ? 'Adding…' : 'Add the desk'}
                  </button>
                ) : (
                  <span className="shrink-0 text-[11px] text-slate-500">
                    an owner can add it
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
