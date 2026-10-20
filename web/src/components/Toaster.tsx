import { useEffect, useState } from 'react';
import { t } from '../i18n';
import type { ToastAction, ToastKind, ToastPayload } from '../toast';

interface Toast {
  id: number;
  message: string;
  kind: ToastKind;
  sticky: boolean;
  action?: ToastAction;
}

let nextId = 1;

const ICONS: Record<ToastKind, string> = {
  success: '\u2713',
  info: '\u24D8',
  warning: '\u26A0',
  error: '\u26A0',
};

const TIMEOUTS: Record<ToastKind, number> = {
  success: 4000,
  info: 4000,
  warning: 5000,
  error: 6000,
};

export default function Toaster() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    const onToast = (e: Event) => {
      const detail = (e as CustomEvent<ToastPayload | string>).detail;
      const payload: ToastPayload =
        typeof detail === 'string' ? { message: detail, kind: 'error' } : detail;
      const id = nextId++;
      const sticky = payload.sticky ?? false;
      // A sticky notice is state, not an event: the version check fires from
      // both the version endpoint and the event stream, and two Reload buttons
      // for one stale tab would only raise the question of which one to press.
      setToasts((prev) => {
        if (sticky && prev.some((x) => x.sticky && x.message === payload.message)) return prev;
        return [
          ...prev,
          { id, message: payload.message, kind: payload.kind ?? 'error', sticky, action: payload.action },
        ];
      });
      if (!sticky) {
        window.setTimeout(
          () => setToasts((t) => t.filter((x) => x.id !== id)),
          TIMEOUTS[payload.kind ?? 'error'] ?? 4000,
        );
      }
    };
    window.addEventListener('salt:toast', onToast);
    return () => window.removeEventListener('salt:toast', onToast);
  }, []);

  const dismiss = (id: number) => setToasts((t) => t.filter((x) => x.id !== id));

  // Only errors interrupt the screen reader; the rest are polite statuses.
  if (toasts.length === 0) return null;
  return (
    <div className="toaster" role="region" aria-label={t('Notifications')} aria-live="polite" aria-atomic="false">
      {toasts.map((item) => (
        <div
          key={item.id}
          className={`toast toast--${item.kind}`}
          role={item.kind === 'error' ? 'alert' : 'status'}
        >
          <span className="toast-icon" aria-hidden="true">{ICONS[item.kind]}</span>{' '}
          {item.message}
          {item.action && (
            <button
              type="button"
              className="toast-action"
              onClick={() => {
                item.action?.run();
                dismiss(item.id);
              }}
            >
              {item.action.label}
            </button>
          )}
          {item.sticky && (
            <button
              type="button"
              className="toast-dismiss"
              aria-label={t('Dismiss')}
              title={t('Dismiss')}
              onClick={() => dismiss(item.id)}
            >
              ×
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
