import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { t } from '../i18n';
import AiAgentStep, { type AiStep } from './AiAgentStep';
import AiMarkdown from './AiMarkdown';
import AiApprovalSelect, { useApprovalMode } from './AiApprovalSelect';

interface Msg { role: string; content: string }

// Side panel variant of the chat (per-document quick chat + agent runs).
// Shares threads/messages/steps with the center AiChatView.
export default function AiChatPanel(props: {
  pageId?: string;
  threadId?: string | null;
  quote?: string | null;
  onQuoteConsumed?: () => void;
  onClose: () => void;
}) {
  const [threadId, setThreadId] = useState<string | null>(props.threadId ?? null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [steps, setSteps] = useState<AiStep[]>([]);
  const [input, setInput] = useState('');
  const [quote, setQuote] = useState(props.quote ?? '');
  const [agentBusy, setAgentBusy] = useState(false);
  const [runStatus, setRunStatus] = useState('');
  const [runId, setRunId] = useState<string | null>(null);
  const [waitingApproval, setWaitingApproval] = useState(false);
  const [pendingQuestion, setPendingQuestion] = useState<{ runId: string; question: string; options: { label: string; description?: string }[]; multiple: boolean } | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [freeText, setFreeText] = useState('');
  const qKeyRef = useRef('');
  const [approval, setApproval] = useApprovalMode();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [format, setFormat] = useState('chat');
  const [apiKey, setApiKey] = useState('');
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [files, setFiles] = useState<{ name: string; text: string }[]>([]);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  function copyText(text: string, idx: number) {
    const done = () => {
      setCopiedIdx(idx);
      window.setTimeout(() => setCopiedIdx((c) => (c === idx ? null : c)), 1500);
    };
    try {
      const p = navigator.clipboard?.writeText(text);
      if (p && typeof (p as Promise<void>).then === 'function') void (p as Promise<void>).then(done).catch(() => {});
      else done();
    } catch {
      /* clipboard unavailable */
    }
  }

  useEffect(() => { setThreadId(props.threadId ?? null); }, [props.threadId]);
  useEffect(() => { if (props.quote) setQuote(props.quote); }, [props.quote]);

  useEffect(() => {
    api.getAISettings().then((s) => {
      setBaseUrl(s.baseUrl || '');
      setModel(s.model || '');
      setFormat(s.format || 'chat');
    }).catch(() => {});
  }, []);

  const [histSteps, setHistSteps] = useState<AiStep[]>([]);
  const [histDuration, setHistDuration] = useState<number | null>(null);
  const [traceOpen, setTraceOpen] = useState(false);
  // Same race as the center view: history fetches must not clobber streaming.
  const streamingRef = useRef(false);

  useEffect(() => {
    if (!threadId) { setMessages([]); setSteps([]); setHistSteps([]); setHistDuration(null); return; }
    api.getAIThreadMessages(threadId).then((r) => { if (!streamingRef.current) setMessages(r as Msg[]); }).catch(() => {});
    api.getAIThreadRuns(threadId).then((runs: any[]) => {
      const done = [...runs].reverse().find((run) => run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled');
      if (!done) return;
      if (done.startedAt && done.finishedAt) {
        const ms = new Date(done.finishedAt).getTime() - new Date(done.startedAt).getTime();
        if (Number.isFinite(ms) && ms >= 0) setHistDuration(ms);
      }
      api.getAIRunSteps(done.id).then((st) => {
        if (Array.isArray(st) && st.length) setHistSteps(st as AiStep[]);
      }).catch(() => {});
    }).catch(() => {});
  }, [threadId]);

  function formatDuration(ms: number): string {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
  }

  function insertIntoPage(markdown: string) {
    window.dispatchEvent(new CustomEvent('salt:ai-insert', {
      detail: { pageId: props.pageId, markdown },
    }));
  }

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, steps]);

  async function ensureThread(text: string): Promise<string | null> {
    if (threadId) return threadId;
    try {
      const r = await api.createAIThread({ pageId: props.pageId, title: text.slice(0, 40) });
      setThreadId(r.id);
      return r.id;
    } catch {
      return null;
    }
  }

  function consumeQuote(): string {
    const q = quote;
    setQuote('');
    props.onQuoteConsumed?.();
    return q;
  }

  function contextTexts() {
    return files.filter((f) => f.text).slice(0, 3).map((f) => ({ name: f.name, text: f.text.slice(0, 4000) }));
  }

  async function attachPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const list = e.target.files;
    e.target.value = '';
    if (!list || !list.length) return;
    for (const f of Array.from(list).slice(0, 3)) {
      const ext = '.' + (f.name.split('.').pop() ?? '').toLowerCase();
      if (['.txt', '.md', '.csv', '.json'].includes(ext)) {
        try {
          const text = (await f.text()).slice(0, 6000);
          setFiles((prev) => [...prev, { name: f.name, text }]);
          continue;
        } catch { /* fall through to server upload */ }
      }
      try {
        const id = threadId ?? await ensureThread(f.name);
        if (!id) continue;
        const r = await api.uploadAIAttachment(f, id);
        if (r.status === 'done' && r.text) setFiles((prev) => [...prev, { name: f.name, text: (r.text as string).slice(0, 6000) }]);
        else setFiles((prev) => [...prev, { name: f.name + ' (unreadable)', text: '' }]);
      } catch {
        /* ignore */
      }
    }
  }

  const [lastRun, setLastRun] = useState<{ id: string; task: string; status: string; error: string } | null>(null);

  async function runAsAgent(reuseTask?: string) {
    if (agentBusy) return;
    const text = (reuseTask ?? input).trim();
    if (!text) return;
    if (!reuseTask) setInput('');
    const tid = await ensureThread(text);
    if (!tid) return;
    const q = consumeQuote();
    const attached = files.filter((f) => f.text).slice(0, 3);
    setFiles([]);
    if (!reuseTask) setMessages((m) => [...m, { role: 'user', content: text }]);
    setLastRun(null);
    setPendingQuestion(null);
    setPicked([]);
    setFreeText('');
    qKeyRef.current = '';
    streamingRef.current = true;
    setAgentBusy(true);
    setRunStatus(t('Working…'));
    setWaitingApproval(false);
    setSteps([]);
    setHistSteps([]);
    setHistDuration(null);
    setTraceOpen(true);
    try {
      const filesBlock = attached.length
        ? 'Attached files:\n' + attached.map((f) => `--- ${f.name} ---\n${f.text.slice(0, 4000)}`).join('\n') + '\n\n'
        : '';
      const fullTask = filesBlock + (q ? `Context quote:\n${q}\n\n` : '') + text;
      const r = await api.createAIRun({ threadId: tid, task: fullTask, pageId: props.pageId });
      setRunId(r.id);
      const res = await fetch(`/api/ai/runs/${r.id}/events`, { credentials: 'same-origin' });
      if (!res.ok || !res.body) throw new Error('no events');
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      const seen = new Set<string>();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          try {
            const j = JSON.parse(line.slice(5).trim());
            if (j.type === 'step' && j.step && !seen.has(j.step.id)) {
              seen.add(j.step.id);
              setSteps((s) => [...s, j.step as AiStep]);
            }
            if (j.type === 'status') {
              const err = typeof j.error === 'string' ? j.error : '';
              setRunStatus(j.status === 'completed' ? '' : ((j.progress || j.status) + (err && j.status === 'failed' ? `: ${err.slice(0, 200)}` : '')));
              setWaitingApproval(j.status === 'waiting_approval');
              if (j.status === 'waiting_user' && j.pendingTool === 'ask_user' && typeof j.pendingArgs === 'string') {
                try {
                  const q = JSON.parse(j.pendingArgs);
                  if (q && typeof q.question === 'string' && Array.isArray(q.options)) {
                    const key = r.id + '|' + q.question;
                    if (qKeyRef.current !== key) {
                      qKeyRef.current = key;
                      setPendingQuestion({ runId: r.id, question: q.question, options: q.options.slice(0, 6), multiple: !!q.multiple });
                      setPicked([]);
                      setFreeText('');
                    }
                  }
                } catch { /* ignore */ }
              }
              if (j.status === 'completed' || j.status === 'failed' || j.status === 'cancelled') {
                setLastRun({ id: r.id, task: fullTask, status: j.status, error: err });
                setPendingQuestion(null);
                break;
              }
            }
          } catch { /* ignore */ }
        }
      }
      const msgs = await api.getAIThreadMessages(tid).catch(() => [] as Msg[]);
      if (msgs.length) setMessages(msgs as Msg[]);
    } catch {
      setRunStatus(t('Run failed'));
    } finally {
      setAgentBusy(false);
      setRunId(null);
      setWaitingApproval(false);
      streamingRef.current = false;
    }
  }

  async function decide(approved: boolean) {
    if (!runId) return;
    try {
      await api.approveAIRun(runId, approved);
    } catch { /* the run will time out on its own */ }
  }

  async function submitAnswer() {
    if (!pendingQuestion) return;
    const parts = [...picked];
    if (freeText.trim()) parts.push(freeText.trim());
    if (parts.length === 0) return;
    try {
      await api.answerAIRun(pendingQuestion.runId, parts.join('; '));
    } catch { /* the run may have timed out or been cancelled */ }
    setPendingQuestion(null);
    setPicked([]);
    setFreeText('');
  }

  return (
    <div className="ai-panel">
      <div className="ai-panel-head">
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><span className="ai-avatar" style={{ width: 22, height: 22, borderRadius: '50%', background: 'var(--hover)', border: '1px solid var(--border)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 12 }}>✨</span>{t('AI')}</span>
        <div style={{ display: 'flex', gap: 4 }}>
          <button className="ai-iconbtn" onClick={() => setSettingsOpen((v) => !v)} title={t('Settings')}>⚙</button>
          <button className="ai-iconbtn" onClick={props.onClose} title={t('Close')}>✕</button>
        </div>
      </div>
      {settingsOpen && (
        <div style={{ padding: 12, borderBottom: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <input placeholder={t('Base URL')} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          <input placeholder={t('Model')} value={model} onChange={(e) => setModel(e.target.value)} />
          <select value={format} onChange={(e) => setFormat(e.target.value)}>
            <option value="chat">{t('Chat completions')}</option>
            <option value="responses">{t('Responses')}</option>
          </select>
          <input placeholder={t('API key')} type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
          <button onClick={async () => {
            await api.putAISettings({ baseUrl, model, format, apiKey });
            setSettingsOpen(false);
            setApiKey('');
          }}>{t('Save')}</button>
        </div>
      )}
      <div className="ai-panel-body">
        {messages.map((m, i) => (
          <div key={i} className={m.role === 'user' ? 'ai-msg user' : 'ai-msg assistant'}>
            {m.role === 'user' ? (
              <div className="ai-bubble-user">{m.content}</div>
            ) : (
              <div className="ai-bubble-ai">
                <AiMarkdown text={m.content} />
                {m.content && (
                  <div className="ai-msg-actions">
                    <button className="ai-iconbtn" onClick={() => copyText(m.content, i)} title={t('Copy')}>
                      {copiedIdx === i ? '✓' : '⧉'}
                    </button>
                    {i === messages.length - 1 && (
                      <button className="ai-iconbtn" onClick={() => {
                        const lu = [...messages].reverse().find((x) => x.role === 'user');
                        if (lu) void runAsAgent(lu.content);
                      }} disabled={agentBusy} title={t('Regenerate')}>
                        ↻
                      </button>
                    )}
                    {props.pageId && (
                      <button className="ai-iconbtn" onClick={() => insertIntoPage(m.content)} title={t('Insert into page')}>
                        ⬇
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
        {(steps.length > 0 || histSteps.length > 0) && (
          <div className="ai-trace">
            <button className="ai-trace-head" onClick={() => setTraceOpen((v) => !v)}>
              {histDuration !== null && steps.length === 0
                ? `${t('Worked for')} ${formatDuration(histDuration)} ${traceOpen ? '▾' : '›'}`
                : `${t('Agent trace')} ${traceOpen ? '▾' : '›'}`}
            </button>
            {traceOpen && (steps.length > 0 ? steps : histSteps).map((s) => <AiAgentStep key={s.id} step={s} />)}
            {runStatus && <div style={{ fontSize: 12, opacity: 0.7 }}>{runStatus}</div>}
            {waitingApproval && runId && (
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button className="btn-sm primary" onClick={() => void decide(true)}>{t('Approve')}</button>
                <button className="btn-sm" onClick={() => void decide(false)}>{t('Reject')}</button>
              </div>
            )}
            {!agentBusy && lastRun && (lastRun.status === 'failed' || lastRun.status === 'cancelled') && (
              <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
                <button className="btn-sm primary" onClick={() => void runAsAgent(lastRun.task)}>{t('Retry')}</button>
                {lastRun.error && <span style={{ fontSize: 12, opacity: 0.7 }}>{lastRun.error.slice(0, 200)}</span>}
              </div>
            )}
          </div>
        )}
        {pendingQuestion && (
          <div className="ai-question-card">
            <div className="ai-question-title"><span>❓</span><span>{pendingQuestion.question}</span></div>
            <div className="ai-question-options">
              {pendingQuestion.options.map((o) => {
                const on = picked.includes(o.label);
                return (
                  <button
                    key={o.label}
                    className={'ai-question-opt' + (on ? ' on' : '')}
                    onClick={() => setPicked((prev) =>
                      pendingQuestion.multiple
                        ? (on ? prev.filter((x) => x !== o.label) : [...prev, o.label])
                        : (on ? [] : [o.label]),
                    )}
                    title={o.description || o.label}
                  >
                    <span className="ai-question-opt-label">{o.label}</span>
                    {o.description && <span className="ai-question-opt-desc">{o.description}</span>}
                  </button>
                );
              })}
            </div>
            <textarea
              value={freeText}
              rows={2}
              onChange={(e) => setFreeText(e.target.value)}
              placeholder={t('Type your own answer…')}
            />
            <div>
              <button className="btn-sm primary" onClick={() => void submitAnswer()} disabled={picked.length === 0 && !freeText.trim()}>
                {t('Submit answer')}
              </button>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>
      {quote && (
        <div className="ai-quote" style={{ margin: '0 12px' }}>
          <span style={{ flex: 1, whiteSpace: 'pre-wrap', maxHeight: 60, overflow: 'auto' }}>❝ {quote}</span>
          <button className="ai-iconbtn" onClick={() => { setQuote(''); props.onQuoteConsumed?.(); }} title={t('Remove quote')}>×</button>
        </div>
      )}
      {files.length > 0 && (
        <div style={{ display: 'flex', gap: 6, padding: '8px 12px 0', flexWrap: 'wrap' }}>
          {files.map((f, i) => (
            <span key={i} className="ai-filechip">
              📎 {f.name}{!f.text ? ` (${t('unreadable')})` : ''}
              {' '}<button className="ai-iconbtn" onClick={() => setFiles((p) => p.filter((_, j) => j !== i))} title={t('Remove')}>×</button>
            </span>
          ))}
        </div>
      )}
      <div className="ai-panel-foot">
        <div className="ai-composer">
          <textarea
            value={input}
            rows={2}
            onChange={(e) => {
              setInput(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = Math.min(e.target.scrollHeight, 140) + 'px';
            }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void runAsAgent(); } }}
            placeholder={t('Ask AI')}
            disabled={agentBusy}
          />
          <div className="ai-composer-bar">
            <button className="ai-attach" onClick={() => fileRef.current?.click()} disabled={agentBusy} title={t('Attach files')}>+</button>
            <input ref={fileRef} type="file" multiple accept=".txt,.md,.csv,.json,.pdf" style={{ display: 'none' }} onChange={(e) => void attachPicked(e)} />
            <span className="spacer" />
            <button className="ai-send" onClick={() => void runAsAgent()} disabled={agentBusy} title={t('Send')}>{agentBusy ? '…' : '↑'}</button>
            {agentBusy && runId && (
              <button className="ai-iconbtn" onClick={() => { void api.cancelAIRun(runId).catch(() => {}); }} title={t('Cancel')}>■</button>
            )}
          </div>
        </div>
        <div style={{ paddingTop: 8 }}>
          <AiApprovalSelect value={approval} onChange={setApproval} />
        </div>
      </div>
    </div>
  );
}
