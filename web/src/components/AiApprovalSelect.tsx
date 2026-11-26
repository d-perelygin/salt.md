import { useEffect, useRef, useState } from 'react';
import { Shield, ShieldCheck, ShieldOff, Hand, Check, type LucideIcon } from 'lucide-react';
import { api } from '../api';
import { t } from '../i18n';
import { useMenuDismiss } from '../modal';

export type ApprovalMode = 'always' | 'review' | 'skip';

const MODES: { id: ApprovalMode; hint: string }[] = [
  { id: 'always', hint: 'Ask before making changes or sharing content' },
  { id: 'review', hint: 'Only consult me about potentially unsafe actions' },
  { id: 'skip', hint: 'Act without asking. Use with caution.' },
];

// One icon per mode, and the trigger shows the one in force: a raised hand
// means the agent asks for everything, a ticked shield means only unsafe
// actions are checked, a crossed-out shield (in the warning colour) means
// nothing is. Reading the state from the composer must not require opening
// the menu.
const MODE_ICON: Record<ApprovalMode, LucideIcon> = {
  always: Hand,
  review: ShieldCheck,
  skip: ShieldOff,
};

/** The warning tint the skip mode wears, on the trigger and in the menu. */
function modeTint(mode: string): string | undefined {
  return mode === 'skip' ? 'var(--warning, #e07d10)' : undefined;
}

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
  /** Anchored to the right edge instead of left. Left by default: the icon
   *  sits at the left of the composer, and a 300px menu opening leftwards
   *  from there runs out of the panel (which clips it). */
  alignRight?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useMenuDismiss(open, ref, () => setOpen(false));
  const ActiveIcon = MODE_ICON[props.value as ApprovalMode] ?? Shield;
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
          <ActiveIcon size={15} style={{ color: modeTint(props.value) }} />
        </button>
      ) : (
        <button
          className="btn-sm"
          title={t('How should the agent ask for approval?')}
          onClick={() => setOpen((v) => !v)}
        >
          <ActiveIcon size={14} style={{ color: modeTint(props.value) }} /> {approvalLabel(props.value)}
        </button>
      )}
      {open && (
        <div
          style={{
            position: 'absolute', bottom: 'calc(100% + 8px)', left: props.alignRight ? 'auto' : 0,
            right: props.alignRight ? 0 : 'auto', zIndex: 60,
            width: 'min(300px, calc(100vw - 32px))', background: 'var(--card)', color: 'var(--card-foreground)',
            border: '1px solid var(--border)', borderRadius: 12, padding: 12,
            boxShadow: '0 8px 24px rgba(0,0,0,.25)',
          }}
          role="menu"
        >
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{t('How should the agent ask for approval?')}</div>
          {MODES.map((m) => {
            const Icon = MODE_ICON[m.id];
            return (
              <button
                key={m.id}
                role="menuitemradio"
                aria-checked={props.value === m.id}
                onClick={() => { props.onChange(m.id); setOpen(false); }}
                style={{
                  display: 'flex', alignItems: 'flex-start', gap: 8, width: '100%', textAlign: 'left', background: 'none',
                  border: 'none', cursor: 'pointer', color: m.id === 'skip' ? 'var(--warning, #e07d10)' : 'inherit',
                  padding: '8px 4px', borderRadius: 8,
                }}
              >
                <span style={{ display: 'inline-flex', marginTop: 2 }}><Icon size={15} style={{ color: modeTint(m.id) }} /></span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>
                    {m.id === 'always' ? t('Always ask') : m.id === 'review' ? t('Review for me') : t('Skip all approvals')}
                    {props.value === m.id && <span style={{ float: 'right' }}><Check size={12} /></span>}
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.7 }}>
                    {m.id === 'always' ? t('Ask before making changes or sharing content')
                      : m.id === 'review' ? t('Only consult me about potentially unsafe actions')
                      : t('Act without asking. Use with caution.')}
                  </div>
                </span>
              </button>
            );
          })}
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
