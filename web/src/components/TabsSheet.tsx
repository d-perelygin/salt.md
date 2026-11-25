import { ArrowLeft, ArrowRight, FileText, Plus, Table2, X } from 'lucide-react';
import { PageIcon } from '../pageIcon';
import type { PageMeta } from '../types';
import type { ArchivedTab } from '../tabAging';
import { t } from '../i18n';
import { goBack, goForward, useNavArrows } from '../navStack';
import Portal from './Portal';

/** Open documents as a sheet of cards, for the phone.
 *
 *  A horizontal strip is the wrong shape here: a phone accumulates a dozen
 *  open pages in a day, and at that count a strip shows two and a half titles
 *  and no way to see the rest. A grid of cards shows eight at once, each one
 *  large enough to hit without aiming, and the × is where the eye looks for it.
 *
 *  Portalled out of the editor: the sheet must cover the viewport, and the
 *  mobile drawer's transform would otherwise become its containing block. */
export default function TabsSheet({
  open,
  tabs,
  pinned,
  activeId,
  pagesById,
  archive,
  staleCount,
  onSelect,
  onClose,
  onCreate,
  onCloseUnused,
  onReopen,
  onDismiss,
}: {
  open: boolean;
  tabs: string[];
  pinned: string[];
  activeId: string | null;
  pagesById: Map<string, PageMeta>;
  archive: ArchivedTab[];
  staleCount: number;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onCreate: () => void;
  onCloseUnused: () => void;
  onReopen: (id: string) => void;
  onDismiss: () => void;
}) {
  const nav = useNavArrows();
  if (!open) return null;
  return (
    <Portal>
      <div className="fs-backdrop tabs-sheet-backdrop" onClick={onDismiss} />
      <div className="tabs-sheet" role="dialog" aria-label={t('Tabs')}>
        <div className="sheet-grab" aria-hidden="true" />
        <div className="tabs-sheet-head">
          <span className="tabs-sheet-title">{t('Tabs')}</span>
          <button
            type="button"
            className="tabs-sheet-dismiss"
            aria-label={t('Close')}
            onClick={onDismiss}
          >
            <X size={17} />
          </button>
        </div>
        <div className="tabs-sheet-body">
          <div className="tabs-sheet-grid">
            {tabs.map((id) => {
              const page = pagesById.get(id);
              const title = page?.title || t('Untitled');
              const isPinned = pinned.includes(id);
              return (
                <div
                  key={id}
                  role="button"
                  tabIndex={0}
                  aria-current={id === activeId}
                  className={'tabs-sheet-card' + (id === activeId ? ' active' : '')}
                  onClick={() => onSelect(id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSelect(id);
                    }
                  }}
                >
                  <span className="tabs-sheet-card-top">
                    <span className="tabs-sheet-card-icon">
                      <PageIcon
                        icon={page?.icon}
                        size={15}
                        fallback={page?.type === 'collection' ? <Table2 size={15} /> : <FileText size={15} />}
                      />
                    </span>
                    {!isPinned && (
                      <button
                        type="button"
                        className="tabs-sheet-card-close"
                        aria-label={t('Close tab {title}', { title })}
                        onClick={(e) => {
                          e.stopPropagation();
                          onClose(id);
                        }}
                      >
                        <X size={13} />
                      </button>
                    )}
                  </span>
                  <span className="tabs-sheet-card-title">{title}</span>
                </div>
              );
            })}
            <button type="button" className="tabs-sheet-card tabs-sheet-new" onClick={onCreate}>
              <span className="tabs-sheet-card-icon">
                <Plus size={17} />
              </span>
              <span className="tabs-sheet-card-title">{t('New page')}</span>
            </button>
          </div>

          {archive.length > 0 && (
            <div className="tabs-sheet-archive">
              <div className="tabs-sheet-archive-title">{t('Recently closed')}</div>
              {archive.slice(0, 5).map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className="tabs-sheet-archive-row"
                  onClick={() => onReopen(entry.id)}
                >
                  <span className="tabs-sheet-card-icon">
                    <PageIcon icon={entry.icon} size={14} fallback={<FileText size={14} />} />
                  </span>
                  <span className="tabs-sheet-archive-name">{entry.title || t('Untitled')}</span>
                  <span className="tabs-sheet-archive-action">{t('Reopen')}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {/* The two arrows a browser has and an installed app does not, along
            the bottom edge where the thumb is — the same place the browser
            puts its own toolbar. The unused-tabs pass sits beside them: both
            are about the collection as a whole, and neither belongs in the
            header. */}
        <div className="tabs-sheet-foot">
          <button
            type="button"
            className="tabs-sheet-arrow"
            aria-label={t('Back')}
            title={t('Back')}
            disabled={!nav.back}
            onClick={goBack}
          >
            <ArrowLeft size={19} />
          </button>
          <button
            type="button"
            className="tabs-sheet-arrow"
            aria-label={t('Forward')}
            title={t('Forward')}
            disabled={!nav.forward}
            onClick={goForward}
          >
            <ArrowRight size={19} />
          </button>
          {staleCount > 0 && (
            <button type="button" className="tabs-sheet-unused" onClick={onCloseUnused}>
              {t('Close unused tabs')}
            </button>
          )}
        </div>
      </div>
    </Portal>
  );
}
