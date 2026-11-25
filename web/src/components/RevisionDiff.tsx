// A version of a page, next to the one before it: what it said, and where it
// differs.
//
// A history dialog that shows a timestamp and the words "Changes were not
// recorded" is a column of timestamps with an excuse. Nobody opens the history
// to read times: they come to see the sentence that used to be there. So the
// two states are compared block by block — a paragraph that was reworded is
// one block with its changed words marked, a block that was added is marked
// whole, and a block that was deleted is shown struck through where it stood —
// and the result is rendered as the page looked, not as an excerpt.
//
// The comparison is on the blocks' own ids, which survive an edit: text typed
// into a paragraph changes its words, not its identity. A block that moved
// reads as deleted-and-added, which is honest about what happened.

/** One block of a stored document, flattened with its nesting depth. */
export interface RevBlock {
  id: string;
  type: string;
  text: string;
  depth: number;
  checked?: boolean;
  level?: number;
  language?: string;
  url?: string;
  caption?: string;
  emoji?: string;
  /** A table, folded to rows of cell text: its cells are blocks of their own. */
  rows?: string[][];
}

export interface Seg {
  text: string;
  kind: 'same' | 'add' | 'del';
}

export type DiffKind = 'same' | 'changed' | 'added' | 'removed';

export interface DiffLine {
  id: string;
  kind: DiffKind;
  block: RevBlock;
  segs?: Seg[];
}

/** The words of a run of inline nodes. A link keeps its words one level down,
 *  and a styled run its own — reading only the top level loses both. */
function inlineText(nodes: unknown): string {
  if (!Array.isArray(nodes)) return '';
  let out = '';
  for (const n of nodes as { text?: unknown; content?: unknown }[]) {
    if (typeof n?.text === 'string') out += n.text;
    if (Array.isArray(n?.content)) out += inlineText(n.content);
  }
  return out.replace(/\s+/g, ' ');
}

export function parseRevisionContent(raw: string): RevBlock[] {
  let v: unknown;
  try {
    v = JSON.parse(raw || '[]');
  } catch {
    return [];
  }
  const out: RevBlock[] = [];
  const walk = (list: unknown, depth: number) => {
    if (!Array.isArray(list)) return;
    for (const node of list) {
      const b = node as Record<string, unknown>;
      if (!b || typeof b !== 'object') continue;
      const type = String(b.type ?? 'paragraph');
      const props = (b.props ?? {}) as Record<string, unknown>;
      const block: RevBlock = {
        id: typeof b.id === 'string' ? b.id : `b${out.length}`,
        type,
        text: inlineText(b.content),
        depth,
        checked: props.checked === true,
        level: Math.min(3, Math.max(1, Number(props.level) || 1)),
        language: String(props.language ?? ''),
        url: String(props.url ?? ''),
        caption: String(props.caption ?? ''),
        emoji: String(props.icon ?? props.emoji ?? ''),
      };
      if (type === 'table') {
        const rows: string[][] = [];
        for (const row of (b.children as Record<string, unknown>[] | undefined) ?? []) {
          const cells: string[] = [];
          for (const cell of (row?.children as Record<string, unknown>[] | undefined) ?? []) {
            cells.push(inlineText((cell as Record<string, unknown>)?.content));
          }
          rows.push(cells);
        }
        block.rows = rows;
      }
      out.push(block);
      // A list item's sub-items and a toggle's body are part of the page; a
      // table is already folded into `rows`.
      if (type !== 'table' && Array.isArray(b.children)) walk(b.children, depth + 1);
    }
  };
  walk(v, 0);
  return out;
}

const tokens = (s: string): string[] => s.match(/\S+\s*/g) ?? [];

/** Words that changed, on both sides: shared words stay plain, inserted ones
 *  are marked, removed ones are struck. Word-level rather than character-level
 *  because fixing a typo in a sentence should mark the word, not the whole
 *  paragraph — and a paragraph of red is a paragraph nobody reads. */
