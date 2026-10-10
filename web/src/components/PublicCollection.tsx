import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarDays, Columns3, LayoutGrid, List, Lock, Table2 } from 'lucide-react';
import { api, ApiError } from '../api';
import { plural, t } from '../i18n';
import { firstWeekday, formatMonth, toDayString, weekdayNames } from '../format';
import { PageIcon } from '../pageIcon';
import { tagColorClass } from '../tags';
import PropertyValue from './PropertyValue';
import GalleryView from './GalleryView';
import ListView from './ListView';
import type { PropDef, PublicCollectionConfig, ViewDef } from '../types';

interface Row {
  id: string;
  title: string;
  icon: string;
  cover: string;
  props: Record<string, unknown>;
  tags?: string[];
}

// Standalone, unauthenticated collection page served at /public/{token}.
// Mirrors the in-app collection look (tabs, table/board/gallery/list) but is
// strictly read-only: no creating, no editing, no drag. Row detail opens only
// when the owner enabled it (allow_detail).
export default function PublicCollection({ token }: { token: string }) {
  const [password, setPassword] = useState('');
  const [needPassword, setNeedPassword] = useState(false);
  const [pwWrong, setPwWrong] = useState(false);
  const [state, setState] = useState<'loading' | 'ready' | 'notfound'>('loading');
  const [cfg, setCfg] = useState<PublicCollectionConfig | null>(null);
  const [viewId, setViewId] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [related, setRelated] = useState<Record<string, { title: string; icon: string }>>({});
  const [total, setTotal] = useState(0);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [detail, setDetail] = useState<{ id: string; title: string; icon: string; content: string; props: Record<string, unknown> } | null>(null);

  const load = useCallback(
    async (pw?: string) => {
      setState('loading');
      setPwWrong(false);
      try {
        const c = await api.publicCollection(token, pw || undefined);
        setCfg(c);
        setViewId(c.views[0]?.id ?? '');
        setNeedPassword(false);
        setState('ready');
        // A working password is remembered for this tab only: a reload
        // reopens straight away, a new tab or a closed browser asks again.
        // The server keeps no session — this never leaves the browser.
        if (pw) {
          try {
            sessionStorage.setItem(`salt:share-pw:${token}`, pw);
          } catch {
            // Private mode — every visit asks, as before.
          }
        }
      } catch (e) {
        if (e instanceof ApiError && e.status === 403) {
          setNeedPassword(true);
          setPwWrong(!!pw);
          setState('ready');
          try {
            sessionStorage.removeItem(`salt:share-pw:${token}`);
          } catch {
            // Nothing stored, nothing to forget.
          }
          return;
        }
        setState('notfound');
      }
    },
    [token],
  );

  useEffect(() => {
    // A ?pw= query opens a password link directly (the API accepts it too);
    // a wrong one lands on the dialog with the value ready to correct.
    // Consumed once: the secret moves from the address into memory, so no
    // history entry and no glance at the bar carries it further. Documents
    // never need this — their gate POSTs the password in the form body.
    // Without ?pw=, a password remembered by this tab (see load) reopens
    // the link without asking again.
    const params = new URLSearchParams(window.location.search);
    let q = params.get('pw');
    if (q) {
      params.delete('pw');
      const rest = params.toString();
      history.replaceState(null, '', window.location.pathname + (rest ? '?' + rest : '') + window.location.hash);
      setPassword(q);
    } else {
      try {
        q = sessionStorage.getItem(`salt:share-pw:${token}`);
      } catch {
        q = null;
      }
      if (q) setPassword(q);
    }
    void load(q || undefined);
  }, [load, token]);

  const view: ViewDef | undefined = useMemo(
    () => cfg?.views.find((v) => v.id === viewId) ?? cfg?.views[0],
    [cfg, viewId],
  );
  const schema = useMemo(() => cfg?.schema ?? [], [cfg]);
  const hidden = useMemo(() => new Set(view?.hidden ?? []), [view]);
  const visibleSchema = useMemo(() => schema.filter((p) => !hidden.has(p.id)), [schema, hidden]);

  useEffect(() => {
    if (!cfg || !view) return;
    let alive = true;
    setRowsLoading(true);
    (async () => {
      let acc: Row[] = [];
      let total = 0;
      let rel: Record<string, { title: string; icon: string }> = {};
      for (;;) {
        const res = await api.publicCollectionRows(token, view.id, acc.length, password || undefined);
        if (!alive) return;
        total = res.total;
        rel = { ...rel, ...res.related };
        acc = [...acc, ...res.rows.map((r) => ({ ...r, props: r.props || {} }))];
        setRows(acc);
        setRelated(rel);
        setTotal(total);
        if (acc.length >= res.total || res.rows.length === 0) break;
      }
      if (alive) setRowsLoading(false);
    })().catch(() => alive && setRowsLoading(false));
    return () => {
      alive = false;
    };
  }, [cfg, view, token, password]);

  const openRow = async (id: string) => {
    if (!cfg?.allowDetail) return;
    try {
      const d = await api.publicCollectionRow(token, id, password || undefined);
      setDetail({ ...d, props: (d.props as Record<string, unknown>) ?? {} });
    } catch {
      // Row detail off or gone — stay on the collection.
    }
  };

  if (state === 'loading') {
    return (
      <div className="public-form-page">
        <div className="form-card public-form-loading">{t('Loading…')}</div>
      </div>
    );
  }
  if (state === 'notfound' || (!needPassword && !cfg)) {
    return (
      <div className="public-form-page">
        <div className="form-card form-done">
          <h2>{t('Page not found')}</h2>
          <p>{t('This link is not valid or has been switched off.')}</p>
        </div>
      </div>
    );
  }
  if (needPassword && !cfg) {
    return (
      <div className="public-form-page lock-gate">
        <div className="form-card">
          <div className="public-form-head">
            <Lock size={28} />
            <h1 className="form-heading form-heading-static">{t('Protected page')}</h1>
          </div>
          <p className="form-desc form-desc-static">{t('This page is protected by a password.')}</p>
          {pwWrong && <p className="form-error">{t('Wrong password.')}</p>}
          <label className="form-field">
            <input
              className="form-input lock-input"
              type="password"
              autoFocus
              placeholder={t('Password')}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void load(password);
              }}
            />
          </label>
          <div className="form-actions">
            <button className="btn primary lock-btn" disabled={!password} onClick={() => void load(password)}>
              {t('Open')}
            </button>
          </div>
        </div>
      </div>
    );
  }
  if (!cfg || !view) return null;

  const tabIcon = (ty: ViewDef['type']) => {
    const sz = 14;
    if (ty === 'board') return <Columns3 size={sz} />;
    if (ty === 'gallery') return <LayoutGrid size={sz} />;
    if (ty === 'list') return <List size={sz} />;
    if (ty === 'calendar') return <CalendarDays size={sz} />;
    return <Table2 size={sz} />;
  };

  return (
    <div className="public-collection-page">
      <div className="public-collection">
        {cfg.cover && <div className="public-collection-cover" style={coverStyle(cfg.cover)} />}
        <div className="public-collection-head">
          {cfg.icon && (
            <span className="public-collection-icon">
              <PageIcon icon={cfg.icon} size={40} />
            </span>
          )}
          <h1 className="public-collection-title">{cfg.title || t('Untitled')}</h1>
          {cfg.description && <p className="public-collection-desc">{cfg.description}</p>}
        </div>
        {cfg.views.length > 1 && (
          <div className="view-tabs public-tabs">
            {cfg.views.map((v) => (
              <button
                key={v.id}
                className={'view-tab view-tab--' + v.type + (v.id === view.id ? ' active' : '')}
                onClick={() => setViewId(v.id)}
              >
                <span className="view-tab-ic">{tabIcon(v.type)}</span>
                {v.name}
              </button>
            ))}
          </div>
        )}
        <div className="public-collection-body">
          {rowsLoading && rows.length === 0 ? (
            <div className="db-empty">{t('Loading…')}</div>
          ) : view.type === 'board' ? (
            <PublicBoard
              rows={rows}
              schema={visibleSchema}
              groupBy={view.groupBy ?? ''}
              related={related}
              allowDetail={cfg.allowDetail}
              onOpen={openRow}
            />
          ) : view.type === 'gallery' ? (
            <GalleryView
              rows={rows}
              schema={visibleSchema}
              emptyLabel={t('No rows')}
              tagColors={{}}
              onNavigate={openRow}
              onSetProp={() => {}}
              onSetOptions={() => {}}
              readOnly
            />
          ) : view.type === 'list' ? (
            <ListView
              rows={rows}
              schema={visibleSchema}
              emptyLabel={t('No rows')}
              tagColors={{}}
              onNavigate={openRow}
              onSetProp={() => {}}
              onSetOptions={() => {}}
              readOnly
            />
          ) : view.type === 'calendar' ? (
            <PublicCalendar
              rows={rows}
              schema={visibleSchema}
              dateProp={view.dateProp ?? ''}
              allowDetail={cfg.allowDetail}
              onOpen={openRow}
            />
          ) : view.type === 'timeline' ? (
            <PublicTimeline
              rows={rows}
              schema={visibleSchema}
              startProp={view.dateProp ?? ''}
              endProp={view.endDateProp ?? ''}
              allowDetail={cfg.allowDetail}
              onOpen={openRow}
            />
          ) : (
            <PublicTable
              rows={rows}
              schema={visibleSchema}
              related={related}
              allowDetail={cfg.allowDetail}
              onOpen={openRow}
            />
          )}
          {total > rows.length && <div className="db-empty">{plural(rows.length, '{n} row', '{n} rows')}</div>}
        </div>
        <div className="public-form-footer">
          {t('Made with')} <b>salt.md</b>
        </div>
      </div>
      {detail && (
        <div className="public-detail-backdrop" onClick={() => setDetail(null)}>
          <div className="public-detail" onClick={(e) => e.stopPropagation()}>
            <div className="public-detail-head">
              {detail.icon && <PageIcon icon={detail.icon} size={22} />}
              <h2>{detail.title || t('Untitled')}</h2>
              <button className="btn-sm" onClick={() => setDetail(null)}>
                ✕
              </button>
            </div>
            <PublicDetailProps schema={schema} values={detail.props} related={related} onOpen={openRow} />
            <PublicDetailContent content={detail.content} />
          </div>
        </div>
      )}
    </div>
  );
}

