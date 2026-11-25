import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PageMeta } from '../types';
import { PageIcon } from '../pageIcon';
import { Table2, FileText } from 'lucide-react';
import { formatRelative } from '../format';
import { tagColorClass } from '../tags';
import { t } from '../i18n';
import Portal from './Portal';
import { api } from '../api';
import { peekPanel } from '../pageOpen';
import { modalOpen } from '../modal';

const CACHE_TTL_MS = 30_000;
const CACHE_MAX_ENTRIES = 200;
type CacheEntry = { promise: Promise<PageMeta | null>; expiresAt: number };
const pageDetailCache = new Map<string, CacheEntry>();

if (typeof window !== 'undefined') {
  window.addEventListener('salt:unauthorized', () => {
    pageDetailCache.clear();
  });
}

export function fetchPageDetail(id: string): Promise<PageMeta | null> {
  const now = Date.now();
  const cached = pageDetailCache.get(id);
  if (cached && cached.expiresAt > now) {
    pageDetailCache.delete(id);
    pageDetailCache.set(id, cached);
    return cached.promise;
  }
  if (cached) {
    pageDetailCache.delete(id);
  }
  if (pageDetailCache.size >= CACHE_MAX_ENTRIES) {
    const oldestKey = pageDetailCache.keys().next().value;
    if (oldestKey !== undefined) pageDetailCache.delete(oldestKey);
  }
  const entry: CacheEntry = {
    expiresAt: now + CACHE_TTL_MS,
    promise: api
      .getPage(id)
      .then((res) => {
        if (!res && pageDetailCache.get(id) === entry) pageDetailCache.delete(id);
        return res;
      })
      .catch(() => {
        if (pageDetailCache.get(id) === entry) {
          pageDetailCache.delete(id);
        }
        return null;
      }),
  };
  pageDetailCache.set(id, entry);
  return entry.promise;
}

function mergePageDetail(page: PageMeta, detail: PageMeta | null): PageMeta {
  if (!detail) return page;
  const fresh: Partial<PageMeta> = {};
  for (const [k, v] of Object.entries(page) as [keyof PageMeta, unknown][]) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    (fresh as Record<string, unknown>)[k] = v;
  }
  fresh.title = page.title;
  return { ...detail, ...fresh };
}

