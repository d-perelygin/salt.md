import { useEffect, useRef, useState } from 'react';
import { Shield, Check } from 'lucide-react';
import { api } from '../api';
import { t } from '../i18n';
import { useMenuDismiss } from '../modal';

export type ApprovalMode = 'always' | 'review' | 'skip';

const MODES: { id: ApprovalMode; hint: string }[] = [
  { id: 'always', hint: 'Ask before making changes or sharing content' },
  { id: 'review', hint: 'Only consult me about potentially unsafe actions' },
  { id: 'skip', hint: 'Act without asking. Use with caution.' },
];

export function approvalLabel(m: string): string {
  if (m === 'always') return t('Always ask');
  if (m === 'skip') return t('Skip all approvals');
  return t('Review for me');
}

// Notion-style approval picker: how should the agent ask for approval?
//
// `compact` is the composer's icon-sized trigger: a shield beside the attach
// "+", the current mode in its tooltip. The wide labelled button read like a
// second submit action sitting under the input, and it took the row the chips
// and the send button needed on a narrow panel.
export default function AiApprovalSelect(props: {
  value: string;
  onChange: (m: ApprovalMode) => void;
  compact?: boolean;
  /** Anchored to the right edge (the composer's own button) instead of left. */
  alignRight?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useMenuDismiss(open, ref, () => setOpen(false));
  return (
    <span ref={ref} style={{ position: 'relative', display: 'inline-flex' }}>
      {props.compact ? (
        <button
          className="ai-iconbtn"
          type="button"
          title={`${t('How should the agent ask for approval?')} — ${approvalLabel(props.value)}`}
          aria-label={approvalLabel(props.value)}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <Shield size={15} />
        </button>
      ) : (
        <button
          className="btn-sm"
          title={t('How should the agent ask for approval?')}
          onClick={() => setOpen((v) => !v)}
        >
          <Shield size={14} /> {approvalLabel(props.value)}
        </button>
      )}
      {open && (
        <div
          style={{
            position: 'absolute', bottom: 'calc(100% + 8px)', left: props.alignRight ? 'auto' : 0,
            right: props.alignRight ? 0 : 'auto', zIndex: 60,
            width: 300, background: 'var(--card)', color: 'var(--card-foreground)',
            border: '1px solid var(--border)', borderRadius: 12, padding: 12,
            boxShadow: '0 8px 24px rgba(0,0,0,.25)',
          }}
          role="menu"
        >
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{t('How should the agent ask for approval?')}</div>
          {MODES.map((m) => (
            <button
              key={m.id}
              role="menuitemradio"
              aria-checked={props.value === m.id}
              onClick={() => { props.onChange(m.id); setOpen(false); }}
              style={{
                display: 'block', width: '100%', textAlign: 'left', background: 'none',
                border: 'none', cursor: 'pointer', color: m.id === 'skip' ? 'var(--warning, #e07d10)' : 'inherit',
                padding: '8px 4px', borderRadius: 8,
              }}
            >
              <div style={{ fontWeight: 600, fontSize: 14 }}>
                {m.id === 'always' ? t('Always ask') : m.id === 'review' ? t('Review for me') : t('Skip all approvals')}
                {props.value === m.id && <span style={{ float: 'right' }}><Check size={12} /></span>}
              </div>
              <div style={{ fontSize: 12, opacity: 0.7 }}>
                {m.id === 'always' ? t('Ask before making changes or sharing content')
                  : m.id === 'review' ? t('Only consult me about potentially unsafe actions')
                  : t('Act without asking. Use with caution.')}
              </div>
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

export function useApprovalMode(): [string, (m: ApprovalMode) => void] {
  const [mode, setMode] = useState('review');
  useEffect(() => {
    api.getAISettings().then((s) => {
      if (s.approval) setMode(s.approval);
    }).catch(() => {});
  }, []);
  const change = (m: ApprovalMode) => {
    setMode(m);
    api.putAISettings({ approval: m }).catch(() => {});
  };
  return [mode, change];
}