function coverStyle(cover: string): React.CSSProperties {
  if (!cover) return {};
  if (cover.startsWith('gradient:')) return { background: cover.slice('gradient:'.length) };
  return { backgroundImage: `url(${cover})`, backgroundSize: 'cover', backgroundPosition: 'center' };
}

// Relation cells resolve titles from the `related` map the server returns —
// the anonymous reader cannot query the relation target collection directly.
function PublicPropValue({
  def,
  value,
  related,
  onOpen,
}: {
  def: PropDef;
  value: unknown;
  related: Record<string, { title: string; icon: string }>;
  onOpen?: (id: string) => void;
}) {
  if (def.type === 'relation') {
    const ids = Array.isArray(value) ? (value as string[]) : value ? [value as string] : [];
    if (ids.length === 0) return null;
    return (
      <span className="prop-multi">
        {ids.slice(0, 3).map((id) => (
          <span key={id} className="prop-chip relation-chip" style={{ background: '#3b6fb52e', color: '#3b6fb5' }}>
            {related[id]?.icon && (
              <span className="relation-icon">
                <PageIcon icon={related[id].icon} size={14} />
              </span>
            )}
            {related[id]?.title || ''}
          </span>
        ))}
        {ids.length > 3 && <span className="prop-chip relation-more">+{ids.length - 3}</span>}
      </span>
    );
  }
  return <PropertyValue def={def} value={value} readOnly compact maxChips={2} onOpen={onOpen} />;
}

