import type { PropDef, WorkflowAction, WorkflowConfig, WorkflowPropCond, WorkflowRule } from './types';
import { api } from './api';
import { promptWorkflow } from './dialog';
import { toast } from './toast';
import { t } from './i18n';
import { checklistItems, loadMembers, type Member } from './components/PropertyValue';

// Client-side mirror of the server guard (server/workflow.go): instant
// feedback before the drag lands. Same OR semantics: only rules whose gate
// opens for this move are checked; foreign gates never block. The server
// stays the source of truth — a 409 rolls the optimistic move back.
//
// A block explains itself: what stops the card and what to do about it —
// the toast at the call site carries it with a shortcut into the process.
export interface BlockHint {
  message: string;
}

export function workflowBlockReason(
  workflow: WorkflowConfig | undefined,
  schema: PropDef[],
  rowProps: Record<string, unknown>,
  from: string,
  to: string,
): BlockHint | null {
  if (!workflow || !workflow.statusPropId || from === to || !to) return null;
  const byId = new Map(schema.map((p) => [p.id, p]));
  const statusDef = byId.get(workflow.statusPropId);
  const optName = (id: string) => statusDef?.options?.find((o) => o.id === id)?.name ?? id;
  const propName = (id: string) => byId.get(id)?.name ?? id;
  const targeted = (workflow.rules ?? []).filter(
    (r) => r.when.type === 'status_to' && (r.when as { to: string }).to === to,
  );
  if (targeted.length === 0) return null;
  const matched = matchRules(workflow, schema, rowProps, from, to);
  const asked = new Set(
    matched.flatMap((r) => (r.do ?? []).filter((a) => a.type === 'require_prop').map((a) => a.prop)),
  );
  if (matched.length === 0) {
    // No rule fires: either the sources or the row values miss. Name the
    // miss — "only from X" lies when the sources are fine but a value is not.
    const valueMiss = firstValueMiss(schema, targeted, rowProps, from);
    if (valueMiss) return { message: valueMiss };
    const froms = [...new Set(targeted.flatMap((r) => r.allowFrom ?? []))].map(optName);
    return {
      message: t('“{to}” only takes cards from {froms} — move it back there first, or loosen the rule in the process.', {
        to: optName(to),
        froms: froms.map((n) => `“${n}”`).join(', '),
      }),
    };
  }
  for (const r of matched) {
    if (r.precondition?.checklistProp && !checklistDone(rowProps[r.precondition.checklistProp])) {
      return {
        message: t('The “{name}” checklist isn’t finished — tick everything off, then move.', {
          name: propName(r.precondition.checklistProp),
        }),
      };
    }
    if (
      r.precondition?.requiredProp &&
      isEmpty(rowProps[r.precondition.requiredProp]) &&
      !asked.has(r.precondition.requiredProp)
    ) {
      return {
        message: t('“{name}” is empty — fill it in, then move.', {
          name: propName(r.precondition.requiredProp),
        }),
      };
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

// Property types a value condition may name. Selects compare option ids,
// multiselects contain them, text and numbers compare as written — every
// other type compares ambiguously, so the editor does not offer it.
export const condPropTypes: PropDef['type'][] = ['select', 'multiselect', 'text', 'number'];

function condValues(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (v === undefined || v === null) return [];
  return [String(v)];
}

/** One row-value condition against the row's current values. Unknown
 *  properties never hold: the rule stays silent rather than misfiring. */
export function propCondHolds(schema: PropDef[], rowProps: Record<string, unknown>, cond: WorkflowPropCond): boolean {
  const def = schema.find((p) => p.id === cond.prop);
  if (!def || !cond.value) return false;
  const vals = condValues(rowProps[cond.prop]);
  const hit =
    def.type === 'multiselect' ? vals.includes(cond.value) : vals.length > 0 && vals[0] === cond.value;
  return cond.op === 'is_not' ? !hit : hit;
}

export function whenPropsHold(
  schema: PropDef[],
  rowProps: Record<string, unknown>,
  rule: WorkflowRule,
): boolean {
  return (rule.whenProps ?? []).every((c) => propCondHolds(schema, rowProps, c));
}

/** Display value of a condition: option names for selects, raw text else. */
export function condDisplay(schema: PropDef[], cond: WorkflowPropCond): string {
  const def = schema.find((p) => p.id === cond.prop);
  if (def && (def.type === 'select' || def.type === 'multiselect')) {
    return def.options?.find((o) => o.id === cond.value)?.name ?? cond.value;
  }
  return cond.value;
}

/** When no rule fires but some targeted rule clears the sources, the miss is
 *  on values: name the first failing condition so the reader knows what to set. */
function firstValueMiss(
  schema: PropDef[],
  targeted: WorkflowRule[],
  rowProps: Record<string, unknown>,
  from: string,
): string | null {
  const propName = (id: string) => schema.find((p) => p.id === id)?.name ?? id;
  for (const r of targeted) {
    if (r.allowFrom && r.allowFrom.length > 0 && !r.allowFrom.includes(from)) continue;
    for (const c of r.whenProps ?? []) {
      if (!propCondHolds(schema, rowProps, c)) {
        return c.op === 'is_not'
          ? t('“{prop}” must not be “{value}” to move here — change it, then move.', {
              prop: propName(c.prop),
              value: condDisplay(schema, c),
            })
          : t('“{prop}” must be “{value}” to move here — set it, then move.', {
              prop: propName(c.prop),
              value: condDisplay(schema, c),
            });
      }
    }
  }
  return null;
}

// A checklist ask is satisfied only when fully ticked — a half-done list
// still opens the dialog. Mirrors requireSatisfied on the server.
function askSatisfied(def: PropDef, always: boolean, v: unknown): boolean {
  if (always) return false;
  return def.type === 'checklist' ? checklistDone(v) : !isEmpty(v);
}

// ---- Move dialog ----
// What a status move still needs from the human. Pure guards (allow-list,
// preconditions, require-steps the row already satisfies) never ask — the
// dialog appears only when there is something to fill. Empty means proceed.

/** One input the move dialog asks for. */
export interface PromptField {
  key: string; // rule + action index, unique per dialog
  label: string;
  kind: 'text' | 'date' | 'person' | 'select' | 'multiselect' | 'checklist' | 'comment';
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
  // One question per field per move: several firing rules may ask for the
  // same thing, and "always" wins over "if empty".
  const seen = new Map<string, { index: number; always: boolean }>();
  const fields: PromptField[] = [];
  const pushField = (key: string, field: PromptField, always: boolean) => {
    const prev = seen.get(key);
    if (!prev) {
      seen.set(key, { index: fields.length, always });
      fields.push(field);
    } else if (always && !prev.always) {
      seen.set(key, prev);
      fields[prev.index] = field;
    }
  };
  for (const r of workflow.rules ?? []) {
    if (r.when.type !== 'status_to' || (r.when as { to: string }).to !== to) continue;
    if (r.allowFrom && r.allowFrom.length > 0 && !r.allowFrom.includes(from)) continue;
    if (!whenPropsHold(schema, rowProps, r)) continue;
    for (let i = 0; i < (r.do ?? []).length; i++) {
      const a = r.do[i];
      if (a.type === 'require_prop') {
        const def = byId.get(a.prop);
        if (!def) continue;
        const always = a.mode === 'always';
        if (askSatisfied(def, always, rowProps[a.prop])) continue;
        const f = await buildPropField(def, `${r.id}:${i}`, a, rowProps[a.prop]);
        pushField(`prop:${a.prop}`, f, always);
      } else if (a.type === 'require_comment') {
        let need = a.mode === 'always';
        if (!need) {
          try {
            need = (await api.listComments(rowId)).length === 0;
          } catch {
            need = true;
          }
        }
        if (need) pushField('comment', { key: `${r.id}:${i}:comment`, label: '', kind: 'comment', value: '' }, a.mode === 'always');
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
  schema: PropDef[],
  baseProps: Record<string, unknown>,
): string | null {
  if (!workflow || !workflow.statusPropId) return null;
  for (const r of workflow.rules ?? []) {
    if (r.when.type !== 'created') continue;
    if (!whenPropsHold(schema, baseProps, r)) continue;
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
          : def.type === 'checklist'
            ? 'checklist'
            : 'text';
}

async function buildPropField(
  def: PropDef,
  key: string,
  a: { prop: string },
  current?: unknown,
): Promise<PromptField> {
  const kind = propFieldKind(def);
  const f: PromptField = {
    key,
    label: def.name,
    kind,
    prop: a.prop,
    value: kind === 'multiselect' ? [] : kind === 'checklist' ? checklistItems(current) : '',
  };
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
    if (!whenPropsHold(schema, baseProps, r)) continue;
    for (let i = 0; i < (r.do ?? []).length; i++) {
      const a = r.do[i];
      if (a.type === 'require_prop') {
        const def = byId.get(a.prop);
        if (!def) continue;
        if (askSatisfied(def, a.mode === 'always', baseProps[a.prop])) continue;
        fields.push(await buildPropField(def, `${r.id}:${i}`, a, baseProps[a.prop]));
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
    | 'bad-propvalue'
    | 'set-checklist'
    | 'conflict'
    | 'ask-dupe'
    | 'ask-req'
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
    case 'bad-propvalue':
      return t('“{value}” is no longer an option of “{prop}”.', {
        value: String(d.name ?? ''),
        prop: String(d.prop ?? ''),
      });
    case 'set-checklist':
      return t('“{name}” is a checklist — it can only be asked for, not set.', { name: String(d.name ?? '') });
    case 'conflict':
      return t('Two rules write to “{prop}” on the way into “{to}” — the last one wins.', { prop: String(d.prop ?? ''), to: String(d.to ?? '') });
    case 'ask-dupe':
      return t('“{prop}” is asked twice on the way into “{to}” — it is asked once.', { prop: String(d.prop ?? ''), to: String(d.to ?? '') });
    case 'ask-req':
      return t('“{prop}” is required and asked on the way into “{to}” — it will be asked once.', { prop: String(d.prop ?? ''), to: String(d.to ?? '') });
    case 'trap':
      return t('Nobody can leave “{name}” — every way out is forbidden.', { name: String(d.name ?? '') });
    case 'unreachable':
      return t('Nobody can move into “{name}” — only creating a row there works.', { name: String(d.name ?? '') });
  }
}

// Two rules co-fire for a target when their gates overlap — an empty gate
// always overlaps, otherwise their allowed sources must intersect. Value
// conditions narrow further: two rules demanding different values (or one
// demanding what the other forbids) for the same property never meet.
function gatesOverlap(a: WorkflowRule, b: WorkflowRule): boolean {
  const fa = a.allowFrom ?? [];
  const fb = b.allowFrom ?? [];
  if (fa.length > 0 && fb.length > 0 && !fa.some((x) => fb.includes(x))) return false;
  for (const ca of a.whenProps ?? []) {
    for (const cb of b.whenProps ?? []) {
      if (ca.prop !== cb.prop || !ca.value || !cb.value) continue;
      if (ca.op === 'is' && cb.op === 'is' && ca.value !== cb.value) return false;
      if (ca.op !== cb.op && ca.value === cb.value) return false;
    }
  }
  return true;
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
          issues.push({ severity: 'error', ruleId: r.id, kind: 'bad-source', data: { name: from, id: from } });
        }
      }
    }
    if (r.precondition?.checklistProp) checkPropRef(r.id, r.precondition.checklistProp, 'checklist');
    if (r.precondition?.requiredProp) checkPropRef(r.id, r.precondition.requiredProp, 'any');
    for (const c of r.whenProps ?? []) {
      const def = c.prop ? byId.get(c.prop) : undefined;
      if (c.prop && (!def || !condPropTypes.includes(def.type))) {
        issues.push({ severity: 'error', ruleId: r.id, kind: 'bad-prop', data: { name: c.prop } });
        continue;
      }
      if (c.op !== 'is' && c.op !== 'is_not') {
        issues.push({ severity: 'error', ruleId: r.id, kind: 'bad-prop', data: { name: c.prop } });
        continue;
      }
      if (
        c.value &&
        def &&
        (def.type === 'select' || def.type === 'multiselect') &&
        !(def.options ?? []).some((o) => o.id === c.value)
      ) {
        issues.push({
          severity: 'error',
          ruleId: r.id,
          kind: 'bad-propvalue',
          data: { name: c.value, prop: def.name ?? c.prop },
        });
      }
    }
    for (const a of r.do ?? []) {
      if (a.type === 'set_prop') {
        const def = a.prop ? byId.get(a.prop) : undefined;
        if (a.prop && def?.type === 'checklist') {
          issues.push({
            severity: 'error',
            ruleId: r.id,
            kind: 'set-checklist',
            data: { name: def.name ?? a.prop, id: a.prop },
          });
        } else {
          checkPropRef(r.id, a.prop, 'any');
        }
      } else if (a.type === 'set_today') checkPropRef(r.id, a.prop, 'date');
      else if (a.type === 'assign_me') checkPropRef(r.id, a.prop, 'person');
      else if (a.type === 'require_prop') {
        const def = a.prop ? byId.get(a.prop) : undefined;
        const ok =
          !!def && ['text', 'date', 'person', 'select', 'multiselect', 'checklist'].includes(def.type);
        if (a.prop && !ok) {
          issues.push({ severity: 'error', ruleId: r.id, kind: 'bad-prop', data: { name: a.prop } });
        }
      }
    }
  }

  // Several rules may write one field or ask one question: harmless when
  // they can never fire together, worth flagging when they can. Two rules
  const coFires = (rs: WorkflowRule[]): boolean =>
    rs.some((a, i) => rs.slice(i + 1).some((b) => gatesOverlap(a, b)));
  const setWriters = new Map<string, WorkflowRule[]>();
  const askers = new Map<string, WorkflowRule[]>();
  const requiredBy = new Map<string, WorkflowRule[]>();
  for (const r of workflow.rules ?? []) {
    if (r.when.type !== 'status_to') continue;
    const to = (r.when as { to: string }).to;
    if (!optIds.has(to)) continue;
    if (r.precondition?.requiredProp) {
      const k = `${to}\0${r.precondition.requiredProp}`;
      if (!requiredBy.has(k)) requiredBy.set(k, []);
      requiredBy.get(k)!.push(r);
    }
    for (const a of r.do ?? []) {
      if (a.type === 'set_prop' && a.prop) {
        const k = `${to}\0${a.prop}`;
        if (!setWriters.has(k)) setWriters.set(k, []);
        setWriters.get(k)!.push(r);
      }
      if (a.type === 'require_prop' && a.prop) {
        const k = `${to}\0${a.prop}`;
        if (!askers.has(k)) askers.set(k, []);
        askers.get(k)!.push(r);
      }
    }
  }
  const propName = (id: string) => byId.get(id)?.name ?? id;
  for (const [k, rs] of setWriters) {
    const [to, prop] = k.split('\0');
    if (rs.length > 1 && coFires(rs)) {
      issues.push({
        severity: 'warning',
        kind: 'conflict',
        data: { to: optName(to), toId: to, prop: propName(prop), propId: prop },
      });
    }
  }
  for (const [k, rs] of askers) {
    const [to, prop] = k.split('\0');
    if (rs.length > 1 && coFires(rs)) {
      issues.push({
        severity: 'warning',
        kind: 'ask-dupe',
        data: { to: optName(to), toId: to, prop: propName(prop), propId: prop },
      });
    }
  }
  // Required and asked on one gate: not a contradiction, the ask fills the
  // requirement — flagged once so the merge is visible.
  for (const [k, rs] of requiredBy) {
    const [to, prop] = k.split('\0');
    const asking = askers.get(k) ?? [];
    const together = [...rs, ...asking];
    if (
      asking.length > 0 &&
      together.some((a, i) => together.slice(i + 1).some((b) => gatesOverlap(a, b)))
    ) {
      issues.push({
        severity: 'warning',
        kind: 'ask-req',
        data: { to: optName(to), toId: to, prop: propName(prop), propId: prop },
      });
    }
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

// All the ways the self-check's fixable findings repair themselves, in one
// place so the issue row is just a button. Pure draft edits — nothing is
// saved until the reader presses Save. Returns null when there is nothing
// safe to do (a trap, a conflict, a truly unknown property).
export function fixWorkflowIssue(
  workflow: WorkflowConfig | undefined,
  schema: PropDef[],
  issue: WorkflowIssue,
): WorkflowConfig | undefined {
  if (!workflow) return undefined;
  const byId = new Map(schema.map((x) => [x.id, x]));
  const rules = workflow.rules ?? [];
  const at = (id?: string | null) => rules.find((r) => r.id === id);
  const d = issue.data ?? {};
  switch (issue.kind) {
    case 'bad-source': {
      // A dead source id simply drops out of the allow-list.
      const r = at(issue.ruleId);
      const dead = String(d.id ?? '');
      if (!r || !(r.allowFrom ?? []).includes(dead)) return undefined;
      const allowFrom = (r.allowFrom ?? []).filter((x) => x !== dead);
      return {
        ...workflow,
        rules: rules.map((x) => (x.id === r.id ? { ...x, allowFrom } : x)),
      };
    }
    case 'set-checklist': {
      // A checklist cannot be set — but it can be asked for, which is
      // almost certainly what the step meant.
      const r = at(issue.ruleId);
      const prop = String(d.id ?? '');
      if (!r || byId.get(prop)?.type !== 'checklist') return undefined;
      let touched = false;
      const do_: WorkflowAction[] = (r.do ?? []).map((a) => {
        if (a.type === 'set_prop' && a.prop === prop) {
          touched = true;
          return { type: 'require_prop', prop, mode: 'if_empty' } as const;
        }
        return a;
      });
      if (!touched) return undefined;
      return { ...workflow, rules: rules.map((x) => (x.id === r.id ? { ...x, do: do_ } : x)) };
    }
    case 'ask-dupe': {
      // Several firing rules ask one field: keep the one the dialog would
      // ask anyway ("always" beats "if empty", otherwise the first).
      const to = String(d.toId ?? '');
      const prop = String(d.propId ?? '');
      const firing = rules.filter(
        (r) =>
          r.when.type === 'status_to' &&
          (r.when as { to: string }).to === to &&
          (r.do ?? []).some((a) => a.type === 'require_prop' && a.prop === prop),
      );
      if (firing.length < 2 || !firing.some((a, i) => firing.slice(i + 1).some((b) => gatesOverlap(a, b)))) {
        return undefined;
      }
      const cands: { rule: WorkflowRule; idx: number; always: boolean }[] = [];
      for (const r of firing) {
        (r.do ?? []).forEach((a, idx) => {
          if (a.type !== 'require_prop' || a.prop !== prop) return;
          cands.push({ rule: r, idx, always: (a as { mode?: string }).mode === 'always' });
        });
      }
      // The dialog asks once: "always" wins over "if empty", otherwise order.
      const best = cands.find((c) => c.always) ?? cands[0];
      if (!best) return undefined;
      const drop = new Set(firing.flatMap((r) => (r.do ?? []).map((_, idx) => `${r.id}${idx}`)));
      drop.delete(`${best.rule.id}${best.idx}`);
      if (drop.size === 0) return undefined;
      return {
        ...workflow,
        rules: rules.map((r) => {
          if (!firing.some((f) => f.id === r.id)) return r;
          return { ...r, do: (r.do ?? []).filter((_, idx) => !drop.has(`${r.id}${idx}`)) };
        }),
      };
    }
    case 'ask-req': {
      // The ask already fills the requirement — drop the redundant gate.
      const to = String(d.toId ?? '');
      const prop = String(d.propId ?? '');
      const asking = rules.filter(
        (r) =>
          r.when.type === 'status_to' &&
          (r.when as { to: string }).to === to &&
          (r.do ?? []).some((a) => a.type === 'require_prop' && a.prop === prop),
      );
      const needing = rules.filter(
        (r) =>
          r.when.type === 'status_to' &&
          (r.when as { to: string }).to === to &&
          r.precondition?.requiredProp === prop,
      );
      const together = [...needing, ...asking];
      if (
        asking.length === 0 ||
        needing.length === 0 ||
        !together.some((a, i) => together.slice(i + 1).some((b) => gatesOverlap(a, b)))
      ) {
        return undefined;
      }
      return {
        ...workflow,
        rules: rules.map((r) => {
          if (!needing.some((n) => n.id === r.id)) return r;
          if (!asking.some((a) => gatesOverlap(r, a))) return r;
          if (!r.precondition?.checklistProp) {
            const { precondition: _drop, ...kept } = r;
            void _drop;
            return kept;
          }
          return { ...r, precondition: { ...r.precondition, requiredProp: undefined } };
        }),
      };
    }
    default:
      return undefined;
  }
}

/** Rules whose trigger matches this move, in order. Value conditions read
 *  the row as it stands (pre-dialog answers are not in it yet). */
export function matchRules(
  workflow: WorkflowConfig | undefined,
  schema: PropDef[],
  rowProps: Record<string, unknown>,
  from: string,
  to: string,
): WorkflowRule[] {
  if (!workflow || !workflow.statusPropId) return [];
  return (workflow.rules ?? []).filter((r) => {
    if (r.when.type !== 'status_to' || (r.when as { to: string }).to !== to) return false;
    if (!whenPropsHold(schema, rowProps, r)) return false;
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
