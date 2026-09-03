import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { DeployInfo } from '../types';
import { ConfirmDialog } from './Confirm';

/**
 * Deploying from the console.
 *
 * The awkward part is that a deploy restarts the server this page is talking
 * to, so partway through, every request fails. That is expected rather than an
 * error: the panel keeps polling through the outage and picks the story back
 * up from the status file once the new build answers.
 */

const STAGES: Array<{ key: string; label: string }> = [
  { key: 'pulling', label: 'Pull' },
  { key: 'installing', label: 'Dependencies' },
  { key: 'building', label: 'Build' },
  { key: 'testing', label: 'Tests' },
  { key: 'restarting', label: 'Restart' },
];

const stageIndex = (stage: string) => STAGES.findIndex((s) => s.key === stage);

export function DeployPanel() {
  const [info, setInfo] = useState<DeployInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  /** True once the server has stopped answering during a deploy we started. */
  const [waiting, setWaiting] = useState(false);
  const startedHere = useRef(false);

  const load = useCallback(async () => {
    try {
      const next = await api.deployInfo();
      setInfo(next);
      setWaiting(false);
      setError(null);
    } catch {
      // While a deploy is running the server is expected to go away. Only
      // report a fetch failure as an error when nothing is in flight.
      if (startedHere.current) setWaiting(true);
      else setError('Could not reach the server.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll quickly while something is happening, slowly when idle.
  const running = info?.running || waiting;
  useEffect(() => {
    const id = setInterval(() => void load(), running ? 2000 : 60_000);
    return () => clearInterval(id);
  }, [running, load]);

  useEffect(() => {
    if (info?.status?.done) startedHere.current = false;
  }, [info?.status?.done]);

  const check = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.deployCheck();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const start = async (force: boolean) => {
    setConfirming(false);
    setBusy(true);
    setError(null);
    try {
      await api.deployStart(force);
      startedHere.current = true;
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!info && !error) return null;

  const update = info?.update;
  const status = info?.status;
  const pending = update?.commits ?? [];
  const blocked = update?.blockedBy ?? [];
  const current = stageIndex(status?.stage ?? '');

  return (
    <section className="deploy-panel">
      <header className="deploy-head">
        <div>
          <h2>Server updates</h2>
          <p className="deploy-sub">
            Running <span className="mono">v{info?.version ?? '?'}</span>
            {update?.current && (
              <>
                {' at '}
                <span className="mono">{update.current}</span>
              </>
            )}
          </p>
        </div>
        <button className="mini" onClick={check} disabled={busy || running}>
          {busy ? 'Checking...' : 'Check now'}
        </button>
      </header>

      {error && <p className="deploy-error">{error}</p>}
      {update?.error && <p className="deploy-error">{update.error}</p>}

      {/* A deploy in flight takes over the panel: it is the only thing that
          matters until it lands, and it outlives this page's connection. */}
      {(running || (status && !status.done)) && (
        <div className="deploy-progress">
          <ol className="deploy-stages">
            {STAGES.map((s, i) => (
              <li
                key={s.key}
                className={`deploy-stage ${
                  current > i ? 'past' : current === i ? 'now' : 'future'
                }`}
              >
                {s.label}
              </li>
            ))}
          </ol>
          <p className="deploy-now">
            {waiting ? 'Server restarting - waiting for it to come back...' : (status?.message ?? 'Starting...')}
          </p>
        </div>
      )}

      {status?.done && (
        <div className={`deploy-result ${status.ok ? 'ok' : 'bad'}`}>
          <strong>{status.ok ? 'Deployed' : 'Failed'}</strong>
          <span>{status.message}</span>
          {!status.ok && status.log.length > 1 && (
            <details>
              <summary>Details</summary>
              <pre>{status.log.join('\n')}</pre>
            </details>
          )}
        </div>
      )}

      {!running && (
        <>
          {blocked.length > 0 && (
            <div className="deploy-blocked">
              <strong>Local code changes on this machine block a deploy:</strong>
              <ul>
                {blocked.map((b) => (
                  <li key={b} className="mono">
                    {b}
                  </li>
                ))}
              </ul>
              <p>Commit, stash or discard them on the server, then check again.</p>
            </div>
          )}

          {pending.length === 0 && !update?.error && blocked.length === 0 && (
            <p className="deploy-none">Up to date.</p>
          )}

          {pending.length > 0 && (
            <>
              <p className="deploy-count">
                {pending.length} commit{pending.length === 1 ? '' : 's'} waiting on{' '}
                <span className="mono">{update?.branch}</span>:
              </p>
              <ul className="deploy-commits">
                {pending.map((c) => (
                  <li key={c.sha}>
                    <span className="mono sha">{c.sha}</span>
                    <span>{c.subject}</span>
                  </li>
                ))}
              </ul>

              {!info?.safeToRestart && (
                <p className="deploy-warn">
                  A race is armed or live ({info?.races.armed} armed, {info?.races.live} live). Deploying
                  restarts the server.
                </p>
              )}

              <button
                className="mini primary deploy-go"
                onClick={() => setConfirming(true)}
                disabled={busy || blocked.length > 0 || !info?.safeToRestart}
              >
                Deploy {pending.length} commit{pending.length === 1 ? '' : 's'}
              </button>
            </>
          )}
        </>
      )}

      {confirming && (
        <ConfirmDialog
          req={{
            title: `Deploy ${pending.length} commit${pending.length === 1 ? '' : 's'}?`,
            body:
              'The new code is pulled, built and tested while this server keeps running. Only then does it ' +
              'restart, which takes a few seconds and briefly drops tracker connections. If the new build ' +
              'does not come back, it rolls back automatically.',
            confirmLabel: 'Deploy',
            onConfirm: () => void start(false),
          }}
          onClose={() => setConfirming(false)}
        />
      )}
    </section>
  );
}
