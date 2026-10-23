import { useState } from 'react';
import { ChevronDown, ChevronRight, Brain, Wrench, CircleCheck } from 'lucide-react';
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

// Collapsible tool / thought row in the trace list
export default function AiAgentStep({ step }: { step: AiStep }) {
  const [open, setOpen] = useState(false);
  const isThinking = step.kind === 'thinking';
  const isDone = step.status === 'completed' || step.status === 'done' || !step.status;
  const isRunning = step.status === 'running' || step.status === 'in_progress';

  return (
    <div className="ai-action-step-item">
      <button
        onClick={() => setOpen((v) => !v)}
        className="ai-action-step-head"
        title={step.title}
        type="button"
      >
        <span style={{ display: 'inline-flex', opacity: 0.7, flex: 'none' }}>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <span style={{ display: 'inline-flex', opacity: 0.8, flex: 'none' }}>
          {isThinking ? <Brain size={14} /> : <Wrench size={14} />}
        </span>
        <strong style={{ fontSize: 12, opacity: 0.85, flex: 'none' }}>
          {isThinking ? t('Thinking') : t('Tool')}
        </strong>
        <span className="ai-action-step-title" style={{ fontSize: 12, opacity: 0.9 }}>
          {step.title}
        </span>
        {isRunning && <span style={{ fontSize: 11, color: 'var(--accent)', marginLeft: 'auto', flex: 'none' }}>⋯</span>}
        {isDone && <CircleCheck size={12} style={{ color: 'var(--success, #10b981)', opacity: 0.8, marginLeft: 'auto', flex: 'none' }} />}
      </button>
      {open && step.body && (
        <pre style={{
          margin: '4px 0 6px 24px', padding: '8px 10px', borderRadius: 8,
          background: 'var(--muted, var(--hover))', color: 'inherit',
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          maxHeight: 240, overflow: 'auto', fontSize: 12, lineHeight: 1.45,
          border: '1px solid var(--border)',
        }}>
          {step.body}
        </pre>
      )}
    </div>
  );
}

