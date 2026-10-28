import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { t } from '../i18n';

interface Anchor {
  blockId: string;
  top: number;
  left: number;
  width: number;
}

// "Press space for AI" on an empty line. The panel is a one-shot: whatever the
// model writes replaces the panel's own line in the document, and nothing is
// stored as a chat. Editing the result afterwards is the side chat's job.
export default function AiEmptyLine(props: { editor: any; pageId: string; canEdit: boolean }) {
  const { editor, pageId, canEdit } = props;
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [prompt, setPrompt] = useState('');
  const [sent, setSent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  function place(blockId: string): Anchor | null {
    const el = editor.prosemirrorView?.dom?.querySelector(`[data-id="${blockId}"]`) as HTMLElement | null;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { blockId, top: r.top, left: r.left, width: r.width };
  }

  function close() {
    abortRef.current?.abort();
    setAnchor(null);
    setPrompt('');
    setSent('');
    setError('');
    setBusy(false);
    try {
      editor.focus();
    } catch {
      /* editor gone */
    }
  }

  // Space on an empty paragraph opens the panel instead of typing a blank.
  useEffect(() => {
    if (!canEdit) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== ' ' || e.isComposing || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      const dom: HTMLElement | undefined = editor.prosemirrorView?.dom;
      if (!dom || !dom.contains(e.target as Node)) return;
      try {
        if (!editor.prosemirrorView.state.selection.empty) return;
        const block = editor.getTextCursorPosition().block;
        if (!block || block.type !== 'paragraph') return;
        const content = (block.content ?? []) as { type: string; text?: string }[];
        if (!content.every((c) => c.type === 'text' && !c.text)) return;
        const a = place(block.id);
        if (!a) return;
        e.preventDefault();
        e.stopPropagation();
        setAnchor(a);
      } catch {
        /* not a text cursor: leave the space alone */
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, canEdit]);

  // The panel is fixed-positioned over its line, so it follows scroll/resize.
  useEffect(() => {
    if (!anchor) return;
    const id = anchor.blockId;
    const follow = () => {
      const a = place(id);
      if (a) setAnchor(a);
    };
    window.addEventListener('scroll', follow, true);
    window.addEventListener('resize', follow);
    return () => {
      window.removeEventListener('scroll', follow, true);
      window.removeEventListener('resize', follow);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor?.blockId]);

  useEffect(() => {
    if (anchor && !busy) inputRef.current?.focus();
  }, [anchor?.blockId, busy]);

  // A click anywhere else puts the panel away, unless it is mid-write.
  useEffect(() => {
    if (!anchor) return;
    const onDown = (e: MouseEvent) => {
      if (busy || wrapRef.current?.contains(e.target as Node)) return;
      close();
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor?.blockId, busy]);

  useEffect(() => () => abortRef.current?.abort(), []);

  async function send() {
    const text = prompt.trim();
    if (!text || busy || !anchor) return;
    const blockId = anchor.blockId;
    const ac = new AbortController();
    abortRef.current = ac;
    setSent(text);
    setError('');
    setBusy(true);
    try {
      const res = await api.generateAI(
        {
          prompt: `Write a note for this request. Use Markdown (headings, lists) where it helps.\n\n${text}`,
          pageId,
          includePage: true,
        },
        ac.signal,
      );
      if (!res.ok || !res.body) {
        let msg = '';
        try {
          const j = JSON.parse(await res.text());
          msg = typeof j?.error === 'string' ? j.error : '';
        } catch {
          /* not JSON */
        }
        throw new Error(msg || t('AI could not write the note'));
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let acc = '';
      let failed = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          try {
            const j = JSON.parse(data);
            if (j.type === 'delta') acc += j.content;
            else if (j.type === 'error') failed = String(j.error || j.message || '');
          } catch {
            /* ignore a partial line */
          }
        }
      }
      if (!acc.trim()) throw new Error(failed || t('AI could not write the note'));
      const blocks = await editor.tryParseMarkdownToBlocks(acc);
      if (!blocks.length) throw new Error(t('AI could not write the note'));
      if (editor.getBlock(blockId)) editor.replaceBlocks([blockId], blocks as never);
      else editor.insertBlocks(blocks as never, editor.document[editor.document.length - 1], 'after');
      setAnchor(null);
      setPrompt('');
      setSent('');
      setBusy(false);
      try {
        editor.focus();
      } catch {
        /* editor gone */
      }
    } catch (err) {
      if (ac.signal.aborted) {
        setBusy(false);
        return;
      }
      setError(err instanceof Error ? err.message : t('AI could not write the note'));
      setBusy(false);
    }
  }

  if (!anchor) return null;
  return (
    <div
      ref={wrapRef}
      className="ai-empty"
      style={{ top: anchor.top - 6, left: anchor.left - 8, width: anchor.width + 16 }}
      contentEditable={false}
    >
      <span className="ai-empty-spark">✨</span>
      {busy ? (
        <>
          <span className="ai-empty-sent">{sent}</span>
          <span className="ai-empty-status">{t('Writing…')}</span>
          <button type="button" className="ai-empty-stop" onClick={() => abortRef.current?.abort()} title={t('Stop')}>
            ■
          </button>
        </>
      ) : (
        <>
          <input
            ref={inputRef}
            className="ai-empty-input"
            value={prompt}
            placeholder={t('Describe the note to write…')}
            onChange={(e) => {
              setPrompt(e.target.value);
              if (error) setError('');
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Escape') {
                e.preventDefault();
                close();
              } else if (e.key === 'Backspace' && !prompt) {
                // Nothing typed: Backspace takes the panel back, like erasing the space.
                e.preventDefault();
                close();
              } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <button type="button" className="ai-inline-go" onClick={() => void send()} disabled={!prompt.trim()} title={t('Send')}>
            ↑
          </button>
        </>
      )}
      {error && <div className="ai-empty-error">{error}</div>}
    </div>
  );
}
