import { useEffect, useMemo, useRef, type RefObject } from 'react';

// Keyword highlighting for the process-code editor: the same grammar the
// server parses (see server/workflow_code.go), painted into a <pre> that sits
// under a transparent textarea. Two layers, not a contenteditable: the caret,
// selection, IME and undo stay the browser's own, which is the whole reason a
// plain textarea is worth keeping.
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
  // A trailing newline has no line box of its own: the overlay would sit one
  // line short of the textarea and drift as soon as the last line wraps.
  return body.endsWith('\n') ? body + '\n' : body;
}

/** A textarea with the process grammar painted underneath it. Tab indents by
 *  two spaces and Enter keeps the indentation — this language nests by
 *  leading spaces, so a Tab that jumped to the next control was a trap. */
export default function HighlightedCode({
  value,
  onChange,
  rows,
  invalid,
  placeholder,
  areaRef,
  ariaLabel,
}: {
  value: string;
  onChange: (next: string) => void;
  rows: number;
  invalid?: boolean;
  placeholder?: string;
  areaRef: RefObject<HTMLTextAreaElement>;
  ariaLabel?: string;
}) {
  const preRef = useRef<HTMLPreElement>(null);
  const html = useMemo(() => highlightCode(value), [value]);
  const pendingCaret = useRef<number | null>(null);

  // The overlay and the textarea scroll as one, or the colours slide out from
  // under the words as soon as the document is taller than the box.
  const syncScroll = () => {
    const ta = areaRef.current;
    const pre = preRef.current;
    if (!ta || !pre) return;
    pre.scrollTop = ta.scrollTop;
    pre.scrollLeft = ta.scrollLeft;
  };

  useEffect(() => {
    const caret = pendingCaret.current;
    const ta = areaRef.current;
    if (caret == null || !ta) return;
    ta.setSelectionRange(caret, caret);
    pendingCaret.current = null;
  }, [value, areaRef]);

  const insert = (text: string) => {
    const ta = areaRef.current;
    if (!ta) return;
    const start = ta.selectionStart ?? value.length;
    const end = ta.selectionEnd ?? start;
    pendingCaret.current = start + text.length;
    onChange(value.slice(0, start) + text + value.slice(end));
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const ta = areaRef.current;
    if (!ta) return;
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

  return (
    <div className="cw-wrap">
      <pre className="cw-pre" ref={preRef} aria-hidden="true" dangerouslySetInnerHTML={{ __html: html }} />
      {value === '' && placeholder && <div className="cw-placeholder">{placeholder}</div>}
      <textarea
        ref={areaRef}
        className={'workflow-code-area cw-area' + (invalid ? ' workflow-code-area-bad' : '')}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onScroll={syncScroll}
        onKeyDown={onKeyDown}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        rows={rows}
        aria-label={ariaLabel}
      />
    </div>
  );
}
