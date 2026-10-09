// The human gate. Opened by clicking an avatar on the floor or a row in the
// pending list. Approve / Reject / Emergency Pause all go through the REST
// routes — this component never touches the socket.
import { useEffect, useState } from 'react';

const CHANNEL_LABEL = {
  email: 'Email',
  meta_dm: 'Meta DM',
  shopee: 'Shopee',
};

export default function ApprovalModal({
  agent, approval, canPause = true, onClose, onApprove, onReject, onKill,
}) {
  const [feedback, setFeedback] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setFeedback('');
    setRejecting(false);
    setError(null);
  }, [approval?.id, agent?.id]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!agent) return null;

  const payload = approval?.payload_json ?? {};
  const paused = agent.status === 'PAUSED';

  const run = async (label, fn) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
      onClose();
    } catch (err) {
      setError(err.message ?? 'Something went wrong');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-4 border-b border-slate-800 p-5">
          <div>
            <p className="font-mono text-xs uppercase tracking-wide text-slate-500">
              {agent.department}
            </p>
            <h2 className="text-xl font-semibold text-slate-100">{agent.name}</h2>
            <p className="text-sm text-slate-400">{agent.role_title}</p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg px-2 py-1 text-slate-500 hover:bg-slate-800 hover:text-slate-200"
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        <div className="space-y-4 p-5">
          {paused && (
            <p className="rounded-lg border border-red-900 bg-red-950/50 p-3 text-sm text-red-200">
              This agent is paused. No work, retry or approval side effect will move it
              until it is resumed.
            </p>
          )}

          {approval ? (
            <>
              <div className="flex flex-wrap gap-2 text-xs">
                {payload.type && (
                  <span className="rounded-full bg-slate-800 px-3 py-1 font-mono text-slate-300">
                    {payload.type}
                  </span>
                )}
                {payload.channel && (
                  <span className="rounded-full bg-sky-950 px-3 py-1 text-sky-300">
                    {CHANNEL_LABEL[payload.channel] ?? payload.channel}
                  </span>
                )}
                {payload.recipient && (
                  <span className="rounded-full bg-slate-800 px-3 py-1 text-slate-300">
                    → {payload.recipient}
                  </span>
                )}
              </div>

              <div>
                <h3 className="text-sm font-medium text-slate-300">
                  {payload.title ?? 'Draft awaiting approval'}
                </h3>
                <pre className="mt-2 whitespace-pre-wrap rounded-lg border border-slate-800 bg-slate-950 p-4 font-sans text-sm leading-relaxed text-slate-200">
{payload.draft ?? '(no draft in payload)'}
                </pre>
              </div>

              {rejecting && (
                <label className="block">
                  <span className="text-sm text-slate-300">
                    What should change? This goes back to the model with the draft.
                  </span>
                  <textarea
                    autoFocus
                    rows={3}
                    value={feedback}
                    onChange={(e) => setFeedback(e.target.value)}
                    placeholder="Too formal — mention the ₱ rate and keep it to three sentences."
                    className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 p-3 text-sm text-slate-100 outline-none focus:border-amber-500"
                  />
                </label>
              )}
            </>
          ) : (
            <p className="text-sm text-slate-400">
              Nothing is waiting on you for this desk. Last activity:{' '}
              <span className="text-slate-200">{agent.last_message ?? '—'}</span>
            </p>
          )}

          {error && (
            <p className="rounded-lg border border-red-900 bg-red-950/50 p-3 text-sm text-red-200">
              {error}
            </p>
          )}
        </div>

        <footer className="flex flex-wrap items-center gap-2 border-t border-slate-800 bg-slate-900/60 p-5">
          {approval && !rejecting && (
            <>
              <button
                disabled={busy !== null}
                onClick={() => run('approve', () => onApprove(approval.id))}
                className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
              >
                {busy === 'approve' ? 'Approving…' : 'Approve & send'}
              </button>
              <button
                disabled={busy !== null}
                onClick={() => setRejecting(true)}
                className="rounded-lg border border-slate-600 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-50"
              >
                Reject with feedback
              </button>
            </>
          )}

          {approval && rejecting && (
            <>
              <button
                disabled={busy !== null || feedback.trim() === ''}
                onClick={() => run('reject', () => onReject(approval.id, feedback.trim()))}
                className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-500 disabled:opacity-50"
              >
                {busy === 'reject' ? 'Sending back…' : 'Send back for revision'}
              </button>
              <button
                disabled={busy !== null}
                onClick={() => setRejecting(false)}
                className="rounded-lg border border-slate-600 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800"
              >
                Cancel
              </button>
            </>
          )}

          <span className="flex-1" />

          {canPause ? (
            <button
              disabled={busy !== null}
              onClick={() => run('kill', () => onKill(agent.id, paused))}
              className={`rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50 ${
                paused
                  ? 'bg-slate-700 text-slate-100 hover:bg-slate-600'
                  : 'bg-red-700 text-white hover:bg-red-600'
              }`}
            >
              {busy === 'kill' ? '…' : paused ? 'Resume agent' : 'Emergency pause'}
            </button>
          ) : (
            // Reviewers decide on drafts; switching a desk off is the owner's call.
            <p className="text-xs text-slate-500">
              {paused ? 'An owner can resume this agent.' : 'An owner can pause this agent.'}
            </p>
          )}
        </footer>
      </div>
    </div>
  );
}
