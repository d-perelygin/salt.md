// How a link to a page opens, wherever it is clicked — a row in a table, a card
// on a board, a note in the notes column. It is the sidebar's rule, in one
// place so no view can spell it differently: a plain click navigates the tab
// you are in (the way a browser tab works), except collection rows and
// relation chips, which peek instead (see below).
//
// The modifiers are absolute, never inverted:
//   Option (Alt)           a side peek over the right side
//   Ctrl/⌘                a new tab beside the active one
//   Ctrl/⌘ together with Alt   the current tab, like a plain click in most places
//
// `onOpenInNewTab` is optional because a view can be rendered without one — an
// embedded collection reaches it through the editor's context, but a bare
// component in a test may not. Plain navigation is then the honest fallback.

export type PageOpeners = {
  onNavigate: (id: string) => void;
  onOpenInNewTab?: (id: string) => void;
};

const open = (id: string, o: PageOpeners) => (o.onOpenInNewTab ?? o.onNavigate)(id);

export type ClickMods = { metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean };

/** Ask for a side peek of the page instead of navigating anywhere.
 *
 *  True when somebody claims the request — App listens for `salt:peek` and
 *  answers with preventDefault. With no listener (tests, a bare component,
 *  a public view) it reports false and the click falls through to its normal
 *  meaning, so no call site needs to know whether peeking exists. */
export function peekPage(
  e: { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean },
  id: string,
): boolean {
  if (!e.altKey || e.ctrlKey || e.metaKey || typeof window === 'undefined') return false;
  return peekPanel(id);
}

/** Open in the side peek when one exists to answer, else false. The plain
 *  click of a collection row or relation chip lands here.
 *
 *  Never on a narrow screen: the peek is a wide-screen panel, and on a phone
 *  it reads as a place you got stuck in rather than a preview — there rows
 *  open tabs, like everywhere else. Same breakpoint as the full-screen peek
 *  stylesheet below (see styles.css). */
export function peekPanel(id: string): boolean {
  if (typeof window === 'undefined') return false;
  if (window.matchMedia('(max-width: 768px)').matches) return false;
  return !window.dispatchEvent(
    new CustomEvent('salt:peek', { detail: { id }, cancelable: true }),
  );
}

/** A click, with modifiers. Option peeks, Ctrl/⌘ together with Alt stays in
 *  place, ⌘/Ctrl opens a new tab. */
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
 *  but the left one — rather than as a `click`. Same modifiers as a plain
 *  click. */
export function openPageAux(
  e: { button?: number; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; preventDefault: () => void },
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

// Rows of a collection, and relation chips pointing at one, open in the side
// peek on a plain click — falling back to a new tab where no peek answers
// (narrow screens, public views, tests). The modifiers are the same absolute
// ones as everywhere else.

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
  if (!peekPanel(id)) open(id, o);
}