export function wordDiff(before: string, after: string): Seg[] {
  const a = tokens(before);
  const b = tokens(after);
  const segs: Seg[] = [];
  const push = (kind: Seg['kind'], text: string) => {
    const last = segs[segs.length - 1];
    if (last && last.kind === kind) last.text += text;
    else segs.push({ kind, text });
  };
  // A very long block is compared as one change rather than with a table of
  // a million cells in the browser.
  if (a.length > 360 || b.length > 360) {
    if (before) push('del', before);
    if (after) push('add', after);
    return segs;
  }
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] =
        a[i].toLowerCase() === b[j].toLowerCase()
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i].toLowerCase() === b[j].toLowerCase()) {
      push('same', b[j]);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      push('del', a[i]);
      i++;
    } else {
      push('add', b[j]);
      j++;
    }
  }
  while (i < n) push('del', a[i++]);
  while (j < m) push('add', b[j++]);
  return segs;
}

/** The two versions, block by block. Blocks are matched by id; anything left
 *  over is added or removed, and a removed block is shown where it stood. */
export function diffRevision(before: RevBlock[], after: RevBlock[]): DiffLine[] {
  const beforeById = new Map(before.map((b) => [b.id, b]));
  const beforeIndex = new Map(before.map((b, i) => [b.id, i]));
  const afterIds = new Set(after.map((b) => b.id));
  const removed = before.filter((b) => !afterIds.has(b.id));
  let nextRemoved = 0;
  const out: DiffLine[] = [];
  const flush = (limit: number) => {
    while (nextRemoved < removed.length && beforeIndex.get(removed[nextRemoved].id)! < limit) {
      const b = removed[nextRemoved++];
      out.push({ id: b.id, kind: 'removed', block: b });
    }
  };
  // Where a block that is gone stood: before the next block that survived, so
  // a deleted paragraph is read in its old place rather than at the end.
  const nextSurvivor = (from: number): number => {
    for (let k = from; k < after.length; k++) {
      const idx = beforeIndex.get(after[k].id);
      if (idx !== undefined) return idx;
    }
    return Number.MAX_SAFE_INTEGER;
  };
  for (let ai = 0; ai < after.length; ai++) {
    const b = after[ai];
    const at = beforeIndex.get(b.id);
    flush(at !== undefined ? at : nextSurvivor(ai));
    const was = beforeById.get(b.id);
    if (!was) {
      out.push({ id: b.id, kind: 'added', block: b });
      continue;
    }
    const changed =
      was.text !== b.text ||
      was.type !== b.type ||
      !!was.checked !== !!b.checked ||
      (was.rows && b.rows ? JSON.stringify(was.rows) !== JSON.stringify(b.rows) : false);
    out.push(
      changed
        ? { id: b.id, kind: 'changed', block: b, segs: wordDiff(was.text, b.text) }
        : { id: b.id, kind: 'same', block: b },
    );
  }
  flush(Number.MAX_SAFE_INTEGER);
  return out;
}

function Words({ line }: { line: DiffLine }) {
  if (line.kind === 'changed' && line.segs) {
    return (
      <>
        {line.segs.map((s, i) =>
          s.kind === 'same' ? (
            <span key={i}>{s.text}</span>
          ) : s.kind === 'add' ? (
            <mark key={i} className="rev-add">
              {s.text}
            </mark>
          ) : (
            <del key={i} className="rev-del">
              {s.text}
            </del>
          ),
        )}
      </>
    );
  }
  if (line.kind === 'added') return <mark className="rev-add">{line.block.text}</mark>;
  if (line.kind === 'removed') return <del className="rev-del">{line.block.text}</del>;
  return <>{line.block.text}</>;
}

