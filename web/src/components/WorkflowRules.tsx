import { Fragment, useEffect, useState } from 'react';
import type { PropDef, WorkflowAction, WorkflowConfig, WorkflowRule } from '../types';
import { t } from '../i18n';
import { SelectCell, loadMembers, type Member } from './PropertyValue';
import { confirm } from '../dialog';
import WorkflowDateInput from './WorkflowDateInput';
import {
  analyzeWorkflow,
  describeAutoActions,
  fixWorkflowIssue,
  issueText,
  matchRules,
  neededPrompts,
  type PromptField,
  type WorkflowIssue,
} from '../workflow';

let ruleCounter = 0;
const newRuleId = () => `rule_${Date.now().toString(36)}_${ruleCounter++}`;


/** A new rule points at the second status, not the first: the first one is
 *  usually where a row starts, so a transition into it is the rare case. */
function defaultTargetId(options: { id: string }[] | undefined): string {
  if (!options || options.length === 0) return '';
  return (options[1] ?? options[0]).id;
}

export default function WorkflowRules({
  schema,
  workflow,
  onChange,
  highlightRuleId,
}: {
  schema: PropDef[];
  workflow: WorkflowConfig | undefined;
  highlightRuleId?: string | null;
  onChange: (w: WorkflowConfig | undefined) => void;
}) {
  const selectProps = schema.filter((p) => p.type === 'select');
  // A stale statusPropId (the property was deleted or retyped since) must not
  // leave the tab dead: fall back to the first select, like a fresh start.
  const statusPropId =
    (workflow?.statusPropId && schema.some((p) => p.id === workflow.statusPropId && p.type === 'select')
      ? workflow.statusPropId
      : selectProps[0]?.id) ?? '';
  const rules = workflow?.rules ?? [];

  const statusProp = schema.find((p) => p.id === statusPropId);
  const statusOpts = statusProp?.options ?? [];

  const commit = (next: WorkflowConfig | undefined) => onChange(next);

  const setStatus = (id: string) => {
    const prop = schema.find((p) => p.id === id);
    const firstOpt = defaultTargetId(prop?.options);
    const kept = (workflow?.rules ?? []).filter((r) =>
      r.when.type === 'created' ? true : (prop?.options ?? []).some((o) => o.id === (r.when as { to: string }).to),
    );
    commit({ statusPropId: id, rules: kept.map((r) => (r.when.type === 'status_to' && firstOpt && !(prop?.options ?? []).some((o) => o.id === (r.when as { to: string }).to) ? r : r)) });
  };

  const updateRule = (id: string, patch: Partial<WorkflowRule>) =>
    commit({ statusPropId, rules: rules.map((r) => (r.id === id ? { ...r, ...patch } : r)) });

  const [openRule, setOpenRule] = useState<string | null>(rules[0]?.id ?? null);
  const [newTarget, setNewTarget] = useState('');
  // List edits the rules; Scheme is a read-only map of where cards can go.
  const [view, setView] = useState<'list' | 'scheme'>('list');
  useEffect(() => {
    if (highlightRuleId) setOpenRule(highlightRuleId);
  }, [highlightRuleId]);

  // Groups by entry: every status with rules gets its own gate section, plus
  // one for creation. Ungrouped "to" values (a deleted option) fall through
  // to a repairs section below — they are also save errors.
  type Group = { key: string; title: string; rules: WorkflowRule[]; when: WorkflowRule['when'] };
  const optName = (id: string) => statusOpts.find((o) => o.id === id)?.name ?? id;
  const groups: Group[] = statusOpts
    .map((o) => ({
      key: `to:${o.id}`,
      title: o.name,
      rules: rules.filter((r) => r.when.type === 'status_to' && (r.when as { to: string }).to === o.id),
      when: { type: 'status_to', to: o.id } as WorkflowRule['when'],
    }))
    .filter((g) => g.rules.length > 0);
  const createdRules = rules.filter((r) => r.when.type === 'created');
  if (createdRules.length > 0) {
    groups.push({ key: 'created', title: '', rules: createdRules, when: { type: 'created' } });
  }
  const orphaned = rules.filter(
    (r) => r.when.type === 'status_to' && !statusOpts.some((o) => o.id === (r.when as { to: string }).to),
  );

  // One flat render list so headers sit exactly above their rules
  // rules; a rule that lost its target renders bare (still flagged above).
  type RowItem =
    | { kind: 'head'; key: string; group: Group }
    | { kind: 'rule'; key: string; rule: WorkflowRule };
  const flatList: RowItem[] = [];
  for (const g of groups) {
    flatList.push({ kind: 'head', key: g.key + ':h', group: g });
    for (const r of g.rules) flatList.push({ kind: 'rule', key: r.id, rule: r });
  }
  for (const r of orphaned) flatList.push({ kind: 'rule', key: r.id, rule: r });

  const addSeparateRule = (when: WorkflowRule['when']) => {
    const r: WorkflowRule = { id: newRuleId(), when, do: [] };
    commit({ statusPropId, rules: [...rules, r] });
    setOpenRule(r.id);
  };

  // The target picker suggests the second still-gateless status (the first
  // one is usually where rows start), or the only one left, or — when every
  // status already has a gate — the usual default for a second branch.
  // The suggestion is just a preselect: every status stays pickable.
  const bareTargets = statusOpts
    .filter((o) => !groups.some((g) => g.key === `to:${o.id}`))
    .map((o) => o.id);
  const smartTarget = bareTargets[1] ?? bareTargets[0] ?? defaultTargetId(statusOpts);
  const effTarget =
    newTarget === '__created' || statusOpts.some((o) => o.id === newTarget) ? newTarget : smartTarget;
  const addRule = () => {
    addSeparateRule(effTarget === '__created' ? { type: 'created' } : { type: 'status_to', to: effTarget });
    setNewTarget('');
  };

  // One-click repairs for the self-check's safe findings: a dead source
  // drops out, a set-on-checklist becomes an ask, a doubled ask or a
  // required-plus-asked collapses to one. Draft only — Save still applies.
  // bad-target deletes through the rule's own confirm; a broken status id
  // never reaches the check (the tab falls back to the first select).
  const fixableKinds = new Set(['bad-source', 'set-checklist', 'ask-dupe', 'ask-req', 'bad-target']);
  const applyFix = (iss: WorkflowIssue) => {
    if (iss.kind === 'bad-target' && iss.ruleId) {
      void askRemoveRule(iss.ruleId);
      return;
    }
    const next = fixWorkflowIssue(workflow, schema, iss);
    if (next) {
      commit(next);
      if (iss.ruleId) setOpenRule(iss.ruleId);
    }
  };

  const askRemoveRule = async (id: string) => {
    const ok = await confirm(t('Delete this rule?'), { confirmText: t('Delete rule'), danger: true });
    if (!ok) return;
    if (openRule === id) setOpenRule(null);
    commit({ statusPropId, rules: rules.filter((r) => r.id !== id) });
  };

  // Self-check over the draft: broken references block saving, structural
  // traps just warn. Recomputed on every keystroke, like everything here.
  const issues = analyzeWorkflow(statusPropId ? { statusPropId, rules } : undefined, schema);
  const errorRules = new Set(
    issues.filter((i) => i.severity === 'error' && i.ruleId).map((i) => i.ruleId!),
  );

  // Try-a-move simulator: what a transition from the chosen status does —
  // passes, asks or refuses, and why. Read-only, never writes.
  interface SimRow {
    to: string;
    toName: string;
    verdict: 'ok' | 'ask' | 'blocked';
    detail: string[];
  }
  const [simFrom, setSimFrom] = useState('');
  const [simRows, setSimRows] = useState<SimRow[] | null>(null);
  const [simBusy, setSimBusy] = useState(false);
  const [ifOpen, setIfOpen] = useState<Record<string, boolean>>({});
  const hasIf = (r: WorkflowRule) =>
    (r.allowFrom?.length ?? 0) > 0 || !!r.precondition?.checklistProp || !!r.precondition?.requiredProp;
  // A filled If shows itself; an empty one stays tucked away. The toggle
  // only records explicit collapses/opens on top of that.
  const isIfOpen = (r: WorkflowRule) => ifOpen[r.id] ?? hasIf(r);
  const runSimulation = async (from: string) => {
    setSimBusy(true);
    try {
      const rows: SimRow[] = [];
      for (const o of statusOpts) {
        if (o.id === from) continue;
        const matched = matchRules(workflow, from, o.id);
        const targeted = (rules ?? []).filter(
          (r) => r.when.type === 'status_to' && (r.when as { to: string }).to === o.id,
        );
        if (targeted.length > 0 && matched.length === 0) {
          const fromName = statusOpts.find((x) => x.id === from)?.name ?? from;
          rows.push({
            to: o.id,
            toName: o.name,
            verdict: 'blocked',
            detail: [t('Not allowed from {from}', { from: fromName })],
          });
          continue;
        }
        const detail: string[] = [];
        for (const r of targeted) {
          if (matched.includes(r)) continue;
          const need = (r.allowFrom ?? []).map((id) => statusOpts.find((x) => x.id === id)?.name ?? id);
          detail.push(t('Skipped — needs {from}', { from: need.join(', ') }));
        }
        const fields = await neededPrompts(workflow, schema, '', {}, from, o.id);
        for (const f of fields) detail.push(f.kind === 'comment' ? t('Comment') : f.label);
        if (matched.length > 1) detail.push(t('Several rules fire here'));
        const asked = new Set(
          matched.flatMap((r) => (r.do ?? []).filter((a) => a.type === 'require_prop').map((a) => a.prop)),
        );
        for (const r of matched) {
          detail.push(...describeAutoActions(r, schema));
          if (r.precondition?.checklistProp) {
            const n = schema.find((p) => p.id === r.precondition!.checklistProp)?.name ?? r.precondition.checklistProp;
            detail.push(t('{name} must be complete', { name: n }));
          }
          // A required field the rules ask for shows up once, as a question
          // above — not as a dead end here.
          if (r.precondition?.requiredProp && !asked.has(r.precondition.requiredProp)) {
            const n = schema.find((p) => p.id === r.precondition!.requiredProp)?.name ?? r.precondition.requiredProp;
            detail.push(t('{name} must be filled', { name: n }));
          }
        }
        rows.push({ to: o.id, toName: o.name, verdict: fields.length > 0 ? 'ask' : 'ok', detail });
      }
      setSimRows(rows);
    } finally {
      setSimBusy(false);
    }
  };


  if (selectProps.length === 0) {
    return (
      <div className="dialog-hint">
        {t('Add a Select property first — a process needs a status to drive.')}
      </div>
    );
  }

  return (
    <div className="workflow-list">
      <div className="workflow-view-toggle" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={view === 'list'}
          className={'workflow-view-tab' + (view === 'list' ? ' workflow-view-tab-on' : '')}
          onClick={() => setView('list')}
        >
          {t('List')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'scheme'}
          className={'workflow-view-tab' + (view === 'scheme' ? ' workflow-view-tab-on' : '')}
          onClick={() => setView('scheme')}
        >
          {t('Scheme')}
        </button>
      </div>
      {view === 'list' ? (
      <>
      <label className="schema-template-row">
        <span>{t('Status property')}</span>
        <select className="prop-select" value={statusPropId} onChange={(e) => setStatus(e.target.value)}>
          {selectProps.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>

      {rules.length === 0 && (
        <div className="dialog-hint">
          {workflow?.statusPropId
            ? t('No rules — saving clears the stored process. Add one to keep it.')
            : t('No rules yet. A rule reads like a sentence: when the status changes, then do something.')}
        </div>
      )}

      {issues.length > 0 && (
        <div className="workflow-issues">
          {issues.map((iss, i) =>
            iss.ruleId ? (
              <button
                key={i}
                type="button"
                className={'workflow-issue ' + (iss.severity === 'error' ? 'workflow-issue-error' : 'workflow-issue-warn')}
                onClick={() => {
                  setOpenRule(iss.ruleId!);
                  if (iss.kind === 'bad-source' || iss.kind === 'bad-prop' || iss.kind === 'set-checklist') {
                    setIfOpen((p) => ({ ...p, [iss.ruleId as string]: true }));
                  }
                }}
              >
                <span>
                  {iss.severity === 'error' ? '✕ ' : '! '}{issueText(iss)}
                </span>
                {fixableKinds.has(iss.kind) && (
                  <span
                    role="button"
                    tabIndex={0}
                    className="workflow-fix"
                    onClick={(e) => {
                      e.stopPropagation();
                      applyFix(iss);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        e.stopPropagation();
                        applyFix(iss);
                      }
                    }}
                  >
                    {t('Fix')}
                  </span>
                )}
              </button>
            ) : (
              <div
                key={i}
                className={'workflow-issue ' + (iss.severity === 'error' ? 'workflow-issue-error' : 'workflow-issue-warn')}
              >
                <span>
                  {iss.severity === 'error' ? '✕ ' : '! '}{issueText(iss)}
                </span>
                {fixableKinds.has(iss.kind) && (
                  <button type="button" className="workflow-fix" onClick={() => applyFix(iss)}>
                    {t('Fix')}
                  </button>
                )}
              </div>
            ),
          )}
        </div>
      )}

      {flatList.map((it) => {
        if (it.kind === 'head') {
          return (
            <div key={it.key} className="workflow-group-head">
              <span>{it.group.key === 'created' ? t('On creation') : t('Entering {name}', { name: it.group.title })}</span>
            </div>
          );
        }
        const r = it.rule;
        const open = openRule === r.id;
        const whenTo = r.when.type === 'status_to' ? (r.when as { to: string }).to : '';
        const whenName =
          r.when.type === 'created'
            ? t('a row is created')
            : `${statusProp?.name ?? ''} → ${statusOpts.find((o) => o.id === whenTo)?.name ?? whenTo}`;
        return (
          <div key={r.id} className={'schema-item' + (errorRules.has(r.id) ? ' schema-item-error' : '')}>
            <div
              className="workflow-head"
              role="button"
              tabIndex={0}
              onClick={() => setOpenRule(open ? null : r.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setOpenRule(open ? null : r.id);
                }
              }}
            >
              <span className="workflow-when">
                {t('When')} {whenName}
              </span>
              <span className="workflow-then">
                {t('Then')} {r.do.length} · {open ? '▾' : '▸'}
              </span>
              <button
                type="button"
                className="icon-btn danger"
                title={t('Delete rule')}
                aria-label={t('Delete rule')}
                onClick={(e) => {
                  e.stopPropagation();
                  void askRemoveRule(r.id);
                }}
              >
                ✕
              </button>
            </div>
            {open && (
              <div className="workflow-body">
                <label>{t('When')}</label>
                <div className="workflow-row">
                  <select
                    className="prop-select"
                    value={r.when.type}
                    onChange={(e) => {
                      const wt = e.target.value as 'status_to' | 'created';
                      const when: WorkflowRule['when'] =
                        wt === 'created' ? { type: 'created' } : { type: 'status_to', to: defaultTargetId(statusOpts) };
                      updateRule(r.id, { when });
                    }}
                  >
                    <option value="status_to">{t('Status becomes…')}</option>
                    <option value="created">{t('Row is created')}</option>
                  </select>
                  {r.when.type === 'status_to' && (
                    <select
                      className="prop-select"
                      value={whenTo}
                      onChange={(e) =>
                        updateRule(r.id, { when: { type: 'status_to', to: e.target.value } })
                      }
                    >
                      {statusOpts.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                        </option>
                      ))}
                    </select>
                  )}
                </div>

                <button
                  type="button"
                  className="workflow-if-toggle"
                  aria-expanded={isIfOpen(r)}
                  onClick={() => setIfOpen((p) => ({ ...p, [r.id]: !isIfOpen(r) }))}
                >
                  {t('If')}{hasIf(r) ? ' •' : ''} {isIfOpen(r) ? '▾' : '▸'}
                </button>
                {isIfOpen(r) && (
                <div className="workflow-if">
                  {r.when.type === 'status_to' && (
                    <>
                      <label>{t('Only from')}</label>
                      {statusOpts.length <= 1 ? (
                        <div className="dialog-hint">
                          {t('Add at least two options to the status property — there is nowhere to come from yet.')}
                        </div>
                      ) : (
                        <>
                          <div className="workflow-chips">
                            {statusOpts
                              .filter((o) => o.id !== whenTo)
                              .map((o) => {
                                const on = (r.allowFrom ?? []).includes(o.id);
                                return (
                                  <button
                                    key={o.id}
                                    type="button"
                                    aria-pressed={on}
                                    className={'prop-chip toggle' + (on ? ' prop-chip-on' : '')}
                                    onClick={() => {
                                      const cur = r.allowFrom ?? [];
                                      updateRule(r.id, {
                                        allowFrom: on ? cur.filter((x) => x !== o.id) : [...cur, o.id],
                                      });
                                    }}
                                  >
                                    {o.name}
                                  </button>
                                );
                              })}
                          </div>
                          <div className="dialog-hint">
                            {t('Empty means it fires from any status, without blocking other rules.')}
                          </div>
                        </>
                      )}
                    </>
                  )}
                  <label>{t('Only if checklist complete')}</label>
                  <select
                    className="prop-select"
                    value={r.precondition?.checklistProp ?? ''}
                    onChange={(e) =>
                      updateRule(r.id, {
                        precondition: {
                          ...r.precondition,
                          checklistProp: e.target.value || undefined,
                          requiredProp: r.precondition?.requiredProp,
                        },
                      })
                    }
                  >
                    <option value="">{t('No check')}</option>
                    {schema
                      .filter((p) => p.type === 'checklist')
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                  </select>
                  <label>{t('Only if filled')}</label>
                  <select
                    className="prop-select"
                    value={r.precondition?.requiredProp ?? ''}
                    onChange={(e) =>
                      updateRule(r.id, {
                        precondition: {
                          ...r.precondition,
                          requiredProp: e.target.value || undefined,
                          checklistProp: r.precondition?.checklistProp,
                        },
                      })
                    }
                  >
                    <option value="">{t('No check')}</option>
                    {schema
                      .filter((p) => p.id !== statusPropId)
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                  </select>
                </div>
                )}

                <label>{t('Then')}</label>
                {r.do.map((a, i) => (
                  <ActionRow
                    key={i}
                    action={a}
                    schema={schema}
                    onChange={(next) =>
                      updateRule(r.id, { do: r.do.map((x, j) => (j === i ? next : x)) })
                    }
                    onRemove={() => updateRule(r.id, { do: r.do.filter((_, j) => j !== i) })}
                  />
                ))}
                <div className="workflow-row">
                  <select
                    className="prop-select"
                    defaultValue=""
                    value=""
                    onChange={(e) => {
                      const at = e.target.value as WorkflowAction['type'];
                      if (!at) return;
                      const prop =
                        at === 'assign_me' ? schema.find((p) => p.type === 'person')?.id ?? '' : '';
                      const next: WorkflowAction =
                        at === 'webhook'
                          ? { type: 'webhook', url: '' }
                          : at === 'set_prop'
                            ? { type: 'set_prop', prop: '', value: '' }
                            : at === 'require_prop'
                              ? { type: 'require_prop', prop: '', mode: 'if_empty' }
                              : at === 'require_comment'
                                ? { type: 'require_comment', mode: 'always' }
                                : ({ type: at, prop } as WorkflowAction);
                      updateRule(r.id, { do: [...r.do, next] });
                    }}
                  >
                    <option value="">{t('+ Add action')}</option>
                    <option value="set_prop">{t('Set a property')}</option>
                    <option value="assign_me">{t('Assign me')}</option>
                    <option value="require_prop">{t('Ask for a property')}</option>
                    <option value="require_comment">{t('Ask for a comment')}</option>
                    <option value="webhook">{t('Call a webhook')}</option>
                  </select>
                </div>
                {r.do.some((a) => {
                  if (a.type === 'webhook') return !a.url.trim();
                  if (a.type === 'require_comment') return false;
                  return !a.prop;
                }) && (
                  <div className="dialog-hint">
                    {t('An unfinished action is a draft: it stays here, but it is not saved.')}
                  </div>
                )}

              </div>
            )}
          </div>
        );
      })}

      <div className="workflow-row">
        <select
          className="prop-select"
          value={effTarget}
          onChange={(e) => setNewTarget(e.target.value)}
        >
          {statusOpts.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
          <option value="__created">{t('On creation')}</option>
        </select>
        <button
          type="button"
          className="btn"
          disabled={!statusPropId || statusOpts.length === 0}
          onClick={addRule}
        >
          {t('+ Add rule')}
        </button>
      </div>

      {statusOpts.length > 1 && (
        <div className="workflow-sim">
          <label>{t('Try a move')}</label>
          <div className="workflow-row">
            <select
              className="prop-select"
              value={simFrom}
              onChange={(e) => {
                setSimFrom(e.target.value);
                setSimRows(null);
              }}
            >
              <option value="">{t('From…')}</option>
              {statusOpts.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn"
              disabled={!simFrom || simBusy}
              onClick={() => void runSimulation(simFrom)}
            >
              {t('Check')}
            </button>
          </div>
          {(simRows ?? []).map((r) => (
            <div key={r.to} className="workflow-sim-row">
              <span>
                {r.verdict === 'ok' ? '✓' : r.verdict === 'ask' ? '? ' : '✕ '}→ {r.toName}
              </span>
              {r.detail.length > 0 && <span className="dialog-hint">{r.detail.join(' · ')}</span>}
            </div>
          ))}
        </div>
      )}
      </>
      ) : (
      <WorkflowScheme
        workflow={workflow}
        schema={schema}
        statusOpts={statusOpts}
        issues={issues}
        statusReady={!!statusPropId && statusOpts.length > 0}
      />
      )}
    </div>
  );
}

/** Read-only map of the process: statuses left to right, one arrow per
 *  allowed transition (×N when several rules share it), a dashed box for
 *  the on-creation rules. Preview only — editing stays in the list. */
function WorkflowScheme({
  workflow,
  schema,
  statusOpts,
  issues,
  statusReady,
}: {
  workflow: WorkflowConfig | undefined;
  schema: PropDef[];
  statusOpts: { id: string; name: string }[];
  issues: WorkflowIssue[];
  statusReady: boolean;
}) {
  if (!statusReady) {
    return (
      <div className="dialog-hint">
        {t('Add a Select property first — a process needs a status to drive.')}
      </div>
    );
  }
  const rules = workflow?.rules ?? [];
  const live = new Set(statusOpts.map((o) => o.id));
  const propName = (id: string) => schema.find((p) => p.id === id)?.name ?? id;
  type Edge = { from: string; to: string; rules: WorkflowRule[] };
  const edgeMap = new Map<string, Edge>();
  for (const r of rules) {
    if (r.when.type !== 'status_to') continue;
    const to = (r.when as { to: string }).to;
    if (!live.has(to)) continue;
    const froms =
      r.allowFrom && r.allowFrom.length > 0
        ? r.allowFrom.filter((f) => live.has(f) && f !== to)
        : statusOpts.map((o) => o.id).filter((id) => id !== to);
    for (const f of froms) {
      const k = `${f}${to}`;
      if (!edgeMap.has(k)) edgeMap.set(k, { from: f, to, rules: [] });
      edgeMap.get(k)!.rules.push(r);
    }
  }
  const edges = [...edgeMap.values()];
  const created = rules.filter((r) => r.when.type === 'created');
  const idx = new Map(statusOpts.map((o, i) => [o.id, i] as const));
  const spanOf = (e: Edge) => Math.abs(idx.get(e.from)! - idx.get(e.to)!);
  const fwd = edges.filter((e) => idx.get(e.from)! < idx.get(e.to)!);
  const bwd = edges.filter((e) => idx.get(e.from)! > idx.get(e.to)!);
  const topH = fwd.length > 0 ? 30 + 24 * Math.max(...fwd.map(spanOf)) : 16;
  const botH = bwd.length > 0 ? 26 + 24 * Math.max(...bwd.map(spanOf)) : 12;
  const NW = 148;
  const NH = 52;
  const GAP = 56;
  const PAD = 14;
  const X = (i: number) => PAD + i * (NW + GAP);
  const width = PAD * 2 + statusOpts.length * NW + Math.max(0, statusOpts.length - 1) * GAP;
  const height = topH + NH + botH;
  const short = (n: string) => (n.length > 16 ? n.slice(0, 15) + '…' : n);
  const flagOf = (id: string): WorkflowIssue | undefined =>
    issues.find(
      (i) =>
        (i.kind === 'trap' || i.kind === 'unreachable') &&
        statusOpts.some((o) => o.id === id && o.name === String(i.data?.name ?? '')),
    );
  const summarize = (r: WorkflowRule): string => {
    const parts = [
      ...describeAutoActions(r, schema),
      ...(r.do ?? []).flatMap((a) => {
        if (a.type === 'require_prop') return [t('Ask {name}', { name: propName(a.prop) })];
        if (a.type === 'require_comment') return [t('Comment')];
        return [];
      }),
    ];
    return parts.length > 0 ? parts.join(' · ') : t('Guard only');
  };
  // Arrowhead at the end of a quadratic curve, drawn by hand — markers do
  // not inherit the theme colour reliably.
  const head = (cx: number, cy: number, x2: number, y2: number): string => {
    const dx = x2 - cx;
    const dy = y2 - cy;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const L = 9;
    const W = 4.5;
    const bx = x2 - ux * L;
    const by = y2 - uy * L;
    return `${x2},${y2} ${bx - uy * W},${by + ux * W} ${bx + uy * W},${by - ux * W}`;
  };
  const renderEdge = (e: Edge) => {
    const i = idx.get(e.from)!;
    const j = idx.get(e.to)!;
    const above = i < j;
    const h = 30 + 24 * (Math.abs(i - j) - 1);
    const x1 = X(i) + NW / 2;
    const x2 = X(j) + NW / 2;
    const y0 = above ? topH : topH + NH;
    const s = above ? -1 : 1;
    const cx = (x1 + x2) / 2;
    const cy = y0 + s * 2 * h;
    const tip = [
      ...e.rules.flatMap((r) => [
        ...describeAutoActions(r, schema),
        ...(r.do ?? []).flatMap((a) => {
          if (a.type === 'require_prop') return [t('Ask {name}', { name: propName(a.prop) })];
          if (a.type === 'require_comment') return [t('Comment')];
          return [];
        }),
      ]),
    ].join('\n');
    const apexY = y0 + s * h;
    return (
      <g key={`${e.from}>${e.to}`}>
        {tip && <title>{tip}</title>}
        <path d={`M ${x1} ${y0} Q ${cx} ${cy} ${x2} ${y0}`} />
        <polygon points={head(cx, cy, x2, y0)} />
        {e.rules.length > 1 && (
          <text x={cx} y={apexY + (above ? -6 : 14)} textAnchor="middle" className="workflow-scheme-count">
            ×{e.rules.length}
          </text>
        )}
      </g>
    );
  };
  return (
    <div className="workflow-scheme">
      {created.length > 0 && (
        <div className="workflow-scheme-created">
          <div className="workflow-scheme-created-head">
            {t('On creation')} · {created.length}
          </div>
          {created.map((r) => (
            <div key={r.id} className="workflow-scheme-rule">
              {summarize(r)}
            </div>
          ))}
        </div>
      )}
      <svg className="workflow-scheme-svg" width={width} height={height} role="img">
        {edges.map(renderEdge)}
        {statusOpts.map((o, i) => {
          const flag = flagOf(o.id);
          return (
            <g key={o.id}>
              <title>{o.name}</title>
              <rect x={X(i)} y={topH} width={NW} height={NH} rx={8} className="workflow-scheme-node" />
              <text x={X(i) + NW / 2} y={topH + NH / 2 + 5} textAnchor="middle" className="workflow-scheme-label">
                {short(o.name)}
              </text>
              {flag && (
                <g>
                  <title>{issueText(flag)}</title>
                  <circle cx={X(i) + NW - 13} cy={topH + 13} r={5} className="workflow-scheme-flag" />
                </g>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function ActionRow({
  action,
  schema,
  onChange,
  onRemove,
}: {
  action: WorkflowAction;
  schema: PropDef[];
  onChange: (a: WorkflowAction) => void;
  onRemove: () => void;
}) {
  if (action.type === 'webhook') {
    return (
      <div className="workflow-row">
        <span className="workflow-act">{t('Webhook')}</span>
        <input
          className="prop-input"
          placeholder="https://…"
          value={action.url}
          onChange={(e) => onChange({ type: 'webhook', url: e.target.value })}
        />
        <button type="button" className="icon-btn danger" onClick={onRemove} title={t('Remove')}>
          ✕
        </button>
      </div>
    );
  }
  if (action.type === 'require_prop') {
    return (
      <div className="workflow-row">
        <span className="workflow-act">{t('Ask')}</span>
        <select
          className="prop-select"
          value={action.prop}
          onChange={(e) => onChange({ ...action, prop: e.target.value })}
        >
          <option value="">{t('Property…')}</option>
          {schema
            .filter((p) =>
              ['text', 'date', 'person', 'select', 'multiselect', 'checklist'].includes(p.type),
            )
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
        </select>
        <select
          className="prop-select"
          value={action.mode}
          title={t('When to ask')}
          onChange={(e) => onChange({ ...action, mode: e.target.value as 'always' | 'if_empty' })}
        >
          <option value="if_empty">{t('If empty')}</option>
          <option value="always">{t('Always')}</option>
        </select>
        <button type="button" className="icon-btn danger" onClick={onRemove} title={t('Remove')}>
          ✕
        </button>
      </div>
    );
  }
  if (action.type === 'require_comment') {
    return (
      <div className="workflow-row">
        <span className="workflow-act">{t('Ask comment')}</span>
        <select
          className="prop-select"
          value={action.mode}
          title={t('When to ask')}
          onChange={(e) => onChange({ ...action, mode: e.target.value as 'always' | 'if_empty' })}
        >
          <option value="always">{t('Always')}</option>
          <option value="if_empty">{t('If none yet')}</option>
        </select>
        <button type="button" className="icon-btn danger" onClick={onRemove} title={t('Remove')}>
          ✕
        </button>
      </div>
    );
  }
  if (action.type === 'set_prop') {
    const def = schema.find((p) => p.id === action.prop);
    const setValue = (v: unknown) => onChange({ type: 'set_prop', prop: action.prop, value: v });
    return (
      <div className="workflow-row">
        <span className="workflow-act">{t('Set')}</span>
        <select
          className="prop-select"
          value={action.prop}
          onChange={(e) => onChange({ type: 'set_prop', prop: e.target.value, value: e.target.value && schema.find((p) => p.id === e.target.value)?.type === 'multiselect' ? [] : '' })}
        >
          <option value="">{t('Property…')}</option>
          {schema
            .filter((p) => p.type !== 'checklist' || p.id === action.prop)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
        </select>
        <SetValueInput def={def} value={action.value} onChange={setValue} />
        <button type="button" className="icon-btn danger" onClick={onRemove} title={t('Remove')}>
          ✕
        </button>
      </div>
    );
  }
  const kind = action.type === 'set_today' ? 'date' : 'person';
  return (
    <div className="workflow-row">
      <span className="workflow-act">{action.type === 'set_today' ? t('Today →') : t('Me →')}</span>
      <select
        className="prop-select"
        value={action.prop}
        onChange={(e) => onChange({ ...action, prop: e.target.value })}
      >
        <option value="">{t('Property…')}</option>
        {schema
          .filter((p) => p.type === kind)
          .map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
      </select>
      <button type="button" className="icon-btn danger" onClick={onRemove} title={t('Remove')}>
        ✕
      </button>
    </div>
  );
}

/** The value half of a "set property" step follows the property: an option
 *  picker for selects, chips for multi-selects, a date field, a person
 *  picker, a checkbox — a free text field only for the rest. Picking from
 *  what exists beats typing an id from memory. */
function SetValueInput({
  def,
  value,
  onChange,
}: {
  def: PropDef | undefined;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const [members, setMembers] = useState<Member[]>([]);
  useEffect(() => {
    if (def?.type === 'person') void loadMembers().then(setMembers).catch(() => {});
  }, [def?.type]);
  if (!def) {
    return <span className="prop-input" aria-hidden="true" />;
  }
  if (def.type === 'select' || def.type === 'multiselect') {
    return (
      <SelectCell
        def={def}
        value={value}
        multi={def.type === 'multiselect'}
        onChange={onChange}
      />
    );
  }
  if (def.type === 'date') {
    return <WorkflowDateInput value={value} onChange={onChange} />;
  }
  if (def.type === 'person') {
    // Person cells always hold a list, single or not — store the same shape.
    const cur = Array.isArray(value) ? ((value as string[])[0] ?? '') : typeof value === 'string' ? value : '';
    return (
      <select
        className="prop-select"
        value={cur}
        onChange={(e) => onChange(e.target.value ? [e.target.value] : [])}
      >
        <option value="">{t('Select…')}</option>
        {members.map((m) => (
          <option key={m.userId} value={m.userId}>
            {m.name}
          </option>
        ))}
      </select>
    );
  }
  if (def.type === 'checkbox') {
    return (
      <input
        type="checkbox"
        checked={value === true || value === 'true' || value === 1}
        onChange={(e) => onChange(e.target.checked)}
      />
    );
  }
  return (
    <input
      className="prop-input"
      placeholder={t('Value')}
      value={typeof value === 'string' || typeof value === 'number' ? String(value) : ''}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
