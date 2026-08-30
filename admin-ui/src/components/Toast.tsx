import { useEffect, useRef } from 'react';

export interface StatusMsg {
  kind: 'ok' | 'err';
  text: string;
}

/**
 * Transient status for a page action ("Saved", "Upload failed").
 *
 * It floats over the bottom-right corner instead of sitting in the page's
 * control bar, where a long message pushed the search and buttons around and
 * wrapped them onto two lines. Confirmations clear themselves; failures stay
 * longer, and can be dismissed, because they are worth reading.
 */
export function Toast({ msg, onDone }: { msg?: StatusMsg; onDone: () => void }) {
  // Callers pass an inline arrow, so onDone is a new function every render;
  // depending on it would restart the timer on each parent render and the
  // toast would never dismiss. Only a genuinely new message restarts the clock.
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => doneRef.current(), msg.kind === 'err' ? 9000 : 4000);
    return () => clearTimeout(t);
  }, [msg]);

  if (!msg) return null;
  return (
    <div className={`toast ${msg.kind}`} role="status" onClick={onDone} title="Dismiss">
      <span className="toast-mark">{msg.kind === 'ok' ? '✓' : '!'}</span>
      <span>{msg.text}</span>
    </div>
  );
}
