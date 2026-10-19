import type { PropDef, WorkflowConfig } from './types';
import { api } from './api';
import { promptWorkflow } from './dialog';
import { toast } from './toast';
import { t } from './i18n';
import { loadMembers, type Member } from './components/PropertyValue';

// Client-side mirror of the server guard (server/workflow.go): instant
// feedback before the drag lands. The server stays the source of truth —
// a 409 rolls the optimistic move back.
export function workflowBlockReason(
  workflow: WorkflowConfig | undefined,
  rowProps: Record<string, unknown>,
  from: string,
  to: string,
): string | null {
  if (!workflow || !workflow.statusPropId || from === to || !to) return null;
  for (const r of workflow.rules ?? []) {
    if (r.when.type !== 'status_to' || (r.when as { to: string }).to !== to) continue;
    if (r.allowFrom && r.allowFrom.length > 0 && !r.allowFrom.includes(from)) {
      return 'This status cannot be reached from here.';
    }
    if (r.precondition?.checklistProp && !checklistDone(rowProps[r.precondition.checklistProp])) {
      return 'Finish the checklist first.';
    }
    if (r.precondition?.requiredProp && isEmpty(rowProps[r.precondition.requiredProp])) {
      return 'Fill the required property first.';
    }
  }
  return null;
}

function checklistDone(v: unknown): boolean {
  if (!Array.isArray(v) || v.length === 0) return false;
  return (v as { done?: boolean }[]).every((it) => !!it?.done);
}

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

// ---- Move dialog ----
// What a status move still needs from the human. Pure guards (allow-list,
// preconditions, require-steps the row already satisfies) never ask — the
// dialog appears only when there is something to fill. Empty means proceed.

/** One input the move dialog asks for. */
export interface PromptField {
  key: string; // rule + action index, unique per dialog
  label: string;
  kind: 'text' | 'date' | 'person' | 'select' | 'multiselect' | 'comment';
  prop?: string;
  options?: { id: string; name: string }[];
  members?: Member[];
  value: unknown;
}

export async function neededPrompts(
  workflow: WorkflowConfig | undefined,
  schema: PropDef[],
  rowId: string,
  rowProps: Record<string, unknown>,
  from: string,
  to: string,
): Promise<PromptField[]> {
  if (!workflow || !workflow.statusPropId || from === to || !to) return [];
  const byId = new Map(schema.map((p) => [p.id, p]));
  const fields: PromptField[] = [];
  for (const r of workflow.rules ?? []) {
    if (r.when.type !== 'status_to' || (r.when as { to: string }).to !== to) continue;
    if (r.allowFrom && r.allowFrom.length > 0 && !r.allowFrom.includes(from)) continue;
    for (let i = 0; i < (r.do ?? []).length; i++) {
      const a = r.do[i];
      if (a.type === 'require_prop') {
        const def = byId.get(a.prop);
        if (!def) continue;
        if (a.mode !== 'always' && !isEmpty(rowProps[a.prop])) continue;
        const kind =
          def.type === 'date'
            ? 'date'
            : def.type === 'person'
              ? 'person'
              : def.type === 'select'
                ? 'select'
                : def.type === 'multiselect'
                  ? 'multiselect'
                  : 'text';
        const f: PromptField = {
          key: `${r.id}:${i}`,
          label: def.name,
          kind,
          prop: a.prop,
          value: kind === 'multiselect' ? [] : '',
        };
        if (kind === 'select' || kind === 'multiselect') {
          f.options = (def.options ?? []).map((o) => ({ id: o.id, name: o.name }));
        }
        if (kind === 'person') f.members = await loadMembers();
        fields.push(f);
      } else if (a.type === 'require_comment') {
        let need = a.mode === 'always';
        if (!need) {
          try {
            need = (await api.listComments(rowId)).length === 0;
          } catch {
            need = true;
          }
        }
        if (need) fields.push({ key: `${r.id}:${i}:comment`, label: '', kind: 'comment', value: '' });
      }
    }
  }
  return fields;
}

/** Preconditions of creation rules, checked against what the row will carry
 *  (template values under the button's preset). A fresh row fails most of
 *  them by definition — refuse before anything exists, not after a stray
 *  copy is already made. */
