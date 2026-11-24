import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Clock } from 'lucide-react';
import { api } from '../api';
import type { Comment, Revision, RevisionChange } from '../types';
import Portal from './Portal';
import { confirm } from '../dialog';
import { useExclusiveModal } from '../modal';
import { toast } from '../toast';
import { formatDay, formatMoment } from '../format';
import { plural, t } from '../i18n';

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

/** One line of a version: what actually changed. Values are already the words
 *  the collection uses (an option's name, a person's name), so the line reads
 *  like the cell did. */
function changeLine(c: RevisionChange): string {
  if (c.kind === 'title') {
    return t('Title: {from} → {to}', { from: c.from || t('empty'), to: c.to || t('empty') });
  }
  if (c.kind === 'content') return t('Text changed');
  const from = c.type === 'date' ? formatDay(c.from) : c.from;
  const to = c.type === 'date' ? formatDay(c.to) : c.to;
  return `${c.name || c.prop || '?'}: ${from || '—'} → ${to || '—'}`;
}

function summaryLine(changes: RevisionChange[] | undefined, oldest: boolean): string {
  if (!changes || changes.length === 0) {
    // A revision from before changes were recorded says nothing about what it
    // changed. Only the oldest version is allowed to be "the first" — calling
    // thirty old snapshots that would be a lie.
    return oldest ? t('The first version') : t('Changes were not recorded');
  }
  const shown = changes.slice(0, 2).map(changeLine);
  if (changes.length > 2) shown.push(t('+{n} more', { n: changes.length - 2 }));
  return shown.join('; ');
}

export function HistoryModal({
  pageId,
  onClose,
  onRestored,
  onOpen,
}: {
  pageId: string;
  onClose: () => void;
  onRestored: () => void;
  /** Where a copy opens: the caller's own opener, so the new page lands in a
   *  tab (or the current one) exactly as any other page would. */
  onOpen?: (id: string) => void;
}) {
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [openRows, setOpenRows] = useState<Set<string>>(new Set());
  const [closedDays, setClosedDays] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  useExclusiveModal(onClose);
  const load = () => void api.listRevisions(pageId).then(setRevisions).catch(() => {});
  useEffect(load, [pageId]);

  // Grouped by the day the reader saw it happen: "today" is the unit people
  // remember a work session in, not an exact timestamp.
  const days: { key: string; items: Revision[] }[] = [];
  for (const r of revisions) {
    const key = dayKey(r.createdAt);
    const last = days[days.length - 1];
    if (last && last.key === key) last.items.push(r);
    else days.push({ key, items: [r] });
  }

  const toggleRow = (id: string) =>
    setOpenRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleDay = (key: string) =>
    setClosedDays((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const restore = async (rev: Revision) => {
    const ok = await confirm(
      t('Restore the version from {when}? The current state is saved as a version first.', {
        when: when(rev.createdAt),
      }),
    );
    if (!ok) return;
    setBusy(rev.id);
    try {
      await api.restoreRevision(pageId, rev.id);
      toast.success(t('Version restored'));
      onRestored();
      onClose();
    } catch (e) {
      toast((e as Error).message || t('Restoring failed'));
    } finally {
      setBusy(null);
    }
  };

  const copyVersion = async (rev: Revision) => {
    setBusy(rev.id);
    try {
      const out = await api.copyRevision(pageId, rev.id);
      toast.success(t('A copy of this version was created'));
      if (onOpen) onOpen(out.id);
      onClose();
    } catch (e) {
      toast((e as Error).message || t('Copying failed'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Portal>
      <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <div className="dialog history-dialog" role="dialog" aria-modal="true" aria-label={t('Version history')}>
          <h2>{t('Version history')}</h2>
          <p className="dialog-hint">
            {t('A version is saved on every change (documents at most every 2 minutes; the latest 50 are kept).')}
          </p>
          <div className="history-body">
            {days.map((day) => {
              const closed = closedDays.has(day.key);
              return (
                <section key={day.key} className="history-day">
                  <button
                    type="button"
                    className="history-day-head"
                    aria-expanded={!closed}
                    onClick={() => toggleDay(day.key)}
                  >
                    {closed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                    <span className="history-day-label">{dayLabel(day.key)}</span>
                    <span className="history-day-count">
                      {plural(day.items.length, '{n} version', '{n} versions')}
                    </span>
                  </button>
                  {!closed &&
                    day.items.map((r) => {
                      const open = openRows.has(r.id);
                      const changes = r.changes ?? [];
                      const oldest = r.id === revisions[revisions.length - 1]?.id;
                      return (
                        <article key={r.id} className={'history-item' + (open ? ' is-open' : '')}>
                          <div className="history-item-head">
                            <button
                              type="button"
                              className="history-item-toggle"
                              aria-expanded={open}
                              onClick={() => toggleRow(r.id)}
                            >
                              <Clock size={13} className="history-clock" />
                              <span className="history-time">{formatMoment(r.createdAt, 'time')}</span>
                              <span className="history-author">{r.authorName || t('unknown')}</span>
                              <span className="history-summary" title={changes.map(changeLine).join('; ')}>
                                {summaryLine(changes, oldest)}
                              </span>
                              {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                            </button>
                            <span className="history-item-actions">
                              <button
                                type="button"
                                className="btn-sm"
                                disabled={busy === r.id}
                                title={t('Restore this version')}
                                onClick={() => void restore(r)}
                              >
                                {t('Restore')}
                              </button>
                              <button
                                type="button"
                                className="btn-sm"
                                disabled={busy === r.id}
                                title={t('Copy this version into a new page')}
                                onClick={() => void copyVersion(r)}
                              >
                                {t('Copy')}
                              </button>
                            </span>
                          </div>
                          {open && (
                            <div className="history-item-detail">
                              {changes.length > 0 ? (
                                <ul className="history-changes">
                                  {changes.map((c, i) => (
                                    <li key={i} className="history-change">
                                      {changeLine(c)}
                                    </li>
                                  ))}
                                </ul>
                              ) : (
                                <p className="history-change">
                                  {oldest ? t('The first version') : t('Changes were not recorded')}
                                </p>
                              )}
                              {r.excerpt && <p className="history-excerpt">{r.excerpt}</p>}
                            </div>
                          )}
                        </article>
                      );
                    })}
                </section>
              );
            })}
            {revisions.length === 0 && <div className="dialog-hint">{t('No versions yet.')}</div>}
          </div>
          <button className="btn dialog-close" onClick={onClose}>{t('Close')}</button>
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
