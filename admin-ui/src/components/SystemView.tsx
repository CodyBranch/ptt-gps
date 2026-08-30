import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { ConfirmRequest } from './Confirm';
import type { FirebaseConn, TunnelStatus, UserRow } from '../types';
import { Toast } from './Toast';

type Msg = { kind: 'ok' | 'err'; text: string };

/** System page: server-wide settings — accounts, feeds, outputs, remote access. */
export function SystemView({ ask }: { ask: (req: ConfirmRequest) => void }) {
  const [msg, setMsg] = useState<Msg>();
  const [fbConns, setFbConns] = useState<FirebaseConn[]>([]);

  useEffect(() => {
    api.firebaseList().then(setFbConns).catch(console.error);
  }, []);

  return (
    <div className="setup">
      <div className="setup-bar">
        <span className="setup-title">System</span>
        <span className="spacer" />
      </div>
      <div className="setup-grid">
        <section>
          <h3>Operator logins</h3>
          <UsersPanel onMsg={setMsg} ask={ask} />
          <ViewerPinRow onMsg={setMsg} ask={ask} />
        </section>

        <section>
          <h3>Firebase connections</h3>
          <FirebasePanel conns={fbConns} onChanged={() => api.firebaseList().then(setFbConns)} onMsg={setMsg} ask={ask} />
        </section>

        <section>
          <h3>Split feed (external)</h3>
          <SplitFeedPanel onMsg={setMsg} ask={ask} />
          <h3 className="section-gap">Ping forwarding</h3>
          <ForwardsPanel onMsg={setMsg} ask={ask} />
        </section>

        <section>
          <h3>Remote access (ngrok)</h3>
          <RemoteAccessPanel onMsg={setMsg} ask={ask} />
        </section>
      </div>

      <Toast msg={msg} onDone={() => setMsg(undefined)} />
    </div>
  );
}

