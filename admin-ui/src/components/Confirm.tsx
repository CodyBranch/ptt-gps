/** In-app confirmation modal — replaces native window.confirm popups. */

export interface ConfirmRequest {
  title: string;
  body?: string;
  confirmLabel?: string;
  danger?: boolean;
  /** Notification-only: single OK button, no cancel. */
  alertOnly?: boolean;
  onConfirm: () => void;
}

export function ConfirmDialog({ req, onClose }: { req: ConfirmRequest; onClose: () => void }) {
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog dialog-confirm" onClick={(e) => e.stopPropagation()}>
        <h3>{req.title}</h3>
        {req.body && <p className="dialog-sub">{req.body}</p>}
        <div className="dialog-actions">
          <span className="spacer" />
          {!req.alertOnly && (
            <button className="mini" onClick={onClose} autoFocus>
              Cancel
            </button>
          )}
          <button
            className={`mini primary ${req.danger ? 'danger-solid' : ''}`}
            onClick={() => {
              onClose();
              req.onConfirm();
            }}
          >
            {req.confirmLabel ?? (req.alertOnly ? 'OK' : 'Confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
