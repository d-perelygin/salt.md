import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ChevronDown, ChevronRight, FileText, Pin, Plus, Table2, X } from 'lucide-react';
import { PageIcon } from '../pageIcon';
import type { PageMeta } from '../types';
import type { ArchivedTab } from '../tabAging';
import { t } from '../i18n';
import { goBack, goForward, useNavArrows } from '../navStack';
import Portal from './Portal';
import SheetGrab from './SheetGrab';

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
  unused,
  onSelect,
  onClose,
  onDiscard,
  onCreate,
  onCloseUnused,
  onReopen,
  onTogglePin,
  onDismiss,
}: {
  open: boolean;
  tabs: string[];
  pinned: string[];
  activeId: string | null;
  pagesById: Map<string, PageMeta>;
  archive: ArchivedTab[];
  /** Tabs nobody has looked at in a week, already filtered of the active and
   *  pinned ones. They leave the grid and gather in their own section, which
   *  is reversible by one tap: nothing is closed behind the reader's back. */
  unused: string[];
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  /** Remove an unused tab. Unlike onClose it files nothing: the tab was
   *  already unwanted, so it simply goes. */
  onDiscard: (id: string) => void;
  onCreate: () => void;
  onCloseUnused: () => void;
  onReopen: (id: string) => void;
  onTogglePin: (id: string) => void;
  onDismiss: () => void;
}) {
  const nav = useNavArrows();
  const sheetRef = useRef<HTMLDivElement>(null);
  // The unused group is a plaque, not a shelf: it sits above the grid and
  // stays closed until asked, so the tabs actually open keep the room. Every
  // open starts closed — the count is what says whether to look.
  const [unusedOpen, setUnusedOpen] = useState(false);
  useEffect(() => {
    if (open) setUnusedOpen(false);
  }, [open]);
  if (!open) return null;
  const unusedSet = new Set(unused);
  const recent = tabs.filter((id) => !unusedSet.has(id));
  /** The pin sits on every card and every unused row: it is the one control
   *  that decides whether a tab can age out at all, so it has to be visible
   *  where the decision is made instead of hiding in a menu. */
  const pinButton = (id: string, size: number) => {
    const isPinned = pinned.includes(id);
    return (
      <button
        type="button"
        className={'tabs-sheet-card-pin' + (isPinned ? ' on' : '')}
        aria-label={isPinned ? t('Unpin tab') : t('Pin tab')}
        aria-pressed={isPinned}
        title={isPinned ? t('Unpin tab') : t('Pin tab')}
        onClick={(e) => {
          e.stopPropagation();
          onTogglePin(id);
        }}
      >
        <Pin size={size} />
      </button>
    );
  };
  return (
    <Portal>
      <div className="fs-backdrop tabs-sheet-backdrop" onClick={onDismiss} />
      <div className="tabs-sheet" role="dialog" aria-label={t('Tabs')} ref={sheetRef}>
        <SheetGrab sheet={sheetRef} onDismiss={onDismiss} />
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
          {/* Above the grid, not below it: the group is a thing to decide
              about before picking a tab, and a shelf under a wall of cards is
              reached only by scrolling past them. Closed by default, then it
              is one bar — the count says whether opening it is worth it. */}
          {unused.length > 0 && (
            <div className="tabs-sheet-unused">
              <div className="tabs-sheet-unused-bar">
                <button
                  type="button"
                  className="tabs-sheet-unused-toggle"
                  aria-expanded={unusedOpen}
                  onClick={() => setUnusedOpen((o) => !o)}
                >
                  {unusedOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                  <span className="tabs-sheet-unused-label">{t('Unused tabs')}</span>
                  <span className="tabs-sheet-unused-count">{unused.length}</span>
                </button>
                {unusedOpen && (
                  <button type="button" className="tabs-sheet-group-close" onClick={onCloseUnused}>
                    {t('Close all')}
                  </button>
                )}
              </div>
              {unusedOpen && (
                <div className="tabs-sheet-unused-list">
                  {unused.map((id) => {
                    const page = pagesById.get(id);
                    const title = page?.title || t('Untitled');
                    return (
                      <div
                        key={id}
                        role="button"
                        tabIndex={0}
                        className="tabs-sheet-archive-row"
                        onClick={() => onSelect(id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            onSelect(id);
                          }
                        }}
                      >
                        <span className="tabs-sheet-card-icon">
                          <PageIcon
                            icon={page?.icon}
                            size={14}
                            fallback={page?.type === 'collection' ? <Table2 size={14} /> : <FileText size={14} />}
                          />
                        </span>
                        <span className="tabs-sheet-archive-name">{title}</span>
                        {pinButton(id, 13)}
                        <button
                          type="button"
                          className="tabs-sheet-card-close"
                          aria-label={t('Close tab {title}', { title })}
                          onClick={(e) => {
                            e.stopPropagation();
                            onDiscard(id);
                          }}
                        >
                          <X size={13} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          <div className="tabs-sheet-grid">
            {recent.map((id) => {
              const page = pagesById.get(id);
              const title = page?.title || t('Untitled');
              const isPinned = pinned.includes(id);
              return (
                <div
                  key={id}
                  role="button"
                  tabIndex={0}
                  aria-current={id === activeId}
                  className={
                    'tabs-sheet-card' +
                    (id === activeId ? ' active' : '') +
                    (isPinned ? ' pinned' : '')
                  }
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
                    <span className="tabs-sheet-card-actions">
                      {pinButton(id, 13)}
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
                    </span>
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
            puts its own toolbar. */}
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
        </div>
      </div>
    </Portal>
  );
}
