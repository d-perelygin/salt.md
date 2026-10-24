import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { t } from '../i18n';
import { useMenuDismiss } from '../modal';
import AiAgentStep, { type AiStep } from './AiAgentStep';
import AiErrorCard from './AiErrorCard';
import AiMarkdown from './AiMarkdown';
import AiApprovalSelect, { useApprovalMode } from './AiApprovalSelect';
import type { AiThread } from './AiThreadList';
import type { PageMeta } from '../types';

interface Msg { role: string; content: string }

// Floating side panel variant of the chat.
// Shares threads/messages/steps with the center AiChatView.
export default function AiChatPanel(props: {
  pageId?: string;
  threadId?: string | null;
  threads?: AiThread[];
  pagesById?: Map<string, PageMeta>;
  onSelectThread?: (id: string | null) => void;
  quote?: string | null;
  onQuoteConsumed?: () => void;
  onClose: () => void;
}) {
  const [threadId, setThreadId] = useState<string | null>(props.threadId ?? null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [steps, setSteps] = useState<AiStep[]>([]);
  const [input, setInput] = useState('');
  const [quote, setQuote] = useState(props.quote ?? '');
  const [autoQuote, setAutoQuote] = useState('');
  const dismissedQuoteRef = useRef('');
  const [agentBusy, setAgentBusy] = useState(false);
  const [runStatus, setRunStatus] = useState('');
  const [runId, setRunId] = useState<string | null>(null);
  const [waitingApproval, setWaitingApproval] = useState(false);
  const [pendingQuestion, setPendingQuestion] = useState<{ runId: string; question: string; options: { label: string; description?: string }[]; multiple: boolean } | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [freeText, setFreeText] = useState('');
  const qKeyRef = useRef('');
  const [approval, setApproval] = useApprovalMode();
  const [threadMenuOpen, setThreadMenuOpen] = useState(false);
  const threadMenuRef = useRef<HTMLDivElement>(null);
  useMenuDismiss(threadMenuOpen, threadMenuRef, () => setThreadMenuOpen(false));
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [workspaceModalOpen, setWorkspaceModalOpen] = useState(false);
  const [workspaceFilter, setWorkspaceFilter] = useState('');
  const attachMenuRef = useRef<HTMLDivElement>(null);
  useMenuDismiss(attachMenuOpen, attachMenuRef, () => setAttachMenuOpen(false));
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [files, setFiles] = useState<{ name: string; text: string }[]>([]);
  const [lastError, setLastError] = useState<string | null>(null);
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

  // Document selection sync: attach selection as a chip over chat input
  useEffect(() => {
    const onSelection = (e: Event) => {
      const text = ((e as CustomEvent<{ text?: string }>).detail?.text || '').trim();
      if (!text) {
        setAutoQuote('');
        return;
      }
      if (text !== dismissedQuoteRef.current) {
        setAutoQuote(text);
      }
    };
    window.addEventListener('salt:editor-selection', onSelection);
    return () => window.removeEventListener('salt:editor-selection', onSelection);
  }, []);

  const [histSteps, setHistSteps] = useState<AiStep[]>([]);
  const [histDuration, setHistDuration] = useState<number | null>(null);
  const [traceOpen, setTraceOpen] = useState(false);
  const streamingRef = useRef(false);

  useEffect(() => {
    if (!threadId) {
      setMessages([]);
      setSteps([]);
      setHistSteps([]);
      setHistDuration(null);
      setLastError(null);
      setLastRun(null);
      return;
    }
    Promise.all([
      api.getAIThreadMessages(threadId).catch(() => [] as Msg[]),
      api.getAIThreadRuns(threadId).catch(() => [] as any[]),
    ]).then(([rawMsgs, runs]) => {
      if (streamingRef.current) return;
      const msgs = [...rawMsgs];
      const done = [...runs].reverse().find((run) => run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled');
      if (done && done.status === 'failed') {
        if (msgs.length === 0 || msgs[msgs.length - 1].role !== 'user') {
          msgs.push({ role: 'user', content: done.task });
        }
        setLastError(done.error || t('Agent run failed'));
        setLastRun({ id: done.id, task: done.task, status: done.status, error: done.error || '' });
      } else {
        setLastError(null);
        setLastRun(null);
      }
      setMessages(msgs);
      if (!done) return;
      if (done.startedAt && done.finishedAt) {
        const ms = Date.parse(done.finishedAt) - Date.parse(done.startedAt);
        if (Number.isFinite(ms) && ms >= 0) setHistDuration(ms);
      }
      api.getAIRunSteps(done.id).then((st) => {
        if (Array.isArray(st) && st.length && !streamingRef.current) setHistSteps(st as AiStep[]);
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
      props.onSelectThread?.(r.id);
      return r.id;
    } catch {
      return null;
    }
  }

  // Keyboard navigation for numbered options 1..9
  useEffect(() => {
    if (!pendingQuestion) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === 'textarea' || tag === 'input') return;
      const num = parseInt(e.key, 10);
      if (!isNaN(num) && num >= 1 && num <= pendingQuestion.options.length) {
        e.preventDefault();
        const opt = pendingQuestion.options[num - 1];
        if (opt) {
          setPicked((prev) =>
            pendingQuestion.multiple
              ? (prev.includes(opt.label) ? prev.filter((x) => x !== opt.label) : [...prev, opt.label])
              : (prev.includes(opt.label) ? [] : [opt.label]),
          );
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [pendingQuestion]);

  const [lastRun, setLastRun] = useState<{ id: string; task: string; status: string; error: string } | null>(null);

  async function runAsAgent(reuseTask?: string) {
    if (agentBusy) return;
    const text = (reuseTask ?? input).trim();
    if (!text) return;
    if (!reuseTask) setInput('');
    const id = await ensureThread(text);
    if (!id) return;
    if (!reuseTask) setMessages((m) => [...m, { role: 'user', content: text }]);
    setLastRun(null);
    setLastError(null);
    setPendingQuestion(null);
    setPicked([]);
    setFreeText('');
    qKeyRef.current = '';
    streamingRef.current = true;
    setAgentBusy(true);
    setRunStatus(t('Working…'));
    setWaitingApproval(false);
    setSteps([]);
    setTraceOpen(true);
    try {
      const activeQ = quote || autoQuote;
      const quoteBlock = activeQ ? `Context quote:\n${activeQ}\n\n` : '';
      const filesBlock = files.length
        ? 'Attached files:\n' + files.filter((f) => f.text).slice(0, 3).map((f) => `--- ${f.name} ---\n${f.text.slice(0, 4000)}`).join('\n') + '\n\n'
        : '';
      const fullTask = reuseTask ? reuseTask : (quoteBlock + filesBlock + text);
      const r = await api.createAIRun({
        threadId: id,
        task: fullTask,
        prompt: reuseTask ? undefined : text,
        retry: !!reuseTask,
        pageId: props.pageId,
      });
      setRunId(r.id);
      setQuote('');
      setAutoQuote('');
      props.onQuoteConsumed?.();
      setFiles([]);
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
              if (j.status === 'failed') {
                setLastError(err || t('Agent run failed'));
              }
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
      const msgs = await api.getAIThreadMessages(id).catch(() => [] as Msg[]);
      if (msgs.length) setMessages(msgs as Msg[]);
    } catch (err: any) {
      setLastError(err?.message || t('Run failed'));
      setRunStatus(t('Run failed'));
    } finally {
      setAgentBusy(false);
      setRunId(null);
      setWaitingApproval(false);
      streamingRef.current = false;
    }
  }

  async function attachPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const flist = e.target.files;
    if (!flist || flist.length === 0) return;
    for (const f of Array.from(flist)) {
      if (f.type.startsWith('text/') || f.name.match(/\.(md|txt|csv|json)$/i)) {
        try {
          const text = await f.text();
          setFiles((prev) => [...prev, { name: f.name, text: text.slice(0, 6000) }]);
          continue;
        } catch { /* fall through to server upload */ }
      }
      try {
        const id = threadId ?? await ensureThread(f.name);
        if (!id) continue;
        const r = (await api.uploadAIAttachment(f, id)) as { status: string; text?: string; fileName?: string };
        if (r.status === 'done' && r.text) setFiles((prev) => [...prev, { name: f.name, text: (r.text as string).slice(0, 6000) }]);
        else setFiles((prev) => [...prev, { name: f.name + ' (unreadable)', text: '' }]);
      } catch { /* ignore */ }
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

  const activeThread = (props.threads || []).find((t) => t.id === threadId);

  return (
    <div className="ai-panel">
      <div className="ai-panel-head">
        <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }} ref={threadMenuRef}>
          <button
            type="button"
            className="ai-panel-chat-switcher"
            onClick={() => setThreadMenuOpen((v) => !v)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'inherit', fontWeight: 600, fontSize: 13, padding: '2px 6px',
              borderRadius: 6, maxWidth: 240,
            }}
          >
            <span style={{ fontSize: 13 }}>✨</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {activeThread?.title || t('AI')}
            </span>
            <span style={{ fontSize: 10, opacity: 0.6, flex: 'none' }}>▼</span>
          </button>
          {threadMenuOpen && (
            <div
              className="menu"
              style={{
                position: 'absolute', top: 'calc(100% + 4px)', left: 0,
                zIndex: 100, minWidth: 220, maxHeight: 280, overflowY: 'auto',
              }}
            >
              <button
                type="button"
                onClick={() => {
                  setThreadMenuOpen(false);
                  props.onSelectThread?.(null);
                }}
              >
                + {t('New chat')}
              </button>
              {(props.threads || []).map((th) => (
                <button
                  key={th.id}
                  type="button"
                  onClick={() => {
                    setThreadMenuOpen(false);
                    props.onSelectThread?.(th.id);
                  }}
                  style={{ fontWeight: th.id === threadId ? 600 : 'normal' }}
                >
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {th.title || t('New chat')}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          <button className="ai-iconbtn" onClick={props.onClose} title={t('Close')} type="button">✕</button>
        </div>
      </div>
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
          <div style={{ margin: '6px 0' }}>
            <div className="ai-actions-bar">
              <button className="ai-actions-toggle" onClick={() => setTraceOpen((v) => !v)} type="button">
                <span style={{ fontSize: 10 }}>{traceOpen ? '▼' : '▶'}</span>
                <span>
                  {histDuration !== null && steps.length === 0
                    ? `${t('Worked for')} ${formatDuration(histDuration)} (${histSteps.length} ${t('steps')})`
                    : `${t('Agent actions')} (${steps.length > 0 ? steps.length : histSteps.length})`}
                </span>
              </button>
            </div>
            {traceOpen && (
              <div className="ai-actions-list">
                {(steps.length > 0 ? steps : histSteps).map((s) => <AiAgentStep key={s.id} step={s} />)}
              </div>
            )}
            {runStatus && <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>{runStatus}</div>}
            {waitingApproval && runId && (
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button className="btn-sm primary" onClick={() => void decide(true)}>{t('Approve')}</button>
                <button className="btn-sm" onClick={() => void decide(false)}>{t('Reject')}</button>
              </div>
            )}
          </div>
        )}
        {lastError && (
          <AiErrorCard
            error={lastError}
            onRetry={lastRun?.task ? () => void runAsAgent(lastRun.task) : undefined}
            onDismiss={() => setLastError(null)}
          />
        )}
        {pendingQuestion && (
          <div className="ai-question-card">
            <div className="ai-question-title"><span>❓</span><span>{pendingQuestion.question}</span></div>
            <div className="ai-question-options">
              {pendingQuestion.options.map((o, idx) => {
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
                    type="button"
                  >
                    <span className="ai-question-opt-num">{idx + 1}</span>
                    <div className="ai-question-opt-body">
                      <span className="ai-question-opt-label">{o.label}</span>
                      {o.description && <span className="ai-question-opt-desc">{o.description}</span>}
                    </div>
                    {on && <span className="ai-question-opt-check">✓</span>}
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
      {(quote || autoQuote) && (
        <div className="ai-quote" style={{ margin: '0 12px' }}>
          <span style={{ flex: 1, whiteSpace: 'pre-wrap', maxHeight: 60, overflow: 'auto' }}>
            ❝ {(quote || autoQuote).slice(0, 300)}{(quote || autoQuote).length > 300 ? '…' : ''}
          </span>
          <button
            className="ai-iconbtn"
            type="button"
            onClick={() => {
              if (quote) {
                setQuote('');
                props.onQuoteConsumed?.();
              }
              if (autoQuote) {
                dismissedQuoteRef.current = autoQuote;
                setAutoQuote('');
              }
            }}
            title={t('Remove quote')}
          >
            ×
          </button>
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
            <div style={{ position: 'relative', display: 'inline-flex' }} ref={attachMenuRef}>
              <button
                className="ai-attach"
                onClick={() => setAttachMenuOpen((v) => !v)}
                disabled={agentBusy}
                title={t('Attach')}
                type="button"
              >
                +
              </button>
              {attachMenuOpen && (
                <div
                  className="menu"
                  style={{
                    position: 'absolute',
                    bottom: 'calc(100% + 6px)',
                    left: 0,
                    zIndex: 60,
                    minWidth: 180,
                  }}
                >
                  <button
                    type="button"
                    onClick={() => {
                      setAttachMenuOpen(false);
                      setInput((prev) => (prev ? (prev.endsWith(' ') ? prev + '@' : prev + ' @') : '@'));
                    }}
                  >
                    📄 {t('Mention note (@)')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setAttachMenuOpen(false);
                      fileRef.current?.click();
                    }}
                  >
                    💻 {t('File from computer')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setAttachMenuOpen(false);
                      setWorkspaceModalOpen(true);
                    }}
                  >
                    🗂️ {t('File from workspace')}
                  </button>
                </div>
              )}
            </div>
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
      {workspaceModalOpen && props.pagesById && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 1200,
            background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(2px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          onClick={() => setWorkspaceModalOpen(false)}
        >
          <div
            style={{
              background: 'var(--card)', color: 'var(--card-foreground)',
              border: '1px solid var(--border)', borderRadius: 12,
              boxShadow: '0 16px 48px rgba(0,0,0,0.3)', width: 440, maxWidth: 'calc(100vw - 32px)',
              maxHeight: '80vh', display: 'flex', flexDirection: 'column', overflow: 'hidden',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <strong style={{ fontSize: 14 }}>{t('Attach from workspace')}</strong>
              <button className="ai-iconbtn" onClick={() => setWorkspaceModalOpen(false)} type="button">✕</button>
            </div>
            <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)' }}>
              <input
                autoFocus
                placeholder={t('Search workspace pages…')}
                value={workspaceFilter}
                onChange={(e) => setWorkspaceFilter(e.target.value)}
                style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'inherit', fontSize: 13 }}
              />
            </div>
            <div style={{ overflowY: 'auto', padding: '6px 8px', flex: 1, maxHeight: 320 }}>
              {[...props.pagesById.values()]
                .filter((p) => !p.trashed && (p.title || t('Untitled')).toLowerCase().includes(workspaceFilter.toLowerCase()))
                .slice(0, 30)
                .map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={async () => {
                      setWorkspaceModalOpen(false);
                      setWorkspaceFilter('');
                      try {
                        const text = await api.exportText(p.id);
                        setFiles((prev) => [...prev, { name: p.title || t('Untitled page'), text: text || '' }]);
                      } catch {
                        setFiles((prev) => [...prev, { name: p.title || t('Untitled page'), text: '' }]);
                      }
                    }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                      padding: '8px 12px', border: 'none', background: 'transparent',
                      borderRadius: 6, color: 'inherit', textAlign: 'left', cursor: 'pointer', fontSize: 13,
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover)')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                  >
                    <span>📄</span>
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {p.title || t('Untitled page')}
                    </span>
                  </button>
                ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
