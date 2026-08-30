import { useState } from 'react';

/**
 * A number input you can actually type a decimal into.
 *
 * Binding a number straight to a controlled input means every keystroke is
 * round-tripped through Number(), and the states you pass through on the way to
 * "0.5" — "" and "0" and "0." — all parse to 0. With a `|| fallback` guard that
 * snapped the field back to its default on every one of those keystrokes, so a
 * window of 1 could never be typed down to 0.5. The raw text is kept while
 * editing and only committed once it parses to something valid; on blur the
 * field falls back to showing whatever was committed.
 */
export function NumberField({
  value,
  onCommit,
  min = 0,
  className,
}: {
  value: number;
  onCommit: (n: number) => void;
  /** Values at or below this are treated as still-being-typed, not committed. */
  min?: number;
  className?: string;
}) {
  const [draft, setDraft] = useState<string>();

  return (
    <input
      className={className}
      inputMode="decimal"
      value={draft ?? String(value)}
      onChange={(e) => {
        setDraft(e.target.value);
        const n = Number(e.target.value);
        if (e.target.value.trim() !== '' && Number.isFinite(n) && n > min) onCommit(n);
      }}
      onBlur={() => setDraft(undefined)}
    />
  );
}
