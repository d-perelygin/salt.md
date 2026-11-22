import { useEffect, useMemo, useRef, useState } from 'react';
import { Lock, TriangleAlert } from 'lucide-react';
import type { PropDef, WorkflowCodeBlock, WorkflowConfig, WorkflowRule } from '../types';
import { api } from '../api';
import { t } from '../i18n';
import { toast } from '../toast';
import { loadMembers, type Member } from './PropertyValue';
import { formatCode, generateVisualCode, splitCodeDocument } from '../workflow';
import HighlightedCode from './HighlightedCode';

export type CodeDiag = { line: number; message: string };

type DocState =
  | { kind: 'clean' }
  | { kind: 'checking' }
  | { kind: 'valid' }
  | { kind: 'invalid'; errors: CodeDiag[] }
  | { kind: 'codeOnly'; reasons: string[] };

const SILENT_MOVE_KEY = 'salt:code-move-silent';

const isSilentMove = () => {
  try {
    return localStorage.getItem(SILENT_MOVE_KEY) === '1';
  } catch {
    return false;
  }
};

const newRuleId = () => `rule_${Date.now().toString(36)}`;

type CompiledRule = {
  header: string;
  line: number;
  rule?: WorkflowRule;
  codeOnly: boolean;
  reason: string;
  errors: CodeDiag[];
};

function featureName(reason: string) {
  return reason === 'constants' ? t('constants') : t('OR conditions');
}

/** The Code tab: the whole process as one text. Valid text applies to the
 *  model at once — known headers update visual rules, new headers create
 *  them, missing ones delete them, code-only sections land in one code
 *  block. Broken text locks the List until fixed or reset. Saving happens
 *  with the dialog's Save button, like everything else here. */
