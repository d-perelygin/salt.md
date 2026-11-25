import { RotateCcw } from 'lucide-react';
import type { CollectionRevisionState, PropDef, RevisionChange, ViewDef, WorkflowRule } from '../types';
import { t, plural } from '../i18n';

// One version of a database's structure, rendered as it was: its columns, its
// views and its process. A removed column is shown struck through — it exists
// only in the version, and putting it back is a button on that row.
//
// Row VALUES are deliberately absent: they live in the rows and have their own
// history. The note at the top says so, because a structure history that looks
// like it should hold the data is the confusion this feature exists to end.

function typeLabel(type: PropDef['type']): string {
  switch (type) {
    case 'text':
      return t('Text');
    case 'number':
      return t('Number');
    case 'select':
      return t('Select');
    case 'multiselect':
      return t('Multi-select');
    case 'date':
      return t('Date');
    case 'checkbox':
      return t('Checkbox');
    case 'checklist':
      return t('Checklist');
    case 'url':
      return 'URL';
    case 'person':
      return t('Person');
    case 'relation':
      return t('Relation');
    case 'backrelation':
      return t('Backrelation');
    case 'rollup':
      return t('Rollup');
    case 'formula':
      return t('Formula');
    case 'lastActivity':
      return t('Last activity');
    default:
      return type;
  }
}

function viewTypeLabel(type: ViewDef['type']): string {
  switch (type) {
    case 'table':
      return t('Table');
    case 'board':
      return t('Board');
    case 'list':
      return t('List');
    case 'gallery':
      return t('Gallery');
    case 'calendar':
      return t('Calendar');
    case 'timeline':
      return t('Timeline');
    case 'form':
      return t('Form');
    default:
      return type;
  }
}

/** A field key in words. Keys come from the stored JSON, so the map is finite
 *  but a build can add one: an unknown key falls through as itself rather
 *  than disappearing. */
export function fieldLabel(field: string): string {
  switch (field) {
    case 'name':
      return t('Name');
    case 'type':
      return t('Type');
    case 'options':
      return t('Options');
    case 'groupBy':
      return t('Group by');
    case 'dateProp':
      return t('Date');
    case 'endDateProp':
      return t('End date');
    case 'filters':
    case 'filterGroups':
      return t('Filters');
    case 'sorts':
    case 'sort':
      return t('Sort');
    case 'hidden':
      return t('Hidden columns');
    case 'stuckCols':
      return t('Pinned columns');
    case 'trayFilters':
    case 'trayFilterGroups':
      return t('Tray filters');
    case 'status':
      return t('Status property');
    case 'process':
    case 'rules':
      return t('Process');
    case 'code':
      return t('Code');
    default:
      return field;
  }
}

function changeChips(changes: RevisionChange[] | undefined): string[] {
  const out: string[] = [];
  for (const c of changes ?? []) {
    if (c.kind === 'option_added' && c.item) {
      out.push(t('Option {item} added', { item: c.item }));
      continue;
    }
    if (c.kind === 'option_removed' && c.item) {
      out.push(t('Option {item} removed', { item: c.item }));
      continue;
    }
    if (c.kind === 'option_changed' && c.item) {
      out.push(
        c.field === 'color'
          ? t('Option {item}: colour changed', { item: c.item })
          : t('Option {item} renamed', { item: c.item }),
      );
      continue;
    }
    if (c.kind === 'workflow_rule_added') {
      out.push(t('Process rule added'));
      continue;
    }
    if (c.kind === 'workflow_rule_removed') {
      out.push(t('Process rule removed'));
      continue;
    }
    if (c.kind === 'workflow_rule_changed') {
      out.push(t('Process rule changed'));
      continue;
    }
    if (c.kind === 'workflow_code_added' && c.name) {
      out.push(t('Code block {name} added', { name: c.name }));
      continue;
    }
    if (c.kind === 'workflow_code_removed' && c.name) {
      out.push(t('Code block {name} removed', { name: c.name }));
      continue;
    }
    if (c.kind === 'workflow_code_changed' && c.name) {
      out.push(t('Code block {name} changed', { name: c.name }));
      continue;
    }
    if (!c.field) continue;
    const label = fieldLabel(c.field);
    if (c.from || c.to) {
      out.push(`${label}: ${c.from || t('empty')} → ${c.to || t('empty')}`);
    } else {
      out.push(label);
    }
  }
  return out;
}

function rowMark(changes: RevisionChange[] | undefined): string {
  if (!changes || changes.length === 0) return '';
  if (changes.some((c) => c.kind === 'column_added' || c.kind === 'view_added')) return ' is-added';
  if (changes.some((c) => c.kind === 'column_removed' || c.kind === 'view_removed')) return ' is-removed';
  return ' is-changed';
}

