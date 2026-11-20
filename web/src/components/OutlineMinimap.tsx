import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '../i18n';
import type { SaltEditor } from '../pageLink';

interface OutlineEntry {
  id: string;
  level: number;
  text: string;
}

function collectHeadings(blocks: unknown[], out: OutlineEntry[]) {
  for (const b of blocks as {
    id?: string;
    type?: string;
    props?: { level?: number };
    content?: { text?: string }[];
    children?: unknown[];
  }[]) {
    if (b?.type === 'heading' && b.id) {
      const text = (b.content ?? [])
        .map((c) => c.text ?? '')
        .join('')
        .trim();
      out.push({ id: b.id, level: Math.min(Math.max(b.props?.level ?? 1, 1), 6), text: text || t('Untitled') });
    }
    if (b?.children?.length) collectHeadings(b.children, out);
  }
}

// A minimap outline of the document, Notion-style: thin bars at the viewport's
// right edge, longer for higher headings. Hovering opens the headings as
// clickable entries; clicking a bar or an entry jumps to it. Lives off the
// editor's own document, so it follows edits, and off the page's scroll
// position, so it marks where you are.
export default function OutlineMinimap({ editor }: { editor: SaltEditor }) {
  const [entries, setEntries] = useState<OutlineEntry[]>([]);
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const compute = () => {
      try {
        const out: OutlineEntry[] = [];
        collectHeadings(editor.document as unknown[], out);
        setEntries(out);
      } catch {
        /* a half-applied edit must not take the rail down */
      }
    };
    compute();
    const unsub = (editor as { onChange?: (cb: () => void) => unknown }).onChange?.(compute);
    return () => {
      if (typeof unsub === 'function') unsub();
    };
  }, [editor]);

  const locate = useCallback((id: string) => {
    const scope = rootRef.current?.closest('.page-body') ?? document;
    return scope.querySelector(`[data-id="${CSS.escape(id)}"]`);
  }, []);

  // The heading the reader is at: the last one at or above a line a third
  // down the viewport. Recomputed on scroll (throttled by the browser: one
  // rAF per frame at most) and whenever the headings themselves change.
  useEffect(() => {
    const root = rootRef.current?.closest('.page-body');
    if (!root || entries.length === 0) {
      setActiveId(null);
      return;
    }
    let frame = 0;
    const mark = () => {
      frame = 0;
      const line = window.innerHeight * 0.33;
      let current: string | null = null;
      let upcoming: string | null = null;
      for (const e of entries) {
        const el = locate(e.id);
        if (!el) continue;
        if (el.getBoundingClientRect().top - line <= 0) current = e.id;
        else if (!upcoming) {
          upcoming = e.id;
          break;
        }
      }
      // Before the first heading (top of the page) the upcoming one reads as
      // current: the minimap is never all dark on a page that has headings.
      const next = current ?? upcoming;
      setActiveId((prev) => (prev === next ? prev : next));
    };
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(mark);
    };
    mark();
    root.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      root.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [entries]);

  if (entries.length === 0) return null;

  const jump = (id: string) => {
    locate(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  // H1 longest; deeper headings shrink to a tick.
  const barWidth = (level: number) => (level <= 1 ? 30 : level === 2 ? 22 : level === 3 ? 15 : 9);

  return (
    <div
      ref={rootRef}
      className="outline-minimap"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <nav className="outline-bars" aria-label={t('Contents')}>
        {entries.map((e) => (
          <button
            key={e.id}
            type="button"
            className={'outline-bar' + (e.id === activeId ? ' is-on' : '')}
            style={{ width: barWidth(e.level) }}
            title={e.text}
            aria-label={e.text}
            onClick={() => jump(e.id)}
          />
        ))}
      </nav>
      {open && (
        <div className="outline-popup" role="listbox" aria-label={t('Contents')}>
          <div className="outline-popup-title">{t('Contents')}</div>
          {entries.map((e) => (
            <button
              key={e.id}
              type="button"
              role="option"
              aria-selected={e.id === activeId}
              className={'outline-item' + (e.id === activeId ? ' is-on' : '')}
              style={{ paddingLeft: 10 + (e.level - 1) * 12 }}
              title={e.text}
              onClick={() => jump(e.id)}
            >
              {e.text}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
