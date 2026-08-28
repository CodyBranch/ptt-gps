import { useEffect, useState } from 'react';

export interface AuthInfo {
  username: string;
  role: 'operator' | 'viewer';
}

export function Login({ onSuccess }: { onSuccess: (auth: AuthInfo) => void }) {
  const [mode, setMode] = useState<'operator' | 'viewer'>('operator');
  const [viewerAvailable, setViewerAvailable] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch('/api/viewer-enabled')
      .then((r) => r.json())
      .then((j) => setViewerAvailable(!!j.enabled))
      .catch(() => {});
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const res =
        mode === 'operator'
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
      if (!res.ok) {
        setError(
          res.status === 401
            ? mode === 'operator'
              ? 'Invalid username or password'
              : 'Invalid PIN'
            : `Sign-in failed (${res.status})`,
        );
        return;
      }
      const j = await res.json();
      onSuccess({ username: j.username ?? username, role: j.role ?? 'operator' });
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
        <div className="login-sub">GPS race control console</div>
        {mode === 'operator' ? (
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
                autoComplete="current-password"
              />
            </label>
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
          disabled={busy || (mode === 'operator' ? !username || !password : pin.length < 4)}
        >
          {busy ? 'Signing in…' : mode === 'operator' ? 'Sign in' : 'View races'}
        </button>
        {viewerAvailable && mode === 'operator' && (
          <button type="button" className="linklike login-alt" onClick={() => setMode('viewer')}>
            Just watching? Enter the viewer PIN
          </button>
        )}
        {mode === 'viewer' && (
          <button type="button" className="linklike login-alt" onClick={() => setMode('operator')}>
            Operator sign-in
          </button>
        )}
      </form>
    </div>
  );
}
