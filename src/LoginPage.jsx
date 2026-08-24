import { useState } from "react";
import * as api from "./api.js";
import Wordmark from "./Wordmark.jsx";

/**
 * Sign in — and, on a fresh install, the screen that creates the first admin.
 * There is no self-service registration: accounts come from the admin panel.
 */
export default function LoginPage({ needsSetup, onSignedIn }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;

    setBusy(true);
    setError(null);
    try {
      const { user } = needsSetup
        ? await api.setupAdmin(username, password)
        : await api.login(username, password);
      onSignedIn(user);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    // overflow-y-auto, not just centred: the document itself no longer
    // scrolls (see index.css), so on a short viewport — a phone in
    // landscape, or with the keyboard up — a form taller than the window
    // would have its top cropped with no way to reach it. py-8 keeps it off
    // the edges once it does scroll; the centring still applies whenever it
    // fits.
    <div className="flex h-full items-center justify-center overflow-y-auto bg-[var(--bg)] px-6 py-8">
      <form onSubmit={submit} className="w-full max-w-[380px] animate-fade-up">
        <div className="mb-9 text-center">
          <Wordmark size={34} />
          <p className="mt-2 text-[14px] text-[var(--faint)]">
            {needsSetup ? "Create the first admin account" : "Sign in to continue"}
          </p>
        </div>

        <label className="mb-4 block">
          <span className="mb-1.5 block text-[13px] text-[var(--text-soft)]">Username</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
            autoCapitalize="none"
            autoComplete="username"
            className="w-full rounded-lg border border-[var(--border-strong)] bg-[var(--raised)]
                       px-3.5 py-2.5 text-[15px] text-[var(--text)] max-md:text-[16px]
                       focus:border-[var(--focus)] focus:outline-none"
          />
        </label>

        <label className="mb-5 block">
          <span className="mb-1.5 block text-[13px] text-[var(--text-soft)]">Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={needsSetup ? "new-password" : "current-password"}
            className="w-full rounded-lg border border-[var(--border-strong)] bg-[var(--raised)]
                       px-3.5 py-2.5 text-[15px] text-[var(--text)] max-md:text-[16px]
                       focus:border-[var(--focus)] focus:outline-none"
          />
        </label>

        {needsSetup && (
          <p className="mb-5 text-[13px] text-[var(--faint)]">
            This account can manage model endpoints, sampler settings and other
            accounts. Passwords must be at least 8 characters.
          </p>
        )}

        {error && (
          <div className="mb-5 animate-fade-up rounded-lg border border-[var(--danger-border)] bg-[var(--danger-bg)]
                          px-3.5 py-2.5 text-[13.5px] text-[var(--danger)]">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={busy || !username.trim() || !password}
          className="w-full rounded-lg bg-[var(--text)] py-3 text-[14.5px] font-medium text-[var(--bg)]
                     transition-[opacity,scale] duration-150 active:scale-[0.99]
                     hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50
                     disabled:active:scale-100"
        >
          {busy
            ? needsSetup ? "Creating…" : "Signing in…"
            : needsSetup ? "Create account" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
