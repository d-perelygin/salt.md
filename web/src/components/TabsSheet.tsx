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
  onMove,
  onDismiss,
}: {
  open: boolean;
  tabs: string[];
  pinned: string[];
  activeId: string | null;
  pagesById: Map<string, PageMeta>;
  archive: ArchivedTab[];
  /** Tabs nobody has looked at for three days, already filtered of the active and
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
  /** Drop `id` at the slot of `to` (an index in the full tabs array). */
  onMove: (id: string, to: number) => void;
  onDismiss: () => void;
}) {
  const nav = useNavArrows();
  const sheetRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  // The unused group is a plaque, not a shelf: it sits above the grid and
  // stays closed until asked, so the tabs actually open keep the room. Every
  // open starts closed — the count is what says whether to look.
  const [unusedOpen, setUnusedOpen] = useState(false);
  // Dragging a card over another one: the one under the finger is marked and
  // the order changes on release. Live reordering while the finger moves
  // makes the grid chase itself — the card under the finger becomes the
  // dragged card and the two trade places twice a frame.
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const suppressClick = useRef(0);
  useEffect(() => {
    if (open) setUnusedOpen(false);
  }, [open]);
  if (!open) return null;

  /** Press a card to pick it up. A mouse lifts at once; a finger after a short
   *  hold, so a swipe still scrolls the grid. Release over another card moves
   *  the tab there, anywhere in the strip; a pin is a mark, not a block. */
  const startDrag = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const touch = e.pointerType !== 'mouse';
    let active = false;
    let timer = 0;
    let over: string | null = null;
    // touch-action is read when the gesture begins, so a hold that turns into
    // a drag cannot switch it off retroactively: the sheet would scroll under
    // the finger. A non-passive touchmove is the only way to stop it now.
    const stopScroll = (ev: TouchEvent) => ev.preventDefault();
    const arm = () => {
      active = true;
      setDragId(id);
      document.body.classList.add('tabs-dragging');
      window.addEventListener('touchmove', stopScroll, { passive: false });
    };
    const move = (ev: PointerEvent) => {
      if (!active) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) <= 6) return;
        // A mouse has no hold to wait for; a finger that moves before the hold
        // is scrolling the grid, not carrying a card.
        if (touch) cleanup();
        else arm();
        if (!active) return;
      }
      ev.preventDefault();
      const card = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)
        ?.closest?.('.tabs-sheet-card[data-tab-id]') as HTMLElement | null;
      const next = card?.dataset.tabId ?? null;
      if (next !== over) {
        over = next && next !== id ? next : null;
        setOverId(over);
      }
      const body = bodyRef.current;
      if (body) {
        const r = body.getBoundingClientRect();
        if (ev.clientY < r.top + 56) body.scrollTop -= 14;
        else if (ev.clientY > r.bottom - 56) body.scrollTop += 14;
      }
    };
    const cleanup = () => {
      window.clearTimeout(timer);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      window.removeEventListener('touchmove', stopScroll);
    };
    const up = () => {
      if (active) {
        suppressClick.current = Date.now();
        if (over) onMove(id, tabs.indexOf(over));
        setDragId(null);
        setOverId(null);
        document.body.classList.remove('tabs-dragging');
      }
      cleanup();
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    if (touch) timer = window.setTimeout(arm, 280);
  };
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
        <div className="tabs-sheet-body" ref={bodyRef}>
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
                  data-tab-id={id}
                  aria-current={id === activeId}
                  className={
                    'tabs-sheet-card' +
                    (id === activeId ? ' active' : '') +
                    (isPinned ? ' pinned' : '') +
                    (id === dragId ? ' is-dragging' : '') +
                    (id === overId ? ' is-drop' : '')
                  }
                  onPointerDown={(e) => startDrag(e, id)}
                  onClick={() => {
                    // The click that ends a drag is the drag's, not a select.
                    if (Date.now() - suppressClick.current < 400) return;
                    onSelect(id);
                  }}
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
