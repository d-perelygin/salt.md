import { useState } from 'react';
import { t } from '../i18n';

export interface AiStep {
  id: string;
  runId: string;
  threadId: string;
  seq: number;
  kind: string;
  title: string;
  body: string;
  status: string;
  createdAt: string;
}

// One agent trace row, in the OpenChamber shape: a "Thinking" line for
// reasoning and a "{ } Script" line for tool calls, each expandable.
export default function AiAgentStep({ step }: { step: AiStep }) {
  const [open, setOpen] = useState(false);
  const isThinking = step.kind === 'thinking';
  const icon = isThinking ? '⚙' : '{ }';
  const label = isThinking ? t('Thinking') : t('Script');
  return (
    <div style={{ marginBottom: 6, fontSize: 13 }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'flex', gap: 8, alignItems: 'baseline', width: '100%',
          background: 'none', border: 'none', cursor: 'pointer',
          color: 'inherit', textAlign: 'left', padding: 0,
        }}
      >
        <span style={{ opacity: 0.6, fontFamily: 'monospace' }}>{icon}</span>
        <strong>{label}</strong>
        <span style={{ opacity: 0.85, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {step.title}
        </span>
      </button>
      {open && step.body && (
        <pre style={{
          margin: '4px 0 0 28px', padding: 8, borderRadius: 6,
          background: 'var(--muted)', whiteSpace: 'pre-wrap',
          maxHeight: 220, overflow: 'auto', fontSize: 12,
        }}>
          {step.body}
        </pre>
      )}
    </div>
  );
}
