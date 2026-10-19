// Minimal toast bus. Anywhere in the app can surface a transient message via
// toast('...') or toast.success/info/warning/error('...'); <Toaster/> in App
// renders them. The kind only changes how the toast looks and how urgently
// screen readers announce it. Bare toast() stays an error so old failure
// call sites keep interrupting instead of silently downgrading.
//
// A toast can also carry an action (for example, reloading on a stale
// version): pass { sticky: true, action } so it stays until acted on or
// dismissed instead of fading away with the news still unread.
export type ToastKind = 'info' | 'success' | 'warning' | 'error';

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface ToastOptions {
  sticky?: boolean;
  action?: ToastAction;
}

export interface ToastPayload {
  message: string;
  kind: ToastKind;
  sticky?: boolean;
  action?: ToastAction;
}

function base(message: string, kind: ToastKind = 'error', opts?: ToastOptions) {
  window.dispatchEvent(
    new CustomEvent<ToastPayload>('salt:toast', {
      detail: { message, kind, sticky: opts?.sticky, action: opts?.action },
    }),
  );
}

export const toast = Object.assign(base, {
  success: (message: string, opts?: ToastOptions) => base(message, 'success', opts),
  info: (message: string, opts?: ToastOptions) => base(message, 'info', opts),
  warning: (message: string, opts?: ToastOptions) => base(message, 'warning', opts),
  error: (message: string, opts?: ToastOptions) => base(message, 'error', opts),
});
