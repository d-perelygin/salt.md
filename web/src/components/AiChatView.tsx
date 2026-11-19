import { Fragment, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { t } from '../i18n';
import { useMenuDismiss } from '../modal';
import type { PageMeta } from '../types';
import AiAgentStep, { type AiStep } from './AiAgentStep';
import AiRunSummary from './AiRunSummary';
import AiErrorCard from './AiErrorCard';
import AiMarkdown from './AiMarkdown';
import AiApprovalSelect, { useApprovalMode } from './AiApprovalSelect';
import { PageIcon } from '../pageIcon';
import { FileText, Table2, ArrowDown, ArrowUpRight, BarChart3, Brain, Check, ChevronDown, ChevronRight, CircleHelp, Copy, Globe, Paperclip, Quote, RefreshCw, Search, Sparkles, SquareCheck, Upload, X } from 'lucide-react';
import type { AiThread } from './AiThreadList';
import { renderTextWithMentions } from './aiChatHelpers';

interface Msg { role: string; content: string; createdAt?: string }
interface AttachedFile { name: string; text: string }
interface MemoryEntry { id: string; workspaceId: string; content: string; createdAt: string; updatedAt: string }

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
  const [runList, setRunList] = useState<any[]>([]);
  const [traceOpen, setTraceOpen] = useState(false);
  const [input, setInput] = useState('');
  const [quote, setQuote] = useState('');
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const [agentBusy, setAgentBusy] = useState(false);
  const [runStatus, setRunStatus] = useState('');
  const [runId, setRunId] = useState<string | null>(null);
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [runElapsed, setRunElapsed] = useState(0);
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
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [memories, setMemories] = useState<MemoryEntry[] | null>(null);
  const [memDraft, setMemDraft] = useState('');
  const [memWorkspaceOnly, setMemWorkspaceOnly] = useState(true);
  const memMenuRef = useRef<HTMLSpanElement>(null);
  useMenuDismiss(memoryOpen, memMenuRef, () => setMemoryOpen(false));
  const attachMenuRef = useRef<HTMLDivElement>(null);
  useMenuDismiss(attachMenuOpen, attachMenuRef, () => setAttachMenuOpen(false));
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const inputBoxRef = useRef<HTMLTextAreaElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const syncBackdrop = () => {
    const ta = inputBoxRef.current;
    const bd = backdropRef.current;
    if (ta && bd) { bd.scrollTop = ta.scrollTop; bd.scrollLeft = ta.scrollLeft; }
  };

  const tid = props.threadId;
  const tidRef = useRef<string | null>(tid);
  useEffect(() => { tidRef.current = tid; }, [tid]);
  // Thread the live run belongs to. Switching threads detaches the UI from a
  // run that belongs elsewhere (it keeps going server-side); switching back
  // re-attaches through the effect below.
  const runThreadRef = useRef<string | null>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);

  useEffect(() => {
    api.listAIThreads().then((r) => setThreads(r as AiThread[])).catch(() => {});
  }, [tid]);

  // History: messages, past runs (for the Worked-for row), and artifacts.
  // History fetches never overwrite live streaming state (see streamingRef),
  // and late answers never land on a thread that is no longer selected.
  useEffect(() => {
    // Detach from a run that belongs to another thread: it keeps going
    // server-side, the UI just stops following it.
    if (streamingRef.current && runThreadRef.current !== tid) {
      streamingRef.current = false;
      // runThreadRef stays: the run is still live, just not followed here.
      try { readerRef.current?.cancel(); } catch { /* already closed */ }
      readerRef.current = null;
      setAgentBusy(false);
      setRunId(null);
      setWaitingApproval(false);
      setSteps([]);
      setRunStatus('');
      setPendingQuestion(null);
    }
    if (!tid) {
      setMessages([]);
      setSteps([]);
      setArtifacts([]);
      setRunList([]);
      setLastError(null);
      setLastRun(null);
      return;
    }
    // Reset per-thread UI at once: the previous thread must not flash through
    // while its replacement loads.
    setSteps([]);
    setRunList([]);
    setLastError(null);
    setLastRun(null);
    let alive = true;
    Promise.all([
      api.getAIThreadMessages(tid).catch(() => [] as Msg[]),
      api.getAIThreadRuns(tid).catch(() => [] as any[]),
    ]).then(([rawMsgs, runs]) => {
      if (!alive || tidRef.current !== tid) return;
      if (streamingRef.current && runThreadRef.current === tid) return;
      const msgs = [...rawMsgs];
      setRunList(Array.isArray(runs) ? (runs as any[]) : []);
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
      if (latest && latest.status === 'failed') {
        if (msgs.length === 0 || msgs[msgs.length - 1].role !== 'user') {
          msgs.push({ role: 'user', content: latest.task });
        }
        setLastError(latest.error || t('Agent run failed'));
        setLastRun({ id: latest.id, task: latest.task, status: latest.status, error: latest.error || '' });
      } else {
        setLastError(null);
        setLastRun(null);
      }
      setMessages(msgs);
    }).catch(() => {});
    return () => { alive = false; };
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

  // Composer draft survives unmounts (Chat/Home switch) and thread
  // switches: one draft per thread, restored when coming back.
  const draftKey = (t: string | null) => 'salt-ai-draft:v:' + (t ?? 'new');
  useEffect(() => {
    try {
      setInput(localStorage.getItem(draftKey(tid)) ?? '');
    } catch { setInput(''); }
    setMentionQuery(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tid]);
  function clearDraft() {
    try { localStorage.removeItem(draftKey(tidRef.current)); } catch { /* ignore */ }
  }

  function onInputChange(v: string) {
    setInput(v);
    try { localStorage.setItem(draftKey(tidRef.current), v); } catch { /* ignore */ }
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
  // Consume one run's SSE stream into this thread's UI. Belongs to
  // myTid: if the user switches threads mid-run the loop stops and the
  // re-attach effect below picks the run up on return.
  async function consumeRun(runId: string, myTid: string, fullTask: string) {
    const res = await fetch(`/api/ai/runs/${runId}/events`, { credentials: 'same-origin' });
    if (!res.ok || !res.body) throw new Error('no events');
    const reader = res.body.getReader();
    readerRef.current = reader;
    try {
      const dec = new TextDecoder();
      let buf = '';
      const seen = new Set<string>();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (tidRef.current !== myTid) {
          try { reader.cancel(); } catch { /* already closed */ }
          return;
        }
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          try {
            const j = JSON.parse(line.slice(5).trim());
            if (j.type === 'step' && j.step) {
              const st = j.step as AiStep;
              if (!seen.has(st.id)) {
                seen.add(st.id);
                setSteps((s) => [...s, st]);
              } else {
                setSteps((s) => s.map((x) => (x.id === st.id ? st : x)));
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
    } finally {
      try { reader.releaseLock(); } catch { /* already closed */ }
      if (readerRef.current === reader) readerRef.current = null;
    }
  }

  async function runAsAgent(reuseTask?: string) {
    if (agentBusy) return;
    const text = (reuseTask ?? input).trim();
    if (!text) return;
    if (!reuseTask) { setInput(''); clearDraft(); }
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
    runThreadRef.current = id;
    setAgentBusy(true);
    setRunStatus(t('Working…'));
    setWaitingApproval(false);
    setSteps([]);
    setTraceOpen(true);
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
      const fullTask = reuseTask ? reuseTask : (refBlock + filesBlock + (quote ? `Context quote:\n${quote}\n\n` : '') + text);
      const r = await api.createAIRun({
        threadId: id,
        task: fullTask,
        prompt: reuseTask ? undefined : text,
        retry: !!reuseTask,
        pageId: props.pageId,
      });
      setRunId(r.id);
      setQuote('');
      setFiles([]);
      await consumeRun(r.id, id, fullTask);
      // The thread may have changed while the run streamed: only the thread
      // the run belongs to takes its results.
      if (tidRef.current === id) {
        const msgs = await api.getAIThreadMessages(id).catch(() => [] as Msg[]);
        if (msgs.length) setMessages(msgs as Msg[]);
        // Fresh threads still carry their first-message slice as a title;
        // upgrade it from the conversation once, never over a rename.
        void api.autoThreadTitle(id, false).then((r) => {
          if (tidRef.current === id && r && (r as any).generated) props.onThreadsChanged();
        }).catch(() => {});
        try {
          const runs = await api.getAIThreadRuns(id).catch(() => [] as any[]);
          if (Array.isArray(runs)) setRunList(runs as any[]);
          const ids: string[] = [];
          for (const run of runs as any[]) {
            try {
              const arr = JSON.parse(run.artifacts || '[]');
              if (Array.isArray(arr)) for (const pid of arr) if (typeof pid === 'string' && !ids.includes(pid)) ids.push(pid);
            } catch { /* ignore */ }
          }
          setArtifacts(ids);
        } catch { /* ignore */ }
      }
      props.onThreadsChanged();
    } catch (err: any) {
      setLastError(err?.message || t('Run failed'));
      setRunStatus(t('Run failed'));
    } finally {
      // Another thread's run finishing must not clear this thread's UI.
      if (runThreadRef.current === id) {
        runThreadRef.current = null;
        streamingRef.current = false;
        setAgentBusy(false);
        setRunId(null);
        setWaitingApproval(false);
      }
    }
  }

  // Coming back to a thread whose run is still going re-attaches the UI to
  // it; otherwise the thread would sit silent until the run ends.
  useEffect(() => {
    if (!tid || streamingRef.current) return;
    let alive = true;
    void api.getAIThreadRuns(tid).catch(() => [] as any[]).then((runs) => {
      if (!alive || !Array.isArray(runs) || tidRef.current !== tid) return;
      const active = (runs as any[]).find((r) => r && (r.status === 'running' || r.status === 'queued' || r.status === 'waiting_approval' || r.status === 'waiting_user'));
      if (!active || streamingRef.current) return;
      streamingRef.current = true;
      runThreadRef.current = tid;
      setAgentBusy(true);
      setRunId(active.id);
      try {
        const ms = Date.parse(active.startedAt);
        setRunStartedAt(Number.isFinite(ms) ? ms : Date.now());
      } catch { setRunStartedAt(Date.now()); }
      setRunElapsed(0);
      setRunStatus(active.progress || active.status || '');
      setSteps([]);
      setTraceOpen(true);
      void consumeRun(active.id, tid, active.task || '').then(async () => {
        if (tidRef.current !== tid) return;
        setAgentBusy(false);
        setRunId(null);
        setWaitingApproval(false);
        const msgs = await api.getAIThreadMessages(tid).catch(() => [] as Msg[]);
        if (tidRef.current !== tid) return;
        if (msgs.length) setMessages(msgs as Msg[]);
        const rs = await api.getAIThreadRuns(tid).catch(() => [] as any[]);
        if (tidRef.current !== tid) return;
        if (Array.isArray(rs)) setRunList(rs as any[]);
        props.onThreadsChanged();
      }).catch(() => {
        if (tidRef.current !== tid) return;
        setAgentBusy(false);
        setRunId(null);
        setWaitingApproval(false);
      });
    }).catch(() => {});
    return () => { alive = false; };
  }, [tid]);

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
  const memWorkspaceId = props.pageId ? props.pagesById.get(props.pageId)?.workspaceId ?? '' : '';

  // Agent memory: durable notes the agent keeps about the user. Global notes
  // always apply; workspace notes apply to the current page's workspace.
  async function loadMemories() {
    try {
      const r = (await api.listAIMemory()) as MemoryEntry[];
      setMemories(Array.isArray(r) ? r : []);
    } catch {
      setMemories([]);
    }
  }
  async function addMemory() {
    const text = memDraft.trim();
    if (!text) return;
    try {
      const ws = memWorkspaceId && memWorkspaceOnly ? memWorkspaceId : '';
      await api.addAIMemory(text, ws);
      setMemDraft('');
      await loadMemories();
    } catch { /* keep the draft */ }
  }
  async function forgetMemory(id: string) {
    try {
      await api.deleteAIMemory(id);
      setMemories((prev) => (prev ?? []).filter((m) => m.id !== id));
    } catch { /* keep it */ }
  }
  const showTrace = steps.length > 0;
  const showZeroState = messages.length === 0 && !agentBusy && steps.length === 0 && !lastError;
  const liveDuration = agentBusy && runStartedAt !== null ? runElapsed : null;

  // Finished runs attach above the answer they produced: the first assistant
  // message created at or after the run finished; stragglers go last.
  const runTargets = new Map<number, any[]>();
  {
    const done = runList.filter(
      (r) => r && r.finishedAt && (r.status === 'completed' || r.status === 'failed' || r.status === 'cancelled'),
    );
    const order = [...done].sort((a, b) => Date.parse(a.finishedAt) - Date.parse(b.finishedAt));
    const used = new Set<number>();
    for (const r of order) {
      const end = Date.parse(r.finishedAt);
      let at = messages.findIndex(
        (m, i) =>
          m.role === 'assistant' && !used.has(i) && m.createdAt && Date.parse(m.createdAt) >= end,
      );
      if (at < 0) at = messages.length;
      else used.add(at);
      const list = runTargets.get(at) ?? [];
      list.push(r);
      runTargets.set(at, list);
    }
  }

  // The live trace sits ABOVE the answer it will produce; while a run streams
  // there is no answer yet, so it stays below the question. Finished runs
  // render through their own per-message rows above.
  const traceEl = showTrace ? (
            <div style={{ margin: '8px 0' }}>
              <div className="ai-actions-bar">
                <button className="ai-actions-toggle" onClick={() => setTraceOpen((v) => !v)} type="button">
                  <span style={{ display: 'inline-flex' }}>{traceOpen ? <ChevronDown size={10} /> : <ChevronRight size={10} />}</span>
                  <span>
                    {liveDuration !== null
                      ? `${t('Working for')} ${formatDuration(liveDuration)} … (${steps.length})`
                      : `${t('Agent actions')} (${steps.length})`}
                  </span>
                </button>
              </div>
              {traceOpen && (
                <div className="ai-actions-list">
                  {steps.map((s) => <AiAgentStep key={s.id} step={s} />)}
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
    <div className="ai-chat-root">
      <div className="ai-chat-main">
        <div className="ai-topbar">
          <span className="ai-avatar"><Sparkles size={16} /></span>
          <span className="ai-crumb">{t('AI')}</span>
          <span className="ai-crumb">/</span>
          <span className="ai-title">{active?.title || t('New chat')}{pageTitle ? ` · ${pageTitle}` : ''}</span>
          <span style={{ flex: 1 }} />
          <span style={{ position: 'relative', display: 'inline-flex' }} ref={memMenuRef}>
            <button
              className="ai-iconbtn"
              title={t('Memory')}
              type="button"
              onClick={() => {
                const next = !memoryOpen;
                setMemoryOpen(next);
                if (next && memories === null) void loadMemories();
              }}
            >
              <Brain size={15} />
            </button>
            {memoryOpen && (
              <div
                style={{
                  position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 400,
                  background: 'var(--card)', color: 'var(--fg)',
                  border: '1px solid var(--border)', borderRadius: 10,
                  boxShadow: '0 8px 24px rgba(0,0,0,.25)', width: 320, maxWidth: '80vw',
                  maxHeight: 320, overflow: 'auto', padding: 10,
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>{t('Memory')}</div>
                {memories === null ? (
                  <div className="dialog-hint">{t('Loading…')}</div>
                ) : memories.length === 0 ? (
                  <div className="dialog-hint" style={{ marginBottom: 8 }}>{t('Nothing memorized yet.')}</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
                    {memories.map((m) => (
                      <div key={m.id} style={{ fontSize: 13, display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                        <span style={{ flex: 1, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{m.content}</span>
                        <button className="ai-iconbtn" type="button" title={t('Forget')} onClick={() => void forgetMemory(m.id)}>
                          <X size={13} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 6 }}>
                  <input
                    className="prop-input"
                    style={{ flex: 1, minWidth: 0 }}
                    value={memDraft}
                    onChange={(e) => setMemDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        void addMemory();
                      }
                    }}
                    placeholder={t('Remember this…')}
                  />
                  <button className="btn-sm primary" type="button" disabled={!memDraft.trim()} onClick={() => void addMemory()}>
                    {t('Remember')}
                  </button>
                </div>
                {memWorkspaceId && (
                  <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
                    <input type="checkbox" checked={memWorkspaceOnly} onChange={(e) => setMemWorkspaceOnly(e.target.checked)} />
                    {t('This workspace only')}
                  </label>
                )}
              </div>
            )}
          </span>
        </div>
        <div className="ai-chat-body">
          {showZeroState && (
            <div className="ai-view-zero">
              <div className="ai-view-zero-hero">
                <span className="ai-view-zero-spark"><Sparkles size={26} /></span>
                <h2>{t('How can I help you today?')}</h2>
              </div>

              <div className="ai-zero-section">{t('Actions')}</div>
              <div className="ai-view-zero-grid">
                <button
                  type="button"
                  className="ai-zero-item"
                  onClick={() => {
                    if (chipPageId) {
                      void runAsAgent(t('Summarize this page concisely with key takeaways.'));
                    } else {
                      const next = t('Summarize') + ' @';
                      onInputChange(next);
                      window.setTimeout(() => inputBoxRef.current?.focus(), 0);
                    }
                  }}
                >
                  <span className="ai-zero-badge"><FileText size={15} /></span>
                  <span className="ai-zero-label">{t('Summarize this page')}</span>
                </button>
                <button
                  type="button"
                  className="ai-zero-item"
                  onClick={() => {
                    if (chipPageId) {
                      void runAsAgent(t('Translate this page'));
                    } else {
                      const next = t('Translate') + ' @';
                      onInputChange(next);
                      window.setTimeout(() => inputBoxRef.current?.focus(), 0);
                    }
                  }}
                >
                  <span className="ai-zero-badge"><Globe size={15} /></span>
                  <span className="ai-zero-label">{t('Translate this page')}</span>
                </button>
                <button
                  type="button"
                  className="ai-zero-item"
                  onClick={() => {
                    if (chipPageId) {
                      void runAsAgent(t('Analyze for insights'));
                    } else {
                      const next = t('Analyze for insights') + ' @';
                      onInputChange(next);
                      window.setTimeout(() => inputBoxRef.current?.focus(), 0);
                    }
                  }}
                >
                  <span className="ai-zero-badge"><BarChart3 size={15} /></span>
                  <span className="ai-zero-label">{t('Analyze for insights')}</span>
                </button>
                <button
                  type="button"
                  className="ai-zero-item"
                  onClick={() => {
                    if (chipPageId) {
                      void runAsAgent(t('Extract action items and next steps from this page as a checklist.'));
                    } else {
                      const next = t('Extract action items') + ' @';
                      onInputChange(next);
                      window.setTimeout(() => inputBoxRef.current?.focus(), 0);
                    }
                  }}
                >
                  <span className="ai-zero-badge"><SquareCheck size={15} /></span>
                  <span className="ai-zero-label">{t('Extract action items')}</span>
                </button>
                <button
                  type="button"
                  className="ai-zero-item"
                  onClick={() => fileRef.current?.click()}
                >
                  <span className="ai-zero-badge"><ArrowDown size={15} /></span>
                  <span className="ai-zero-label">{t('Attach file or CSV')}</span>
                </button>
                <button
                  type="button"
                  className="ai-zero-item"
                  onClick={triggerMentionInInput}
                >
                  <span className="ai-zero-badge" data-tone="plain"><ArrowUpRight size={15} /></span>
                  <span className="ai-zero-label">{t('Link workspace page or collection')}</span>
                </button>
              </div>
            </div>
          )}
          {messages.map((m, i) => (
            <Fragment key={i}>
            {i === traceAt && traceEl}
            {(runTargets.get(i) ?? []).map((r) => (
              <AiRunSummary key={r.id} run={r} />
            ))}
            <div className={m.role === 'user' ? 'ai-msg user' : 'ai-msg assistant'}>
              {m.role === 'user' ? (
                <div className="ai-bubble-user">{renderTextWithMentions(m.content, props.pagesById, true)}</div>
              ) : (
                <div className="ai-bubble-ai">
                  <AiMarkdown text={m.content} />
                  {m.content && (
                    <div className="ai-msg-actions">
                      <button className="ai-iconbtn" onClick={() => copyText(m.content, i)} title={t('Copy')}>
                        {copiedIdx === i ? <Check size={14} /> : <Copy size={14} />}
                      </button>
                      {i === messages.length - 1 && (
                        <button className="ai-iconbtn" onClick={() => {
                          const lu = [...messages].reverse().find((x) => x.role === 'user');
                          if (lu) void runAsAgent(lu.content);
                        }} disabled={agentBusy} title={t('Regenerate')}>
                          <RefreshCw size={14} />
                        </button>
                      )}
                      {props.pageId && (
                        <button className="ai-iconbtn" onClick={() => insertIntoPage(m.content)} title={t('Insert into page')}>
                          <ArrowDown size={14} />
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
          {(runTargets.get(messages.length) ?? []).map((r) => (
            <AiRunSummary key={r.id} run={r} />
          ))}
          {lastError && (
            <AiErrorCard
              error={lastError}
              onRetry={lastRun?.task ? () => void runAsAgent(lastRun.task) : undefined}
              onDismiss={() => setLastError(null)}
            />
          )}
          {pendingQuestion && (
            <div className="ai-question-card">
              <div className="ai-question-title"><span><CircleHelp size={15} /></span><span>{pendingQuestion.question}</span></div>
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
                      {on && <span className="ai-question-opt-check"><Check size={13} /></span>}
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
          {artifacts.length > 0 && (
            <div className="ai-artifacts-inline">
              <div className="ai-artifacts-inline-title">{t('Artifacts')}</div>
              <div className="ai-artifacts-inline-row">
                {artifacts.map((id) => {
                  const title = props.pagesById.get(id)?.title || t('Untitled page');
                  return (
                    <button key={id} className="ai-artifact-chip" onClick={() => props.onOpenPage?.(id)} title={title}>
                      <span><FileText size={14} /></span>
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
            <span style={{ flex: 1, whiteSpace: 'pre-wrap', maxHeight: 80, overflow: 'auto' }}><Quote size={13} /> {quote}</span>
            <button className="ai-iconbtn" onClick={() => setQuote('')} title={t('Remove quote')}><X size={13} /></button>
          </div>
        )}
        {files.length > 0 && (
          <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
            {files.map((f, i) => (
              <span key={i} className="ai-filechip">
                <Paperclip size={13} /> {f.name}{!f.text ? ` (${t('unreadable')})` : ''}
                {' '}<button className="ai-iconbtn" onClick={() => setFiles((p) => p.filter((_, j) => j !== i))} title={t('Remove')}><X size={13} /></button>
              </span>
            ))}
          </div>
        )}
        <div style={{ position: 'relative' }}>
          {mentionQuery !== null && mentionMatches().length > 0 && (
            <div style={{
              position: 'absolute', bottom: 'calc(100% + 6px)', left: 0, zIndex: 400,
              background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 10,
              boxShadow: '0 8px 24px rgba(0,0,0,.25)', maxHeight: 220, overflow: 'auto', minWidth: 260,
            }}>
              {mentionMatches().map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => pickMention(p)}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', padding: '8px 12px', fontSize: 14 }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
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
                <div className="ai-input-backdrop" aria-hidden="true" ref={backdropRef}>
                  {input.length > 20000 ? input : renderTextWithMentions(input, props.pagesById, false)}
                  {input.endsWith('\n') ? '\n ' : ''}
                </div>
              )}
              <textarea
                ref={inputBoxRef}
                className={input ? 'ai-input-mirrored' : undefined}
                value={input}
                rows={2}
                onScroll={syncBackdrop}
                onChange={(e) => {
                  onInputChange(e.target.value);
                  e.target.style.height = 'auto';
                  e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px';
                  syncBackdrop();
                }}
                onKeyDown={(e) => {
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
                placeholder={t('Ask, search, or make anything…')}
                disabled={agentBusy}
              />
            </div>
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
                      top: 'auto',
                      right: 'auto',
                      bottom: 'calc(100% + 6px)',
                      left: 0,
                      zIndex: 400,
                      minWidth: 200,
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setAttachMenuOpen(false);
                        triggerMentionInInput();
                      }}
                    >
                      <FileText size={14} /> {t('Mention note (@)')}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setAttachMenuOpen(false);
                        fileRef.current?.click();
                      }}
                    >
                      <Upload size={14} /> {t('File from computer')}
                    </button>
                  </div>
                )}
              </div>
              <input ref={fileRef} type="file" multiple accept=".txt,.md,.csv,.json,.pdf,.docx,.xlsx,.pptx,.odt" style={{ display: 'none' }} onChange={(e) => void attachPicked(e)} />
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
        {/* quick-prompt chips removed */}
      </div>
    </div>
  );
}
