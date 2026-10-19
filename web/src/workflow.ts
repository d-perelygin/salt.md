import type { PropDef, WorkflowConfig, WorkflowRule } from './types';
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

/** A finding of the process self-check. Errors block saving (the server
 *  would reject the same thing); warnings explain what to double-check. */
export interface WorkflowIssue {
  severity: 'error' | 'warning';
  ruleId?: string;
  kind:
    | 'bad-status'
    | 'bad-target'
    | 'bad-source'
    | 'bad-prop'
    | 'duplicate'
    | 'trap'
    | 'unreachable';
  /** Names/ids the message is built from. */
  data?: Record<string, string | number>;
}

export function issueText(issue: WorkflowIssue): string {
  const d = issue.data ?? {};
  switch (issue.kind) {
    case 'bad-status':
      return t('The status property is missing or is not a Select — pick one above.');
    case 'bad-target':
      return t('Rule points at “{name}”, which is no longer a status option.', { name: String(d.name ?? '') });
    case 'bad-source':
      return t('“Only from” names “{name}”, which is no longer a status option.', { name: String(d.name ?? '') });
    case 'bad-prop':
      return t('“{name}” is not usable here — the property is gone or has the wrong type.', { name: String(d.name ?? '') });
    case 'duplicate':
      return t('{n} rules fire on “{name}” — they all run, in order.', { n: String(d.count ?? 2), name: String(d.name ?? '') });
    case 'trap':
      return t('Nobody can leave “{name}” — every way out is forbidden.', { name: String(d.name ?? '') });
    case 'unreachable':
      return t('Nobody can move into “{name}” — only creating a row there works.', { name: String(d.name ?? '') });
  }
}

/** Static self-check of the whole process: broken references (errors) plus
 *  structural traps a card can never escape (warnings). Pure logic, no I/O. */
export function analyzeWorkflow(workflow: WorkflowConfig | undefined, schema: PropDef[]): WorkflowIssue[] {
  const issues: WorkflowIssue[] = [];
  if (!workflow || !workflow.statusPropId) return issues;
  const byId = new Map(schema.map((p) => [p.id, p]));
  const status = byId.get(workflow.statusPropId);
  if (!status || status.type !== 'select') {
    return [{ severity: 'error', kind: 'bad-status' }];
  }
  const opts = status.options ?? [];
  const optIds = new Set(opts.map((o) => o.id));
  const optName = (id: string) => opts.find((o) => o.id === id)?.name ?? id;

  const checkPropRef = (ruleId: string, propId: string | undefined, want: PropDef['type'] | 'any'): boolean => {
    if (!propId) return true; // blank means draft, not broken
    const def = propId ? byId.get(propId) : undefined;
    const ok = !!def && (want === 'any' || def.type === want);
    if (!ok) issues.push({ severity: 'error', ruleId, kind: 'bad-prop', data: { name: propId } });
    return ok;
  };

  for (const r of workflow.rules ?? []) {
    if (r.when.type === 'status_to') {
      const to = (r.when as { to: string }).to;
      if (!optIds.has(to)) {
        issues.push({ severity: 'error', ruleId: r.id, kind: 'bad-target', data: { name: to } });
        continue;
      }
      for (const from of r.allowFrom ?? []) {
        if (!optIds.has(from)) {
          issues.push({ severity: 'error', ruleId: r.id, kind: 'bad-source', data: { name: from } });
        }
      }
    }
    if (r.precondition?.checklistProp) checkPropRef(r.id, r.precondition.checklistProp, 'checklist');
    if (r.precondition?.requiredProp) checkPropRef(r.id, r.precondition.requiredProp, 'any');
    for (const a of r.do ?? []) {
      if (a.type === 'set_prop') checkPropRef(r.id, a.prop, 'any');
      else if (a.type === 'set_today') checkPropRef(r.id, a.prop, 'date');
      else if (a.type === 'assign_me') checkPropRef(r.id, a.prop, 'person');
      else if (a.type === 'require_prop') {
        const def = a.prop ? byId.get(a.prop) : undefined;
        const ok =
          !!def && ['text', 'date', 'person', 'select', 'multiselect'].includes(def.type);
        if (a.prop && !ok) {
          issues.push({ severity: 'error', ruleId: r.id, kind: 'bad-prop', data: { name: a.prop } });
        }
      }
    }
  }

  // Several rules on one transition stack rather than override — worth
  // knowing, not worth forbidding.
  const byTarget = new Map<string, number>();
  for (const r of workflow.rules ?? []) {
    if (r.when.type !== 'status_to') continue;
    const to = (r.when as { to: string }).to;
    if (!optIds.has(to)) continue;
    byTarget.set(to, (byTarget.get(to) ?? 0) + 1);
  }
  for (const [to, n] of byTarget) {
    if (n > 1) issues.push({ severity: 'warning', kind: 'duplicate', data: { count: n, name: optName(to) } });
  }

  // Reachability on the allowed graph. No rule = allowed; a rule with an
  // empty source list = allowed; otherwise only the listed sources pass.
  if (opts.length > 1) {
    const targets = new Map<string, WorkflowRule[]>();
    for (const r of workflow.rules ?? []) {
      if (r.when.type !== 'status_to') continue;
      const to = (r.when as { to: string }).to;
      if (!optIds.has(to)) continue;
      if (!targets.has(to)) targets.set(to, []);
      targets.get(to)!.push(r);
    }
    const allowed = (from: string, to: string): boolean => {
      if (from === to) return false;
      const rules = targets.get(to) ?? [];
      if (rules.length === 0) return true;
      return rules.some((r) => !r.allowFrom || r.allowFrom.length === 0 || r.allowFrom.includes(from));
    };
    for (const o of opts) {
      const out = opts.some((t) => allowed(o.id, t.id));
      if (!out) issues.push({ severity: 'warning', kind: 'trap', data: { name: o.name } });
      const inn = opts.some((s) => allowed(s.id, o.id));
      if (!inn) issues.push({ severity: 'warning', kind: 'unreachable', data: { name: o.name } });
    }
  }
  return issues;
}

