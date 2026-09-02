import { useEffect, useState } from 'react';

export interface AuthInfo {
  username: string;
  role: 'admin' | 'staff' | 'viewer';
  /** What the server reports itself as, to catch a half-finished deploy. */
  serverVersion?: string;
}

export function Login({ onSuccess }: { onSuccess: (auth: AuthInfo) => void }) {
  // The /watch link handed to viewers lands directly on PIN entry.
  const [mode, setMode] = useState<'operator' | 'viewer' | 'firstrun'>(
    window.location.pathname === '/watch' ? 'viewer' : 'operator',
  );
  const [viewerAvailable, setViewerAvailable] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch('/api/viewer-enabled')
      .then((r) => r.json())
      .then((j) => setViewerAvailable(!!j.enabled))
      .catch(() => {});
    // Fresh server with zero accounts → create the first admin right here.
    fetch('/api/setup-needed')
      .then((r) => r.json())
      .then((j) => {
        if (j.needed && window.location.pathname !== '/watch') setMode('firstrun');
      })
      .catch(() => {});
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (mode === 'firstrun' && password !== confirmPw) {
      setError('Passwords do not match');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const res =
        mode === 'firstrun'
          ? await fetch('/api/first-admin', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ username, password }),
            })
          : mode === 'operator'
            ? await fetch('/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password }),
              })
            : await fetch('/api/viewer-login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pin }),
              });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(
          j.error ??
            (res.status === 401
              ? mode === 'viewer'
                ? 'Invalid PIN'
                : 'Invalid username or password'
              : `Sign-in failed (${res.status})`),
        );
        return;
      }
      onSuccess({ username: j.username ?? username, role: j.role ?? 'staff' });
    } catch {
      setError('Cannot reach server');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <img className="login-logo" src="/img/PRIMETIME.png" alt="Primetime Timing" />
        {mode === 'firstrun' && (
          <div className="login-firstrun">
            Welcome — this server has no accounts yet.
            <br />
            Create the first <b>admin</b> login to get started.
          </div>
        )}
        {mode !== 'viewer' ? (
          <>
            <label>
              Username
              <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus />
            </label>
            <label>
              Password
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === 'firstrun' ? 'new-password' : 'current-password'}
              />
            </label>
            {mode === 'firstrun' && (
              <label>
                Confirm password
                <input
                  type="password"
                  value={confirmPw}
                  onChange={(e) => setConfirmPw(e.target.value)}
                  autoComplete="new-password"
                />
              </label>
            )}
          </>
        ) : (
          <label>
            Viewer PIN
            <input
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="digits only"
              autoFocus
            />
          </label>
        )}
        {error && <div className="login-error">{error}</div>}
        <button
          className="login-btn"
          disabled={
            busy ||
            (mode === 'viewer'
              ? pin.length < 4
              : !username || !password || (mode === 'firstrun' && password.length < 8))
          }
        >
          {busy ? 'Working…' : mode === 'firstrun' ? 'Create admin & sign in' : mode === 'operator' ? 'Sign in' : 'View races'}
        </button>
        {viewerAvailable && mode === 'operator' && (
          <button type="button" className="login-secondary" onClick={() => setMode('viewer')}>
            <span className="login-secondary-icon">👁</span> Watch with a viewer PIN
          </button>
        )}
        {mode === 'viewer' && (
          <button type="button" className="login-secondary" onClick={() => setMode('operator')}>
            Operator sign-in
          </button>
        )}
      </form>
    </div>
  );
}