function UsersPanel({ onMsg, ask }: { onMsg: (m: Msg) => void; ask: (req: ConfirmRequest) => void }) {
  const [users, setUsers] = useState<UserRow[]>([]);
  useEffect(() => {
    api.users().then(setUsers).catch(console.error);
  }, []);

  return (
    <>
      <table className="setup-table">
        <tbody>
          {users.map((u) => (
            <tr key={u.username}>
              <td>{u.username}</td>
              <td>
                <span className={`role-badge ${u.role}`}>{u.role}</span>
              </td>
              <td className="dim">added {new Date(u.created_at_ms).toLocaleDateString()}</td>
              <td>
                <button
                  className="mini danger"
                  onClick={() =>
                    ask({
                      title: `Remove login "${u.username}"?`,
                      body: 'Their sessions are signed out immediately.',
                      confirmLabel: 'Remove',
                      danger: true,
                      onConfirm: async () => {
                        try {
                          await api.deleteUser(u.username);
                          setUsers(await api.users());
                        } catch (err) {
                          onMsg({ kind: 'err', text: (err as Error).message });
                        }
                      },
                    })
                  }
                >
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <NewUserRow
        onAdd={async (username, password, role) => {
          try {
            await api.addUser(username, password, role);
            setUsers(await api.users());
            onMsg({ kind: 'ok', text: `${role === 'admin' ? 'Admin' : 'Staff'} login "${username}" created.` });
          } catch (err) {
            onMsg({ kind: 'err', text: (err as Error).message });
          }
        }}
      />
      <p className="hint">
        <b>admin</b> — full access including this page · <b>staff</b> — run races (start/finish, failover,
        windows, publishing) but no setup changes · viewers use the PIN below.
      </p>
    </>
  );
}

function NewUserRow({ onAdd }: { onAdd: (username: string, password: string, role: 'admin' | 'staff') => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [role, setRole] = useState<'admin' | 'staff'>('staff');
  const valid = /^[a-zA-Z0-9._-]{2,32}$/.test(username) && password.length >= 8 && password === confirm;
  return (
    <div className="form-row">
      <label>
        Username
        <input value={username} onChange={(e) => setUsername(e.target.value.trim())} autoComplete="off" />
      </label>
      <label>
        Password (min 8)
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
      </label>
      <label>
        Confirm
        <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
      </label>
      <label>
        Level
        <select value={role} onChange={(e) => setRole(e.target.value as 'admin' | 'staff')}>
          <option value="staff">staff</option>
          <option value="admin">admin</option>
        </select>
      </label>
      <button
        className="mini self-end"
        disabled={!valid}
        onClick={() => {
          onAdd(username, password, role);
          setUsername('');
          setPassword('');
          setConfirm('');
          setRole('staff');
        }}
      >
        + Add login
      </button>
    </div>
  );
}

function ViewerPinRow({ onMsg, ask }: { onMsg: (m: Msg) => void; ask: (req: ConfirmRequest) => void }) {
  const [enabled, setEnabled] = useState(false);
  const [pin, setPin] = useState('');

  useEffect(() => {
    api.viewerEnabled().then(setEnabled).catch(() => {});
  }, []);

  const setNewPin = async () => {
    try {
      await api.setViewerPin(pin);
      setEnabled(true);
      setPin('');
      onMsg({ kind: 'ok', text: 'Viewer PIN set — existing viewer sessions were signed out.' });
    } catch (err) {
      onMsg({ kind: 'err', text: (err as Error).message });
    }
  };

  return (
    <>
      <h4>Viewer access</h4>
      <p className="hint">
        A shared PIN lets announcers, spotters, and displays watch with no controls — the server
        refuses every change from a viewer session. Hand out <span className="mono">/watch</span> + the PIN.
        {enabled ? ' Currently ENABLED.' : ' Currently disabled.'}
      </p>
      <div className="form-row">
        <label>
          {enabled ? 'New PIN (replaces current)' : 'PIN (4–12 digits)'}
          <input
            value={pin}
            inputMode="numeric"
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
            placeholder="e.g. 260426"
          />
        </label>
        <button className="mini self-end" disabled={pin.length < 4} onClick={setNewPin}>
          {enabled ? 'Replace PIN' : 'Enable viewer access'}
        </button>
        {enabled && (
          <button
            className="mini danger self-end"
            onClick={() =>
              ask({
                title: 'Disable viewer access?',
                body: 'All viewer sessions are signed out immediately.',
                confirmLabel: 'Disable',
                danger: true,
                onConfirm: async () => {
                  try {
                    await api.setViewerPin(null);
                    setEnabled(false);
                    onMsg({ kind: 'ok', text: 'Viewer access disabled.' });
                  } catch (err) {
                    onMsg({ kind: 'err', text: (err as Error).message });
                  }
                },
              })
            }
          >
            Disable
          </button>
        )}
      </div>
    </>
  );
}

function FirebasePanel({
  conns,
  onChanged,
  onMsg,
  ask,
}: {
  conns: FirebaseConn[];
  onChanged: () => void;
  onMsg: (m: Msg) => void;
  ask: (req: ConfirmRequest) => void;
}) {
  const [tests, setTests] = useState<Record<string, string>>({});
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const credRef = useRef<HTMLInputElement>(null);
  const [browseConn, setBrowseConn] = useState('');
  const [browsePath, setBrowsePath] = useState('');
  const [browseValue, setBrowseValue] = useState('');
  const [browseMethod, setBrowseMethod] = useState<'set' | 'update' | 'delete'>('update');
  const [busy, setBusy] = useState(false);

  const runTest = async (n: string) => {
    setTests((t) => ({ ...t, [n]: 'testing…' }));
    const r = await api.firebaseTest(n);
    setTests((t) => ({ ...t, [n]: r.ok ? `✓ connected (${r.latencyMs} ms)` : `✗ ${r.error}` }));
  };

  const addConn = async (file: File) => {
    try {
      const sa = JSON.parse(await file.text());
      await api.firebaseAdd(name, url, sa);
      onMsg({ kind: 'ok', text: `Connection "${name}" saved — test it below.` });
      setName('');
      setUrl('');
      onChanged();
    } catch (err) {
      onMsg({ kind: 'err', text: (err as Error).message });
    }
  };

  const read = async () => {
    setBusy(true);
    try {
      const value = await api.firebaseRead(browseConn, browsePath);
      setBrowseValue(JSON.stringify(value, null, 2) ?? 'null');
      onMsg({ kind: 'ok', text: `Read ${browsePath}` });
    } catch (err) {
      onMsg({ kind: 'err', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const write = () => {
    let value: unknown = null;
    if (browseMethod !== 'delete') {
      try {
        value = JSON.parse(browseValue);
      } catch {
        return onMsg({ kind: 'err', text: 'Value must be valid JSON (strings need quotes)' });
      }
    }
    ask({
      title: `${browseMethod.toUpperCase()} ${browsePath}?`,
      body: `Writes directly to "${browseConn}" — scoreboards and maps reading this path see it immediately.`,
      confirmLabel: browseMethod.toUpperCase(),
      danger: true,
      onConfirm: async () => {
        setBusy(true);
        try {
          await api.firebaseWrite(browseConn, browsePath, value, browseMethod);
          onMsg({ kind: 'ok', text: `${browseMethod} ${browsePath} done.` });
        } catch (err) {
          onMsg({ kind: 'err', text: (err as Error).message });
        } finally {
          setBusy(false);
        }
      },
    });
  };

  return (
    <>
      <p className="hint">
        Connect any Firebase project by uploading its service-account JSON (Firebase console →
        Project settings → Service accounts). Events pick outputs from these connections.
      </p>
      <table className="setup-table">
        <tbody>
          {conns.map((c) => (
            <tr key={c.name}>
              <td>
                <div className="t-label">{c.name}</div>
                <div className="t-imei">{c.databaseURL}</div>
              </td>
              <td className="fb-test-result">{tests[c.name] ?? ''}</td>
              <td>
                <button className="mini" onClick={() => runTest(c.name)}>
                  Test
                </button>
              </td>
              <td>
                <button
                  className="mini danger"
                  onClick={() =>
                    ask({
                      title: `Remove connection "${c.name}"?`,
                      body: 'Its credential file is deleted from the server.',
                      confirmLabel: 'Remove',
                      danger: true,
                      onConfirm: async () => {
                        try {
                          await api.firebaseDelete(c.name);
                          onChanged();
                        } catch (err) {
                          onMsg({ kind: 'err', text: (err as Error).message });
                        }
                      },
                    })
                  }
                >
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="form-row">
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="ptt-franklin" />
        </label>
        <label>
          Database URL
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://ptt-franklin.firebaseio.com" />
        </label>
        <input
          ref={credRef}
          type="file"
          accept=".json"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) addConn(f);
            e.target.value = '';
          }}
        />
        <button className="mini primary self-end" disabled={!name.trim() || !url.trim()} onClick={() => credRef.current?.click()}>
          ⬆ Upload key & add
        </button>
      </div>

      {conns.length > 0 && (
        <>
          <h4>Data browser</h4>
          <div className="form-row">
            <label>
              Connection
              <select value={browseConn} onChange={(e) => setBrowseConn(e.target.value)}>
                <option value="">choose…</option>
                {conns.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Path
              <input value={browsePath} onChange={(e) => setBrowsePath(e.target.value)} placeholder="9999/Meta/Clock" />
            </label>
            <button className="mini self-end" disabled={busy || !browseConn || !browsePath} onClick={read}>
              ⬇ Read
            </button>
          </div>
          <textarea
            className="fb-json"
            rows={7}
            value={browseValue}
            onChange={(e) => setBrowseValue(e.target.value)}
            placeholder='JSON — e.g. {"showDistance": true}'
            spellCheck={false}
          />
          <div className="form-row">
            <label>
              Write mode
              <select value={browseMethod} onChange={(e) => setBrowseMethod(e.target.value as typeof browseMethod)}>
                <option value="update">update (merge keys)</option>
                <option value="set">set (replace node)</option>
                <option value="delete">delete (remove node)</option>
              </select>
            </label>
            <button className="mini danger self-end" disabled={busy || !browseConn || !browsePath} onClick={write}>
              ⬆ Write
            </button>
          </div>
        </>
      )}
    </>
  );
}

function SplitFeedPanel({ onMsg, ask }: { onMsg: (m: Msg) => void; ask: (req: ConfirmRequest) => void }) {
  const [token, setToken] = useState<string | null>(null);
  const [show, setShow] = useState(false);

  useEffect(() => {
    api.ingestToken().then(setToken).catch(console.error);
  }, []);

  const regenerate = () =>
    ask({
      title: token ? 'Regenerate the split feed token?' : 'Enable the split feed?',
      body: token
        ? 'The current token stops working immediately — the external source must be updated.'
        : 'Generates a token the external split-time system uses to authenticate.',
      confirmLabel: token ? 'Regenerate' : 'Generate token',
      danger: !!token,
      onConfirm: async () => {
        try {
          setToken(await api.regenerateIngestToken());
          setShow(true);
          onMsg({ kind: 'ok', text: 'Split feed token generated.' });
        } catch (err) {
          onMsg({ kind: 'err', text: (err as Error).message });
        }
      },
    });

  return (
    <>
      <p className="hint">
        Split-time simulated distances from an external system (the NYC setup). Socket.io event{' '}
        <span className="mono">raceTimeUpdate</span> with <span className="mono">{'{ tracker, distance, raceTime }'}</span>,
        or <span className="mono">POST /api/splits</span> with <span className="mono">X-Ingest-Token</span>. Key{' '}
        <span className="mono">tracker</span> by role key, IMEI, or map cmd.
      </p>
      <div className="form-row">
        <label>
          Feed token
          <input
            readOnly
            type={show ? 'text' : 'password'}
            value={token ?? ''}
            placeholder="not generated — feed disabled"
            onFocus={(e) => e.target.select()}
          />
        </label>
        {token && (
          <button className="mini self-end" onClick={() => setShow(!show)}>
            {show ? 'Hide' : 'Show'}
          </button>
        )}
        <button className="mini self-end" onClick={regenerate}>
          {token ? 'Regenerate' : 'Generate'}
        </button>
      </div>
    </>
  );
}

interface ForwardRow {
  host: string;
  port: number;
  enabled: boolean;
  connected?: boolean;
  sent?: number;
  dropped?: number;
  error?: string;
}

function ForwardsPanel({ onMsg, ask }: { onMsg: (m: Msg) => void; ask: (req: ConfirmRequest) => void }) {
  const [rows, setRows] = useState<ForwardRow[]>([]);
  const [newHost, setNewHost] = useState('');
  const [newPort, setNewPort] = useState('');

  const refresh = () => api.forwards().then(setRows).catch(console.error);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, []);

  const save = async (targets: ForwardRow[]) => {
    try {
      setRows(await api.setForwards(targets.map((t) => ({ host: t.host, port: t.port, enabled: t.enabled }))));
      onMsg({ kind: 'ok', text: 'Forward targets updated.' });
    } catch (err) {
      onMsg({ kind: 'err', text: (err as Error).message });
    }
  };

  return (
    <>
      <p className="hint">
        Mirrors every raw tracker frame — live and simulated — to other systems in real time. A down
        target is skipped and counted, never blocks ingest.
      </p>
      <table className="setup-table">
        <thead>
          <tr><th>Target</th><th>Status</th><th>Sent</th><th>Dropped</th><th>On</th><th></th></tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.host}:${r.port}`}>
              <td className="mono">{r.host}:{r.port}</td>
              <td>
                {r.enabled ? (
                  <span className={r.connected ? 'fwd-ok' : 'fwd-bad'}>
                    {r.connected ? '● connected' : `○ ${r.error ?? 'connecting…'}`}
                  </span>
                ) : (
                  <span className="dim">off</span>
                )}
              </td>
              <td className="num">{r.sent ?? 0}</td>
              <td className={`num ${(r.dropped ?? 0) > 0 ? 'warn' : ''}`}>{r.dropped ?? 0}</td>
              <td className="center">
                <input
                  type="checkbox"
                  checked={r.enabled}
                  onChange={(e) => save(rows.map((x, j) => (j === i ? { ...x, enabled: e.target.checked } : x)))}
                />
              </td>
              <td>
                <button
                  className="mini danger"
                  onClick={() =>
                    ask({
                      title: `Remove forward to ${r.host}:${r.port}?`,
                      confirmLabel: 'Remove',
                      danger: true,
                      onConfirm: () => save(rows.filter((_, j) => j !== i)),
                    })
                  }
                >
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="form-row">
        <label>
          Host
          <input value={newHost} onChange={(e) => setNewHost(e.target.value.trim())} placeholder="23.99.178.28" />
        </label>
        <label>
          Port
          <input className="w-num" value={newPort} inputMode="numeric" onChange={(e) => setNewPort(e.target.value)} placeholder="1010" />
        </label>
        <button
          className="mini self-end"
          disabled={!newHost || !(Number(newPort) > 0)}
          onClick={() => {
            save([...rows, { host: newHost, port: Number(newPort), enabled: true }]);
            setNewHost('');
            setNewPort('');
          }}
        >
          + Add forward
        </button>
      </div>
    </>
  );
}

function RemoteAccessPanel({ onMsg, ask }: { onMsg: (m: Msg) => void; ask: (req: ConfirmRequest) => void }) {
  const [status, setStatus] = useState<TunnelStatus>();
  const [domain, setDomain] = useState('');
  const [authtoken, setAuthtoken] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = () =>
    api
      .tunnelStatus()
      .then((s: TunnelStatus) => {
        setStatus(s);
        setDomain((d) => (d === '' ? s.domain : d));
      })
      .catch(console.error);
  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    if (status?.state !== 'connecting') return;
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [status?.state]);

  const apply = async (opts: { enabled?: boolean }) => {
    setBusy(true);
    try {
      const s = await api.tunnelApply({ ...opts, domain, ...(authtoken ? { authtoken } : {}) });
      setStatus(s);
      setAuthtoken('');
      if (s.state === 'online') onMsg({ kind: 'ok', text: `Tunnel online: ${s.url}` });
      else if (s.state === 'error') onMsg({ kind: 'err', text: s.error ?? 'Tunnel failed' });
      else onMsg({ kind: 'ok', text: 'Tunnel settings saved.' });
    } catch (err) {
      onMsg({ kind: 'err', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const stateLabel: Record<string, string> = { off: 'OFF', connecting: 'CONNECTING…', online: 'ONLINE', error: 'ERROR' };

  return (
    <>
      <p className="hint">
        Publishes this console on a public HTTPS URL through ngrok — protected by the same logins and
        viewer PIN. Trackers are unaffected (they use the box's static IP directly).
      </p>
      <div className="tunnel-status">
        <span className={`tunnel-state ${status?.state ?? 'off'}`}>{stateLabel[status?.state ?? 'off']}</span>
        {status?.url && (
          <a className="tunnel-url" href={status.url} target="_blank" rel="noreferrer">
            {status.url}
          </a>
        )}
        {status?.error && <span className="tunnel-err">{status.error}</span>}
      </div>
      <div className="form-row">
        <label>
          Reserved domain (optional)
          <input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="gps.pttiming.ngrok.app" />
        </label>
        <label>
          Authtoken {status?.hasToken ? (status.tokenFromEnv ? '(from env var)' : '(configured)') : ''}
          <input
            type="password"
            value={authtoken}
            onChange={(e) => setAuthtoken(e.target.value)}
            placeholder={status?.hasToken ? 'unchanged' : 'from dashboard.ngrok.com'}
            disabled={status?.tokenFromEnv}
          />
        </label>
        {status?.enabled ? (
          <button
            className="mini danger self-end"
            disabled={busy}
            onClick={() =>
              ask({
                title: 'Take the tunnel offline?',
                body: 'Remote operators and viewers lose access immediately. Local access continues.',
                confirmLabel: 'Go offline',
                danger: true,
                onConfirm: () => apply({ enabled: false }),
              })
            }
          >
            Disable
          </button>
        ) : (
          <button
            className="mini primary self-end"
            disabled={busy || (!status?.hasToken && !authtoken)}
            onClick={() => apply({ enabled: true })}
          >
            {busy ? 'Connecting…' : 'Connect'}
          </button>
        )}
        <button className="mini self-end" disabled={busy} onClick={() => apply({})}>
          Save
        </button>
      </div>
    </>
  );
}
