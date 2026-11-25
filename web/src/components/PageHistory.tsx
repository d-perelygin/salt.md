import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, ChevronUp, Copy, RotateCcw, X } from 'lucide-react';
import { api } from '../api';
import type { CollectionRevisionState, Comment, Revision, RevisionChange } from '../types';
import Portal from './Portal';
import { confirm } from '../dialog';
import { useExclusiveModal } from '../modal';
import { toast } from '../toast';
import { formatDay, formatMoment, formatMonthYear } from '../format';
import { plural, t } from '../i18n';
import { RevisionBody, diffRevision, parseRevisionContent, wordDiff, type Seg } from './RevisionDiff';
import { CollectionHistory, revisionChangeLine } from './CollectionHistory';

const when = (iso: string) => formatMoment(iso, 'full');

/** The calendar day a moment belongs to, in the reader's own zone: that is
 *  what "today" means to the person reading the list. */
function dayKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDays(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number);
  const t = new Date(y, (m ?? 1) - 1, d ?? 1);
  t.setDate(t.getDate() + days);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

function dayLabel(key: string): string {
  const today = dayKey(new Date().toISOString());
  if (key === today) return t('Today');
  if (key === addDays(today, -1)) return t('Yesterday');
  return formatDay(key);
}

/** How wide a group is. Notion offers this as a pill above the list, and the
 *  reason is plain: a page saved ten times this morning is one thing to read
 *  by the hour and ten things by the minute. A day is the default because it is
 *  the unit people remember a work session in. */
type GroupBy = '15m' | '1h' | '1d' | '1w' | '1m';

const GROUP_MODES: GroupBy[] = ['15m', '1h', '1d', '1w', '1m'];

function groupModeLabel(mode: GroupBy): string {
  switch (mode) {
    case '15m':
      return t('15 minutes');
    case '1h':
      return t('1 hour');
    case '1w':
      return t('1 week');
    case '1m':
      return t('1 month');
    default:
      return t('1 day');
  }
}

/** The first moment of the group a version belongs to, in the reader's zone. */
function groupStart(iso: string, mode: GroupBy): Date | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  d.setSeconds(0, 0);
  if (mode === '1m') {
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    return d;
  }
  if (mode === '1w') {
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // Monday
    d.setHours(0, 0, 0, 0);
    return d;
  }
  if (mode === '1d') {
    d.setHours(0, 0, 0, 0);
    return d;
  }
  if (mode === '1h') {
    d.setMinutes(0, 0, 0);
    return d;
  }
  d.setMinutes(Math.floor(d.getMinutes() / 15) * 15, 0, 0);
  return d;
}

function groupLabel(start: Date, mode: GroupBy): string {
  if (mode === '1m') return formatMonthYear(start.getFullYear(), start.getMonth());
  const day = dayLabel(dayKey(start.toISOString()));
  if (mode === '1w') return t('Week of {date}', { date: day });
  if (mode === '1d') return day;
  return t('{day} at {time}', { day, time: formatMoment(start.toISOString(), 'time') });
}

/** One line of a version: what actually changed. Values are already the words
 *  the collection uses (an option's name, a person's name), so the line reads
 *  like the cell did. */
function changeLine(c: RevisionChange): string {
  if (c.kind === 'title') {
    return t('Title: {from} → {to}', { from: c.from || t('empty'), to: c.to || t('empty') });
  }
  if (c.kind === 'content') return t('Text changed');
  if (c.kind !== 'prop') return revisionChangeLine(c);
  const from = c.type === 'date' ? formatDay(c.from) : c.from;
  const to = c.type === 'date' ? formatDay(c.to) : c.to;
  return `${c.name || c.prop || '?'}: ${from || '—'} → ${to || '—'}`;
}

function summaryLine(changes: RevisionChange[] | undefined, oldest: boolean): string {
  if (!changes || changes.length === 0) {
    return oldest ? t('The first version') : t('No visible change');
  }
  return changes.slice(0, 2).map(changeLine).join('; ');
}

