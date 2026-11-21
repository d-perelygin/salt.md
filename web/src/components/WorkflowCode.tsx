import { useEffect, useMemo, useRef, useState } from 'react';
import { Lock, Plus, Trash2, TriangleAlert } from 'lucide-react';
import type { PropDef, WorkflowCodeBlock, WorkflowConfig, WorkflowRule } from '../types';
import { api } from '../api';
import { t } from '../i18n';
import { confirm } from '../dialog';
import { toast } from '../toast';
import { loadMembers, type Member } from './PropertyValue';
import { generateRuleCode } from '../workflow';

export type CodeDiag = { block: string; line: number; message: string };

type CompileDiag = { line: number; message: string };

type RuleState =
  | { kind: 'clean' }
  | { kind: 'checking' }
  | { kind: 'valid' }
  | { kind: 'invalid'; errors: CompileDiag[] }
  | { kind: 'codeOnly'; reason: string };

const SILENT_MOVE_KEY = 'salt:code-move-silent';

const isSilentMove = () => {
  try {
    return localStorage.getItem(SILENT_MOVE_KEY) === '1';
  } catch {
    return false;
  }
};

/** One editable rule: the List tab's rule as text. Valid text applies to
 *  the model at once; broken text reports errors and locks its List row;
 *  text using code-only features asks to move (or moves silently). */
function RuleCodeEditor({
  rule,
  title,
  text,
  state,
  banner,
  registerRef,
  onEdit,
  onReset,
  onMove,
  onKeep,
}: {
  rule: WorkflowRule;
  title: string;
  text: string;
  state: RuleState;
  banner: boolean;
  registerRef: (key: string, el: HTMLDivElement | null) => void;
  onEdit: (source: string) => void;
  onReset: () => void;
  onMove: (silent: boolean) => void;
  onKeep: () => void;
}) {
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const rows = Math.max(6, Math.min(16, text.split('\n').length + 1));

  const jumpToLine = (line: number) => {
    const el = areaRef.current;
    if (!el) return;
    const off = el.value.split('\n').slice(0, Math.max(0, line - 1)).join('\n').length + (line > 1 ? 1 : 0);
    el.focus();
    el.setSelectionRange(off, off);
  };

  const [hideAsk, setHideAsk] = useState(false);

  return (
    <div className="workflow-code-block" data-rule-id={rule.id} ref={(el) => registerRef(`rule:${rule.id}`, el)}>
      <div className="workflow-code-block-bar">
        <span className="workflow-code-name">{title}</span>
        <button type="button" className="btn-sm" onClick={onReset}>
          {t('Reset')}
        </button>
      </div>
      <textarea
        ref={areaRef}
        className={'workflow-code-area' + (state.kind === 'invalid' ? ' workflow-code-area-bad' : '')}
        value={text}
        onChange={(e) => onEdit(e.target.value)}
        spellCheck={false}
        rows={rows}
      />
      {state.kind === 'invalid' && (
        <div className="workflow-code-errors">
          {state.errors.map((e, i) => (
            <button key={i} type="button" className="workflow-code-error" onClick={() => e.line > 0 && jumpToLine(e.line)}>
              <TriangleAlert size={13} />
              <span>
                {e.line > 0 ? `${t('Line {n}', { n: e.line })}: ` : ''}
                {e.message}
              </span>
            </button>
          ))}
        </div>
      )}
      {state.kind === 'codeOnly' && banner && (
        <div className="workflow-code-move">
          <span>
            {t('Uses {feature}, only available in code', {
              feature: state.reason === 'constants' ? t('constants') : t('OR conditions'),
            })}
          </span>
          <label className="workflow-code-silence">
            <input type="checkbox" checked={hideAsk} onChange={(e) => setHideAsk(e.target.checked)} />
            {t("Don't ask again")}
          </label>
          <span className="workflow-code-move-actions">
            <button type="button" className="btn-sm" onClick={() => onMove(hideAsk)}>
              {t('Move to code')}
            </button>
            <button type="button" className="btn-sm" onClick={onKeep}>
              {t('Keep editing')}
            </button>
          </span>
        </div>
      )}
    </div>
  );
}

