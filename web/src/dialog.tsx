import { useEffect, useRef, useState } from 'react';
import Portal from './components/Portal';
import { t } from './i18n';
import type { PromptField } from './workflow';
import { SelectCell } from './components/PropertyValue';
import type { PropDef } from './types';

// In-app confirm / prompt dialogs (replacing native window.confirm/prompt,
// which look out of place and can't be styled). Promise-based: call
// `await confirm(msg)` or `await promptText(msg)`; a single <DialogHost/>
// mounted at the app root renders the actual dialog and resolves the promise.

type ConfirmReq = {
  kind: 'confirm';
  message: string;
  confirmText?: string;
  danger?: boolean;
  resolve: (v: boolean) => void;
};
type PromptReq = {
  kind: 'prompt';
  message: string;
  placeholder?: string;
  defaultValue?: string;
  confirmText?: string;
  resolve: (v: string | null) => void;
};
// A status move that needs answers first: one dialog, one input per
// require-step, a single patch on confirm. Cancel leaves the card alone.
type WorkflowReq = {
  kind: 'workflow';
  title: string;
  fields: PromptField[];
  okText?: string;
  resolve: (v: Record<string, unknown> | null) => void;
};
type Req = ConfirmReq | PromptReq | WorkflowReq;

export function confirm(
  message: string,
  opts: { confirmText?: string; danger?: boolean } = {},
): Promise<boolean> {
  return new Promise((resolve) => {
    window.dispatchEvent(
      new CustomEvent('salt:dialog', { detail: { kind: 'confirm', message, ...opts, resolve } }),
    );
  });
}

export function promptText(
  message: string,
  opts: { placeholder?: string; defaultValue?: string; confirmText?: string } = {},
): Promise<string | null> {
  return new Promise((resolve) => {
    window.dispatchEvent(
      new CustomEvent('salt:dialog', { detail: { kind: 'prompt', message, ...opts, resolve } }),
    );
  });
}

/** Ask for the answers a status move needs. Resolves with keyed answers, or
 *  null when the mover backs out — then nothing moves. */
export function promptWorkflow(
  title: string,
  fields: PromptField[],
  opts?: { okText?: string },
): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    window.dispatchEvent(
      new CustomEvent('salt:dialog', { detail: { kind: 'workflow', title, fields, ...opts, resolve } }),
    );
  });
}

export function DialogHost() {
  const [req, setReq] = useState<Req | null>(null);
  const [value, setValue] = useState('');
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onReq = (e: Event) => {
      const detail = (e as CustomEvent<Req>).detail;
      setReq(detail);
      setValue(detail.kind === 'prompt' ? detail.defaultValue ?? '' : '');
      if (detail.kind === 'workflow') {
        const init: Record<string, unknown> = {};
        for (const f of detail.fields) init[f.key] = f.value;
        setAnswers(init);
      }
    };
    window.addEventListener('salt:dialog', onReq);
    return () => window.removeEventListener('salt:dialog', onReq);
  }, []);

  useEffect(() => {
    if (req?.kind === 'prompt') setTimeout(() => inputRef.current?.focus(), 0);
    if (!req) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req]);

  if (!req) return null;

  const cancel = () => {
    if (req.kind === 'confirm') req.resolve(false);
    else if (req.kind === 'workflow') req.resolve(null);
    else req.resolve(null);
    setReq(null);
  };
  const ok = () => {
    if (req.kind === 'confirm') req.resolve(true);
    else if (req.kind === 'workflow') req.resolve(answers);
    else req.resolve(value.trim() ? value.trim() : null);
    setReq(null);
  };
  const workflowReady =
    req?.kind === 'workflow' &&
    req.fields.every((f) => {
      const v = answers[f.key];
      if (f.kind === 'multiselect') return Array.isArray(v) && v.length > 0;
      if (f.kind === 'person') return typeof v === 'string' && v !== '';
      return typeof v === 'string' && v.trim() !== '';
    });

  return (
    <Portal>
      <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) cancel(); }}>
        <div className="dialog confirm-dialog" role="dialog" aria-modal="true">
          {req.kind === 'workflow' ? (
            <>
              <p className="confirm-message">{req.title}</p>
              <div className="workflow-ask">
                {req.fields.map((f) => (
                  <label key={f.key} className="workflow-ask-row">
                    <span>{f.kind === 'comment' ? t('Comment') : f.label}</span>
                    {f.kind === 'text' || f.kind === 'comment' ? (
                      f.kind === 'comment' ? (
                        <textarea
                          className="prop-input"
                          rows={3}
                          value={(answers[f.key] as string) ?? ''}
                          onChange={(e) => setAnswers((p) => ({ ...p, [f.key]: e.target.value }))}
                        />
                      ) : (
                        <input
                          className="prop-input"
                          value={(answers[f.key] as string) ?? ''}
                          onChange={(e) => setAnswers((p) => ({ ...p, [f.key]: e.target.value }))}
                        />
                      )
                    ) : f.kind === 'date' ? (
                      <input
                        type="date"
                        className="prop-input"
                        value={(answers[f.key] as string) ?? ''}
                        onChange={(e) => setAnswers((p) => ({ ...p, [f.key]: e.target.value }))}
                      />
                    ) : f.kind === 'person' ? (
                      <select
                        className="prop-select"
                        value={(answers[f.key] as string) ?? ''}
                        onChange={(e) => setAnswers((p) => ({ ...p, [f.key]: e.target.value }))}
                      >
                        <option value="">{t('Select…')}</option>
                        {(f.members ?? []).map((m) => (
                          <option key={m.userId} value={m.userId}>
                            {m.name}
                          </option>
                        ))}
                      </select>
                    ) : f.kind === 'select' || f.kind === 'multiselect' ? (
                      <SelectCell
                        def={{
                          id: f.prop ?? '',
                          name: f.label,
                          type: f.kind,
                          options: (f.options ?? []) as PropDef['options'],
                        }}
                        value={(answers[f.key] as string | string[]) ?? (f.kind === 'multiselect' ? [] : '')}
                        multi={f.kind === 'multiselect'}
                        onChange={(v) => setAnswers((p) => ({ ...p, [f.key]: v as string | string[] }))}
                      />
                    ) : null}
                  </label>
                ))}
              </div>
            </>
          ) : (
            <p className="confirm-message">{req.message}</p>
          )}
          {req.kind === 'prompt' && (
            <input
              ref={inputRef}
              className="prop-input confirm-input"
              placeholder={req.placeholder}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') ok();
              }}
            />
          )}
          <div className="dialog-buttons">
            <button className="btn" onClick={cancel}>{t('Cancel')}</button>
            <button
              className={'btn ' + (req.kind === 'confirm' && req.danger ? 'danger' : 'primary')}
              onClick={ok}
              disabled={req.kind === 'workflow' && !workflowReady}
            >
              {req.kind === 'workflow' ? (req.okText ?? t('Move card')) : (req.confirmText ?? (req.kind === 'prompt' ? t('OK') : t('Confirm')))}
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
}
