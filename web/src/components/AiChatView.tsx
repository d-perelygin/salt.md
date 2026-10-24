import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { t } from '../i18n';
import { useMenuDismiss } from '../modal';
import type { PageMeta } from '../types';
import AiAgentStep, { type AiStep } from './AiAgentStep';
import AiErrorCard from './AiErrorCard';
import AiMarkdown from './AiMarkdown';
import AiApprovalSelect, { useApprovalMode } from './AiApprovalSelect';
import type { AiThread } from './AiThreadList';

interface Msg { role: string; content: string }
interface AttachedFile { name: string; text: string }

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// Center chat view (Notion-like): thread header with agent trace,
// artifacts of the runs, and a big rounded input at the bottom.
// The same threads back the sidebar list and the per-document side panel.
export default function AiChatView(props: {
  threadId: string | null;
  pageId?: string;
  pagesById: Map<string, PageMeta>;
  onOpenPage?: (id: string) => void;
  onThreadCreated: (id: string) => void;
  onThreadsChanged: () => void;
}) {
  const [threads, setThreads] = useState<AiThread[]>([]);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [steps, setSteps] = useState<AiStep[]>([]);
  // While a reply or run streams, late history fetches must not clobber the
  // live state (a brand-new thread's fetch resolves with [] mid-stream and
  // would otherwise wipe the user's own just-sent message).
  const streamingRef = useRef(false);
  const [histSteps, setHistSteps] = useState<AiStep[]>([]);
  const [traceOpen, setTraceOpen] = useState(false);
  const [input, setInput] = useState('');
  const [quote, setQuote] = useState('');
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const [agentBusy, setAgentBusy] = useState(false);
  const [runStatus, setRunStatus] = useState('');
  const [runId, setRunId] = useState<string | null>(null);
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [runElapsed, setRunElapsed] = useState(0);
  const [histDurationMs, setHistDurationMs] = useState<number | null>(null);
  const [artifacts, setArtifacts] = useState<string[]>([]);
  const [waitingApproval, setWaitingApproval] = useState(false);
  const [pendingQuestion, setPendingQuestion] = useState<{ runId: string; question: string; options: { label: string; description?: string }[]; multiple: boolean } | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [freeText, setFreeText] = useState('');
  const qKeyRef = useRef('');
  const [approval, setApproval] = useApprovalMode();
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [workspaceModalOpen, setWorkspaceModalOpen] = useState(false);
  const [workspaceFilter, setWorkspaceFilter] = useState('');
  const attachMenuRef = useRef<HTMLDivElement>(null);
  useMenuDismiss(attachMenuOpen, attachMenuRef, () => setAttachMenuOpen(false));
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const tid = props.threadId;

  useEffect(() => {
    api.listAIThreads().then((r) => setThreads(r as AiThread[])).catch(() => {});
  }, [tid]);

  // History: messages, past runs (for the Worked-for row), and artifacts.
  // History fetches never overwrite live streaming state (see streamingRef).
  useEffect(() => {
    if (!tid) { setMessages([]); setSteps([]); setHistSteps([]); setArtifacts([]); setHistDurationMs(null); return; }
    api.getAIThreadMessages(tid).then((r) => { if (!streamingRef.current) setMessages(r as Msg[]); }).catch(() => {});
    api.getAIThreadRuns(tid).then((runs: any[]) => {
      const ids: string[] = [];
      let latest: any = null;
      for (const run of runs) {
        try {
          const arr = JSON.parse(run.artifacts || '[]');
          if (Array.isArray(arr)) for (const id of arr) if (typeof id === 'string' && !ids.includes(id)) ids.push(id);
        } catch { /* ignore */ }
        latest = run;
      }
      setArtifacts(ids);
      if (latest && latest.startedAt && latest.finishedAt && latest.status !== 'running' && latest.status !== 'queued') {
        const ms = Date.parse(latest.finishedAt) - Date.parse(latest.startedAt);
        if (Number.isFinite(ms) && ms >= 0) setHistDurationMs(ms);
        // Show the trace of the latest finished run.
        api.getAIRunSteps(latest.id).then((st) => {
          if (Array.isArray(st) && st.length && !streamingRef.current) {
            setHistSteps(st as AiStep[]);
            setTraceOpen(false);
          }
        }).catch(() => {});
      } else {
        setHistDurationMs(null);
      }
    }).catch(() => {});
  }, [tid]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, steps]);

  // Ticking elapsed time while an agent run is live.
  useEffect(() => {
    if (!agentBusy || runStartedAt === null) return;
    const iv = window.setInterval(() => setRunElapsed(Date.now() - runStartedAt), 1000);
    return () => window.clearInterval(iv);
  }, [agentBusy, runStartedAt]);

  function resolveMentions(text: string): { id: string; title: string }[] {
    const out: { id: string; title: string }[] = [];
    const seen = new Set<string>();
    for (const p of props.pagesById.values()) {
      if (p.trashed || seen.has(p.id)) continue;
      if (text.includes('@' + (p.title || 'Untitled'))) {
        seen.add(p.id);
        out.push({ id: p.id, title: p.title || 'Untitled' });
      }
    }
    return out.slice(0, 8);
  }

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

  function onInputChange(v: string) {
    setInput(v);
    const m = v.match(/@([^@]{0,60})$/);
    setMentionQuery(m ? m[1] : null);
  }

  function mentionMatches(): PageMeta[] {
    const q = (mentionQuery ?? '').toLowerCase();
    const all = [...props.pagesById.values()].filter((p) => !p.trashed && p.id !== props.pageId);
    return all
      .filter((p) => (p.title || 'Untitled').toLowerCase().includes(q))
      .slice(0, 8);
  }

  function pickMention(p: PageMeta) {
    const title = p.title || 'Untitled';
    setInput((cur) => cur.replace(/@[^@]{0,60}$/, '@' + title + ' '));
    setMentionQuery(null);
  }

  function contextTexts(): { name: string; text: string }[] {
    return files.filter((f) => f.text).slice(0, 3).map((f) => ({ name: f.name, text: f.text.slice(0, 4000) }));
  }

  async function ensureThread(text: string): Promise<string | null> {
    if (tid) return tid;
    try {
      const r = await api.createAIThread({ pageId: props.pageId, title: text.slice(0, 40) });
      props.onThreadCreated(r.id);
      return r.id;
    } catch {
      return null;
    }
  }

  function insertIntoPage(markdown: string) {
    window.dispatchEvent(new CustomEvent('salt:ai-insert', {
      detail: { pageId: props.pageId, markdown },
    }));
  }

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
        const id = tid ?? await ensureThread(f.name);
        if (!id) continue;
        const r = (await api.uploadAIAttachment(f, id)) as { status: string; text?: string; fileName?: string };
        if (r.status === 'done' && r.text) setFiles((prev) => [...prev, { name: f.name, text: (r.text as string).slice(0, 6000) }]);
        else setFiles((prev) => [...prev, { name: f.name + ' (unreadable)', text: '' }]);
      } catch {
        /* ignore */
      }
    }
  }

  const [lastRun, setLastRun] = useState<{ id: string; task: string; status: string; error: string } | null>(null);

  // Agent run: the model works with tools and the trace streams in as
  // Thinking/Script steps, OpenChamber-style. May pause for approval.
  // With reuseTask the user message is already in the thread (retry).
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
    setHistDurationMs(null);
    setRunStartedAt(Date.now());
    setRunElapsed(0);
    try {
      const refs = resolveMentions(text);
      const refBlock = refs.length
        ? 'Referenced pages (read them with get_page first):\n' + refs.map((m) => `- ${m.title} (id: ${m.id})`).join('\n') + '\n\n'
        : '';
      const filesBlock = files.length
        ? 'Attached files:\n' + files.filter((f) => f.text).slice(0, 3).map((f) => `--- ${f.name} ---\n${f.text.slice(0, 4000)}`).join('\n') + '\n\n'
        : '';
      const fullTask = refBlock + filesBlock + (quote ? `Context quote:\n${quote}\n\n` : '') + text;
      const r = await api.createAIRun({ threadId: id, task: fullTask, pageId: props.pageId });
      setRunId(r.id);
      setQuote('');
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
      try {
        const done = await api.getAIRun(r.id).catch(() => null) as any;
        if (done && done.startedAt && done.finishedAt) {
          const ms = Date.parse(done.finishedAt) - Date.parse(done.startedAt);
          if (Number.isFinite(ms) && ms >= 0) setHistDurationMs(ms);
        }
        const runs = await api.getAIThreadRuns(id).catch(() => [] as any[]);
        const ids: string[] = [];
        for (const run of runs as any[]) {
          try {
            const arr = JSON.parse(run.artifacts || '[]');
            if (Array.isArray(arr)) for (const pid of arr) if (typeof pid === 'string' && !ids.includes(pid)) ids.push(pid);
          } catch { /* ignore */ }
        }
        setArtifacts(ids);
      } catch { /* ignore */ }
      props.onThreadsChanged();
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

  async function cancelRun() {
    if (!runId) return;
    try {
      await api.cancelAIRun(runId);
    } catch { /* ignore */ }
  }

  const pageTitle = props.pageId ? props.pagesById.get(props.pageId)?.title : '';
  const active = threads.find((x) => x.id === tid);
  // Page-scoped chips only make sense with a page in context; in the global
  // view they would promise something the chat cannot see.
  const chipPageId = props.pageId || active?.pageId || '';
  const showTrace = steps.length > 0 || histSteps.length > 0;
  const liveDuration = agentBusy && runStartedAt !== null ? runElapsed : null;
  const doneDuration = !agentBusy ? histDurationMs : null;

  return (
    <div className="ai-chat-root">
      <div className="ai-chat-main">
        <div className="ai-topbar">
          <span className="ai-avatar">✨</span>
          <span className="ai-crumb">{t('AI')}</span>
          <span className="ai-crumb">/</span>
          <span className="ai-title">{active?.title || t('New chat')}{pageTitle ? ` · 📄 ${pageTitle}` : ''}</span>
        </div>
        <div className="ai-chat-body">
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
          {showTrace && (
            <div style={{ margin: '8px 0' }}>
              <div className="ai-actions-bar">
                <button className="ai-actions-toggle" onClick={() => setTraceOpen((v) => !v)} type="button">
                  <span style={{ fontSize: 10 }}>{traceOpen ? '▼' : '▶'}</span>
                  <span>
                    {liveDuration !== null
                      ? `${t('Working for')} ${formatDuration(liveDuration)} … (${steps.length})`
                      : doneDuration !== null
                        ? `${t('Worked for')} ${formatDuration(doneDuration)} (${steps.length > 0 ? steps.length : histSteps.length} ${t('steps')})`
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
          {artifacts.length > 0 && (
            <div className="ai-artifacts-inline">
              <div className="ai-artifacts-inline-title">{t('Artifacts')}</div>
              <div className="ai-artifacts-inline-row">
                {artifacts.map((id) => {
                  const title = props.pagesById.get(id)?.title || t('Untitled page');
                  return (
                    <button key={id} className="ai-artifact-chip" onClick={() => props.onOpenPage?.(id)} title={title}>
                      <span>📄</span>
                      <span>{title}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
        {quote && (
          <div className="ai-quote">
            <span style={{ flex: 1, whiteSpace: 'pre-wrap', maxHeight: 80, overflow: 'auto' }}>❝ {quote}</span>
            <button className="ai-iconbtn" onClick={() => setQuote('')} title={t('Remove quote')}>×</button>
          </div>
        )}
        {files.length > 0 && (
          <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
            {files.map((f, i) => (
              <span key={i} className="ai-filechip">
                📎 {f.name}{!f.text ? ` (${t('unreadable')})` : ''}
                {' '}<button className="ai-iconbtn" onClick={() => setFiles((p) => p.filter((_, j) => j !== i))} title={t('Remove')}>×</button>
              </span>
            ))}
          </div>
        )}
        <div style={{ position: 'relative' }}>
          {mentionQuery !== null && mentionMatches().length > 0 && (
            <div style={{
              position: 'absolute', bottom: 'calc(100% + 6px)', left: 0, zIndex: 50,
              background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 10,
              boxShadow: '0 8px 24px rgba(0,0,0,.25)', maxHeight: 220, overflow: 'auto', minWidth: 260,
            }}>
              {mentionMatches().map((p) => (
                <button
                  key={p.id}
                  onClick={() => pickMention(p)}
                  style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', padding: '8px 12px', fontSize: 14 }}
                >
                  📄 {p.title || t('Untitled')}
                </button>
              ))}
            </div>
          )}
          <div className="ai-composer">
            <textarea
              value={input}
              rows={2}
              onChange={(e) => {
                onInputChange(e.target.value);
                e.target.style.height = 'auto';
                e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px';
              }}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void runAsAgent(); } }}
              placeholder={t('Ask, search, or make anything…')}
              disabled={agentBusy}
            />
            <div className="ai-composer-bar">
              <div style={{ position: 'relative', display: 'inline-flex' }} ref={attachMenuRef}>
                <button
                  className="ai-attach"
                  onClick={() => setAttachMenuOpen((v) => !v)}
                  title={t('Attach')}
                  disabled={agentBusy}
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
                      minWidth: 200,
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setAttachMenuOpen(false);
                        const next = input ? (input.endsWith(' ') ? input + '@' : input + ' @') : '@';
                        setInput(next);
                        onInputChange(next);
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
              <AiApprovalSelect value={approval} onChange={setApproval} />
              <span className="spacer" />
              <button className="ai-send" onClick={() => void runAsAgent()} disabled={agentBusy} title={t('Send')}>{agentBusy ? '…' : '↑'}</button>
              {agentBusy && runId && (
                <button className="ai-iconbtn" onClick={() => { void api.cancelAIRun(runId).catch(() => {}); }} title={t('Cancel')}>
                  ■
                </button>
              )}
            </div>
          </div>
        </div>
        {workspaceModalOpen && (
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
                boxShadow: '0 16px 48px rgba(0,0,0,0.3)', width: 480, maxWidth: 'calc(100vw - 32px)',
                maxHeight: '80vh', display: 'flex', flexDirection: 'column', overflow: 'hidden',
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <strong style={{ fontSize: 15 }}>{t('Attach from workspace')}</strong>
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
              <div style={{ overflowY: 'auto', padding: '6px 8px', flex: 1, maxHeight: 360 }}>
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
                        borderRadius: 6, color: 'inherit', textAlign: 'left', cursor: 'pointer', fontSize: 14,
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
        {chipPageId !== '' && (
          <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            {[t('Summarize this page'), t('Translate this page'), t('Analyze for insights')].map((s) => (
              <button key={s} className="ai-approval-pill" disabled={agentBusy}
                onClick={() => { setInput(s); }}>
                {s}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