function coverStyle(cover: string): React.CSSProperties {
  if (!cover) return {};
  if (cover.startsWith('gradient:')) return { background: cover.slice('gradient:'.length) };
  return { backgroundImage: `url(${cover})`, backgroundSize: 'cover', backgroundPosition: 'center' };
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
const peekMod = isMac ? '⌥' : 'Alt';
const newTabMod = isMac ? '⌘' : 'Ctrl';

// Group hover state: once any card opens, subsequent cards open near-instantaneously
// as the user glides across the sidebar or tabs. When leaving all triggers, cooldown
// resets to the deliberate delay.
let isWarm = false;
let warmTimer: number | null = null;
let warmHolders = 0;
let activeCloseFn: (() => void) | null = null;

export function holdWarm() {
  warmHolders++;
  if (warmTimer) {
    window.clearTimeout(warmTimer);
    warmTimer = null;
  }
}

export function releaseWarm() {
  warmHolders = Math.max(0, warmHolders - 1);
  if (warmHolders === 0 && isWarm) {
    startWarmCooldown();
  }
}

export function resetWarm() {
  warmHolders = 0;
  setWarmState(false);
}

function setWarmState(warm: boolean) {
  isWarm = warm;
  if (!warm) warmHolders = 0;
  if (warmTimer) {
    window.clearTimeout(warmTimer);
    warmTimer = null;
  }
}

function startWarmCooldown() {
  if (warmTimer) window.clearTimeout(warmTimer);
  if (warmHolders > 0) return;
  warmTimer = window.setTimeout(() => {
    isWarm = false;
    warmTimer = null;
  }, 250);
}

export interface PageHoverCardProps {
  page?: PageMeta | null;
  side?: 'right' | 'bottom' | 'top' | 'cursor';
  offset?: number;
  tagColors?: Record<string, string>;
  disabled?: boolean;
  children: React.ReactElement;
}

type CardPos = {
  left: number;
  top?: number;
  bottom?: number;
};

export function PageHoverCard({
  page,
  side = 'right',
  offset: customOffset,
  tagColors,
  disabled,
  children,
}: PageHoverCardProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<CardPos | null>(null);
  const [detail, setDetail] = useState<PageMeta | null>(null);
  const prevId = useRef(page?.id);
  if (prevId.current !== page?.id) {
    prevId.current = page?.id;
    setDetail(null);
  }
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  const prefetchTimer = useRef<number | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const mouseRef = useRef<{ x: number; y: number } | null>(null);

  const needsDetail = Boolean(page?.id && !page.description && !page.snippet);

  useEffect(() => {
    if (!open || !needsDetail || !page?.id) return;
    let alive = true;
    const fetchId = page.id;
    void fetchPageDetail(fetchId).then((p) => {
      if (alive && prevId.current === fetchId && p) setDetail(p);
    });
    return () => {
      alive = false;
    };
  }, [open, needsDetail, page?.id]);

  const clearTimers = () => {
    if (openTimer.current) {
      window.clearTimeout(openTimer.current);
      openTimer.current = null;
    }
    if (closeTimer.current) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    if (prefetchTimer.current) {
      window.clearTimeout(prefetchTimer.current);
      prefetchTimer.current = null;
    }
  };

  const closeRef = useRef<() => void>(() => {});
  closeRef.current = () => {
    clearTimers();
    setOpen(false);
    setPos(null);
    if (activeCloseFn === stableClose) {
      activeCloseFn = null;
    }
  };
  const stableClose = useRef(() => closeRef.current()).current;

  useEffect(() => {
    if (disabled || !page) stableClose();
  }, [disabled, page, stableClose]);

  useEffect(() => {
    window.addEventListener('salt:modal', stableClose);
    return () => {
      window.removeEventListener('salt:modal', stableClose);
      stableClose();
    };
  }, [stableClose]);

  useEffect(() => {
    if (!open) return;
    const onScrollOrResize = () => stableClose();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') stableClose();
    };
    const onPointerDownCapture = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (cardRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      stableClose();
    };
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointerdown', onPointerDownCapture, true);
    return () => {
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointerdown', onPointerDownCapture, true);
    };
  }, [open, stableClose]);

  const effPage = page ? mergePageDetail(page, detail) : null;

  useLayoutEffect(() => {
    if (!open || !pos || !cardRef.current) return;
    const cardRect = cardRef.current.getBoundingClientRect();
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const PAD = 12;
    const gap = customOffset ?? (side === 'right' ? 8 : 5);
    const next: CardPos = { ...pos };

    if (next.left + cardRect.width > vw - PAD) {
      next.left = Math.max(PAD, vw - cardRect.width - PAD);
    } else if (next.left < PAD) {
      next.left = PAD;
    }

    if (next.top !== undefined) {
      if (next.top + cardRect.height > vh - PAD) {
        const anchorRect = anchorRef.current?.getBoundingClientRect();
        if (side === 'bottom' && anchorRect && anchorRect.top - gap - PAD >= cardRect.height) {
          delete next.top;
          next.bottom = Math.max(PAD, vh - anchorRect.top + gap);
        } else {
          next.top = Math.max(PAD, vh - cardRect.height - PAD);
        }
      }
    } else if (next.bottom !== undefined) {
      if (vh - next.bottom - cardRect.height < PAD) {
        const anchorRect = anchorRef.current?.getBoundingClientRect();
        if (side === 'top' && anchorRect && vh - anchorRect.bottom - gap - PAD >= cardRect.height) {
          delete next.bottom;
          next.top = Math.max(PAD, anchorRect.bottom + gap);
        } else {
          next.bottom = Math.max(PAD, vh - cardRect.height - PAD);
        }
      }
    }

    if (next.left !== pos.left || next.top !== pos.top || next.bottom !== pos.bottom) {
      setPos(next);
    }
  }, [open, pos, side, customOffset, effPage?.id, effPage?.cover, effPage?.tags?.length, effPage?.description, effPage?.snippet]);

  if (!page || !effPage || disabled) {
    return children;
  }

  const child = React.Children.only(children);

  const setRef = (node: HTMLElement | null) => {
    anchorRef.current = node;
    const childRef = (child as any).ref;
    if (typeof childRef === 'function') {
      childRef(node);
    } else if (childRef && 'current' in childRef) {
      childRef.current = node;
    }
  };

  const handleMouseEnter = (e: React.MouseEvent) => {
    (child.props as any).onMouseEnter?.(e);
    if (disabled || !page || modalOpen()) return;
    mouseRef.current = { x: e.clientX, y: e.clientY };
    if (typeof window !== 'undefined' && window.matchMedia && !window.matchMedia('(pointer: fine)').matches) {
      return;
    }
    if (closeTimer.current) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    if (open) return;
    clearTimers();

    if (needsDetail && page?.id) {
      const fetchId = page.id;
      prefetchTimer.current = window.setTimeout(() => {
        prefetchTimer.current = null;
        if (modalOpen() || prevId.current !== fetchId) return;
        void fetchPageDetail(fetchId).then((p) => {
          if (prevId.current === fetchId && p) setDetail(p);
        });
      }, 150);
    }

    // Warm: glide across items in 40ms. Cold: deliberate 550ms hover.
    const delay = isWarm ? 40 : 550;

    openTimer.current = window.setTimeout(() => {
      if (!anchorRef.current || modalOpen()) return;
      const rect = anchorRef.current.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;

      const CARD_W = 290;
      const gap = customOffset ?? (side === 'right' ? 8 : 5);
      const nextPos: CardPos = { left: 0 };

      if (side === 'cursor') {
        const cx = mouseRef.current?.x ?? rect.right;
        const cy = mouseRef.current?.y ?? rect.top;
        const gapX = customOffset ?? 18;
        let left = cx + gapX;
        if (left + CARD_W > window.innerWidth - 12) {
          left = Math.max(12, cx - gapX - CARD_W);
        }
        nextPos.left = left;
        const top = cy + 4;
        if (top + 220 > window.innerHeight - 12) {
          nextPos.bottom = 12;
        } else {
          nextPos.top = Math.max(12, top);
        }
      } else if (side === 'right') {
        let left = rect.right + gap;
        if (left + CARD_W > window.innerWidth - 12) {
          left = Math.max(12, rect.left - CARD_W - gap);
        }
        nextPos.left = left;
        if (rect.top + 220 > window.innerHeight - 12) {
          nextPos.bottom = 12;
        } else {
          nextPos.top = Math.max(12, rect.top - 2);
        }
      } else if (side === 'top') {
        nextPos.left = Math.max(12, Math.min(rect.left, window.innerWidth - CARD_W - 12));
        const spaceAbove = rect.top;
        if (spaceAbove < 170 && window.innerHeight - rect.bottom > spaceAbove) {
          nextPos.top = rect.bottom + gap;
        } else {
          nextPos.bottom = window.innerHeight - rect.top + gap;
        }
      } else {
        // side === 'bottom'
        nextPos.left = Math.max(12, Math.min(rect.left, window.innerWidth - CARD_W - 12));
        const spaceBelow = window.innerHeight - rect.bottom;
        if (spaceBelow < 170 && rect.top > spaceBelow) {
          nextPos.bottom = window.innerHeight - rect.top + gap;
        } else {
          nextPos.top = rect.bottom + gap;
        }
      }

      // Close any previously active card instantly
      if (activeCloseFn && activeCloseFn !== stableClose) {
        activeCloseFn();
      }
      activeCloseFn = stableClose;

      setPos(nextPos);
      setOpen(true);
      setWarmState(true);
      openTimer.current = null;
    }, delay);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    (child.props as any).onMouseMove?.(e);
    if (!open) {
      mouseRef.current = { x: e.clientX, y: e.clientY };
    }
  };

  const handleMouseLeave = (e: React.MouseEvent) => {
    (child.props as any).onMouseLeave?.(e);
    if (openTimer.current) {
      window.clearTimeout(openTimer.current);
      openTimer.current = null;
    }
    if (prefetchTimer.current) {
      window.clearTimeout(prefetchTimer.current);
      prefetchTimer.current = null;
    }
    if (!open) return;
    closeTimer.current = window.setTimeout(() => {
      setOpen(false);
      setPos(null);
      closeTimer.current = null;
      if (activeCloseFn === stableClose) {
        activeCloseFn = null;
      }
      startWarmCooldown();
    }, 160);
  };

  const handleClick = (e: React.MouseEvent) => {
    stableClose();
    setWarmState(false);
    (child.props as any).onClick?.(e);
  };

  const handleClickCapture = (e: React.MouseEvent) => {
    stableClose();
    setWarmState(false);
    (child.props as any).onClickCapture?.(e);
  };

  const handlePointerDownCapture = (e: React.PointerEvent) => {
    stableClose();
    (child.props as any).onPointerDownCapture?.(e);
  };

  const handleContextMenuCapture = (e: React.MouseEvent) => {
    stableClose();
    setWarmState(false);
    (child.props as any).onContextMenuCapture?.(e);
  };

  const handleDragStart = (e: React.DragEvent) => {
    stableClose();
    setWarmState(false);
    (child.props as any).onDragStart?.(e);
  };

  const handleCardMouseEnter = () => {
    if (closeTimer.current) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setWarmState(true);
  };

  const handleCardMouseLeave = () => {
    closeTimer.current = window.setTimeout(() => {
      setOpen(false);
      setPos(null);
      closeTimer.current = null;
      if (activeCloseFn === stableClose) {
        activeCloseFn = null;
      }
      startWarmCooldown();
    }, 150);
  };

  const isDb = effPage.type === 'collection';
  const title = effPage.title || t('Untitled');
  const hasDesc = Boolean(effPage.description?.trim());
  const hasSnippet = Boolean(effPage.snippet?.trim());
  const tags = effPage.tags || [];
  const canPeek = typeof window !== 'undefined' && !window.matchMedia('(max-width: 768px)').matches;

  return (
    <>
      {React.cloneElement(child, {
        ref: setRef,
        onMouseEnter: handleMouseEnter,
        onMouseMove: handleMouseMove,
        onMouseLeave: handleMouseLeave,
        onClick: handleClick,
        onClickCapture: handleClickCapture,
        onPointerDownCapture: handlePointerDownCapture,
        onContextMenuCapture: handleContextMenuCapture,
        onDragStart: handleDragStart,
      })}
      {open && pos && (
        <Portal>
          <div
            ref={cardRef}
            className="page-hover-card"
            style={{
              position: 'fixed',
              left: pos.left,
              top: pos.top,
              bottom: pos.bottom,
            }}
            onMouseEnter={handleCardMouseEnter}
            onMouseLeave={handleCardMouseLeave}
          >
            {effPage.cover && (
              <div className="page-hover-card-cover" style={coverStyle(effPage.cover)} />
            )}
            <div className="page-hover-card-body">
              <div className="page-hover-card-header">
                <span className="page-hover-card-icon">
                  <PageIcon
                    icon={effPage.icon}
                    size={17}
                    fallback={isDb ? <Table2 size={17} /> : <FileText size={17} />}
                  />
                </span>
                <span className="page-hover-card-title">{title}</span>
                {isDb && <span className="page-hover-card-badge">{t('Database')}</span>}
              </div>

              {hasDesc ? (
                <div className="page-hover-card-desc">{effPage.description}</div>
              ) : hasSnippet ? (
                <div className="page-hover-card-snippet">{effPage.snippet}</div>
              ) : (
                <div className="page-hover-card-empty">{t('No content')}</div>
              )}

              {tags.length > 0 && (
                <div className="page-hover-card-tags">
                  {tags.slice(0, 4).map((tag) => (
                    <span key={tag} className={'row-tag ' + tagColorClass(tag, tagColors)}>
                      #{tag}
                    </span>
                  ))}
                  {tags.length > 4 && (
                    <span className="page-hover-card-more">+{tags.length - 4}</span>
                  )}
                </div>
              )}

              <div className="page-hover-card-footer">
                {effPage.updatedAt && (
                  <span className="page-hover-card-time">
                    {t('Updated')} {formatRelative(effPage.updatedAt)}
                  </span>
                )}
                <div className="page-hover-card-hints">
                  {canPeek && (
                    <>
                      <button
                        type="button"
                        className="page-hover-card-action"
                        onClick={(e) => {
                          e.stopPropagation();
                          stableClose();
                          setWarmState(false);
                          if (!peekPanel(effPage.id)) {
                            window.dispatchEvent(
                              new CustomEvent('salt:navigate', {
                                detail: { id: effPage.id, newTab: false },
                              }),
                            );
                          }
                        }}
                        title={`${peekMod}+Click ${t('to peek')}`}
                      >
                        {peekMod}+Click {t('to peek')}
                      </button>
                      <span className="page-hover-card-dot">•</span>
                    </>
                  )}
                  <button
                    type="button"
                    className="page-hover-card-action"
                    onClick={(e) => {
                      e.stopPropagation();
                      stableClose();
                      setWarmState(false);
                      window.dispatchEvent(
                        new CustomEvent('salt:navigate', {
                          detail: { id: effPage.id, newTab: true },
                        }),
                      );
                    }}
                    title={`${newTabMod}+Click ${t('new tab')}`}
                  >
                    {newTabMod}+Click {t('new tab')}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </Portal>
      )}
    </>
  );
}
