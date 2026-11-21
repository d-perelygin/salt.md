import { useEffect, useMemo, useRef, useState } from 'react';
import { Lock, Plus, Trash2, TriangleAlert } from 'lucide-react';
import type { PropDef, WorkflowCodeBlock, WorkflowConfig } from '../types';
import { api } from '../api';
import { t } from '../i18n';
import { confirm } from '../dialog';
import { loadMembers, type Member } from './PropertyValue';
import { generateWorkflowCode } from '../workflow';

export type CodeDiag = { block: string; line: number; message: string };

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
  registerRef: (id: string, el: HTMLDivElement | null) => void;
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

/** The Code tab: a read-only rendering of the visual rules plus one editor
 *  per code block with live server validation. Saving happens with the
 *  dialog's Save button, like everything else here. */
export default function WorkflowCode({
  collectionId,
  schema,
  workflow,
  statusPropId,
  focus,
  onChange,
}: {
  collectionId: string;
  schema: PropDef[];
  workflow: WorkflowConfig | undefined;
  statusPropId: string;
  focus: { blockId: string; n: number } | null;
  onChange: (w: WorkflowConfig | undefined) => void;
}) {
  const blocks = useMemo(() => workflow?.code ?? [], [workflow]);
  const [members, setMembers] = useState<Member[]>([]);
  const [errors, setErrors] = useState<CodeDiag[]>([]);
  const blockRefs = useRef(new Map<string, HTMLDivElement>());

  useEffect(() => {
    let alive = true;
    loadMembers()
      .then((m) => alive && setMembers(m))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const preview = useMemo(
    () => generateWorkflowCode(workflow ? { ...workflow, code: [] } : undefined, schema, members),
    [workflow, schema, members],
  );

  // Live check: debounced, against the draft (saved and unsaved alike).
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

  // A map click on a code edge lands here with its block id.
  useEffect(() => {
    if (!focus) return;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        blockRefs.current.get(focus.blockId)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }),
    );
  }, [focus]);

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
      <div className="workflow-code-preview">
        <div className="workflow-code-label">{t('Visual rules as code (read-only)')}</div>
        {preview ? (
          <pre className="workflow-code-pre">{preview}</pre>
        ) : (
          <div className="dialog-hint">{t('No visual rules to show.')}</div>
        )}
      </div>

      {blocks.map((b, i) => (
        <CodeBlockEditor
          key={b.id}
          block={b}
          errors={errors}
          autoFocus={i === blocks.length - 1 && b.source === ''}
          registerRef={(id, el) => {
            if (el) blockRefs.current.set(id, el);
            else blockRefs.current.delete(id);
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
