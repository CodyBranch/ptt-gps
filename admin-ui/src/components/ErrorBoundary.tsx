import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Keeps a render crash from blanking the console.
 *
 * The usual cause is version skew: the server has been updated and restarted
 * but the built console has not, so the page reads a field the API no longer
 * sends. That produced a white screen and a stack trace in devtools — useless
 * at a start line. This says what probably happened and how to get out of it,
 * and leaves the rest of the app navigable.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode; where: string },
  { error?: Error }
> {
  state: { error?: Error } = {};

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[console] ${this.props.where} failed to render`, error, info.componentStack);
  }

  /** A new page gets a clean slate; the old error is not about it. */
  componentDidUpdate(prev: { children: ReactNode; where: string }) {
    if (this.state.error && prev.where !== this.props.where) this.setState({ error: undefined });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="crash">
        <h3>This page hit an error</h3>
        <p>
          If the server was just updated, the console is probably running an older build than the API.
          Rebuild it with <span className="mono">npm run build -w admin-ui</span> and hard-refresh
          (Ctrl+Shift+R).
        </p>
        <p className="crash-detail mono">{this.state.error.message}</p>
        <div className="home-actions">
          <button className="mini primary" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
        <p className="hint">
          Tracking is unaffected — the server keeps ingesting, computing and publishing whatever the
          console is doing.
        </p>
      </div>
    );
  }
}