function PublicTable({
  rows,
  schema,
  related,
  allowDetail,
  onOpen,
}: {
  rows: Row[];
  schema: PropDef[];
  related: Record<string, { title: string; icon: string }>;
  allowDetail: boolean;
  onOpen: (id: string) => void;
}) {
  if (rows.length === 0) return <div className="db-empty">{t('No rows')}</div>;
  return (
    <div className="table-wrap">
      <table className="db-table">
        <thead>
          <tr>
            <th className="db-title-col">{t('Name')}</th>
            {schema.map((p) => (
              <th key={p.id}>{p.name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="db-title-col">
                {allowDetail ? (
                  <button className="db-title-link" onClick={() => void onOpen(r.id)}>
                    {r.icon && (
                      <span className="inline-icon">
                        <PageIcon icon={r.icon} size={14} />{' '}
                      </span>
                    )}
                    {r.title || t('Untitled')}
                  </button>
                ) : (
                  <span className="db-title-inner">
                    {r.icon && (
                      <span className="inline-icon">
                        <PageIcon icon={r.icon} size={14} />{' '}
                      </span>
                    )}
                    {r.title || t('Untitled')}
                  </span>
                )}
              </td>
              {schema.map((p) => (
                <td key={p.id}>
                  <PublicPropValue def={p} value={r.props[p.id]} related={related} onOpen={allowDetail ? onOpen : undefined} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="db-calc-row">
            <td className="db-title-col db-calc-cell">
              {plural(rows.length, '{n} row', '{n} rows')}
            </td>
            {schema.map((p) => (
              <td key={p.id} className="db-calc-cell" />
            ))}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function PublicBoard({
  rows,
  schema,
  groupBy,
  related,
  allowDetail,
  onOpen,
}: {
  rows: Row[];
  schema: PropDef[];
  groupBy: string;
  related: Record<string, { title: string; icon: string }>;
  allowDetail: boolean;
  onOpen: (id: string) => void;
}) {
  const prop = schema.find((p) => p.id === groupBy);
  const showProps = schema.filter((p) => p.id !== groupBy).slice(0, 3);
  if (!prop || (prop.type !== 'select' && prop.type !== 'multiselect' && prop.type !== 'relation')) {
    return <div className="board-empty">{t('This board needs a Select property to group by.')}</div>;
  }
  const options =
    prop.type === 'relation'
      ? Object.entries(related).map(([id, r]) => ({ id, name: r.title, color: '#999' }))
      : (prop.options ?? []);
  const UNSET = '__unset__';
  const columns = [...options, { id: UNSET, name: t('No {name}', { name: prop.name }), color: '#999' }];
  const rowsFor = (optId: string) =>
    rows.filter((r) => {
      const v = r.props[groupBy];
      if (optId === UNSET) return !v || (Array.isArray(v) && v.length === 0);
      if (Array.isArray(v)) return v.includes(optId);
      return v === optId;
    });
  return (
    <div className="board">
      {columns.map((col) => {
        const cards = rowsFor(col.id);
        if (col.id === UNSET && cards.length === 0) return null;
        return (
          <div key={col.id} className="board-col" style={col.id !== UNSET ? ({ '--col-c': col.color } as React.CSSProperties) : undefined}>
            <div className="board-col-head">
              <span className="board-col-name">{col.name}</span>
              <span className="board-col-count">{cards.length}</span>
            </div>
            {cards.map((r) => (
              <div
                key={r.id}
                className={'board-card' + (allowDetail ? ' is-clickable' : '')}
                onClick={allowDetail ? () => void onOpen(r.id) : undefined}
              >
                <div className="card-title">
                  {r.icon && (
                    <span className="inline-icon">
                      <PageIcon icon={r.icon} size={14} />{' '}
                    </span>
                  )}
                  {r.title || t('Untitled')}
                </div>
                {showProps.map((p) => {
                  const v = r.props[p.id];
                  if (v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) return null;
                  return (
                    <div key={p.id} className="card-prop">
                      <PublicPropValue def={p} value={v} related={related} onOpen={allowDetail ? onOpen : undefined} />
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

// Read-only month grid mirroring the in-app calendar: same layout and CSS,
// no drag, no create. Events open the row only when the owner enabled detail.
function PublicCalendar({
  rows,
  schema,
  dateProp,
  allowDetail,
  onOpen,
}: {
  rows: Row[];
  schema: PropDef[];
  dateProp: string;
  allowDetail: boolean;
  onOpen: (id: string) => void;
}) {
  const [month, setMonth] = useState(() => {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), 1);
  });

  if (!dateProp || !schema.some((p) => p.id === dateProp && p.type === 'date')) {
    return (
      <div className="board-empty">
        {t('This calendar needs a {type} property. Open ⚙ Properties to add one.', { type: t('Date') })}
      </div>
    );
  }

  const byDate = new Map<string, Row[]>();
  for (const r of rows) {
    const v = r.props[dateProp];
    if (typeof v !== 'string' || !v) continue;
    const key = v.slice(0, 10);
    (byDate.get(key) ?? byDate.set(key, []).get(key)!).push(r);
  }

  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const startWeekday = (first.getDay() - firstWeekday() + 7) % 7;
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells: (Date | null)[] = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(month.getFullYear(), month.getMonth(), d));
  while (cells.length % 7 !== 0) cells.push(null);

  const today = toDayString(new Date());
  const step = (delta: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + delta, 1));

  return (
    <div className="calendar">
      <div className="calendar-head">
        <button className="btn-sm" onClick={() => step(-1)} aria-label={t('Previous month')}>‹</button>
        <span className="calendar-title">{formatMonth(month.getFullYear(), month.getMonth(), 'long')}</span>
        <button className="btn-sm" onClick={() => step(1)} aria-label={t('Next month')}>›</button>
        <button className="btn-sm" onClick={() => setMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}>{t('Today')}</button>
      </div>
      <div className="calendar-grid">
        {weekdayNames().map((d) => (
          <div key={d} className="calendar-dow">{d}</div>
        ))}
        {cells.map((d, i) => {
          const key = d ? toDayString(d) : '';
          const dayRows = d ? byDate.get(key) ?? [] : [];
          return (
            <div key={i} className={'calendar-cell' + (d ? '' : ' empty') + (key === today ? ' today' : '')}>
              {d && <div className="calendar-daynum">{d.getDate()}</div>}
              {dayRows.map((r) =>
                allowDetail ? (
                  <button key={r.id} className="calendar-event" onClick={() => void onOpen(r.id)} title={r.title}>
                    {r.icon && <span className="inline-icon"><PageIcon icon={r.icon} size={14} /> </span>}
                    {r.title || t('Untitled')}
                  </button>
                ) : (
                  <span key={r.id} className="calendar-event is-static" title={r.title}>
                    {r.icon && <span className="inline-icon"><PageIcon icon={r.icon} size={14} /> </span>}
                    {r.title || t('Untitled')}
                  </span>
                ),
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Read-only Gantt mirroring the in-app timeline: same geometry and CSS, no
// editing. Bars/labels open the row only when the owner enabled detail.
function PublicTimeline({
  rows,
  schema,
  startProp,
  endProp,
  allowDetail,
  onOpen,
}: {
  rows: Row[];
  schema: PropDef[];
  startProp: string;
  endProp: string;
  allowDetail: boolean;
  onOpen: (id: string) => void;
}) {
  if (!startProp || !schema.some((p) => p.id === startProp && p.type === 'date')) {
    return (
      <div className="board-empty">
        {t('This timeline needs a {type} property as its start. Open ⚙ Properties to add one.', { type: t('Date') })}
      </div>
    );
  }

  const DAY = 26; // px per day, same as inside
  const LABELW = 190;
  const dayNum = (iso: string) => {
    const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
    return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
  };

  type Item = { row: Row; start: number; end: number };
  const items: Item[] = [];
  for (const r of rows) {
    const sv = r.props[startProp];
    if (typeof sv !== 'string' || !sv) continue;
    const start = dayNum(sv);
    let end = start;
    if (endProp) {
      const ev = r.props[endProp];
      if (typeof ev === 'string' && ev) end = Math.max(start, dayNum(ev));
    }
    items.push({ row: r, start, end });
  }

  if (items.length === 0) {
    return (
      <div className="board-empty">
        {t('No entries with a date yet. Set a start date so they appear on the timeline.')}
      </div>
    );
  }

  const today = dayNum(toDayString(new Date()));
  const min = Math.min(today, ...items.map((i) => i.start)) - 3;
  const max = Math.max(today, ...items.map((i) => i.end)) + 4;
  const gridWidth = (max - min + 1) * DAY;

  const months: { label: string; left: number; width: number }[] = [];
  let cursor = min;
  while (cursor <= max) {
    const d = new Date(cursor * 86400000);
    const y = d.getUTCFullYear();
    const mo = d.getUTCMonth();
    const nextMonthDay = Math.floor(Date.UTC(y, mo + 1, 1) / 86400000);
    const segEnd = Math.min(nextMonthDay - 1, max);
    months.push({
      label: formatMonth(y, mo, 'short'),
      left: (cursor - min) * DAY,
      width: (segEnd - cursor + 1) * DAY,
    });
    cursor = nextMonthDay;
  }
  const todayLeft = (today - min) * DAY;

  return (
    <div className="timeline">
      <div className="tl-scroll">
        <div className="tl-inner" style={{ width: LABELW + gridWidth }}>
          <div className="tl-header">
            <div className="tl-corner" style={{ width: LABELW }} />
            <div className="tl-months" style={{ width: gridWidth }}>
              {months.map((m, i) => (
                <div key={i} className="tl-month" style={{ left: m.left, width: m.width }}>
                  {m.label}
                </div>
              ))}
              <div className="tl-today-tick" style={{ left: todayLeft }} title={t('Today')} />
            </div>
          </div>
          <div className="tl-body">
            {items.map(({ row, start, end }) => {
              const left = (start - min) * DAY;
              const width = Math.max(DAY - 4, (end - start + 1) * DAY - 4);
              return (
                <div key={row.id} className="tl-row">
                  <div
                    className={'tl-label' + (allowDetail ? '' : ' is-static')}
                    style={{ width: LABELW }}
                    onClick={allowDetail ? () => void onOpen(row.id) : undefined}
                    title={row.title}
                  >
                    {row.icon && (
                      <span className="inline-icon">
                        <PageIcon icon={row.icon} size={14} />
                      </span>
                    )}
                    <span className="tl-label-text">{row.title || t('Untitled')}</span>
                  </div>
                  <div className="tl-track" style={{ width: gridWidth }}>
                    <div className="tl-today-line" style={{ left: todayLeft }} />
                    <div
                      className={'tl-bar' + (allowDetail ? '' : ' is-static')}
                      style={{ left, width }}
                      onClick={allowDetail ? () => void onOpen(row.id) : undefined}
                      title={row.title}
                    >
                      <span className="tl-bar-label">{row.title || t('Untitled')}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function PublicDetailProps({
  schema,
  values,
  related,
  onOpen,
}: {
  schema: PropDef[];
  values: Record<string, unknown>;
  related: Record<string, { title: string; icon: string }>;
  onOpen: (id: string) => void;
}) {
  const shown = schema.filter((p) => {
    const v = values[p.id];
    return !(v === undefined || v === '' || v === null || (Array.isArray(v) && v.length === 0));
  });
  if (shown.length === 0) return null;
  return (
    <div className="public-detail-props">
      {shown.map((p) => (
        <div key={p.id} className="public-detail-prop">
          <span className="public-detail-prop-name">{p.name}</span>
          <PublicPropValue def={p} value={values[p.id]} related={related} onOpen={onOpen} />
        </div>
      ))}
    </div>
  );
}

// Row content is BlockNote JSON. Render an honest plain-text extract —
// headings, lists and paragraphs as text, nothing executable.
function PublicDetailContent({ content }: { content: string }) {
  const blocks = useMemo(() => {
    try {
      const v = JSON.parse(content || '[]');
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }, [content]);
  if (blocks.length === 0) return null;
  const textOf = (b: Record<string, unknown>): string => {
    const c = b.content;
    if (!Array.isArray(c)) return '';
    return c
      .map((n) => (typeof n === 'object' && n !== null && 'text' in (n as object) ? String((n as { text: unknown }).text) : ''))
      .join('');
  };
  return (
    <div className="public-detail-content">
      {blocks.map((b, i) => {
        const block = b as Record<string, unknown>;
        const text = textOf(block);
        if (!text.trim()) return null;
        const type = String(block.type ?? 'paragraph');
        if (type === 'heading') return <h3 key={i}>{text}</h3>;
        if (type === 'bulletListItem') return <li key={i}>{text}</li>;
        if (type === 'checkListItem')
          return (
            <li key={i} className="public-check">
              {(block.props as { checked?: boolean } | undefined)?.checked ? '☑ ' : '☐ '}
              {text}
            </li>
          );
        return <p key={i}>{text}</p>;
      })}
    </div>
  );
}
