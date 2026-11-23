import type { PropDef } from './types';
import { t } from './i18n';

// Typing help for the process-code editor (see server/workflow_code.go for
// the grammar). The editor is a plain textarea, so this is a completion
// engine rather than a language server: it reads the line under the caret,
// works out which slot the cursor is in, and offers the words that fit —
// guard keywords, statuses, property names, their values, people, and the
// constants the document itself declares.
//
// Everything here is pure: source in, suggestions out. HighlightedCode owns
// the popup, WorkflowCode owns the world (schema, members).

export type HintKind = 'keyword' | 'builtin' | 'status' | 'property' | 'option' | 'member';

export interface CodeHint {
  /** The text to type, without quotes: the editor decides how to quote it. */
  label: string;
  kind: HintKind;
  /** One word under the name in the popup. */
  detail: string;
}

/** What the document can name. */
export interface CodeWorld {
  /** Id of the status property; its options are the statuses. */
  statusPropId: string;
  props: { id: string; name: string; type: PropDef['type']; options: string[] }[];
  members: string[];
}

export interface CompletionState {
  /** Replace source[start:end] with the accepted hint. */
  start: number;
  end: number;
  /** The caret sits inside an open quote. */
  inQuote: boolean;
  /** The quote character, when inQuote. */
  quote: string;
  items: CodeHint[];
}

const KEYWORD = (label: string, detail: string): CodeHint => ({ label, kind: 'keyword', detail });

// Functions, not constants: t() at module level would freeze the language
// the app was imported in.
const bodyKeywords = (): CodeHint[] => [
  KEYWORD('when', t('Trigger: a status change or creation')),
  KEYWORD('only from', t('Allow the move only from these statuses')),
  KEYWORD('needs checklist', t('Require a finished checklist')),
  KEYWORD('needs filled', t('Require a property to have a value')),
  KEYWORD('if', t('Fire only when a property matches')),
  KEYWORD('do:', t('Actions to run')),
];

const actionKeywords = (): CodeHint[] => [
  KEYWORD('set', t('Set a property')),
  KEYWORD('assign', t('Assign a person')),
  KEYWORD('ask', t('Ask the mover to fill something')),
  KEYWORD('webhook', t('Call a URL')),
];

const whenItems = (): CodeHint[] => [
  KEYWORD('created', t('When the row is created')),
  KEYWORD('any', t('From any status')),
];

const becomes = (): CodeHint => KEYWORD('becomes', t('The transition verb'));

const CONDITION_TYPES = new Set<PropDef['type']>(['select', 'multiselect', 'text', 'number']);
const COMPUTED_TYPES = new Set<PropDef['type']>(['formula', 'rollup', 'backrelation', 'lastActivity']);

/** Bare words and quoted names in order, so `if "Type" is` reads as
 *  [if, Type, is]. Quotes stay as a marker: a name is not a keyword. */
function tokenize(line: string): { text: string; quoted: boolean }[] {
  const out: { text: string; quoted: boolean }[] = [];
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (' \t,:'.includes(c)) {
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const q = c;
      let j = i + 1;
      let text = '';
      while (j < line.length) {
        if (q === '"' && line[j] === '\\') {
          text += line[j + 1] ?? '';
          j += 2;
          continue;
        }
        if (line[j] === q) break;
        text += line[j];
        j++;
      }
      out.push({ text, quoted: true });
      i = j + 1;
      continue;
    }
    let j = i + 1;
    while (j < line.length && !' \t,:'.includes(line[j]) && line[j] !== '"' && line[j] !== "'") j++;
    out.push({ text: line.slice(i, j), quoted: false });
    i = j;
  }
  return out;
}

/** Constants the document declares: `name = value` at column 0. They can be
 *  written wherever a value goes, and completing them saves retyping URLs. */
