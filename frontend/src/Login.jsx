// Sign-in. Accounts are created by an operator with
// `npm run create-user` in backend/, so there is no sign-up link here.
import { useState } from 'react';
import { api } from './api.js';

export default function Login({ onSignedIn }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.login(email.trim(), password);
      onSignedIn(result.user);
    } catch (err) {
      setError(err.message ?? 'Could not sign in');
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center bg-slate-950 p-4">
      <div className="w-full max-w-sm">
        <h1 className="text-center text-2xl font-semibold text-slate-100">
          Virtual <span className="text-amber-400">Office</span>
        </h1>
        <p className="mt-1 text-center text-sm text-slate-500">
          Sign in to review your agents&apos; work.
        </p>

        <form
          onSubmit={submit}
          className="mt-6 space-y-4 rounded-2xl border border-slate-800 bg-slate-900 p-6"
        >
          <label className="block">
            <span className="text-sm text-slate-300">Email</span>
            <input
              id="email"
              type="email"
              required
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-amber-500"
            />
          </label>

          <label className="block">
            <span className="text-sm text-slate-300">Password</span>
            <input
              id="password"
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-amber-500"
            />
          </label>

          {error && (
            <p className="rounded-lg border border-red-900 bg-red-950/50 p-3 text-sm text-red-200">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-lg bg-amber-500 px-4 py-2.5 font-medium text-slate-950 hover:bg-amber-400 disabled:opacity-50"
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="mt-4 text-center text-xs text-slate-600">
          Ask whoever runs this office for an account.
        </p>
      </div>
    </div>
  );
}
