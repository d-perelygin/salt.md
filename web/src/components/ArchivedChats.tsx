import { useEffect, useState } from 'react';
import { Archive, ArchiveRestore, MessageCircle, Search, X } from 'lucide-react';
import type { AiThread } from './AiThreadList';
import type { PageMeta } from '../types';
import { t } from '../i18n';
import { confirm } from '../dialog';
import Portal from './Portal';

// Archived chats, where the trash sits when the sidebar is on its Chat side:
// the same drawer the trash uses (a third of the sidebar, its own scroller, a
// sticky search), because it is the same kind of thing — a place pages and
// conversations go when they leave the working list.

function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

interface Props {
  threads: AiThread[];
  activeId: string | null;
  pagesById: Map<string, PageMeta>;
  onOpen: (id: string) => void;
  onUnarchive: (id: string) => void;
  onDelete: (id: string) => void;
}

function ArchivedList({ threads, activeId, pagesById, onOpen, onUnarchive, onDelete }: Props) {
  const [query, setQuery] = useState('');
  const q = fold(query.trim());
  const shown = q
    ? threads.filter((th) =>
        fold(
          [th.title, th.pageTitle, th.lastPreview, pagesById.get(th.pageId)?.title]
            .filter(Boolean)
            .join(' '),
        ).includes(q),
      )
    : threads;

  return (
    <div className="trash-body">
      {threads.length > 0 && (
        <label className="trash-search">
          <Search size={13} />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('Search archived chats')}
            aria-label={t('Search archived chats')}
          />
        </label>
      )}
      {shown.map((th) => {
        const pageTitle = th.pageTitle || pagesById.get(th.pageId)?.title || '';
        return (
          <div
            key={th.id}
            className={'ai-chat-row archive-row' + (th.id === activeId ? ' active' : '')}
            onClick={() => onOpen(th.id)}
            title={th.title || t('New chat')}
          >
            <span className="ai-row-icon"><MessageCircle size={15} /></span>
            <span className="ai-row-title">
              <span>{th.title || t('New chat')}</span>
              {(pageTitle || th.lastPreview) && (
                <span className="ai-row-sub">
                  {[pageTitle, th.lastPreview].filter(Boolean).join(' · ').slice(0, 80)}
                </span>
              )}
            </span>
            <button
              type="button"
              className="archive-restore"
              title={t('Restore')}
              aria-label={t('Restore')}
              onClick={(e) => {
                e.stopPropagation();
                onUnarchive(th.id);
              }}
            >
              <ArchiveRestore size={14} />
            </button>
            <button
              type="button"
              className="archive-restore archive-delete"
              title={t('Delete forever')}
              aria-label={t('Delete forever')}
              onClick={(e) => {
                e.stopPropagation();
                void confirm(t('Delete this chat forever?'), { confirmText: t('Delete forever'), danger: true }).then((ok) => {
                  if (ok) onDelete(th.id);
                });
              }}
            >
              <X size={14} />
            </button>
          </div>
        );
      })}
      {threads.length === 0 && <div className="trash-empty">{t('No archived chats')}</div>}
      {threads.length > 0 && q && shown.length === 0 && (
        <div className="trash-empty">{t('Nothing archived matches.')}</div>
      )}
    </div>
  );
}

/** The desktop frame: a drawer below the tree, exactly the trash's shape. */
export function ArchivedChatsSection(props: Props) {
  const [open, setOpen] = useState(false);
  return (
    <div className={open ? 'trash-section archive-section open' : 'trash-section archive-section'}>
      <button className="trash-toggle" onClick={() => setOpen(!open)} type="button">
        <span className="sidebar-item-label"><Archive size={15} /> {t('Archived')}</span>{' '}
        <span className="trash-count">{props.threads.length}</span>
      </button>
      {open && <ArchivedList {...props} />}
    </div>
  );
}

/** The phone frame: the same list in the trash dialog's sheet. */
export function ArchivedChatsDialog({
  open,
  onClose,
  ...rest
}: Props & { open: boolean; onClose: () => void }) {
  // Same way out as the trash dialog: the phone has no visible keyboard.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <Portal>
      <div
        className="modal-overlay"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div className="dialog wide trash-dialog" role="dialog" aria-modal="true" aria-label={t('Archived')}>
          <div className="trash-dialog-head">
            <h2>
              <Archive size={18} />
              {t('Archived')}
              {rest.threads.length > 0 && <span className="trash-count">{rest.threads.length}</span>}
            </h2>
            <button className="icon-btn" title={t('Close')} aria-label={t('Close')} onClick={onClose}>
              <X size={16} />
            </button>
          </div>
          <ArchivedList {...rest} />
        </div>
      </div>
    </Portal>
  );
}
