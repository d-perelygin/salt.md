import { useEffect, useRef, useState } from 'react';
import { GripVertical } from 'lucide-react';
import Portal from './components/Portal';
import { t } from './i18n';
import type { PromptField } from './workflow';
import { SelectCell, checklistItems } from './components/PropertyValue';
import WorkflowDateInput from './components/WorkflowDateInput';
import type { ChecklistItem, PropDef } from './types';

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

function cleanAnswers(
  fields: PromptField[],
  answers: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...answers };
  for (const f of fields) {
    if (f.kind !== 'checklist') continue;
    const v = out[f.key];
    if (Array.isArray(v)) {
      out[f.key] = (v as ChecklistItem[]).filter((i) => i && i.text.trim() !== '');
    }
  }
  return out;
}

// The move dialog's face for a checklist ask: the row's current items,
// tickable on the spot, with room for new sub-tasks. Same shapes as the
// cell editor (PropertyValue), deliberately open — not a summary.
function ChecklistAsk({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (v: ChecklistItem[]) => void;
}) {
  const items = checklistItems(value);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; after: boolean } | null>(null);
  const focusIdRef = useRef<string | null>(null);
  const inputRefs = useRef<Map<string, HTMLInputElement>>(new Map());

  const write = (next: ChecklistItem[]) => onChange(next.length ? next : []);
  const toggle = (id: string) => write(items.map((i) => (i.id === id ? { ...i, done: !i.done } : i)));
  const setText = (id: string, text: string) => write(items.map((i) => (i.id === id ? { ...i, text } : i)));
  const remove = (id: string) => write(items.filter((i) => i.id !== id));

  useEffect(() => {
    if (focusIdRef.current) {
      const el = inputRefs.current.get(focusIdRef.current);
      if (el) {
        el.focus();
        const len = el.value.length;
        el.setSelectionRange(len, len);
      }
      focusIdRef.current = null;
    }
  }, [items]);

  const add = (afterIndex?: number) => {
    const newId = 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    focusIdRef.current = newId;
    if (afterIndex !== undefined && afterIndex >= 0 && afterIndex < items.length) {
      const next = [...items];
      next.splice(afterIndex + 1, 0, { id: newId, text: '', done: false });
      write(next);
    } else {
      write([...items, { id: newId, text: '', done: false }]);
    }
  };

  const moveItem = (id: string, targetId: string, after: boolean) => {
    const source = items.findIndex((i) => i.id === id);
    const target = items.findIndex((i) => i.id === targetId);
    if (source < 0 || target < 0 || source === target) return;
    const next = [...items];
    const [item] = next.splice(source, 1);
    next.splice(target - (source < target ? 1 : 0) + Number(after), 0, item);
    write(next);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>, it: ChecklistItem, index: number) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      toggle(it.id);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (it.text.trim()) {
        add(index);
      }
    } else if (e.key === 'Backspace' && it.text === '') {
      e.preventDefault();
      if (items.length > 1) {
        const targetIndex = index > 0 ? index - 1 : index + 1;
        focusIdRef.current = items[targetIndex]?.id ?? null;
      }
      remove(it.id);
    } else if (e.altKey && e.key === 'ArrowUp') {
      e.preventDefault();
      if (index > 0) {
        focusIdRef.current = it.id;
        moveItem(it.id, items[index - 1].id, false);
      }
    } else if (e.altKey && e.key === 'ArrowDown') {
      e.preventDefault();
      if (index < items.length - 1) {
        focusIdRef.current = it.id;
        moveItem(it.id, items[index + 1].id, true);
      }
    } else if (e.key === 'ArrowUp') {
      if (index > 0) {
        const prevEl = inputRefs.current.get(items[index - 1].id);
        if (prevEl) {
          e.preventDefault();
          prevEl.focus();
        }
      }
    } else if (e.key === 'ArrowDown') {
      if (index < items.length - 1) {
        const nextEl = inputRefs.current.get(items[index + 1].id);
        if (nextEl) {
          e.preventDefault();
          nextEl.focus();
        }
      }
    }
  };

  return (
    <div className="prop-checklist">
      {items.map((it, idx) => (
        <div
          key={it.id}
          className={
            'pcl-item' +
            (it.done ? ' is-done' : '') +
            (dragId === it.id ? ' pcl-dragging' : '') +
            (dropTarget?.id === it.id ? (dropTarget.after ? ' pcl-drop-after' : ' pcl-drop-before') : '')
          }
          onDragOver={(e) => {
            if (!dragId || dragId === it.id) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'move';
            const bounds = e.currentTarget.getBoundingClientRect();
            setDropTarget({
              id: it.id,
              after: e.clientY > bounds.top + bounds.height / 2,
            });
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
              if (dropTarget?.id === it.id) setDropTarget(null);
            }
          }}
          onDrop={(e) => {
            if (!dragId || dragId === it.id) return;
            e.preventDefault();
            e.stopPropagation();
            const bounds = e.currentTarget.getBoundingClientRect();
            moveItem(dragId, it.id, e.clientY > bounds.top + bounds.height / 2);
            setDragId(null);
            setDropTarget(null);
          }}
        >
          <span
            className="pcl-drag-handle"
            draggable
            title={t('Drag to reorder')}
            onDragStart={(e) => {
              e.stopPropagation();
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', it.id);
              setDragId(it.id);
            }}
            onDragEnd={() => {
              setDragId(null);
              setDropTarget(null);
            }}
          >
            <GripVertical size={13} />
          </span>
          <input type="checkbox" checked={it.done} onChange={() => toggle(it.id)} />
          <input
            ref={(el) => {
              if (el) inputRefs.current.set(it.id, el);
              else inputRefs.current.delete(it.id);
            }}
            className="pcl-text"
            value={it.text}
            placeholder={t('Sub-task')}
            onChange={(e) => setText(it.id, e.target.value)}
            onKeyDown={(e) => onKeyDown(e, it, idx)}
          />
          <button type="button" className="pcl-del" title={t('Delete')} onClick={() => remove(it.id)}>
            ✕
          </button>
        </div>
      ))}
      <div className="pcl-actions">
        <button type="button" className="pcl-add" onClick={() => add()}>
          + {t('Sub-task')}
        </button>
      </div>
    </div>
  );
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
    else if (req.kind === 'workflow') req.resolve(cleanAnswers(req.fields, answers));
    else req.resolve(value.trim() ? value.trim() : null);
    setReq(null);
  };
  const workflowReady =
    req?.kind === 'workflow' &&
    req.fields.every((f) => {
      const v = answers[f.key];
      if (f.kind === 'multiselect') return Array.isArray(v) && v.length > 0;
      if (f.kind === 'person') return typeof v === 'string' && v !== '';
      if (f.kind === 'checklist') {
        const named = checklistItems(v).filter((i) => i.text.trim() !== '');
        return named.length > 0 && named.every((i) => i.done);
      }
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
                      <WorkflowDateInput
                        value={answers[f.key]}
                        onChange={(v) => setAnswers((p) => ({ ...p, [f.key]: v }))}
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
                    ) : f.kind === 'checklist' ? (
                      <span className="workflow-ask-check">
                        <ChecklistAsk
                          value={answers[f.key]}
                          onChange={(v) => setAnswers((p) => ({ ...p, [f.key]: v }))}
                        />
                        <span className="dialog-hint">{t('Tick everything to continue')}</span>
                      </span>
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
