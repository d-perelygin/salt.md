import React, { useEffect, useRef, useState } from 'react';
import type { PageMeta } from '../types';
import { PageIcon } from '../pageIcon';
import { Table2, FileText } from 'lucide-react';
import { formatRelative } from '../format';
import { tagColorClass } from '../tags';
import { t } from '../i18n';
import Portal from './Portal';

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
let activeCloseFn: (() => void) | null = null;

function setWarmState(warm: boolean) {
  isWarm = warm;
  if (warmTimer) {
    window.clearTimeout(warmTimer);
    warmTimer = null;
  }
}

function startWarmCooldown() {
  if (warmTimer) window.clearTimeout(warmTimer);
  warmTimer = window.setTimeout(() => {
    isWarm = false;
    warmTimer = null;
  }, 350);
}

export interface PageHoverCardProps {
  page?: PageMeta | null;
  side?: 'right' | 'bottom' | 'top';
  tagColors?: Record<string, string>;
  disabled?: boolean;
  children: React.ReactElement;
}

export function PageHoverCard({
  page,
  side = 'right',
  tagColors,
  disabled,
  children,
}: PageHoverCardProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);

  const clearTimers = () => {
    if (openTimer.current) {
      window.clearTimeout(openTimer.current);
      openTimer.current = null;
    }
    if (closeTimer.current) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };

  const closeImmediately = () => {
    clearTimers();
    setOpen(false);
    setPos(null);
    if (activeCloseFn === closeImmediately) {
      activeCloseFn = null;
    }
  };

  useEffect(() => {
    return () => {
      clearTimers();
      if (activeCloseFn === closeImmediately) {
        activeCloseFn = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onScrollOrResize = () => closeImmediately();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeImmediately();
    };
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  if (!page || disabled) {
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
    if (disabled || !page) return;
    if (typeof window !== 'undefined' && window.matchMedia && !window.matchMedia('(pointer: fine)').matches) {
      return;
    }
    if (closeTimer.current) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    if (open) return;
    clearTimers();

    // Warm: glide across items in 40ms. Cold: deliberate 550ms hover.
    const delay = isWarm ? 40 : 550;

    openTimer.current = window.setTimeout(() => {
      if (!anchorRef.current) return;
      const rect = anchorRef.current.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;

      const CARD_W = 290;
      const CARD_H = 190;
      let x = 0;
      let y = 0;

      if (side === 'right') {
        x = rect.right + 10;
        y = Math.min(rect.top, window.innerHeight - CARD_H - 12);
        if (x + CARD_W > window.innerWidth - 12) {
          x = Math.max(12, rect.left - CARD_W - 10);
        }
        y = Math.max(12, y);
      } else if (side === 'top') {
        x = Math.max(12, Math.min(rect.left, window.innerWidth - CARD_W - 12));
        y = rect.top - CARD_H - 10;
        if (y < 12) {
          y = Math.min(window.innerHeight - CARD_H - 12, rect.bottom + 10);
        }
      } else {
        x = Math.max(12, Math.min(rect.left, window.innerWidth - CARD_W - 12));
        y = rect.bottom + 10;
        if (y + CARD_H > window.innerHeight - 12) {
          y = Math.max(12, rect.top - CARD_H - 10);
        }
      }

      // Close any previously active card instantly
      if (activeCloseFn && activeCloseFn !== closeImmediately) {
        activeCloseFn();
      }
      activeCloseFn = closeImmediately;

      setPos({ x, y });
      setOpen(true);
      setWarmState(true);
      openTimer.current = null;
    }, delay);
  };

  const handleMouseLeave = (e: React.MouseEvent) => {
    (child.props as any).onMouseLeave?.(e);
    if (openTimer.current) {
      window.clearTimeout(openTimer.current);
      openTimer.current = null;
    }
    if (!open) return;
    closeTimer.current = window.setTimeout(() => {
      setOpen(false);
      setPos(null);
      closeTimer.current = null;
      if (activeCloseFn === closeImmediately) {
        activeCloseFn = null;
      }
      startWarmCooldown();
    }, 160);
  };

  const handleClick = (e: React.MouseEvent) => {
    closeImmediately();
    setWarmState(false);
    (child.props as any).onClick?.(e);
  };

  const handleDragStart = (e: React.DragEvent) => {
    closeImmediately();
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
      if (activeCloseFn === closeImmediately) {
        activeCloseFn = null;
      }
      startWarmCooldown();
    }, 150);
  };

  const isDb = page.type === 'collection';
  const title = page.title || t('Untitled');
  const hasDesc = Boolean(page.description?.trim());
  const hasSnippet = Boolean(page.snippet?.trim());
  const tags = page.tags || [];

  return (
    <>
      {React.cloneElement(child, {
        ref: setRef,
        onMouseEnter: handleMouseEnter,
        onMouseLeave: handleMouseLeave,
        onClick: handleClick,
        onDragStart: handleDragStart,
      })}
      {open && pos && (
        <Portal>
          <div
            className="page-hover-card"
            style={{ position: 'fixed', left: pos.x, top: pos.y }}
            onMouseEnter={handleCardMouseEnter}
            onMouseLeave={handleCardMouseLeave}
          >
            {page.cover && (
              <div className="page-hover-card-cover" style={coverStyle(page.cover)} />
            )}
            <div className="page-hover-card-body">
              <div className="page-hover-card-header">
                <span className="page-hover-card-icon">
                  <PageIcon
                    icon={page.icon}
                    size={17}
                    fallback={isDb ? <Table2 size={17} /> : <FileText size={17} />}
                  />
                </span>
                <span className="page-hover-card-title">{title}</span>
                {isDb && <span className="page-hover-card-badge">{t('Database')}</span>}
              </div>

              {hasDesc ? (
                <div className="page-hover-card-desc">{page.description}</div>
              ) : hasSnippet ? (
                <div className="page-hover-card-snippet">{page.snippet}</div>
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
                <span className="page-hover-card-time">
                  {t('Updated')} {formatRelative(page.updatedAt)}
                </span>
                <div className="page-hover-card-hints">
                  <span>{peekMod}+Click {t('to peek')}</span>
                  <span className="page-hover-card-dot">•</span>
                  <span>{newTabMod}+Click {t('new tab')}</span>
                </div>
              </div>
            </div>
          </div>
        </Portal>
      )}
    </>
  );
}
