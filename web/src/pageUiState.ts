// Per-page interface state that survives switching document tabs: which view
// of a collection was open, and where each page was scrolled.
//
// The document tabs in App.tsx remount the Editor on every switch
// (`key={currentId}`), so anything kept in component state alone — the view
// tab, the scroll position — resets. This module is the memory instead: small
// JSON values in localStorage, read on mount and written on change.
//
// View ids persist across reloads (a choice, like the theme). Scroll positions
// also persist across reloads — localStorage is the store either way, and a
// reload lands back where you were rather than at the top.

const VIEW_PREFIX = 'salt:view:';
const SCROLL_PREFIX = 'salt:scroll:';

// A horizontal scroller inside a collection view (the board columns, the wide
// table) is keyed by collection AND view: each view scrolls on its own.
const H_PREFIX = 'salt:hscroll:';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode, quota — state is a nice-to-have */
  }
}

function remove(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* nothing stored, nothing to forget */
  }
}

/** The last open view of a collection, or null when never chosen. */
export function readViewId(collectionId: string): string | null {
  return read(VIEW_PREFIX + collectionId);
}

export function writeViewId(collectionId: string, viewId: string) {
  if (!viewId) return;
  write(VIEW_PREFIX + collectionId, viewId);
}

export function forgetViewId(collectionId: string) {
  remove(VIEW_PREFIX + collectionId);
}

export interface PageScroll {
  top: number;
}

/** The vertical scroll of a page's `.page-body`, or null. */
export function readPageScroll(pageId: string): PageScroll | null {
  const raw = read(SCROLL_PREFIX + pageId);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as PageScroll;
    if (typeof p.top !== 'number' || !Number.isFinite(p.top) || p.top <= 0) return null;
    return { top: p.top };
  } catch {
    return null;
  }
}

export function writePageScroll(pageId: string, top: number) {
  if (!Number.isFinite(top) || top < 0) return;
  write(SCROLL_PREFIX + pageId, JSON.stringify({ top: Math.round(top) }));
}

export function forgetPageScroll(pageId: string) {
  remove(SCROLL_PREFIX + pageId);
}

/** The horizontal scroll of one view of a collection, or null. */
export function readViewScroll(collectionId: string, viewId: string): number | null {
  const raw = read(H_PREFIX + collectionId + ':' + viewId);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function writeViewScroll(collectionId: string, viewId: string, left: number) {
  if (!viewId || !Number.isFinite(left) || left < 0) return;
  write(H_PREFIX + collectionId + ':' + viewId, String(Math.round(left)));
}

export function forgetViewScrolls(collectionId: string) {
  // Keys carry the view id, so drop them by prefix scan. Bounded: one entry
  // per visited view, removed with the collection's tab at the latest.
  try {
    const prefix = H_PREFIX + collectionId + ':';
    const gone: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix)) gone.push(k);
    }
    gone.forEach((k) => localStorage.removeItem(k));
  } catch {
    /* best-effort */
  }
}