export default function WorkflowCode({
  collectionId,
  schema,
  workflow,
  statusPropId,
  focus,
  onChange,
  onCodeLockedChange,
  discardTick,
}: {
  collectionId: string;
  schema: PropDef[];
  workflow: WorkflowConfig | undefined;
  statusPropId: string;
  focus: { target: string; n: number } | null;
  onChange: (w: WorkflowConfig | undefined) => void;
  onCodeLockedChange: (locked: boolean) => void;
  /** Incremented by the List's pause notice to throw the draft away. */
  discardTick: number;
}) {
  const rules = useMemo(() => workflow?.rules ?? [], [workflow]);
  const blocks = useMemo(() => workflow?.code ?? [], [workflow]);
  const [members, setMembers] = useState<Member[]>([]);
  // The user draft; undefined means the generated document is shown.
  const [text, setText] = useState<string | undefined>(undefined);
  const [state, setState] = useState<DocState>({ kind: 'clean' });
  // "Keep editing" hides the move banner until the text turns clean again.
  const [kept, setKept] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const seqs = useRef(0);
  const applied = useRef<WorkflowConfig | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastVerdict = useRef<{ source: string; compiled: CompiledRule[] } | null>(null);

  useEffect(() => {
    let alive = true;
    loadMembers()
      .then((m) => alive && setMembers(m))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // The generated document: visual rules in order, then the code sources.
  const built = useMemo(() => {
    const v = generateVisualCode(rules, schema, members, statusPropId);
    const headerToId = new Map<string, string>();
    rules.forEach((r, i) => {
      if (!headerToId.has(v.headers[i])) headerToId.set(v.headers[i], r.id);
    });
    const codeParts = blocks.map((b) => b.source.trimEnd()).filter((s) => s.length > 0);
    const visual = v.text.trimEnd();
    const parts = [visual, ...codeParts].filter((s) => s.length > 0);
    return { headerToId, doc: parts.length > 0 ? parts.join('\n\n') + '\n' : '' };
  }, [rules, blocks, schema, members, statusPropId]);

  const shown = text ?? built.doc;

  // A visual edit snaps a draft back to generated text: the model is truth.
  useEffect(() => {
    if (text !== undefined && workflow !== applied.current) {
      setText(undefined);
      setState({ kind: 'clean' });
      setKept(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflow]);

  const locked = state.kind === 'invalid';
  useEffect(() => {
    onCodeLockedChange(locked);
  }, [locked, onCodeLockedChange]);

  // A map click on a code edge lands here.
  useEffect(() => {
    if (!focus || focus.target !== 'code') return;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        areaRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        areaRef.current?.focus({ preventScroll: true });
      }),
    );
  }, [focus]);

  const jumpToLine = (line: number) => {
    const el = areaRef.current;
    if (!el || line < 1) return;
    const off = el.value.split('\n').slice(0, line - 1).join('\n').length + (line > 1 ? 1 : 0);
    el.focus();
    el.setSelectionRange(off, off);
  };

  const applyDoc = (source: string, seq: number) => {
    api
      .compileWorkflowText(collectionId, source, statusPropId)
      .then((r) => {
        if (seqs.current !== seq) return;
        const errors: CodeDiag[] = [...(r.errors ?? []), ...r.rules.flatMap((e) => e.errors ?? [])];
        if (errors.length > 0) {
          setState({ kind: 'invalid', errors });
          return;
        }
        const codeOnly = r.rules.filter((e) => e.codeOnly);
        if (codeOnly.length > 0) {
          setState({ kind: 'codeOnly', reasons: [...new Set(codeOnly.map((e) => e.reason))] });
          lastVerdict.current = { source, compiled: r.rules };
          if (isSilentMove()) moveToCode(source, r.rules);
          return;
        }
        lastVerdict.current = null;
        applyClean(source, r.rules);
        setState({ kind: 'valid' });
        setKept(false);
      })
      .catch(() => {});
  };

  // Sections matched greedily in order: the first section for a header
  // takes its compiled rule, later duplicates fall through to code.
  const matchSections = (
    sections: { header: string; text: string }[],
    compiled: CompiledRule[],
  ) => {
    const queue = new Map<string, CompiledRule[]>();
    for (const c of compiled) {
      const q = queue.get(c.header) ?? [];
      q.push(c);
      queue.set(c.header, q);
    }
    return sections.map((s) => ({ section: s, compiled: queue.get(s.header)?.shift() }));
  };

  const singleCodeBlock = (sources: string[]): WorkflowCodeBlock[] => {
    const parts = sources.map((x) => x.trimEnd()).filter((x) => x.length > 0);
    if (parts.length === 0) return [];
    const first = blocks[0];
    return [{
      id: first?.id ?? `new_${Date.now().toString(36)}`,
      name: first?.name || 'Code',
      source: parts.join('\n\n') + '\n',
      rules: first?.rules ?? [],
    }];
  };

  const applyClean = (source: string, compiled: CompiledRule[]) => {
    if (!workflow) return;
    const seen = new Set<string>();
    const nextRules: WorkflowRule[] = [];
    const codeSections: string[] = [];
    const { preamble, sections } = splitCodeDocument(source);
    for (const { section: sec, compiled: c } of matchSections(sections, compiled)) {
      if (!c || !c.rule) {
        codeSections.push(sec.text);
        continue;
      }
      const id = built.headerToId.get(sec.header);
      if (id && !seen.has(id)) {
        seen.add(id);
        nextRules.push({ ...c.rule, id });
      } else if (!id) {
        nextRules.push({ ...c.rule, id: newRuleId() });
      } else {
        codeSections.push(sec.text);
      }
    }
    const next = {
      ...workflow,
      rules: nextRules,
      code: singleCodeBlock([preamble, ...codeSections]),
    };
    applied.current = next;
    onChange(next);
  };

  const moveToCode = (source: string, compiled: CompiledRule[]) => {
    if (!workflow) return;
    const codeOnlyHeaders = new Set(compiled.filter((c) => c.codeOnly).map((c) => c.header));
    const { preamble, sections } = splitCodeDocument(source);
    // Moved sections join the code; the rest applies as the visual rules.
    const moved = sections.filter((s) => codeOnlyHeaders.has(s.header));
    const seen = new Set<string>();
    const nextRules: WorkflowRule[] = [];
    const matched = matchSections(
      sections.filter((s) => !codeOnlyHeaders.has(s.header)),
      compiled.filter((c) => !c.codeOnly && c.rule),
    );
    for (const { section: sec, compiled: c } of matched) {
      if (!c || !c.rule) continue;
      const id = built.headerToId.get(sec.header);
      if (id && !seen.has(id)) {
        seen.add(id);
        nextRules.push({ ...c.rule, id });
      } else if (!id) {
        nextRules.push({ ...c.rule, id: newRuleId() });
      }
    }
    const next = {
      ...workflow,
      rules: nextRules,
      code: singleCodeBlock([preamble, ...moved.map((s) => s.text)]),
    };
    applied.current = next;
    setText(undefined);
    setState({ kind: 'clean' });
    setKept(false);
    onChange(next);
    const n = moved.length;
    toast(n === 1 ? t('Rule moved to code') : t('Rules moved to code'));
  };

  const editDoc = (source: string) => {
    setText(source);
    if (timer.current) clearTimeout(timer.current);
    const seq = ++seqs.current;
    setState({ kind: 'checking' });
    timer.current = setTimeout(() => applyDoc(source, seq), 500);
  };

  // Canonical layout, in place. Nothing is applied here directly — the
  // formatted text goes through the same debounced compile as typing, so a
  // document that does not compile is still left alone.
  const formatDoc = () => {
    const next = formatCode(shown);
    if (next === shown) return;
    editDoc(next);
    requestAnimationFrame(() => areaRef.current?.focus({ preventScroll: true }));
  };

  // Throw the draft away and show the document the model builds. Reached
  // from the List while the code does not compile: without it, broken text
  // would have no way back.
  useEffect(() => {
    if (discardTick === 0) return;
    if (timer.current) clearTimeout(timer.current);
    seqs.current++;
    lastVerdict.current = null;
    setText(undefined);
    setState({ kind: 'clean' });
    setKept(false);
    // Only a new tick should fire; the draft state is not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [discardTick]);

  const [hideAsk, setHideAsk] = useState(false);

  return (
    <div className="workflow-code">
      <div className="workflow-code-block" data-code-doc="1">
        <div className="workflow-code-block-bar">
          <span className="workflow-code-name">{t('Process as code')}</span>
          <button type="button" className="btn-sm" onClick={formatDoc}>
            {t('Format')}
          </button>
        </div>
        <HighlightedCode
          areaRef={areaRef}
          value={shown}
          placeholder={'rule "Name":\n  when "New" becomes "Done"\n  do:\n    ask comment always'}
          onChange={editDoc}
          invalid={state.kind === 'invalid'}
          rows={16}
          ariaLabel={t('Process as code')}
          errorLines={state.kind === 'invalid' ? state.errors.map((e) => e.line) : undefined}
          onJumpToLine={jumpToLine}
        />
        {state.kind === 'invalid' && (
          <div className="workflow-code-errors">
            {state.errors.map((e, i) => (
              <button key={i} type="button" className="workflow-code-error" onClick={() => jumpToLine(e.line)}>
                <TriangleAlert size={13} />
                <span>
                  {e.line > 0 ? `${t('Line {n}', { n: e.line })}: ` : ''}
                  {e.message}
                </span>
              </button>
            ))}
          </div>
        )}
        {state.kind === 'codeOnly' && (
          <div className="workflow-code-move">
            <span>
              {t('Uses {feature}, only available in code', {
                feature: state.reasons.map(featureName).join(', '),
              })}
            </span>
            <label className="workflow-code-silence">
              <input type="checkbox" checked={hideAsk} onChange={(e) => setHideAsk(e.target.checked)} />
              {t("Don't ask again")}
            </label>
            <span className="workflow-code-move-actions">
              <button
                type="button"
                className="btn-sm"
                onClick={() => {
                  if (hideAsk) {
                    try {
                      localStorage.setItem(SILENT_MOVE_KEY, '1');
                    } catch {
                      /* private mode: ask every time */
                    }
                  }
                  const v = lastVerdict.current;
                  if (v && text !== undefined && v.source === text) moveToCode(text, v.compiled);
                }}
              >
                {t('Move to code')}
              </button>
              <button type="button" className="btn-sm" onClick={() => setKept(true)}>
                {t('Keep editing')}
              </button>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/** Locked rows for the List tab: rules that live only in code, readable
 *  where the visual rules are edited, edited where the code lives. */
export function CodeLockRows({ blocks, onOpen }: { blocks: WorkflowCodeBlock[]; onOpen: (blockId: string) => void }) {
  if (blocks.length === 0) return null;
  return (
    <div className="workflow-code-locks">
      {blocks.map((b) => (
        <button key={b.id} type="button" className="workflow-code-lock" data-block-id={b.id} onClick={() => onOpen(b.id)}>
          <Lock size={13} />
          <span className="workflow-code-lock-name">{b.name || t('Untitled block')}</span>
          <span className="workflow-code-lock-meta">
            {b.rules.length} · {t('edited in code')}
          </span>
        </button>
      ))}
    </div>
  );
}
