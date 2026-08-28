import type { ConfirmRequest } from './Confirm';
import type { RaceSnap } from '../types';

const ACTIONS: Record<
  string,
  { label: string; action: 'arm' | 'start' | 'finish' | 'reset'; confirm?: { title: string; body: string; danger?: boolean } }[]
> = {
  scheduled: [{ label: 'Arm race', action: 'arm' }],
  armed: [
    {
      label: '▶ Start race',
      action: 'start',
      confirm: {
        title: 'Start race?',
        body: 'Opens a session and begins publishing distances to all configured outputs.',
      },
    },
    { label: 'Stand down', action: 'reset' },
  ],
  live: [
    {
      label: '■ Finish race',
      action: 'finish',
      confirm: {
        title: 'Finish race?',
        body: 'Stops publishing and closes the session.',
        danger: true,
      },
    },
  ],
  finished: [
    {
      label: 'Reset',
      action: 'reset',
      confirm: { title: 'Reset race?', body: 'Returns the race to scheduled. The finished session stays recorded.' },
    },
  ],
};

export function RacePanel({
  race,
  ask,
  onAction,
}: {
  race: RaceSnap;
  ask: (req: ConfirmRequest) => void;
  onAction: (a: 'arm' | 'start' | 'finish' | 'reset') => void;
}) {
  return (
    <div className="race-panel">
      <span className={`race-status ${race.status}`}>{race.status.toUpperCase()}</span>
      {race.sessionId != null && <span className="session-id">session #{race.sessionId}</span>}
      {ACTIONS[race.status].map((a) => (
        <button
          key={a.action}
          className={`lifecycle ${a.action}`}
          onClick={() => {
            if (a.confirm) {
              ask({
                title: a.confirm.title,
                body: a.confirm.body,
                confirmLabel: a.label.replace(/^[▶■] /, ''),
                danger: a.confirm.danger,
                onConfirm: () => onAction(a.action),
              });
            } else {
              onAction(a.action);
            }
          }}
        >
          {a.label}
        </button>
      ))}
    </div>
  );
}
