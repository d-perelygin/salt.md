import { useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { t } from '../i18n';
import type { CodeHint, CompletionState } from '../workflowComplete';

// Keyword highlighting for the process-code editor: the same grammar the
// server parses (see server/workflow_code.go), painted into a <pre> that sits
// under a transparent textarea. Two layers, not a contenteditable: the caret,
// selection, IME and undo stay the browser's own, which is the whole reason a
// plain textarea is worth keeping. Lines never wrap — one logical line is one
// visual line, so the gutter numbers and the server's error lines agree.
const KEYWORDS = new Set([
  'rule',
  'when',
  'only',
  'from',
  'needs',
  'checklist',
  'filled',
  'if',
  'is',
  'not',
  'do',
  'set',
  'assign',
  'to',
  'ask',
  'comment',
  'always',
  'empty',
  'webhook',
  'created',
  'any',
  'becomes',
  'moved',
]);
// Built-in values the language provides; a constant with these names is
// refused by the parser.
const BUILTINS = new Set(['today', 'me']);

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const span = (cls: string, text: string) => `<span class="cw-${cls}">${escapeHtml(text)}</span>`;

/** Paints one line of process code. Names stay plain on purpose: almost
 *  everything meaningful in this language lives in quotes, so colouring the
 *  bare words would compete with the strings. */
function highlightLine(line: string): string {
  let out = '';
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === '#') {
      out += span('com', line.slice(i));
      break;
    }
    if (c === '"' || c === "'") {
      const q = c;
      let j = i + 1;
      while (j < line.length) {
        if (q === '"' && line[j] === '\\') {
          j += 2;
          continue;
        }
        if (line[j] === q) {
          j++;
          break;
        }
        j++;
      }
      out += span('str', line.slice(i, j));
      i = j;
      continue;
    }
    if (c >= '0' && c <= '9') {
      let j = i + 1;
      while (j < line.length && ((line[j] >= '0' && line[j] <= '9') || line[j] === '.')) j++;
      out += span('num', line.slice(i, j));
      i = j;
      continue;
    }
    if (c === '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) {
      let j = i + 1;
      while (j < line.length) {
        const d = line[j];
        const word = d === '_' || d === '-' || (d >= 'a' && d <= 'z') || (d >= 'A' && d <= 'Z') || (d >= '0' && d <= '9');
        if (!word) break;
        j++;
      }
      const w = line.slice(i, j);
      const cls = KEYWORDS.has(w) ? 'kw' : BUILTINS.has(w) ? 'bi' : w === 'true' || w === 'false' ? 'num' : '';
      out += cls ? span(cls, w) : escapeHtml(w);
      i = j;
      continue;
    }
    out += escapeHtml(c);
    i++;
  }
  return out;
}

export function highlightCode(source: string): string {
  const body = source
    .split('\n')
    .map(highlightLine)
    .join('\n');
  // A trailing newline has no line box of its own: the caret can sit one line
  // below the last painted one, and the overlay would scroll short.
  return body.endsWith('\n') ? body + '\n' : body;
}

const KIND_CLASS: Record<CodeHint['kind'], string> = {
  keyword: 'kw',
  builtin: 'bi',
  status: 'st',
  property: 'pr',
  option: 'op',
  member: 'me',
};

/** Caret position in the textarea's own coordinate space, measured against a
 *  mirror that copies its metrics. The popup must sit where the next letter
 *  will land, not at the element's corner — the whole point is to type
 *  without looking away from the caret. */
function caretPoint(ta: HTMLTextAreaElement, pos: number): { left: number; top: number; lineHeight: number } {
  const cs = getComputedStyle(ta);
  const div = document.createElement('div');
  div.style.cssText = [
    'position:absolute',
    'top:0',
    'left:0',
    'visibility:hidden',
    'white-space:pre',
    'overflow-wrap:normal',
    'word-break:normal',
    `box-sizing:${cs.boxSizing}`,
    `width:${ta.offsetWidth}px`,
    `font-family:${cs.fontFamily}`,
    `font-size:${cs.fontSize}`,
    `font-weight:${cs.fontWeight}`,
    `font-style:${cs.fontStyle}`,
    `font-variant-ligatures:${cs.fontVariantLigatures}`,
    `letter-spacing:${cs.letterSpacing}`,
    `line-height:${cs.lineHeight}`,
    `text-transform:${cs.textTransform}`,
    `tab-size:${cs.tabSize}`,
    `padding:${cs.padding}`,
    `border:${cs.border}`,
  ].join(';');
  const text = document.createTextNode(ta.value.slice(0, pos));
  const mark = document.createElement('span');
  mark.textContent = ta.value.slice(pos, pos + 1) || '.';
  div.append(text, mark);
  document.body.appendChild(div);
  const markRect = mark.getBoundingClientRect();
  const boxRect = div.getBoundingClientRect();
  const left = markRect.left - boxRect.left - ta.scrollLeft;
  const top = markRect.top - boxRect.top - ta.scrollTop;
  div.remove();
  return { left, top, lineHeight: parseFloat(cs.lineHeight) || 19.2 };
}