/** Rules whose trigger matches this move, in order. */
export function matchRules(
  workflow: WorkflowConfig | undefined,
  from: string,
  to: string,
): WorkflowRule[] {
  if (!workflow || !workflow.statusPropId) return [];
  return (workflow.rules ?? []).filter((r) => {
    if (r.when.type !== 'status_to' || (r.when as { to: string }).to !== to) return false;
    return !r.allowFrom || r.allowFrom.length === 0 || r.allowFrom.includes(from);
  });
}

/** One line per automatic step, for the simulator ("what will happen").
 *  Asked-for steps are not listed here — the simulator shows them as
 *  questions, from the same helper the move dialog uses. */
export function describeAutoActions(rule: WorkflowRule, schema: PropDef[]): string[] {
  const name = (id: string | undefined) =>
    (id && schema.find((p) => p.id === id)?.name) || id || '—';
  const optName = (propId: string, v: unknown): string => {
    const def = schema.find((p) => p.id === propId);
    if (!def) return String(v ?? '');
    if (def.type === 'person') return t('Set {prop}', { prop: name(propId) });
    if (def.type === 'select' || def.type === 'multiselect') {
      const names = (Array.isArray(v) ? v : [v]).map(
        (id) => def.options?.find((o) => o.id === id)?.name ?? String(id),
      );
      return t('Set {prop} to {value}', {
        prop: name(propId),
        value: names.filter(Boolean).join(', '),
      });
    }
    return t('Set {prop} to {value}', { prop: name(propId), value: String(v ?? '') });
  };
  const out: string[] = [];
  for (const a of rule.do ?? []) {
    switch (a.type) {
      case 'set_prop':
        out.push(optName(a.prop, (a as { value?: unknown }).value));
        break;
      case 'set_today':
        out.push(t('Stamp today into {prop}', { prop: name(a.prop) }));
        break;
      case 'assign_me':
        out.push(t('Assign the mover to {prop}', { prop: name(a.prop) }));
        break;
      case 'webhook':
        out.push(t('Call a webhook'));
        break;
      default:
        break;
    }
  }
  return out;
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