/** One named block of process code: name, source textarea, live errors. */
function CodeBlockEditor({
  block,
  errors,
  autoFocus,
  registerRef,
  onRename,
  onEdit,
  onDelete,
}: {
  block: WorkflowCodeBlock;
  errors: CodeDiag[];
  autoFocus: boolean;
  registerRef: (key: string, el: HTMLDivElement | null) => void;
  onRename: (name: string) => void;
  onEdit: (source: string) => void;
  onDelete: () => void;
}) {
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const mine = errors.filter((e) => e.block === block.name || e.block === '');

  const jumpToLine = (line: number) => {
    const el = areaRef.current;
    if (!el) return;
    const lines = el.value.split('\n');
    const off = lines.slice(0, Math.max(0, line - 1)).join('\n').length + (line > 1 ? 1 : 0);
    el.focus();
    el.setSelectionRange(off, off);
  };

  return (
    <div
      className="workflow-code-block"
      data-block-id={block.id}
      ref={(el) => registerRef(block.id, el)}
    >
      <div className="workflow-code-block-bar">
        <input
          className="workflow-code-name"
          value={block.name}
          placeholder={t('Block name')}
          onChange={(e) => onRename(e.target.value)}
          aria-label={t('Block name')}
        />
        <span className="workflow-code-count">{t('Rules')}: {block.rules.length}</span>
        <button
          type="button"
          className="icon-btn"
          title={t('Delete block')}
          aria-label={t('Delete block')}
          onClick={onDelete}
        >
          <Trash2 size={14} />
        </button>
      </div>
      <textarea
        ref={areaRef}
        className={'workflow-code-area' + (mine.length > 0 ? ' workflow-code-area-bad' : '')}
        value={block.source}
        placeholder={'rule "Name":\n  when "New" becomes "Done"\n  do:\n    ask comment always'}
        onChange={(e) => onEdit(e.target.value)}
        spellCheck={false}
        rows={10}
        autoFocus={autoFocus}
      />
      {mine.length > 0 && (
        <div className="workflow-code-errors">
          {mine.map((e, i) => (
            <button key={i} type="button" className="workflow-code-error" onClick={() => e.line > 0 && jumpToLine(e.line)}>
              <TriangleAlert size={13} />
              <span>
                {e.line > 0 ? `${t('Line {n}', { n: e.line })}: ` : ''}
                {e.message}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The Code tab: every visual rule as editable text plus one editor per
 *  code block with live server validation. Saving happens with the dialog's
 *  Save button, like everything else here. */
export default function WorkflowCode({
  collectionId,
  schema,
  workflow,
  statusPropId,
  focus,
  onChange,
  onBlockedChange,
}: {
  collectionId: string;
  schema: PropDef[];
  workflow: WorkflowConfig | undefined;
  statusPropId: string;
  focus: { target: string; n: number } | null;
  onChange: (w: WorkflowConfig | undefined) => void;
  onBlockedChange: (ids: string[]) => void;
}) {
  const rules = useMemo(() => workflow?.rules ?? [], [workflow]);
  const blocks = useMemo(() => workflow?.code ?? [], [workflow]);
  const [members, setMembers] = useState<Member[]>([]);
  const [errors, setErrors] = useState<CodeDiag[]>([]);
  // Draft text per rule: present only while the rule differs from generated.
  // A visual edit snaps it back — the model is the truth.
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [states, setStates] = useState<Record<string, RuleState>>({});
  // "Keep editing" per rule: the banner stays away until the text turns
  // compatible again and then code-only once more.
  const [kept, setKept] = useState<Record<string, boolean>>({});
  const refs = useRef(new Map<string, HTMLDivElement>());
  const seqs = useRef<Record<string, number>>({});
  const applied = useRef<Record<string, WorkflowRule>>({});
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(() => {
    let alive = true;
    loadMembers()
      .then((m) => alive && setMembers(m))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // A visual edit snaps that rule's editor back to generated text.
  useEffect(() => {
    setTexts((prev) => {
      if (Object.keys(prev).length === 0) return prev;
      const next = { ...prev };
      let changed = false;
      for (const id of Object.keys(next)) {
        const cur = rules.find((r) => r.id === id);
        if (!cur || cur !== applied.current[id]) {
          delete next[id];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    setStates((prev) => {
      if (Object.keys(prev).length === 0) return prev;
      const next = { ...prev };
      let changed = false;
      for (const id of Object.keys(next)) {
        const cur = rules.find((r) => r.id === id);
        if (!cur || cur !== applied.current[id]) {
          delete next[id];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [rules]);

  // Red rules lock their List rows until fixed or reset.
  const blockedKey = useMemo(
    () =>
      Object.entries(states)
        .filter(([, s]) => s.kind === 'invalid')
        .map(([id]) => id)
        .sort()
        .join('\n'),
    [states],
  );
  const blockedRef = useRef('');
  useEffect(() => {
    if (blockedKey === blockedRef.current) return;
    blockedRef.current = blockedKey;
    onBlockedChange(blockedKey ? blockedKey.split('\n') : []);
  });

  // Live check for code blocks: debounced, against the draft.
  useEffect(() => {
    if (!workflow) {
      setErrors([]);
      return;
    }
    let alive = true;
    const h = setTimeout(() => {
      api
        .validateWorkflow(collectionId, workflow)
        .then((r) => alive && setErrors(r.errors.filter((e) => e.block)))
        .catch(() => {});
    }, 500);
    return () => {
      alive = false;
      clearTimeout(h);
    };
  }, [workflow, collectionId]);

  // A map click lands here with a block id or a rule id.
  useEffect(() => {
    if (!focus) return;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        refs.current.get(focus.target)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }),
    );
  }, [focus]);

  const ruleTitle = (r: WorkflowRule) => {
    const status = schema.find((p) => p.id === statusPropId);
    if (r.when.type === 'created') return t('On creation');
    const toId = r.when.to;
    const to = status?.options?.find((o) => o.id === toId)?.name ?? toId;
    return `${status?.name ?? ''} → ${to}`;
  };

  const generated = (r: WorkflowRule) => generateRuleCode(r, schema, members, statusPropId);

  const applyCompiled = (ruleId: string, rule: WorkflowRule) => {
    if (!workflow) return;
    const next = { ...rule, id: ruleId };
    applied.current[ruleId] = next;
    onChange({ ...workflow, rules: workflow.rules.map((r) => (r.id === ruleId ? next : r)) });
  };

  const moveRuleToCode = (ruleId: string, source: string, silent: boolean) => {
    if (!workflow) return;
    const m = source.match(/^rule\s+"((?:[^"\\]|\\.)*)":/);
    const name = m ? m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\') : t('Moved rule');
    if (timers.current[ruleId]) clearTimeout(timers.current[ruleId]);
    seqs.current[ruleId] = (seqs.current[ruleId] ?? 0) + 1;
    setTexts((p) => {
      const next = { ...p };
      delete next[ruleId];
      return next;
    });
    setStates((p) => {
      const next = { ...p };
      delete next[ruleId];
      return next;
    });
    delete applied.current[ruleId];
    onChange({
      ...workflow,
      rules: workflow.rules.filter((r) => r.id !== ruleId),
      code: [...(workflow.code ?? []), { id: `new_${Date.now().toString(36)}`, name, source, rules: [] }],
    });
    if (silent) toast(t('Rule moved to code'));
  };

  const compileRule = (ruleId: string, source: string) => {
    const seq = (seqs.current[ruleId] ?? 0) + 1;
    seqs.current[ruleId] = seq;
    setStates((p) => ({ ...p, [ruleId]: { kind: 'checking' } }));
    api
      .compileWorkflowRule(collectionId, source, statusPropId)
      .then((r) => {
        if (seqs.current[ruleId] !== seq) return;
        if (r.errors.length > 0) {
          setStates((p) => ({ ...p, [ruleId]: { kind: 'invalid', errors: r.errors } }));
          return;
        }
        if (r.codeOnly && r.rule) {
          setStates((p) => ({ ...p, [ruleId]: { kind: 'codeOnly', reason: r.reason } }));
          if (isSilentMove()) moveRuleToCode(ruleId, source, true);
          return;
        }
        if (r.rule) {
          applyCompiled(ruleId, r.rule);
          setStates((p) => ({ ...p, [ruleId]: { kind: 'valid' } }));
          setKept((p) => {
            if (!p[ruleId]) return p;
            const next = { ...p };
            delete next[ruleId];
            return next;
          });
        }
      })
      .catch(() => {});
  };

  const editRule = (ruleId: string, source: string) => {
    setTexts((p) => ({ ...p, [ruleId]: source }));
    if (timers.current[ruleId]) clearTimeout(timers.current[ruleId]);
    timers.current[ruleId] = setTimeout(() => compileRule(ruleId, source), 500);
  };

  const resetRule = (ruleId: string) => {
    if (timers.current[ruleId]) clearTimeout(timers.current[ruleId]);
    seqs.current[ruleId] = (seqs.current[ruleId] ?? 0) + 1;
    setTexts((p) => {
      const next = { ...p };
      delete next[ruleId];
      return next;
    });
    setStates((p) => {
      const next = { ...p };
      delete next[ruleId];
      return next;
    });
  };

  const keepEditing = (ruleId: string) => setKept((p) => ({ ...p, [ruleId]: true }));

  const setBlocks = (next: WorkflowCodeBlock[]) => {
    if (!workflow) {
      onChange({ statusPropId, rules: [], code: next });
      return;
    }
    onChange({ ...workflow, code: next });
  };

  const addBlock = () => {
    const n = blocks.length + 1;
    setBlocks([
      ...blocks,
      {
        id: `new_${Date.now().toString(36)}`,
        name: `${t('Block')} ${n}`,
        source: '',
        rules: [],
      },
    ]);
  };

  const deleteBlock = async (id: string) => {
    const ok = await confirm(t('Delete this code block?'), { confirmText: t('Delete block'), danger: true });
    if (ok) setBlocks(blocks.filter((b) => b.id !== id));
  };

  return (
    <div className="workflow-code">
      {rules.map((r) => {
        const text = texts[r.id] ?? generated(r);
        const state = states[r.id] ?? { kind: 'clean' as const };
        const banner = state.kind === 'codeOnly' && !kept[r.id] && !isSilentMove();
        return (
          <RuleCodeEditor
            key={r.id}
            rule={r}
            title={ruleTitle(r)}
            text={text}
            state={state}
            banner={banner}
            registerRef={(key, el) => {
              if (el) refs.current.set(key, el);
              else refs.current.delete(key);
            }}
            onEdit={(source) => editRule(r.id, source)}
            onReset={() => resetRule(r.id)}
            onMove={(hide) => {
              if (hide) {
                try {
                  localStorage.setItem(SILENT_MOVE_KEY, '1');
                } catch {
                  /* private mode: ask every time */
                }
              }
              moveRuleToCode(r.id, text, false);
            }}
            onKeep={() => keepEditing(r.id)}
          />
        );
      })}

      {blocks.map((b, i) => (
        <CodeBlockEditor
          key={b.id}
          block={b}
          errors={errors}
          autoFocus={i === blocks.length - 1 && b.source === ''}
          registerRef={(key, el) => {
            if (el) refs.current.set(key, el);
            else refs.current.delete(key);
          }}
          onRename={(name) => setBlocks(blocks.map((x) => (x.id === b.id ? { ...x, name } : x)))}
          onEdit={(source) => setBlocks(blocks.map((x) => (x.id === b.id ? { ...x, source } : x)))}
          onDelete={() => deleteBlock(b.id)}
        />
      ))}

      <button type="button" className="workflow-code-add" onClick={addBlock}>
        <Plus size={14} />
        <span>{t('Add code block')}</span>
      </button>
    </div>
  );
}

/** Locked rows for the List tab: code blocks readable where the visual
 *  rules are edited, edited where the code lives. */
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
