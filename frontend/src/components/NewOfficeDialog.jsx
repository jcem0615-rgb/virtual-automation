// Opening another office.
//
// An owner of one floor can start another: a different line of business, its
// own desks, its own catalogue, its own buyers. Same features and the same
// rules — what changes is the trade, which decides what the desks are called
// so a salon's floor does not read like an electrical contractor's.
//
// Nothing of the new office is visible from the old one and nothing of the old
// one leaks into it. They are separate tenants that happen to share a person.
import { useEffect, useState } from 'react';
import { api, Unauthorized } from './../api.js';

export default function NewOfficeDialog({ onClose, onOpened }) {
  const [lines, setLines] = useState([]);
  const [name, setName] = useState('');
  const [line, setLine] = useState('retail');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.businessLines()
      .then((result) => setLines(result.lines ?? []))
      .catch((err) => {
        if (err instanceof Unauthorized) return;
        setError(err.message);
      });
  }, []);

  const open = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.openOffice({ name, business_type: line });
      onOpened(result.business);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  const chosen = lines.find((l) => l.key === line);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/80 p-4 sm:items-center"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-xl border border-slate-800 bg-slate-900 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-slate-100">Open another office</h2>
        <p className="mt-1 text-sm text-slate-400">
          A whole new floor: ten desks, their skills, and the payment rules —
          with its own products, shops and buyers kept apart from this one.
        </p>

        {error && <p className="mt-3 text-sm text-red-300">{error}</p>}

        <form onSubmit={open} className="mt-4 space-y-3">
          <label className="block text-sm">
            <span className="text-slate-400">What is it called?</span>
            <input
              id="office-name" required autoFocus value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Elecfix Supply"
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-sky-500"
            />
          </label>

          <div className="block text-sm">
            <span className="text-slate-400">What line of business?</span>
            <div className="mt-1.5 grid gap-1.5 sm:grid-cols-2">
              {lines.map((l) => (
                <button
                  key={l.key}
                  type="button"
                  onClick={() => setLine(l.key)}
                  className={`rounded-lg border px-3 py-2 text-left text-xs ${
                    line === l.key
                      ? 'border-sky-700 bg-sky-950 text-sky-200'
                      : 'border-slate-700 text-slate-400 hover:bg-slate-800'
                  }`}
                >
                  <span className="block text-sm">{l.label}</span>
                  <span className="block text-[11px] text-slate-500">{l.blurb}</span>
                </button>
              ))}
            </div>
          </div>

          {chosen && (
            <p className="text-[11px] text-slate-500">
              The desks are the same ten; on a {chosen.label.toLowerCase()} floor they
              are named for that trade.
            </p>
          )}

          <div className="flex flex-wrap gap-2 pt-1">
            <button
              disabled={busy || !name.trim()}
              className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
            >
              {busy ? 'Opening…' : 'Open it'}
            </button>
            <button
              type="button" onClick={onClose}
              className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