export function HistoryModal({
  pageId,
  collection = false,
  onClose,
  onRestored,
  onOpen,
}: {
  pageId: string;
  /** The page is a database: this dialog shows its structure, not a body. */
  collection?: boolean;
  onClose: () => void;
  onRestored: () => void;
  /** Where a duplicate opens: the caller's own opener, so the new page lands
   *  in a tab (or the current one) exactly as any other page would. */
  onOpen?: (id: string) => void;
}) {
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [groupBy, setGroupBy] = useState<GroupBy>('1d');
  const [closedGroups, setClosedGroups] = useState<Set<number>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  // The full state of the versions being looked at: the one selected and the
  // one above it, because a diff needs both. Fetched on demand and kept, so
  // stepping up and down the list costs one request per version.
  const [states, setStates] = useState<
    Record<string, { title: string; content: string; collection?: CollectionRevisionState }>
  >({});
  const inFlight = useRef<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [active, setActive] = useState(1);
  const bodyRef = useRef<HTMLDivElement>(null);
  useExclusiveModal(onClose);

  const load = useCallback(
    () =>
      void api
        .listRevisions(pageId)
        .then((list) => {
          setRevisions(list);
          setSelected((cur) => (cur && list.some((r) => r.id === cur) ? cur : (list[0]?.id ?? null)));
        })
        .catch(() => {}),
    [pageId],
  );
  useEffect(load, [load]);

  // After a partial restore the newest version is the result: show it, so the
  // pane answers "what is it now" rather than staying on the old one.
  const loadNewest = useCallback(() => {
    void api
      .listRevisions(pageId)
      .then((list) => {
        setRevisions(list);
        setSelected(list[0]?.id ?? null);
      })
      .catch(() => {});
  }, [pageId]);

  const selectedIndex = revisions.findIndex((r) => r.id === selected);
  const older = selectedIndex >= 0 ? revisions[selectedIndex + 1] : undefined;

  const ensure = useCallback(
    (id: string | undefined) => {
      if (!id || states[id] || inFlight.current.has(id)) return;
      inFlight.current.add(id);
      void api
        .getRevision(pageId, id)
        .then((r) => {
          const collectionState: CollectionRevisionState | undefined =
            r.kind === 'collection'
              ? {
                  kind: 'collection',
                  schema: r.schema ?? [],
                  views: r.views ?? [],
                  workflow: r.workflow,
                  newFromTemplate: r.newFromTemplate,
                  createdAt: r.createdAt,
                  authorName: r.authorName,
                  changes: r.changes,
                }
              : undefined;
          const content = JSON.stringify(r.content ?? []);
          setStates((prev) =>
            prev[id]
              ? prev
              : { ...prev, [id]: { title: r.title ?? '', content, collection: collectionState } },
          );
        })
        .catch(() => {})
        .finally(() => inFlight.current.delete(id));
    },
    [pageId, states],
  );

  useEffect(() => {
    ensure(selected ?? undefined);
    ensure(older?.id);
  }, [ensure, selected, older?.id]);

  const current = selected ? states[selected] : undefined;
  const previous = older ? states[older.id] : undefined;

  const lines = useMemo(() => {
    if (!current) return [];
    const after = parseRevisionContent(current.content);
    if (!previous) return diffRevision([], after).map((l) => ({ ...l, kind: 'same' as const }));
    return diffRevision(parseRevisionContent(previous.content), after);
  }, [current, previous]);

  const titleChanged = !!(current && previous && current.title !== previous.title);
  const titleSegs: Seg[] | undefined =
    titleChanged && previous ? wordDiff(previous.title, current!.title) : undefined;

  // The title, when it changed, is the first thing to look at; every changed
  // block after it. The footer steps through these numbers.
  const ranks = useMemo(() => {
    let n = titleChanged ? 1 : 0;
    return lines.map((l) => (l.kind === 'same' ? 0 : ++n));
  }, [lines, titleChanged]);
  const total = ranks.reduce((m, r) => Math.max(m, r), titleChanged ? 1 : 0);

  useEffect(() => {
    setActive(1);
  }, [selected]);

  useEffect(() => {
    if (!total) return;
    const el = bodyRef.current?.querySelector(`[data-change="${active}"]`);
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center' });
  }, [active, total, selected, lines]);

  const grouped = useMemo(() => {
    const groups: { key: number; start: Date; items: Revision[] }[] = [];
    for (const r of revisions) {
      const start = groupStart(r.createdAt, groupBy);
      const key = start ? start.getTime() : 0;
      const last = groups[groups.length - 1];
      if (last && last.key === key) last.items.push(r);
      else groups.push({ key, start: start ?? new Date(0), items: [r] });
    }
    return groups;
  }, [revisions, groupBy]);

  const toggleGroup = (key: number) =>
    setClosedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const isCollection = collection || revisions.some((r) => r.kind === 'collection');

  const restore = async (rev: Revision) => {
    const ok = await confirm(
      isCollection
        ? t('Restore the structure from {when}? The current structure is saved as a version first.', {
            when: when(rev.createdAt),
          })
        : t('Restore the version from {when}? The current state is saved as a version first.', {
            when: when(rev.createdAt),
          }),
    );
    if (!ok) return;
    setBusy(rev.id);
    try {
      await api.restoreRevision(pageId, rev.id, isCollection ? { scope: 'all' } : undefined);
      toast.success(isCollection ? t('Structure restored') : t('Version restored'));
      onRestored();
      onClose();
    } catch (e) {
      toast((e as Error).message || t('Restoring failed'));
    } finally {
      setBusy(null);
    }
  };

  // One column, one view, the process: no confirmation, because it is exactly
  // as reversible as a whole restore and the dialog stays open to show the
  // result.
  const restorePart = async (rev: Revision, scope: 'property' | 'view' | 'workflow', itemId?: string) => {
    setBusy(rev.id);
    try {
      await api.restoreRevision(pageId, rev.id, { scope, itemId });
      toast.success(t('Structure restored'));
      onRestored();
      loadNewest();
    } catch (e) {
      toast((e as Error).message || t('Restoring failed'));
    } finally {
      setBusy(null);
    }
  };

  const duplicate = async (rev: Revision) => {
    setBusy(rev.id);
    try {
      const out = await api.copyRevision(pageId, rev.id);
      toast.success(t('Version duplicated'));
      if (onOpen) onOpen(out.id);
      onClose();
    } catch (e) {
      toast((e as Error).message || t('Duplicating failed'));
    } finally {
      setBusy(null);
    }
  };

  const rev = selectedIndex >= 0 ? revisions[selectedIndex] : undefined;
  const oldest = selectedIndex >= 0 && selectedIndex === revisions.length - 1;
  const propChanges = (rev?.changes ?? []).filter((c) => c.kind === 'prop');

  return (
    <Portal>
      <div
        className="modal-overlay"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div className="rev-dialog" role="dialog" aria-modal="true" aria-label={isCollection ? t('Structure history') : t('Version history')}>
          <aside className="rev-list-pane">
            <div className="rev-list-head">
              <h2>{isCollection ? t('Structure history') : t('Version history')}</h2>
              <label className="rev-group">
                <span>{t('Group by')}</span>
                <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)}>
                  {GROUP_MODES.map((m) => (
                    <option key={m} value={m}>
                      {groupModeLabel(m)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="rev-list">
              {grouped.map((g) => {
                const closed = closedGroups.has(g.key);
                return (
                  <section key={g.key} className="rev-group-block">
                    <button
                      type="button"
                      className="rev-group-head"
                      aria-expanded={!closed}
                      onClick={() => toggleGroup(g.key)}
                    >
                      {closed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                      <span className="rev-group-label">{groupLabel(g.start, groupBy)}</span>
                      <span className="rev-group-count">
                        {plural(g.items.length, '{n} version', '{n} versions')}
                      </span>
                    </button>
                    {!closed &&
                      g.items.map((r) => {
                        const index = revisions.findIndex((x) => x.id === r.id);
                        const isOldest = index === revisions.length - 1;
                        const summary = summaryLine(r.changes, isOldest);
                        return (
                          <button
                            key={r.id}
                            type="button"
                            className={'rev-item' + (r.id === selected ? ' is-active' : '')}
                            aria-current={r.id === selected}
                            onClick={() => setSelected(r.id)}
                          >
                            <span className="rev-item-dot" aria-hidden="true" />
                            <span className="rev-item-main">
                              <span className="rev-item-top">
                                <span className="rev-item-time">{formatMoment(r.createdAt, 'time')}</span>
                                <span className="rev-item-author">{r.authorName || t('unknown')}</span>
                              </span>
                              <span className="rev-item-summary" title={summary}>
                                {summary}
                              </span>
                            </span>
                          </button>
                        );
                      })}
                  </section>
                );
              })}
              {revisions.length === 0 && <div className="dialog-hint">{t('No versions yet.')}</div>}
            </div>
            <p className="rev-list-foot">
              {isCollection
                ? t('A version is saved on every structure change (at most every 2 minutes for layout edits; the latest 50 are kept).')
                : t('A version is saved on every change (documents at most every 2 minutes; the latest 50 are kept).')}
            </p>
          </aside>

          <section className="rev-doc-pane">
            {!rev ? (
              <div className="rev-doc-empty" />
            ) : (
              <>
                <div className="rev-doc-head">
                  <div className="rev-doc-when">
                    <span className="rev-doc-moment">{when(rev.createdAt)}</span>
                    <span className="rev-doc-author">{rev.authorName || t('unknown')}</span>
                  </div>
                  <div className="rev-doc-actions">
                    <button
                      className="btn"
                      disabled={busy === rev.id}
                      title={t('Restore this version')}
                      onClick={() => void restore(rev)}
                    >
                      <RotateCcw size={14} /> {t('Restore')}
                    </button>
                    {!isCollection && (
                      <button
                        className="btn"
                        disabled={busy === rev.id}
                        title={t('Duplicate this version into a new page')}
                        onClick={() => void duplicate(rev)}
                      >
                        <Copy size={14} /> {t('Duplicate')}
                      </button>
                    )}
                    <button className="btn-sm rev-close" onClick={onClose} aria-label={t('Close')}>
                      <X size={16} />
                    </button>
                  </div>
                </div>
                {isCollection ? (
                  <CollectionHistory
                    state={current?.collection}
                    changes={rev.changes}
                    busy={busy === rev.id}
                    onRestore={(scope, itemId, fromPrevious) =>
                      void restorePart(fromPrevious && older ? older : rev, scope, itemId)
                    }
                  />
                ) : (
                  <>
                    {propChanges.length > 0 && (
                      <div className="rev-props">
                        {propChanges.map((c, i) => (
                          <span key={i} className="rev-prop">
                            {changeLine(c)}
                          </span>
                        ))}
                      </div>
                    )}
                    {current ? (
                      <RevisionBody
                        lines={lines}
                        ranks={ranks}
                        title={current.title}
                        titleSegs={titleSegs}
                        titleChange={titleChanged ? 1 : 0}
                        activeChange={active}
                        bodyRef={bodyRef}
                      />
                    ) : (
                      <div className="rev-doc-loading" />
                    )}
                    <div className="rev-doc-foot">
                      {total > 0 ? (
                        <>
                          <span className="rev-doc-count">
                            {active} / {plural(total, '{n} change', '{n} changes')}
                          </span>
                          <span className="rev-doc-nav">
                            <button
                              className="btn-sm"
                              disabled={active <= 1}
                              title={t('Previous change')}
                              onClick={() => setActive((n) => Math.max(1, n - 1))}
                            >
                              <ChevronUp size={15} />
                            </button>
                            <button
                              className="btn-sm"
                              disabled={active >= total}
                              title={t('Next change')}
                              onClick={() => setActive((n) => Math.min(total, n + 1))}
                            >
                              <ChevronDown size={15} />
                            </button>
                          </span>
                        </>
                      ) : (
                        <span className="rev-doc-count">
                          {oldest ? t('The first version') : t('No changes in the text')}
                        </span>
                      )}
                    </div>
                  </>
                )}
              </>
            )}
          </section>
        </div>
      </div>
    </Portal>
  );
}

export function CommentsModal({
  pageId,
  myUserId,
  onClose,
}: {
  pageId: string;
  myUserId: string;
  onClose: () => void;
}) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [body, setBody] = useState('');
  const [showResolved, setShowResolved] = useState(false);
  useExclusiveModal(onClose);
  const load = () => void api.listComments(pageId).then(setComments).catch(() => {});
  useEffect(load, [pageId]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!body.trim()) return;
    try {
      await api.createComment(pageId, body.trim());
      setBody('');
      load();
    } catch (err) {
      toast((err as Error).message || t('Could not post the comment'));
    }
  };
  const toggleResolve = async (c: Comment) => {
    await api.resolveComment(c.id, !c.resolvedAt).catch(() => {});
    load();
  };
  const remove = async (c: Comment) => {
    await api.deleteComment(c.id).catch(() => {});
    load();
  };

  const visible = comments.filter((c) => showResolved || !c.resolvedAt);

  return (
    <Portal>
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={t('Comments')}>
        <h2>{t('Comments')}</h2>
        <label className="check-label">
          <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} />
          {t('Show resolved')}
        </label>
        <div className="comment-list">
          {visible.map((c) => (
            <div key={c.id} className={'comment' + (c.resolvedAt ? ' resolved' : '')}>
              <div className="comment-head">
                <strong>{c.authorName || t('unknown')}</strong>
                <span className="comment-time">{when(c.createdAt)}</span>
              </div>
              <div className="comment-body">{c.body}</div>
              <div className="comment-actions">
                <button className="btn-sm" onClick={() => void toggleResolve(c)}>
                  {c.resolvedAt ? t('Reopen') : t('✓ Resolved')}
                </button>
                {c.authorId === myUserId && (
                  <button className="btn-sm danger" onClick={() => void remove(c)}>{t('Delete')}</button>
                )}
              </div>
            </div>
          ))}
          {visible.length === 0 && <div className="dialog-hint">{t('No comments yet.')}</div>}
        </div>
        <form className="user-add" onSubmit={add}>
          <input value={body} placeholder={t('Write a comment…')} onChange={(e) => setBody(e.target.value)} />
          <button className="btn primary" type="submit">{t('Send')}</button>
        </form>
        <button className="btn dialog-close" onClick={onClose}>{t('Close')}</button>
      </div>
    </div>
    </Portal>
  );
}
