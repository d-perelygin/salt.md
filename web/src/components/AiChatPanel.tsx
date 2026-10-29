import { Fragment, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { t } from '../i18n';
import { useMenuDismiss } from '../modal';
import AiAgentStep, { type AiStep } from './AiAgentStep';
import AiErrorCard from './AiErrorCard';
import AiMarkdown from './AiMarkdown';
import AiApprovalSelect, { useApprovalMode } from './AiApprovalSelect';
import { PageIcon } from '../pageIcon';
import { FileText, Table2 } from 'lucide-react';
import type { AiThread } from './AiThreadList';
import type { PageMeta } from '../types';
import {
  COLLECTION_PRESETS,
  applyCollectionPreset,
  instantiateCollectionTemplate,
  renderTextWithMentions,
} from './aiChatHelpers';

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
  onOpenSidebar?: () => void;
  hidden?: boolean;
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
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [collectionTemplates, setCollectionTemplates] = useState<PageMeta[]>([]);
  const [collectionEmpty, setCollectionEmpty] = useState(false);
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
  useEffect(() => {
    const id = props.threadId;
    if (!id || agentBusy) return;
    let alive = true;
    void api.getAIThreadRuns(id).then((runs: any[]) => {
      if (!alive || !Array.isArray(runs)) return;
      const active = runs.find((r) => r && (r.status === 'running' || r.status === 'queued' || r.status === 'waiting_approval' || r.status === 'waiting_user'));
      if (!active) return;
      setThreadId(id);
      setAgentBusy(true);
      setRunId(active.id);
      setRunStatus(active.status === 'completed' ? '' : (active.progress || active.status || ''));
      setSteps([]);
      setTraceOpen(true);
      void consumeRun(active.id, id, active.task || '').then(() => {
        setAgentBusy(false); setRunId(null); setWaitingApproval(false);
      }).catch(() => {
        setAgentBusy(false); setRunId(null); setWaitingApproval(false);
      });
    }).catch(() => {});
    return () => { alive = false; };
  }, [props.threadId]);
  useEffect(() => { if (props.quote) setQuote(props.quote); }, [props.quote]);
  useEffect(() => {
    api.templates()
      .then((list) => setCollectionTemplates(list.filter((p) => p.type === 'collection' && !p.trashed)))
      .catch(() => {});
  }, [props.pageId]);

  useEffect(() => {
    const pid = props.pageId;
    const isCol = pid && props.pagesById?.get(pid)?.type === 'collection';
    if (!pid || !isCol) {
      setCollectionEmpty(false);
      return;
    }
    let alive = true;
    const checkEmpty = () => {
      void api.collectionRows(pid, { limit: 1 })
        .then((res) => { if (alive) setCollectionEmpty(res.total === 0 && res.rows.length === 0); })
        .catch(() => { if (alive) setCollectionEmpty(false); });
    };
    checkEmpty();
    const onRows = (e: Event) => {
      if ((e as CustomEvent<string>).detail === pid) checkEmpty();
    };
    window.addEventListener('salt:rows', onRows);
    return () => {
      alive = false;
      window.removeEventListener('salt:rows', onRows);
    };
  }, [props.pageId, props.pagesById]);

  function onInputChange(v: string) {
    setInput(v);
    const m = v.match(/@([^@]{0,60})$/);
    setMentionQuery(m ? m[1] : null);
    setMentionIndex(0);
  }

  function mentionMatches(): PageMeta[] {
    if (!props.pagesById) return [];
    const q = (mentionQuery ?? '').toLowerCase();
    const all = [...props.pagesById.values()].filter((p) => !p.trashed);
    return all
      .filter((p) => (p.title || t('Untitled')).toLowerCase().includes(q))
      .slice(0, 8);
  }

  function pickMention(p: PageMeta) {
    const title = p.title || t('Untitled');
    const next = input.replace(/@[^@]{0,60}$/, '@' + title + ' ');
    setInput(next);
    setMentionQuery(null);
    window.setTimeout(() => inputBoxRef.current?.focus(), 0);
  }

  function triggerMentionInInput() {
    const next = input ? (input.endsWith(' ') ? input + '@' : input + ' @') : '@';
    onInputChange(next);
    window.setTimeout(() => {
      const el = inputBoxRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(next.length, next.length);
      }
    }, 0);
  }

  function resolveMentions(text: string): { id: string; title: string }[] {
    const out: { id: string; title: string }[] = [];
    if (!props.pagesById) return out;
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

  // Document selection sync: attach selection as a chip over chat input
  useEffect(() => {
    const onSelection = (e: Event) => {
      const text = ((e as CustomEvent<{ text?: string }>).detail?.text || '').trim();
      // An empty selection is what the document reports whenever focus leaves
      // it or a click lands back in it. The quote must outlive that: it goes
      // only when the user removes the chip or sends the message.
      if (!text) return;
      // A fresh selection shows natively again; the mirrored highlight is stale.
      (window as any).CSS?.highlights?.delete('ai-doc-selection');
      if (text !== dismissedQuoteRef.current) {
        setAutoQuote(text);
      }
    };
    window.addEventListener('salt:editor-selection', onSelection);
    return () => window.removeEventListener('salt:editor-selection', onSelection);
  }, []);

  // Keep the document selection visible while the chat input has focus: the
  // native highlight vanishes once focus leaves the editor, so mirror it with
  // the CSS Custom Highlight API (no-op where unsupported).
  useEffect(() => {
    const css = (window as any).CSS;
    const HL = (window as any).Highlight;
    if (!css?.highlights || !HL) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement | null)?.closest?.('.ai-panel')) return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return;
      const r = sel.getRangeAt(0);
      const host = r.commonAncestorContainer instanceof Element ? r.commonAncestorContainer : r.commonAncestorContainer.parentElement;
      if (host?.closest('.bn-editor')) css.highlights.set('ai-doc-selection', new HL(r.cloneRange()));
    };
    document.addEventListener('mousedown', onDown, true);
    // The mirror lives exactly as long as the quote it belongs to.
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      css.highlights.delete('ai-doc-selection');
    };
  }, []);

  useEffect(() => {
    if (!quote && !autoQuote) (window as any).CSS?.highlights?.delete('ai-doc-selection');
  }, [quote, autoQuote]);

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

  // Keyboard navigation for numbered options 1..9 and Enter to submit
  useEffect(() => {
    if (!pendingQuestion) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName?.toLowerCase();
      if (tag === 'textarea' || tag === 'input' || el?.isContentEditable) return;
      if (e.key === 'Enter' && !e.shiftKey && picked.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        void submitAnswer();
        return;
      }
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
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [pendingQuestion, picked, freeText]);

  const [lastRun, setLastRun] = useState<{ id: string; task: string; status: string; error: string } | null>(null);
  const inputBoxRef = useRef<HTMLTextAreaElement | null>(null);

  async function consumeRun(runId: string, threadId: string, fullTask: string) {
    const res = await fetch(`/api/ai/runs/${runId}/events`, { credentials: 'same-origin' });
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
          if (j.type === 'step' && j.step) {
            const stp = j.step as AiStep;
            if (!seen.has(stp.id)) {
              seen.add(stp.id);
              setSteps((st) => [...st, stp]);
            } else {
              setSteps((st) => st.map((x) => (x.id === stp.id ? stp : x)));
            }
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
                  const key = runId + '|' + q.question;
                  if (qKeyRef.current !== key) {
                    qKeyRef.current = key;
                    setPendingQuestion({ runId, question: q.question, options: q.options.slice(0, 6), multiple: !!q.multiple });
                    setPicked([]);
                    setFreeText('');
                  }
                }
              } catch { /* ignore */ }
            }
            if (j.status === 'completed' || j.status === 'failed' || j.status === 'cancelled') {
              setLastRun({ id: runId, task: fullTask, status: j.status, error: err });
              setPendingQuestion(null);
              break;
            }
          }
        } catch { /* ignore */ }
      }
    }
    const msgs = await api.getAIThreadMessages(threadId).catch(() => [] as Msg[]);
    if (msgs.length) setMessages(msgs as Msg[]);
  }

  async function runAsAgent(reuseTask?: string, isRetry = false) {
    if (agentBusy) return;
    const text = (reuseTask ?? input).trim();
    if (!text) return;
    if (!isRetry) setInput('');
    const id = await ensureThread(text);
    if (!id) return;
    if (!isRetry) setMessages((m) => [...m, { role: 'user', content: text }]);
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
      const refs = resolveMentions(text);
      const refBlock = refs.length
        ? 'Referenced pages (read them with get_page first):\n' + refs.map((m) => `- ${m.title} (id: ${m.id})`).join('\n') + '\n\n'
        : '';
      const activeQ = quote || autoQuote;
      const quoteBlock = activeQ ? `Context quote:\n${activeQ}\n\n` : '';
      const filesBlock = files.length
        ? 'Attached files:\n' + files.filter((f) => f.text).slice(0, 3).map((f) => `--- ${f.name} ---\n${f.text.slice(0, 4000)}`).join('\n') + '\n\n'
        : '';
      const fullTask = isRetry && reuseTask ? reuseTask : (refBlock + quoteBlock + filesBlock + text);
      const r = await api.createAIRun({
        threadId: id,
        task: fullTask,
        prompt: isRetry ? undefined : text,
        retry: isRetry,
        pageId: props.pageId,
      });
      setRunId(r.id);
      setQuote('');
      setAutoQuote('');
      props.onQuoteConsumed?.();
      setFiles([]);
      await consumeRun(r.id, id, fullTask);
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

  async function cancelQuestion() {
    if (!pendingQuestion) return;
    try {
      await api.cancelAIRun(pendingQuestion.runId);
    } catch { /* the run may have timed out or been cancelled */ }
    setPendingQuestion(null);
    setPicked([]);
    setFreeText('');
  }

  const activeThread = (props.threads || []).find((t) => t.id === threadId);
  const currentPage = props.pageId && props.pagesById ? props.pagesById.get(props.pageId) : undefined;
  const isCollectionPage = currentPage?.type === 'collection';
  const showZeroState = messages.length === 0 && !agentBusy && steps.length === 0 && histSteps.length === 0 && !lastError;

  // The trace ("Worked for …") sits ABOVE the answer it produced; while a run
  // streams there is no answer yet, so it stays below the question.
  const traceEl = (steps.length > 0 || histSteps.length > 0) ? (
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
  ) : null;
  const traceAt = !agentBusy && messages.length > 0 && messages[messages.length - 1].role !== 'user' ? messages.length - 1 : messages.length;

  return (
    <div className="ai-panel" style={props.hidden ? { display: 'none' } : undefined}>
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
          {props.onOpenSidebar && (
            <button className="ai-iconbtn ai-panel-sidebarbtn" onClick={props.onOpenSidebar} title={t('Menu')} type="button">☰</button>
          )}
          <button className="ai-iconbtn" onClick={props.onClose} title={t('Close')} type="button">✕</button>
        </div>
      </div>
      <div className="ai-panel-body">
        {showZeroState && (
          <div className="ai-panel-zero">
            {currentPage && (
              <div className="ai-zero-context">
                <span className="ai-zero-context-icon">
                  <PageIcon
                    icon={currentPage.icon}
                    size={15}
                    fallback={isCollectionPage ? <Table2 size={15} /> : <FileText size={15} />}
                  />
                </span>
                <span className="ai-zero-context-title">{currentPage.title || t('Untitled')}</span>
                <span className="ai-zero-context-badge">{isCollectionPage ? t('Collection') : t('Note')}</span>
              </div>
            )}

            <div className="ai-zero-section">{t('Actions')}</div>
            <div className="ai-zero-list">
              {isCollectionPage ? (
                <>
                  <button
                    type="button"
                    className="ai-zero-item"
                    onClick={() => void runAsAgent(t('Summarize the current collection: group items by status and highlight anything overdue or blocked.'))}
                  >
                    <span className="ai-zero-badge">📊</span>
                    <span className="ai-zero-label">{t('Summarize collection')}</span>
                  </button>
                  <button
                    type="button"
                    className="ai-zero-item"
                    onClick={() => void runAsAgent(t('Analyze this collection for patterns, bottlenecks, and actionable insights.'))}
                  >
                    <span className="ai-zero-badge">🔍</span>
                    <span className="ai-zero-label">{t('Analyze for insights')}</span>
                  </button>
                </>
              ) : currentPage ? (
                <>
                  <button
                    type="button"
                    className="ai-zero-item"
                    onClick={() => void runAsAgent(t('Summarize this page concisely with key takeaways.'))}
                  >
                    <span className="ai-zero-badge">📝</span>
                    <span className="ai-zero-label">{t('Summarize this page')}</span>
                  </button>
                  <button
                    type="button"
                    className="ai-zero-item"
                    onClick={() => void runAsAgent(t('Translate this page'))}
                  >
                    <span className="ai-zero-badge">🌐</span>
                    <span className="ai-zero-label">{t('Translate this page')}</span>
                  </button>
                  <button
                    type="button"
                    className="ai-zero-item"
                    onClick={() => void runAsAgent(t('Extract action items and next steps from this page as a checklist.'))}
                  >
                    <span className="ai-zero-badge">✅</span>
                    <span className="ai-zero-label">{t('Extract action items')}</span>
                  </button>
                </>
              ) : null}
              <button
                type="button"
                className="ai-zero-item"
                onClick={() => fileRef.current?.click()}
              >
                <span className="ai-zero-badge">↓</span>
                <span className="ai-zero-label">{t('Attach file or CSV')}</span>
              </button>
            </div>

            {isCollectionPage && collectionEmpty && (
              <>
                <div className="ai-zero-section">{t('Suggested')}</div>
                <div className="ai-zero-list">
                  {COLLECTION_PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      className="ai-zero-item"
                      onClick={() => void applyCollectionPreset(preset, props.pageId)}
                    >
                      <span className="ai-zero-badge" data-tone={preset.tone}>{preset.badge}</span>
                      <span className="ai-zero-label">{preset.label()}</span>
                    </button>
                  ))}
                  {collectionTemplates.map((tpl) => (
                    <button
                      key={tpl.id}
                      type="button"
                      className="ai-zero-item"
                      onClick={() => void instantiateCollectionTemplate(tpl.id)}
                    >
                      <span className="ai-zero-badge">
                        <PageIcon icon={tpl.icon} size={14} fallback={<Table2 size={14} />} />
                      </span>
                      <span className="ai-zero-label">{tpl.title || t('Untitled')}</span>
                    </button>
                  ))}
                </div>
              </>
            )}

            <div className="ai-zero-divider" />
            <div className="ai-zero-list">
              <button
                type="button"
                className="ai-zero-item"
                onClick={triggerMentionInInput}
              >
                <span className="ai-zero-badge" data-tone="plain">↗</span>
                <span className="ai-zero-label">{t('Link workspace page or collection')}</span>
              </button>
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <Fragment key={i}>
          {i === traceAt && traceEl}
          <div className={m.role === 'user' ? 'ai-msg user' : 'ai-msg assistant'}>
            {m.role === 'user' ? (
              <div className="ai-bubble-user">{renderTextWithMentions(m.content, props.pagesById, true)}</div>
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
                        if (lu) void runAsAgent(lu.content, true);
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
          </Fragment>
        ))}
        {traceAt >= messages.length && traceEl}
        {lastError && (
          <AiErrorCard
            error={lastError}
            onRetry={lastRun?.task ? () => void runAsAgent(lastRun.task, true) : undefined}
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
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button className="btn-sm primary" type="button" onClick={() => void submitAnswer()} disabled={picked.length === 0 && !freeText.trim()}>
                {t('Submit answer')}
              </button>
              <button className="btn-sm" type="button" onClick={() => void cancelQuestion()}>
                {t('Cancel')}
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
      <div className="ai-panel-foot" style={{ position: 'relative' }}>
        {mentionQuery !== null && mentionMatches().length > 0 && (
          <div
            className="ai-mention-menu"
            style={{
              position: 'absolute',
              bottom: 'calc(100% - 4px)',
              left: 12,
              right: 12,
              zIndex: 400,
              background: 'var(--card)',
              border: '1px solid var(--border)',
              borderRadius: 10,
              boxShadow: '0 8px 24px rgba(0,0,0,.25)',
              maxHeight: 220,
              overflow: 'auto',
            }}
          >
            {mentionMatches().map((p, idx) => (
              <button
                key={p.id}
                type="button"
                onClick={() => pickMention(p)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  width: '100%',
                  textAlign: 'left',
                  background: idx === mentionIndex ? 'var(--hover)' : 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: 'inherit',
                  padding: '8px 12px',
                  fontSize: 13,
                }}
                onMouseEnter={(e) => { setMentionIndex(idx); e.currentTarget.style.background = 'var(--hover)'; }}
                onMouseLeave={(e) => { if (idx !== mentionIndex) e.currentTarget.style.background = 'transparent'; }}
              >
                <PageIcon
                  icon={p.icon}
                  size={14}
                  fallback={p.type === 'collection' ? <Table2 size={14} /> : <FileText size={14} />}
                />
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {p.title || t('Untitled')}
                </span>
              </button>
            ))}
          </div>
        )}
        <div className="ai-composer">
          <div className="ai-input-wrap">
            {input && (
              <div className="ai-input-backdrop" aria-hidden="true">
                {renderTextWithMentions(input, props.pagesById, false)}
                {input.endsWith('\n') ? '\n ' : ''}
              </div>
            )}
            <textarea
              ref={inputBoxRef}
              className={input ? 'ai-input-mirrored' : undefined}
              value={input}
              rows={2}
              onChange={(e) => {
                onInputChange(e.target.value);
                e.target.style.height = 'auto';
                e.target.style.height = Math.min(e.target.scrollHeight, 140) + 'px';
              }}
              onKeyDown={(e) => {
                if (mentionQuery !== null && mentionMatches().length > 0) {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setMentionIndex((i) => (i + 1) % mentionMatches().length);
                    return;
                  }
                  if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setMentionIndex((i) => (i - 1 + mentionMatches().length) % mentionMatches().length);
                    return;
                  }
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    const m = mentionMatches();
                    if (m[mentionIndex]) pickMention(m[mentionIndex]);
                    return;
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    setMentionQuery(null);
                    return;
                  }
                }
                if (e.key === 'Escape' && mentionQuery !== null) {
                  e.preventDefault();
                  setMentionQuery(null);
                  return;
                }
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  setMentionQuery(null);
                  void runAsAgent();
                }
              }}
              placeholder={showZeroState ? t('Describe what you want to build or ask…') : t('Ask AI')}
              disabled={agentBusy}
            />
          </div>
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
                    top: 'auto',
                    right: 'auto',
                    bottom: 'calc(100% + 6px)',
                    left: 0,
                    zIndex: 400,
                    minWidth: 190,
                  }}
                >
                  <button
                    type="button"
                    onClick={() => {
                      setAttachMenuOpen(false);
                      triggerMentionInInput();
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
        <div style={{ paddingTop: 4 }}>
          <AiApprovalSelect value={approval} onChange={setApproval} />
        </div>
      </div>
    </div>
  );
}
