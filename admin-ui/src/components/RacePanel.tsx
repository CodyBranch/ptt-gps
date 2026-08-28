import type { RaceSnap } from '../types';

const ACTIONS: Record<string, { label: string; action: 'arm' | 'start' | 'finish' | 'reset'; confirm?: string }[]> = {
  scheduled: [{ label: 'Arm race', action: 'arm' }],
  armed: [
    { label: '▶ Start race', action: 'start', confirm: 'Start race and begin publishing distances?' },
    { label: 'Stand down', action: 'reset' },
  ],
  live: [{ label: '■ Finish race', action: 'finish', confirm: 'Finish race and stop publishing?' }],
  finished: [{ label: 'Reset', action: 'reset', confirm: 'Reset race back to scheduled?' }],
};

export function RacePanel({ race, onAction }: { race: RaceSnap; onAction: (a: 'arm' | 'start' | 'finish' | 'reset') => void }) {
  return (
    <div className="race-panel">
      <span className={`race-status ${race.status}`}>{race.status.toUpperCase()}</span>
      {race.sessionId != null && <span className="session-id">session #{race.sessionId}</span>}
      {ACTIONS[race.status].map((a) => (
        <button
          key={a.action}
          className={`lifecycle ${a.action}`}
          onClick={() => {
            if (!a.confirm || window.confirm(a.confirm)) onAction(a.action);
          }}
        >
          {a.label}
        </button>
      ))}
    </div>
  );
}
