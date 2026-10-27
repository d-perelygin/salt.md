import { Fragment, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, FileText, Pin, Table2, X } from 'lucide-react';
import { PageIcon } from '../pageIcon';
import { PageHoverCard } from './PageHoverCard';
import type { PageMeta } from '../types';
import { t } from '../i18n';
import { hint } from '../keys';
import Portal from './Portal';

// Obsidian-style document tabs (Welle 26). One chip per open page; the active
// one is highlighted. Middle-click closes, matching browser tabs. Right-click
// opens the tab's own menu — pin, move, close — acting on that tab without
// switching to it first. Tabs are draggable along the strip.
export default function TabBar({
  tabs,
  pinned,
  activeId,
  pagesById,
  onSelect,
  onClose,
  onCloseOthers,
  onCloseToRight,
  onTogglePin,
  onMove,
  onMoveTo,
  tagColors,
}: {
  tabs: string[];
  pinned: string[];
  activeId: string | null;
  pagesById: Map<string, PageMeta>;
  tagColors?: Record<string, string>;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onCloseOthers: (id: string) => void;
  onCloseToRight: (id: string) => void;
  onTogglePin: (id: string) => void;
  onMove: (id: string, delta: -1 | 1) => void;
  onMoveTo: (id: string, index: number) => void;
}) {
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const longPressTimer = useRef<number | null>(null);
  const touchStartPos = useRef<{ x: number; y: number } | null>(null);
  const didLongPress = useRef(false);

  const clearLongPress = () => {
    if (longPressTimer.current) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    touchStartPos.current = null;
  };

  useEffect(() => {
    const onCaptureClick = (e: MouseEvent) => {
      if (didLongPress.current) {
        e.preventDefault();
        e.stopPropagation();
        didLongPress.current = false;
      }
    };
    const onCaptureContextMenu = (e: MouseEvent) => {
      if (didLongPress.current) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('click', onCaptureClick, true);
    window.addEventListener('contextmenu', onCaptureContextMenu, true);
    return () => {
      window.removeEventListener('click', onCaptureClick, true);
      window.removeEventListener('contextmenu', onCaptureContextMenu, true);
    };
  }, []);

  const onTouchStart = (id: string, e: React.TouchEvent) => {
    clearLongPress();
    const touch = e.touches[0];
    if (!touch) return;
    const { clientX, clientY } = touch;
    touchStartPos.current = { x: clientX, y: clientY };
    longPressTimer.current = window.setTimeout(() => {
      didLongPress.current = true;
      setMenu({
        id,
        x: Math.max(8, Math.min(clientX, window.innerWidth - 240)),
        y: Math.max(8, Math.min(clientY, window.innerHeight - 260)),
      });
      longPressTimer.current = null;
    }, 450);
  };

  const onTouchMove = (e: React.TouchEvent) => {
    if (!touchStartPos.current || !longPressTimer.current) return;
    const touch = e.touches[0];
    if (!touch) return;
    const dist = Math.hypot(touch.clientX - touchStartPos.current.x, touch.clientY - touchStartPos.current.y);
    if (dist > 8) {
      clearLongPress();
    }
  };

  const onTouchEnd = () => {
    clearLongPress();
    if (didLongPress.current) {
      window.setTimeout(() => {
        didLongPress.current = false;
      }, 400);
    }
  };
  if (tabs.length <= 1) return null; // a single doc needs no tab strip
  const isPinned = (id: string) => pinned.includes(id);
  const pinnedCount = tabs.filter(isPinned).length;
  // Where `id` sits among its own block, for greying the move entries out at
  // the ends instead of hiding them.
  const canMove = (id: string, delta: -1 | 1) => {
    const at = tabs.indexOf(id);
    if (at < 0) return false;
    if (isPinned(id)) return delta < 0 ? at > 0 : at < pinnedCount - 1;
    return delta < 0 ? at > pinnedCount : at < tabs.length - 1;
  };
  const closeMenu = () => setMenu(null);
  const act = (fn: () => void) => () => {
    closeMenu();
    fn();
  };
  return (
    <>
      <div
        className="tab-bar"
        role="tablist"
        onDragOver={(e) => {
          // Past the last tab (the bar's own padding): dropping here appends.
          if (!dragId || e.target !== e.currentTarget) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          setDropAt(tabs.length);
        }}
        onDrop={(e) => {
          e.preventDefault();
          if (dragId && dropAt !== null) onMoveTo(dragId, dropAt);
          setDragId(null);
          setDropAt(null);
        }}
      >
        {tabs.map((id, index) => {
          const p = pagesById.get(id);
          const title = p?.title || t('Untitled');
          const pinnedTab = isPinned(id);
          return (
            <Fragment key={id}>
              {dropAt === index && <div className="tab-drop-line" aria-hidden="true" />}
              <PageHoverCard
                page={p}
                side="bottom"
                offset={6}
                tagColors={tagColors}
                disabled={!!menu || !!dragId}
              >
                <div
                  role="tab"
                  aria-selected={id === activeId}
                  className={
                    'tab' + (id === activeId ? ' active' : '') + (pinnedTab ? ' pinned' : '')
                  }
                  draggable
                  onTouchStart={(e) => onTouchStart(id, e)}
                  onTouchMove={onTouchMove}
                  onTouchEnd={onTouchEnd}
                  onTouchCancel={clearLongPress}
                  onClick={() => {
                    if (didLongPress.current) return;
                    onSelect(id);
                  }}
                  onAuxClick={(e) => {
                    if (e.button === 1) {
                      e.preventDefault();
                      onClose(id);
                    }
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({
                      id,
                      x: Math.max(8, Math.min(e.clientX, window.innerWidth - 240)),
                      y: Math.max(8, Math.min(e.clientY, window.innerHeight - 260)),
                    });
                  }}
                  onDragStart={(e) => {
                    setDragId(id);
                    setDropAt(null);
                    e.dataTransfer.effectAllowed = 'move';
                    try {
                      e.dataTransfer.setData('text/plain', id);
                    } catch {
                      /* some browsers need the setData call to start dragging */
                    }
                  }}
                  onDragOver={(e) => {
                    if (!dragId || dragId === id) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    setDropAt(e.clientX > rect.left + rect.width / 2 ? index + 1 : index);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragId && dragId !== id && dropAt !== null) onMoveTo(dragId, dropAt);
                    setDragId(null);
                    setDropAt(null);
                  }}
                  onDragEnd={() => {
                    setDragId(null);
                    setDropAt(null);
                  }}
                >
                  <span className="tab-icon">
                    <PageIcon icon={p?.icon} size={13} fallback={p?.type === 'collection' ? <Table2 size={13} /> : <FileText size={13} />} />
                  </span>
                  {pinnedTab && (
                    <span className="tab-pin" aria-hidden="true">
                      <Pin size={11} />
                    </span>
                  )}
                  <span className="tab-title">{title}</span>
                  {!pinnedTab && (
                    <button
                      className="tab-close"
                      aria-label={t('Close tab {title}', { title })}
                      onClick={(e) => {
                        e.stopPropagation();
                        onClose(id);
                      }}
                    >
                      <X size={13} />
                    </button>
                  )}
                </div>
              </PageHoverCard>
            </Fragment>
          );
        })}
        {dropAt === tabs.length && <div className="tab-drop-line" aria-hidden="true" />}
      </div>
      {menu && (
        <Portal>
          <div
            className="fs-backdrop"
            onClick={() => {
              if (didLongPress.current) return;
              closeMenu();
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              if (didLongPress.current) return;
              closeMenu();
            }}
          />
          <div className="menu tab-menu" style={{ position: 'fixed', left: menu.x, top: menu.y, right: 'auto', zIndex: 320 }}>
            <button onClick={act(() => onTogglePin(menu.id))}>
              <Pin size={15} /> {isPinned(menu.id) ? t('Unpin tab') : t('Pin tab')}
            </button>
            <button disabled={!canMove(menu.id, -1)} onClick={act(() => onMove(menu.id, -1))}>
              <ArrowLeft size={15} /> {hint(t('Move left'), 'tabs.moveLeft')}
            </button>
            <button disabled={!canMove(menu.id, 1)} onClick={act(() => onMove(menu.id, 1))}>
              <ArrowRight size={15} /> {hint(t('Move right'), 'tabs.moveRight')}
            </button>
            <button onClick={act(() => onClose(menu.id))}>
              <X size={15} /> {hint(t('Close tab'), 'tabs.close')}
            </button>
            <button onClick={act(() => onCloseOthers(menu.id))}>
              <X size={15} /> {t('Close other tabs')}
            </button>
            <button onClick={act(() => onCloseToRight(menu.id))}>
              <ArrowRight size={15} /> {t('Close tabs to the right')}
            </button>
          </div>
        </Portal>
      )}
    </>
  );
}
