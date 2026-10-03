import React, { useEffect, useState } from 'react';
import { useAuth } from '../lib/auth.jsx';
import { useRuntime } from '../lib/runtime.jsx';
import api from '../lib/api.js';
import { Field, Notice } from '../components/ui.jsx';
import { roleLabel } from '../lib/format.js';

/**
 * Sign-in.
 *
 * The demo accounts are listed because the installer seeds College A and College
 * B (Section 17's acceptance scenario), and a coordinator opening the application
 * for the first time otherwise has no way in. The list comes from the server's
 * own health endpoint, so once someone resets the machine to empty and creates
 * real accounts, it stops being shown.
 */

export default function Login() {
  const auth = useAuth();
  const { runtime } = useRuntime();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [demo, setDemo] = useState(null);

  useEffect(() => {
    // /health is unauthenticated on purpose -- it is what a client machine probes.
    api.get('/health')
      .then((body) => setDemo(body && body.seed ? body.seed : null))
      .catch(() => setDemo(null));
  }, []);

  const submit = async (event) => {
    event.preventDefault();
    if (!username.trim() || !password) return;
    setBusy(true);
    try {
      await auth.signIn(username.trim(), password);
    } catch {
      // The error is already on auth.error; nothing to add here.
    } finally {
      setBusy(false);
    }
  };

  const useAccount = (account) => {
    setUsername(account.username);
    setPassword((demo && demo.password) || 'demo1234');
    auth.clearError();
  };

  return (
    <div className="login-wrap">
      <div className="login">
        <div className="login-card">
          <div className="login-brand">
            <h1>University Timetable Management</h1>
            <p>Sign in to continue</p>
          </div>

          {auth.error ? <div className="mb"><Notice tone="bad">{auth.error}</Notice></div> : null}
          {runtime && runtime.startupError ? (
            <div className="mb"><Notice tone="warn" title="Start-up warning">{runtime.startupError}</Notice></div>
          ) : null}

          <form onSubmit={submit}>
            <Field label="Username" htmlFor="username" required>
              <input
                id="username"
                type="text"
                value={username}
                autoComplete="username"
                autoFocus
                onChange={(e) => { setUsername(e.target.value); auth.clearError(); }}
              />
            </Field>
            <Field label="Password" htmlFor="password" required>
              <input
                id="password"
                type="password"
                value={password}
                autoComplete="current-password"
                onChange={(e) => { setPassword(e.target.value); auth.clearError(); }}
              />
            </Field>
            <button type="submit" className="btn primary large block" disabled={busy || !username.trim() || !password}>
              {busy ? <span className="spinner" /> : null} Sign in
            </button>
          </form>

          {demo && Array.isArray(demo.accounts) && demo.accounts.length ? (
            <div className="demo-accounts">
              <h3>Demo accounts on this machine</h3>
              {demo.accounts.map((account) => (
                <button key={account.username} type="button" className="demo-row" onClick={() => useAccount(account)}>
                  <span className="demo-user">{account.username}</span>
                  <span className="demo-role">{roleLabel(account.role)}</span>
                </button>
              ))}
              <p className="tiny muted" style={{ marginTop: 8 }}>
                Password for all of them: <code>{demo.password || 'demo1234'}</code>. Clear them from
                Settings → Backup → Reset to empty once your own data is in.
              </p>
            </div>
          ) : null}
        </div>

        <p className="offline-note">
          Everything works with no internet connection. Only the optional AI Assistant contacts the outside world.
        </p>
      </div>
    </div>
  );
}