function constantNames(source: string, upto: number): string[] {
  const out: string[] = [];
  for (const line of source.slice(0, upto).split('\n')) {
    const m = /^([A-Za-z_][\w-]*)\s*=/.exec(line);
    if (m && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

function hintsOfNames(names: string[], kind: HintKind, detail: string): CodeHint[] {
  return names.map((name) => ({ label: name, kind, detail }));
}

function unique(items: CodeHint[]): CodeHint[] {
  const seen = new Set<string>();
  const out: CodeHint[] = [];
  for (const it of items) {
    const key = it.label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

/** Which hints belong where the caret is. Returns null when the caret is in
 *  a comment, or the line offers nothing. */
export function codeCompletions(source: string, caret: number, world: CodeWorld): CompletionState | null {
  const lineStart = source.lastIndexOf('\n', Math.max(0, caret - 1)) + 1;
  const before = source.slice(lineStart, caret);

  // Find an open quote and a # comment on the current line, in one pass.
  let quote: string | null = null;
  let quoteStart = -1;
  for (let i = 0; i < before.length; i++) {
    const c = before[i];
    if (quote) {
      if (c === '\\' && quote === '"') {
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      quoteStart = i;
      continue;
    }
    if (c === '#') return null;
  }

  const inQuote = quote !== null;
  let prefix: string;
  let start: number;
  let contextLine: string;
  if (inQuote) {
    prefix = before.slice(quoteStart + 1);
    start = lineStart + quoteStart + 1;
    contextLine = before.slice(0, quoteStart);
  } else {
    const m = /[A-Za-z_][\w-]*$/.exec(before);
    prefix = m ? m[0] : '';
    start = caret - prefix.length;
    // `before` is line-relative and `start` is document-relative: cut the
    // prefix off with its own length, or the word being typed stays in the
    // context and reads as an unknown keyword.
    contextLine = before.slice(0, before.length - prefix.length);
  }

  const indent = /^ */.exec(before)?.[0].length ?? 0;
  const tokens = tokenize(contextLine);
  const words = tokens.map((x) => x.text);
  const low = words.map((x) => x.toLowerCase());
  const last = tokens[tokens.length - 1];
  const atLineStart = tokens.length === 0;
  const statuses = world.props.find((p) => p.id === world.statusPropId)?.options ?? [];
  // The status property drives the process; setting or requiring it inside a
  // rule contradicts the trigger, so the List never offers it either.
  const notStatus = (p: { id: string }) => p.id !== world.statusPropId;
  const settable = world.props.filter((p) => !COMPUTED_TYPES.has(p.type) && notStatus(p));
  const fillable = settable;
  const conditional = world.props.filter((p) => CONDITION_TYPES.has(p.type) && notStatus(p));
  const statusHints = hintsOfNames(statuses, 'status', t('Status'));
  const propHints = (list: { name: string }[], detail: string) =>
    hintsOfNames(list.map((p) => p.name), 'property', detail);

  const valueHints = (propName: string | null): CodeHint[] => {
    const prop = propName ? world.props.find((p) => p.name === propName) : undefined;
    const out: CodeHint[] = [];
    if (prop?.type === 'select' || prop?.type === 'multiselect') {
      out.push(...hintsOfNames(prop.options, 'option', t('Option of “{name}”', { name: prop.name })));
    } else if (prop?.type === 'person') {
      out.push(...hintsOfNames(world.members, 'member', t('Workspace member')));
    } else if (prop?.type === 'checkbox') {
      out.push(KEYWORD('true', t('Checked')), KEYWORD('false', t('Unchecked')));
    } else if (prop?.type === 'date' && !inQuote) {
      out.push({ label: 'today', kind: 'builtin', detail: t('The day the move happens') });
    }
    if (!inQuote) {
      for (const c of constantNames(source, lineStart)) {
        out.push({ label: c, kind: 'builtin', detail: t('Constant from this document') });
      }
    }
    return out;
  };

  const modes = () => [
    KEYWORD('always', t('Ask every time')),
    KEYWORD('if empty', t('Ask only when the property is empty')),
  ];

  let items: CodeHint[] = [];
  // A slot whose next word is fixed opens as soon as the space is typed;
  // a value list does not, or finishing one value would offer the whole
  // list again. `eager` marks the former.
  let eager = false;
  const head = low[0] ?? '';

  if (atLineStart) {
    if (indent === 0) items = [KEYWORD('rule', t('Start a rule'))];
    else items = lastDoBlock(source, lineStart, indent) ? actionKeywords() : bodyKeywords();
  } else if (head === 'rule') {
    items = [];
  } else if (head === 'when') {
    if (tokens.length === 1) {
      items = [...whenItems(), ...statusHints];
    } else if (tokens.length === 2 && (last?.quoted || low[1] === 'any')) {
      items = [becomes()];
      eager = true;
    } else if (tokens.length === 3 && low[2] === 'becomes') {
      items = statusHints;
    } else if (tokens.length === 2 && low[1] === 'created') {
      items = [];
    } else {
      // A partial third word after `becomes`, or a value being typed.
      items = last?.quoted || low[1] === 'any' || low[2] === 'becomes' ? statusHints : [];
    }
  } else if (head === 'only') {
    if (tokens.length === 1) {
      items = [KEYWORD('from', t('The sources that may move in'))];
      eager = true;
    } else if (low[1] === 'from') items = statusHints;
  } else if (head === 'needs') {
    if (tokens.length === 1) {
      items = [
        KEYWORD('checklist', t('Require a finished checklist')),
        KEYWORD('filled', t('Require a property to have a value')),
      ];
      eager = true;
    } else if (low[1] === 'checklist') {
      items = propHints(world.props.filter((p) => p.type === 'checklist'), t('Checklist property'));
    } else if (low[1] === 'filled') {
      items = propHints(fillable, t('Property'));
    }
  } else if (head === 'if') {
    if (tokens.length === 1) {
      items = propHints(conditional, t('Property'));
    } else if (tokens.length === 2) {
      items = [KEYWORD('is', t('Compare to a value')), KEYWORD('is not', t('Exclude a value'))];
      eager = true;
    } else {
      const propName = tokens[1]?.quoted ? words[1] : '';
      const not = low[2] === 'not';
      const valueAt = not ? 3 : 2;
      if (tokens.length <= valueAt) items = [KEYWORD('is', t('Compare to a value')), KEYWORD('is not', t('Exclude a value'))];
      else items = valueHints(propName);
    }
  } else if (head === 'do') {
    items = [];
  } else if (head === 'set') {
    if (tokens.length === 1) items = propHints(settable, t('Property'));
    else if (tokens.length === 2) {
      items = tokens[1]?.quoted ? [KEYWORD('=', t('The new value follows'))] : propHints(settable, t('Property'));
      eager = !!tokens[1]?.quoted;
    } else {
      items = valueHints(tokens[1]?.quoted ? words[1] : null);
    }
  } else if (head === 'assign') {
    if (tokens.length === 1) {
      items = [KEYWORD('me', t('The person making the move'))];
      eager = true;
    } else if (tokens.length === 2) {
      items = [KEYWORD('to', t('The person property'))];
      eager = true;
    } else items = propHints(world.props.filter((p) => p.type === 'person'), t('Person property'));
  } else if (head === 'ask') {
    if (tokens.length === 1) {
      items = [KEYWORD('comment', t('Ask for a comment')), ...propHints(fillable, t('Property'))];
    } else if (low[1] === 'comment') {
      items = tokens.length === 2 ? modes() : [];
      eager = tokens.length === 2;
    } else if (tokens.length === 2 && tokens[1]?.quoted) {
      items = modes();
      eager = true;
    } else {
      items = propHints(fillable, t('Property'));
    }
  } else if (head === 'webhook') {
    items = [];
  } else if (head === 'today') {
    items = tokens.length === 1 ? [KEYWORD('->', t('The date property'))] : [];
  } else if (indent > 0) {
    // Something unrecognised at the start of an indented line: offer the
    // guard words, which is the usual way out of a typo.
    items = lastDoBlock(source, lineStart, indent) ? actionKeywords() : bodyKeywords();
  } else {
    // A top-level word being typed: `rule` is the only one that starts a
    // document (constants are the user's own names).
    items = [KEYWORD('rule', t('Start a rule'))];
  }

  const lower = prefix.toLowerCase();
  // Inside quotes only names fit: keywords are written bare, so offering
  // `created` after an opening quote produced `"created` and a parser error.
  const candidates = inQuote ? items.filter((h) => h.kind !== 'keyword') : items;
  const filtered = unique(candidates.filter((h) => h.label.toLowerCase().startsWith(lower)));
  if (filtered.length === 0) return null;
  // In a slot that takes names, an empty prefix should still open the list;
  // in a keyword slot, wait until a letter is typed so an empty line stays
  // quiet.
  const nameSlot = filtered.some((h) => h.kind !== 'keyword');
  if (!inQuote && prefix === '' && !nameSlot && !eager) return null;
  return { start, end: caret, inQuote, quote: quote ?? '"', items: filtered.slice(0, 12) };
}

/** True when the block the caret sits in is a `do:` body: the nearest line
 *  above with a smaller indent opens that block. */
function lastDoBlock(source: string, lineStart: number, indent: number): boolean {
  const lines = source.slice(0, lineStart).split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const lineIndent = /^ */.exec(line)?.[0].length ?? 0;
    if (lineIndent >= indent) continue;
    return /^\s*do\s*:?\s*$/.test(line);
  }
  return false;
}
