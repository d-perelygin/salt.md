import { useSyncExternalStore } from 'react';

/** Back and forward inside the app, for the phone's tabs sheet.
 *
 *  A browser has two arrows of its own; an installed PWA has none, and an
 *  installed app on a phone is where this applies — there is no reload button
 *  and no history chrome at all. The arrows have to live in the product.
 *
 *  Knowing whether either arrow can do anything needs the position in the
 *  history stack, which the browser deliberately does not expose. So every
 *  pushState is stamped with a sequence number, and the position is read back
 *  from `popstate` — the state object is the only thing that survives a
 *  history move and comes back with it.
 *
 *  Installed once, before React mounts. The wrapper keeps the caller's own
 *  state untouched apart from the extra key, so the app's existing navigation
 *  (which stores tabs and the active id in exactly that object) is unaffected. */

type NavState = { __nav?: number };

let pos = 0;
let max = 0;
const listeners = new Set<() => void>();

const emit = () => {
  for (const listener of listeners) listener();
};

export function installNavIndex(): () => void {
  const pushState = history.pushState.bind(history);
  const replaceState = history.replaceState.bind(history);

  history.pushState = ((state: unknown, title: string, url?: string | URL | null) => {
    pos += 1;
    max = pos;
    pushState({ ...(state as object | null), __nav: pos }, title, url ?? null);
    emit();
  }) as History['pushState'];

  history.replaceState = ((state: unknown, title: string, url?: string | URL | null) => {
    replaceState({ ...(state as object | null), __nav: pos }, title, url ?? null);
  }) as History['replaceState'];

  // The entry the app was loaded on gets a number too: without it, going back
  // to the first page would look like leaving the app and disable the arrow
  // that had just worked.
  replaceState({ ...(history.state as object | null), __nav: pos }, '', location.href);

  const onPop = (e: PopStateEvent) => {
    const index = (e.state as NavState | null)?.__nav;
    // No stamp means the entry predates the app (a link followed into it):
    // that is the far left of the stack.
    pos = typeof index === 'number' ? index : 0;
    emit();
  };
  window.addEventListener('popstate', onPop);
  return () => window.removeEventListener('popstate', onPop);
}

export const canGoBack = () => pos > 0;
export const canGoForward = () => pos < max;
export const goBack = () => history.back();
export const goForward = () => history.forward();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Which of the two arrows is live, for the sheet that draws them. */
export function useNavArrows(): { back: boolean; forward: boolean } {
  const back = useSyncExternalStore(subscribe, canGoBack, () => false);
  const forward = useSyncExternalStore(subscribe, canGoForward, () => false);
  return { back, forward };
}