export function creationBlockReason(
  workflow: WorkflowConfig | undefined,
  baseProps: Record<string, unknown>,
): string | null {
  if (!workflow || !workflow.statusPropId) return null;
  for (const r of workflow.rules ?? []) {
    if (r.when.type !== 'created') continue;
    if (r.precondition?.checklistProp && !checklistDone(baseProps[r.precondition.checklistProp])) {
      return 'Finish the checklist first.';
    }
    if (r.precondition?.requiredProp && isEmpty(baseProps[r.precondition.requiredProp])) {
      return 'Fill the required property first.';
    }
  }
  return null;
}

function propFieldKind(def: PropDef): PromptField['kind'] {
  return def.type === 'date'
    ? 'date'
    : def.type === 'person'
      ? 'person'
      : def.type === 'select'
        ? 'select'
        : def.type === 'multiselect'
          ? 'multiselect'
          : 'text';
}

async function buildPropField(
  def: PropDef,
  key: string,
  a: { prop: string },
): Promise<PromptField> {
  const kind = propFieldKind(def);
  const f: PromptField = { key, label: def.name, kind, prop: a.prop, value: kind === 'multiselect' ? [] : '' };
  if (kind === 'select' || kind === 'multiselect') {
    f.options = (def.options ?? []).map((o) => ({ id: o.id, name: o.name }));
  }
  if (kind === 'person') f.members = await loadMembers();
  return f;
}

/** What creating a row still needs from the human. Same steps as a move,
 *  but there is no row yet: comment conditions always ask, and the base is
 *  what the row will carry (template values under the button's preset). */
export async function neededCreationPrompts(
  workflow: WorkflowConfig | undefined,
  schema: PropDef[],
  baseProps: Record<string, unknown>,
): Promise<PromptField[]> {
  if (!workflow || !workflow.statusPropId) return [];
  const byId = new Map(schema.map((p) => [p.id, p]));
  const fields: PromptField[] = [];
  for (const r of workflow.rules ?? []) {
    if (r.when.type !== 'created') continue;
    for (let i = 0; i < (r.do ?? []).length; i++) {
      const a = r.do[i];
      if (a.type === 'require_prop') {
        const def = byId.get(a.prop);
        if (!def) continue;
        if (a.mode !== 'always' && !isEmpty(baseProps[a.prop])) continue;
        fields.push(await buildPropField(def, `${r.id}:${i}`, a));
      } else if (a.type === 'require_comment') {
        fields.push({ key: `${r.id}:${i}:comment`, label: '', kind: 'comment', value: '' });
      }
    }
  }
  return fields;
}

/** Fold dialog answers back into a props patch. Person answers are member
 *  ids, stored the way person cells store them (a list). */
export function answersToPatch(
  fields: PromptField[],
  answers: Record<string, unknown>,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.kind === 'comment' || f.prop === undefined) continue;
    const v = answers[f.key];
    patch[f.prop] = f.kind === 'person' ? (typeof v === 'string' && v ? [v] : []) : v;
  }
  return patch;
}

export function commentAnswer(
  fields: PromptField[],
  answers: Record<string, unknown>,
): string | null {
  for (const f of fields) {
    if (f.kind !== 'comment') continue;
    const v = answers[f.key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/** The whole move handshake in one call. Returns null when the mover backs
 *  out of the dialog — then nothing may be written, the card stays. */
export async function planStatusMove(
  workflow: WorkflowConfig | undefined,
  schema: PropDef[],
  rowId: string,
  rowProps: Record<string, unknown>,
  from: string,
  to: string,
  toName: string,
): Promise<{ patch: Record<string, unknown>; comment: string | null } | null> {
  const fields = await neededPrompts(workflow, schema, rowId, rowProps, from, to);
  if (fields.length === 0) return { patch: {}, comment: null };
  const answers = await promptWorkflow(`Move to ${toName}?`, fields);
  if (!answers) return null;
  return { patch: answersToPatch(fields, answers), comment: commentAnswer(fields, answers) };
}

/** Post the move's comment to the row's own comments. Best-effort: the move
 *  stands even if the comment fails, and the reader is told. */
export async function postMoveComment(rowId: string, comment: string | null): Promise<void> {
  if (!comment) return;
  try {
    await api.createComment(rowId, comment);
  } catch {
    toast(t('Comment not saved'));
  }
}