function RestoreButton({
  label,
  busy,
  onClick,
}: {
  label: string;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <button className="btn-sm rev-col-restore" disabled={busy} title={label} onClick={onClick}>
      <RotateCcw size={13} /> {t('Restore')}
    </button>
  );
}

export function CollectionHistory({
  state,
  changes,
  busy,
  onRestore,
}: {
  state?: CollectionRevisionState;
  changes?: RevisionChange[];
  busy: boolean;
  /** fromPrevious is true for a row that exists only in the version ABOVE
   *  this one (a column this version removed): it must be restored from that
   *  older version, because this one no longer holds it. */
  onRestore: (scope: 'property' | 'view' | 'workflow', itemId?: string, fromPrevious?: boolean) => void;
}) {
  if (!state) return <div className="rev-doc-loading" />;

  const byId = new Map<string, RevisionChange[]>();
  for (const c of changes ?? []) {
    if (!c.id) continue;
    const list = byId.get(c.id) ?? [];
    list.push(c);
    byId.set(c.id, list);
  }
  const present = new Set(state.schema.map((p) => p.id));
  const removedColumns = (changes ?? []).filter((c) => c.kind === 'column_removed' && c.id && !present.has(c.id));
  const presentViews = new Set((state.views ?? []).map((v) => v.id));
  const removedViews = (changes ?? []).filter((c) => c.kind === 'view_removed' && c.id && !presentViews.has(c.id));
  const workflowChanges = (changes ?? []).filter((c) => (c.scope ?? '') === 'workflow');
  const statusProp = state.schema.find((p) => p.id === state.workflow?.statusPropId);
  const rules = state.workflow?.rules ?? [];
  const code = state.workflow?.code ?? [];
  const ruleCount = rules.length + code.reduce((n, b) => n + b.rules.length, 0);

  return (
    <div className="rev-collection">
      <p className="rev-col-note">
        {t('This records the database’s structure: its columns, views and process. Row values have their own history on each row and are never touched by a restore.')}
      </p>

      <section className="rev-col-section">
        <h3>{t('Columns')}</h3>
        {state.schema.length === 0 && removedColumns.length === 0 ? (
          <div className="rev-col-empty">{t('No columns')}</div>
        ) : (
          <ul className="rev-col-list">
            {removedColumns.map((c) => (
              <li key={'removed-' + c.id} className="rev-col-row is-removed">
                <span className="rev-col-name">{c.name || c.id}</span>
                <span className="rev-col-chips">
                  <span className="rev-col-chip">{t('Removed')}</span>
                </span>
                <RestoreButton busy={busy} label={t('Restore this column')} onClick={() => onRestore('property', c.id, true)} />
              </li>
            ))}
            {state.schema.map((p) => {
              const rowChanges = byId.get(p.id);
              const chips = changeChips(rowChanges);
              return (
                <li key={p.id} className={'rev-col-row' + rowMark(rowChanges)}>
                  <span className="rev-col-name">{p.name || p.id}</span>
                  <span className="rev-col-type">{typeLabel(p.type)}</span>
                  {p.type === 'select' || p.type === 'multiselect' ? (
                    <span className="rev-col-chips">
                      {(p.options ?? []).map((o) => (
                        <span key={o.id} className="rev-col-chip rev-col-option">
                          {o.name}
                        </span>
                      ))}
                    </span>
                  ) : null}
                  {chips.length > 0 && (
                    <span className="rev-col-chips">
                      {chips.map((line, i) => (
                        <span key={i} className="rev-col-chip is-change">
                          {line}
                        </span>
                      ))}
                    </span>
                  )}
                  {rowChanges && rowChanges.length > 0 ? (
                    <RestoreButton busy={busy} label={t('Restore this column')} onClick={() => onRestore('property', p.id)} />
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="rev-col-section">
        <h3>{t('Views')}</h3>
        {(state.views ?? []).length === 0 && removedViews.length === 0 ? (
          <div className="rev-col-empty">{t('No views')}</div>
        ) : (
          <ul className="rev-col-list">
            {removedViews.map((c) => (
              <li key={'removed-' + c.id} className="rev-col-row is-removed">
                <span className="rev-col-name">{c.name || c.id}</span>
                <span className="rev-col-chips">
                  <span className="rev-col-chip">{t('Removed')}</span>
                </span>
                <RestoreButton busy={busy} label={t('Restore this view')} onClick={() => onRestore('view', c.id, true)} />
              </li>
            ))}
            {(state.views ?? []).map((v) => {
              const rowChanges = byId.get(v.id);
              const chips = changeChips(rowChanges);
              return (
                <li key={v.id} className={'rev-col-row' + rowMark(rowChanges)}>
                  <span className="rev-col-name">{v.name || v.id}</span>
                  <span className="rev-col-type">{viewTypeLabel(v.type)}</span>
                  <span className="rev-col-chips">
                    {v.groupBy && (
                      <span className="rev-col-chip">
                        {t('Group by')}: {state.schema.find((p) => p.id === v.groupBy)?.name ?? v.groupBy}
                      </span>
                    )}
                    {(v.filters?.length ?? 0) > 0 && (
                      <span className="rev-col-chip">
                        {t('Filters')}: {v.filters!.length}
                      </span>
                    )}
                    {(v.hidden?.length ?? 0) > 0 && (
                      <span className="rev-col-chip">
                        {t('Hidden columns')}: {v.hidden!.length}
                      </span>
                    )}
                  </span>
                  {chips.length > 0 && (
                    <span className="rev-col-chips">
                      {chips.map((line, i) => (
                        <span key={i} className="rev-col-chip is-change">
                          {line}
                        </span>
                      ))}
                    </span>
                  )}
                  {rowChanges && rowChanges.length > 0 ? (
                    <RestoreButton busy={busy} label={t('Restore this view')} onClick={() => onRestore('view', v.id)} />
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="rev-col-section">
        <h3>{t('Process')}</h3>
        {!state.workflow ? (
          <div className="rev-col-empty">{t('No process')}</div>
        ) : (
          <ul className="rev-col-list">
            <li className="rev-col-row">
              <span className="rev-col-name">
                {statusProp ? statusProp.name : state.workflow.statusPropId || t('Status property')}
              </span>
              <span className="rev-col-type">
                {plural(ruleCount, '{n} rule', '{n} rules')}
                {code.length > 0 ? ` · ${plural(code.length, '{n} code block', '{n} code blocks')}` : ''}
              </span>
              {workflowChanges.length > 0 && (
                <span className="rev-col-chips">
                  {changeChips(workflowChanges).map((line, i) => (
                    <span key={i} className="rev-col-chip is-change">
                      {line}
                    </span>
                  ))}
                </span>
              )}
              {workflowChanges.length > 0 ? (
                <RestoreButton busy={busy} label={t('Restore the process')} onClick={() => onRestore('workflow')} />
              ) : null}
            </li>
            {rules.slice(0, 12).map((r: WorkflowRule) => (
              <li key={r.id} className="rev-col-row rev-col-rule">
                <span className="rev-col-type">{ruleLine(r, statusProp)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function ruleLine(rule: WorkflowRule, statusProp: PropDef | undefined): string {
  const when = rule.when;
  if (when.type === 'created') return t('When a row is created');
  const to = statusProp?.options?.find((o) => o.id === when.to);
  return t('When the status becomes {value}', { value: to?.name ?? when.to });
}

/** One line of a structure version, for the list on the left. Lives beside the
 *  chips that render the same change in the pane, so the two cannot drift. */
export function revisionChangeLine(c: RevisionChange): string {
  const name = c.name || c.id || '?';
  switch (c.kind) {
    case 'column_added':
      return t('Column {name} added', { name });
    case 'column_removed':
      return t('Column {name} removed', { name });
    case 'column_moved':
      return c.from && c.to
        ? t('Column {name}: {from} → {to}', { name, from: c.from, to: c.to })
        : t('Column {name} moved', { name });
    case 'column_changed':
      return c.field ? `${name}: ${fieldLabel(c.field)}` : t('Column {name} changed', { name });
    case 'option_added':
      return t('Option {item} added', { item: c.item || '?' });
    case 'option_removed':
      return t('Option {item} removed', { item: c.item || '?' });
    case 'option_changed':
      return c.field === 'color'
        ? t('Option {item}: colour changed', { item: c.item || '?' })
        : t('Option {item} renamed', { item: c.item || '?' });
    case 'view_added':
      return t('View {name} added', { name });
    case 'view_removed':
      return t('View {name} removed', { name });
    case 'view_moved':
      return c.from && c.to
        ? t('View {name}: {from} → {to}', { name, from: c.from, to: c.to })
        : t('View {name} moved', { name });
    case 'view_changed':
      return c.field ? `${name}: ${fieldLabel(c.field)}` : t('View {name} changed', { name });
    case 'workflow_changed':
      return c.field ? t('Process: {field}', { field: fieldLabel(c.field) }) : t('Process changed');
    case 'workflow_rule_added':
      return t('Process rule added');
    case 'workflow_rule_removed':
      return t('Process rule removed');
    case 'workflow_rule_changed':
      return t('Process rule changed');
    case 'workflow_code_added':
      return t('Code block {name} added', { name: c.name || '?' });
    case 'workflow_code_removed':
      return t('Code block {name} removed', { name: c.name || '?' });
    case 'workflow_code_changed':
      return t('Code block {name} changed', { name: c.name || '?' });
    case 'template_changed':
      return t('Row template changed');
  }
  return t('Changed');
}
