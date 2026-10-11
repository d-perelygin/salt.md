// How a link to a page opens, wherever it is clicked — a row in a table, a card
// on a board, a note in the notes column. It is the sidebar's rule, in one
// place so no view can spell it differently: a plain click navigates the tab
// you are in (the way a browser tab works), while ⌘-click (Ctrl-click on
// Windows and Linux) and the middle button add a tab beside the active one.
// Alt (Option on a Mac) always stays in the current tab — the one modifier
// that means the same everywhere, whatever the plain click would do.
//
// `onOpenInNewTab` is optional because a view can be rendered without one — an
// embedded collection reaches it through the editor's context, but a bare
// component in a test may not. Plain navigation is then the honest fallback.

import { getPrefs } from './i18n';

export type PageOpeners = {
  onNavigate: (id: string) => void;
  onOpenInNewTab?: (id: string) => void;
};

const open = (id: string, o: PageOpeners) => (o.onOpenInNewTab ?? o.onNavigate)(id);

export type ClickMods = { metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean };

/** Ask for a side peek of the page instead of navigating anywhere.
 *
 *  True when somebody claims the request — App listens for `salt:peek` and
 *  answers with preventDefault. With no listener (tests, a bare component,
 *  a public view) it reports false and the click falls through to its normal
 *  meaning, so no call site needs to know whether peeking exists. */
export function peekPage(e: { shiftKey?: boolean }, id: string): boolean {
  if (!e.shiftKey || typeof window === 'undefined') return false;
  return !window.dispatchEvent(
    new CustomEvent('salt:peek', { detail: { id }, cancelable: true }),
  );
}

/** A click, with modifiers. Shift peeks, Alt stays in place, ⌘/Ctrl opens a new tab. */
export function openPage(e: ClickMods, id: string, o: PageOpeners): void {
  if (peekPage(e, id)) return;
  if (e.altKey) {
    o.onNavigate(id);
    return;
  }
  if (e.metaKey || e.ctrlKey) open(id, o);
  else o.onNavigate(id);
}

/** The middle button, which a browser reports on `auxclick` — as every button
 *  but the left one — rather than as a `click`. Shift peeks, Alt with it stays
 *  in place, like Alt with a plain click. */
export function openPageAux(
  e: { button?: number; altKey?: boolean; shiftKey?: boolean; preventDefault: () => void },
  id: string,
  o: PageOpeners,
): void {
  if (e.button !== 1) return;
  e.preventDefault();
  if (peekPage(e, id)) return;
  if (e.altKey) o.onNavigate(id);
  else open(id, o);
}

// ---- collection rows ----

// Rows of a collection open in a NEW tab on a plain click — the account's
// choice (server prefs, default on), not the sidebar's in-place rule above.
// The modifiers are absolute and never inverted: Alt (Option) stays in the
// current tab, ⌘/Ctrl opens a new one — whatever the plain click would do.
export const collectionRowNewTab = (): boolean => getPrefs().openRowsNewTab ?? true;

/** A click on a collection row, with modifiers. */
export function openCollectionRow(e: ClickMods, id: string, o: PageOpeners): void {
  if (peekPage(e, id)) return;
  if (e.altKey) {
    o.onNavigate(id);
    return;
  }
  if (e.metaKey || e.ctrlKey) {
    open(id, o);
    return;
  }
  if (collectionRowNewTab()) open(id, o);
  else o.onNavigate(id);
}