/** A textarea with the process grammar painted underneath it and a numbered
 *  gutter beside it. Tab indents by two spaces and Enter keeps the
 *  indentation — this language nests by leading spaces, so a Tab that jumped
 *  to the next control was a trap. Lines with reported problems carry a red
 *  number the reader can click to jump there.
 *
 *  While typing, `suggest` offers the words that fit the caret's slot:
 *  keywords, statuses, properties and their values. The list opens below the
 *  caret; Tab or Enter takes the highlighted entry. */
export default function HighlightedCode({
  value,
  onChange,
  rows,
  invalid,
  placeholder,
  areaRef,
  ariaLabel,
  errorLines,
  onJumpToLine,
  suggest,
  onSave,
}: {
  value: string;
  onChange: (next: string) => void;
  rows: number;
  invalid?: boolean;
  placeholder?: string;
  areaRef: RefObject<HTMLTextAreaElement>;
  ariaLabel?: string;
  errorLines?: number[];
  onJumpToLine?: (line: number) => void;
  suggest?: (source: string, caret: number) => CompletionState | null;
  onSave?: () => void;
}) {
  const preRef = useRef<HTMLPreElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const html = useMemo(() => highlightCode(value), [value]);
  const pendingCaret = useRef<number | null>(null);
  const [completion, setCompletion] = useState<CompletionState | null>(null);
  const [active, setActive] = useState(0);
  const [scrollTick, setScrollTick] = useState(0);

  const lineCount = useMemo(() => value.split('\n').length, [value]);
  const digits = String(lineCount).length;
  const badLines = useMemo(() => new Set(errorLines ?? []), [errorLines]);

  // The overlay and the gutter scroll as one with the textarea, or the colours
  // and the numbers slide out from under the words.
  const syncScroll = () => {
    const ta = areaRef.current;
    const pre = preRef.current;
    if (!ta) return;
    if (pre) {
      pre.scrollTop = ta.scrollTop;
      pre.scrollLeft = ta.scrollLeft;
    }
    if (gutterRef.current) gutterRef.current.style.transform = `translateY(${-ta.scrollTop}px)`;
  };

  useEffect(() => {
    const caret = pendingCaret.current;
    const ta = areaRef.current;
    if (caret == null || !ta) return;
    ta.setSelectionRange(caret, caret);
    pendingCaret.current = null;
  }, [value, areaRef]);

  const point = useMemo(() => {
    const ta = areaRef.current;
    if (!completion || !ta) return null;
    void scrollTick;
    return caretPoint(ta, completion.end);
  }, [completion, scrollTick, areaRef]);

  const refresh = (source: string, caret: number) => {
    if (!suggest) return;
    const next = suggest(source, caret);
    setCompletion(next);
    setActive(0);
  };

  const insert = (text: string) => {
    const ta = areaRef.current;
    if (!ta) return;
    const start = ta.selectionStart ?? value.length;
    const end = ta.selectionEnd ?? start;
    pendingCaret.current = start + text.length;
    onChange(value.slice(0, start) + text + value.slice(end));
  };

  const accept = (hint: CodeHint) => {
    const ta = areaRef.current;
    if (!ta || !completion) return;
    const { start, end, inQuote, quote } = completion;
    const nextChar = value[end] ?? '';
    const quoted = hint.kind !== 'keyword' && hint.kind !== 'builtin';
    let text: string;
    if (!quoted) {
      text = hint.label;
      if (hint.label.endsWith(':')) {
        // do: / rule headers open a block; the newline is the user's.
      } else if (nextChar !== ' ') {
        text += ' ';
      }
    } else if (inQuote) {
      text = hint.label;
      const after = value[end] ?? '';
      if (after !== '' && after !== quote && !/[\s,.]/.test(after)) {
        // Completing in the middle of an existing quoted name: keep the
        // closing quote and the rest of the word that is already there.
      } else {
        if (after !== quote) text += quote;
        const tail = after === quote ? (value[end + 1] ?? '') : after;
        if (tail !== '' && !/[\s,.]/.test(tail)) text += ' ';
      }
    } else {
      text = `${quote}${hint.label}${quote}`;
      if (nextChar !== '' && !/[\s,.]/.test(nextChar)) text += ' ';
    }
    pendingCaret.current = start + text.length;
    setCompletion(null);
    onChange(value.slice(0, start) + text + value.slice(end));
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const ta = areaRef.current;
    if (!ta) return;
    if ((e.key === 's' || e.key === 'S') && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onSave?.();
      return;
    }
    if (completion) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setActive((i) => (i + step + completion.items.length) % completion.items.length);
        return;
      }
      if ((e.key === 'Tab' && !e.shiftKey) || e.key === 'Enter') {
        e.preventDefault();
        const hint = completion.items[active];
        if (hint) accept(hint);
        return;
      }
      if (e.key === 'Escape') {
        // The popup closes first: the dialog (and the fullscreen map) listens
        // for Escape on the document and must not see this one.
        e.preventDefault();
        e.stopPropagation();
        setCompletion(null);
        return;
      }
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) {
        setCompletion(null);
      }
    }
    if (e.key === 'Tab' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      insert('  ');
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const start = ta.selectionStart ?? 0;
      if (start !== ta.selectionEnd) return; // Enter replaces the selection
      e.preventDefault();
      const lineStart = value.lastIndexOf('\n', start - 1) + 1;
      const line = value.slice(lineStart, start);
      const indent = /^ */.exec(line)?.[0] ?? '';
      // After `rule "…":` and `do:` the body goes one level deeper.
      const extra = /:\s*$/.test(line) ? '  ' : '';
      insert('\n' + indent + extra);
    }
  };

  const listHeight = completion ? Math.min(completion.items.length, 8) * 25 + 28 : 0;

  return (
    <div className="cw-wrap" style={{ '--cw-digits': digits } as CSSProperties}>
      <div className="cw-gutter" aria-hidden="true">
        <div className="cw-gutter-inner" ref={gutterRef}>
          {Array.from({ length: lineCount }, (_, i) => {
            const n = i + 1;
            return (
              <div
                key={n}
                className={'cw-ln' + (badLines.has(n) ? ' cw-ln-err' : '')}
                onClick={onJumpToLine ? () => onJumpToLine(n) : undefined}
              >
                {n}
              </div>
            );
          })}
        </div>
      </div>
      <pre className="cw-pre" ref={preRef} aria-hidden="true" dangerouslySetInnerHTML={{ __html: html }} />
      {value === '' && placeholder && <div className="cw-placeholder">{placeholder}</div>}
      <textarea
        ref={areaRef}
        className={'workflow-code-area cw-area' + (invalid ? ' workflow-code-area-bad' : '')}
        value={value}
        onChange={(e) => {
          const next = e.target.value;
          onChange(next);
          refresh(next, e.target.selectionStart ?? next.length);
        }}
        onScroll={() => {
          syncScroll();
          setScrollTick((n) => n + 1);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => setCompletion(null)}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        rows={rows}
        aria-label={ariaLabel}
        aria-autocomplete={suggest ? 'list' : undefined}
      />
      {completion && point && (
        <div
          className="cw-complete"
          role="listbox"
          aria-label={t('Suggestions')}
          style={{
            left: Math.max(4, Math.min(point.left, (areaRef.current?.clientWidth ?? 320) - 280)),
            top:
              point.top + point.lineHeight + 2 + listHeight > (areaRef.current?.clientHeight ?? 240)
                ? Math.max(4, point.top - listHeight - 2)
                : point.top + point.lineHeight + 2,
          }}
        >
          {completion.items.map((h, i) => (
            <button
              key={`${h.kind}:${h.label}`}
              type="button"
              role="option"
              aria-selected={i === active}
              className={'cw-complete-item' + (i === active ? ' is-active' : '')}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => accept(h)}
            >
              <span className={'cw-complete-kind cw-kind-' + KIND_CLASS[h.kind]} aria-hidden="true" />
              <span className="cw-complete-label">{h.label}</span>
              {h.detail && <span className="cw-complete-detail">{h.detail}</span>}
            </button>
          ))}
          <div className="cw-complete-foot">{t('Tab accepts · ↑↓ choose · Esc closes')}</div>
        </div>
      )}
    </div>
  );
}
