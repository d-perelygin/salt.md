import { useEffect, useState } from 'react';
import type { PropDef, WorkflowAction, WorkflowConfig, WorkflowRule } from '../types';
import { t } from '../i18n';
import { SelectCell, loadMembers, type Member } from './PropertyValue';

let ruleCounter = 0;
const newRuleId = () => `rule_${Date.now().toString(36)}_${ruleCounter++}`;

function emptyRule(firstOpt: string): WorkflowRule {
  return {
    id: newRuleId(),
    when: { type: 'status_to', to: firstOpt },
    // A fresh action starts blank, like in Shortcuts — the reader picks the
    // kind and its target. Blank actions simply do not travel on save.
    do: [{ type: 'set_today', prop: '' }],
  };
}

export default function WorkflowRules({
  schema,
  workflow,
  onChange,
}: {
  schema: PropDef[];
  workflow: WorkflowConfig | undefined;
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
  const [openRule, setOpenRule] = useState<string | null>(rules[0]?.id ?? null);
  const [showAdvanced, setShowAdvanced] = useState<Record<string, boolean>>({});

  const statusProp = schema.find((p) => p.id === statusPropId);
  const statusOpts = statusProp?.options ?? [];

  const commit = (next: WorkflowConfig | undefined) => onChange(next);

  const setStatus = (id: string) => {
    const prop = schema.find((p) => p.id === id);
    const firstOpt = prop?.options?.[0]?.id ?? '';
    const kept = (workflow?.rules ?? []).filter((r) =>
      r.when.type === 'created' ? true : (prop?.options ?? []).some((o) => o.id === (r.when as { to: string }).to),
    );
    commit({ statusPropId: id, rules: kept.map((r) => (r.when.type === 'status_to' && firstOpt && !(prop?.options ?? []).some((o) => o.id === (r.when as { to: string }).to) ? r : r)) });
  };

  const updateRule = (id: string, patch: Partial<WorkflowRule>) =>
    commit({ statusPropId, rules: rules.map((r) => (r.id === id ? { ...r, ...patch } : r)) });

  const removeRule = (id: string) => {
    const next = rules.filter((r) => r.id !== id);
    commit(next.length === 0 && !statusPropId ? undefined : { statusPropId, rules: next });
    if (openRule === id) setOpenRule(null);
  };

  const addRule = () => {
    if (!statusPropId || statusOpts.length === 0) return;
    const r = emptyRule(statusOpts[0].id);
    commit({ statusPropId, rules: [...rules, r] });
    setOpenRule(r.id);
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
          {t('No rules yet. A rule reads like a sentence: when the status changes, then do something.')}
        </div>
      )}

      {rules.map((r) => {
        const open = openRule === r.id;
        const adv = !!showAdvanced[r.id];
        const whenTo = r.when.type === 'status_to' ? (r.when as { to: string }).to : '';
        const whenName =
          r.when.type === 'created'
            ? t('a row is created')
            : `${statusProp?.name ?? ''} → ${statusOpts.find((o) => o.id === whenTo)?.name ?? whenTo}`;
        return (
          <div key={r.id} className="schema-item">
            <button type="button" className="workflow-head" onClick={() => setOpenRule(open ? null : r.id)}>
              <span className="workflow-when">
                {t('When')} {whenName}
              </span>
              <span className="workflow-then">
                {t('Then')} {r.do.length} · {open ? '▾' : '▸'}
              </span>
            </button>
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
                        wt === 'created' ? { type: 'created' } : { type: 'status_to', to: statusOpts[0]?.id ?? '' };
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
                        at === 'set_today'
                          ? schema.find((p) => p.type === 'date')?.id ?? ''
                          : at === 'assign_me'
                            ? schema.find((p) => p.type === 'person')?.id ?? ''
                            : '';
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
                    <option value="set_today">{t('Stamp today')}</option>
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

                <button
                  type="button"
                  className="workflow-more"
                  onClick={() => setShowAdvanced((p) => ({ ...p, [r.id]: !adv }))}
                >
                  {adv ? t('Fewer options ▾') : t('More options ▸')}
                </button>
                {adv && (
                  <div className="workflow-adv">
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
                              {t('Empty = from any status. Pick sources to forbid jumps.')}
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

                <button type="button" className="btn danger" onClick={() => removeRule(r.id)}>
                  {t('Delete rule')}
                </button>
              </div>
            )}
          </div>
        );
      })}

      <button type="button" className="btn" onClick={addRule} disabled={!statusPropId || statusOpts.length === 0}>
        {t('+ Add rule')}
      </button>
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
            .filter((p) => ['text', 'date', 'person', 'select', 'multiselect'].includes(p.type))
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
          {schema.map((p) => (
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
    return (
      <input
        type="date"
        className="prop-input"
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value)}
      />
    );
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
