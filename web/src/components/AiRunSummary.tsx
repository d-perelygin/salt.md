import { useState } from 'react';
import { api } from '../api';
import { t } from '../i18n';
import { ChevronDown, ChevronRight } from 'lucide-react';
import AiAgentStep, { type AiStep } from './AiAgentStep';

export interface AiRunInfo {
  id: string;
  status: string;
  startedAt: string;
  finishedAt: string;
  stepCount: number;
}

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// One finished run under the answer it produced: "Worked for 1m 9s (20
// steps)", collapsed. Steps load on first expand and stay cached.
export default function AiRunSummary({ run, preloaded }: { run: AiRunInfo; preloaded?: AiStep[] }) {
  const [open, setOpen] = useState(false);
  const [steps, setSteps] = useState<AiStep[] | null>(preloaded && preloaded.length > 0 ? preloaded : null);
  const toggle = () => {
    if (!open && !steps) {
      api
        .getAIRunSteps(run.id)
        .then((st) => {
          if (Array.isArray(st)) setSteps(st as AiStep[]);
        })
        .catch(() => setSteps([]));
    }
    setOpen((v) => !v);
  };
  const end = Date.parse(run.finishedAt);
  const start = Date.parse(run.startedAt);
  const ms = Number.isFinite(end) && Number.isFinite(start) && end >= start ? end - start : 0;
  const count = steps !== null ? steps.length : run.stepCount || 0;
  return (
    <div style={{ margin: '8px 0' }}>
      <div className="ai-actions-bar">
        <button className="ai-actions-toggle" onClick={toggle} type="button">
          <span style={{ display: 'inline-flex' }}>{open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}</span>
          <span>
            {t('Worked for')} {formatDuration(ms)} ({count} {t('steps')})
          </span>
        </button>
      </div>
      {open && (
        <div className="ai-actions-list">
          {steps ? (
            steps.map((s) => <AiAgentStep key={s.id} step={s} />)
          ) : (
            <div className="dialog-hint">{t('Loading…')}</div>
          )}
        </div>
      )}
    </div>
  );
}