function BlockBody({ line, numbered }: { line: DiffLine; numbered?: number }) {
  const b = line.block;
  switch (b.type) {
    case 'heading':
      return (
        <div className={'rev-h rev-h' + b.level}>
          <Words line={line} />
        </div>
      );
    case 'bulletListItem':
      return (
        <div className="rev-li">
          <span className="rev-bullet">•</span>
          <span>
            <Words line={line} />
          </span>
        </div>
      );
    case 'numberedListItem':
      return (
        <div className="rev-li">
          <span className="rev-bullet rev-bullet--num">{numbered ?? 1}.</span>
          <span>
            <Words line={line} />
          </span>
        </div>
      );
    case 'checkListItem':
      return (
        <div className="rev-li rev-check">
          <span className={'rev-box' + (b.checked ? ' on' : '')} aria-hidden="true" />
          <span className={b.checked ? 'rev-done' : undefined}>
            <Words line={line} />
          </span>
        </div>
      );
    case 'toggleListItem':
      return (
        <div className="rev-li">
          <span className="rev-bullet">▸</span>
          <span>
            <Words line={line} />
          </span>
        </div>
      );
    case 'quote':
      return (
        <blockquote className="rev-quote">
          <Words line={line} />
        </blockquote>
      );
    case 'codeBlock':
      return (
        <pre className="rev-code">
          <code>{line.kind === 'same' ? b.text : <Words line={line} />}</code>
        </pre>
      );
    case 'divider':
      return <hr className="rev-rule" />;
    case 'image':
      return (
        <figure className="rev-figure">
          {b.url ? <img src={b.url} alt={b.caption} loading="lazy" /> : null}
          {b.caption ? <figcaption>{b.caption}</figcaption> : null}
          {line.kind !== 'same' && (
            <span className="rev-media-mark">{line.kind === 'removed' ? '−' : '+'}</span>
          )}
        </figure>
      );
    case 'table':
      return (
        <div className="rev-table-wrap">
          <table className="rev-table">
            <tbody>
              {(b.rows ?? []).map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'callout':
      return (
        <div className="rev-callout">
          {b.emoji && <span className="rev-callout-ic">{b.emoji}</span>}
          <span>
            <Words line={line} />
          </span>
        </div>
      );
    default:
      // A paragraph, and any block this build does not know: its words are
      // still the thing the reader came for.
      if (!b.text) return null;
      return (
        <p className="rev-p">
          <Words line={line} />
        </p>
      );
  }
}

/** The document at one version, with its changes marked, and each change
 *  numbered so the footer can step through them. */
export function RevisionBody({
  lines,
  ranks,
  title,
  titleSegs,
  titleChange,
  activeChange,
  bodyRef,
}: {
  lines: DiffLine[];
  /** The change number of each line, or 0 for a line that did not change. */
  ranks: number[];
  title: string;
  titleSegs?: Seg[];
  titleChange: number;
  /** The change the footer is pointing at, so it can be seen and not only
   *  scrolled to. */
  activeChange: number;
  bodyRef: React.RefObject<HTMLDivElement>;
}) {
  let number = 0;
  return (
    <div className="rev-doc-body" ref={bodyRef}>
      <h1
        className={'rev-doc-title' + (titleChange && titleChange === activeChange ? ' is-current' : '')}
        data-change={titleChange || undefined}
      >
        {titleSegs ? (
          <>
            {titleSegs.map((s, i) =>
              s.kind === 'same' ? (
                <span key={i}>{s.text}</span>
              ) : s.kind === 'add' ? (
                <mark key={i} className="rev-add">
                  {s.text}
                </mark>
              ) : (
                <del key={i} className="rev-del">
                  {s.text}
                </del>
              ),
            )}
          </>
        ) : (
          title
        )}
      </h1>
      {lines.map((line, i) => {
        // Numbered list items count within a run of their own depth; a line
        // that is not one resets the count, as a list does.
        if (line.kind === 'same' && line.block.type !== 'numberedListItem') number = 0;
        if (line.block.type === 'numberedListItem') number++;
        return (
          <div
            key={line.id + ':' + i}
            className={
              'rev-line rev-line--' + line.kind + (ranks[i] && ranks[i] === activeChange ? ' is-current' : '')
            }
            data-change={ranks[i] || undefined}
            style={line.block.depth ? { marginLeft: line.block.depth * 18 } : undefined}
          >
            <BlockBody line={line} numbered={number} />
          </div>
        );
      })}
    </div>
  );
}
