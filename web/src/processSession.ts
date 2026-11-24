// Surviving a reload inside Properties → Process.
//
// A process is edited in a dialog on top of the collection: the code tab holds
// a draft, the map holds the open rule, the fullscreen workspace holds its own
// scroll position. A reload — a new build arriving, a tab crashing, a stray
// Cmd+R — used to take all of it away with the window. This keeps the dialog,
// its tab, the List/Scheme/Code view and the code draft for the same browser
// session, and only across a reload: closing the dialog on purpose clears the
// keys, so the next open starts clean.
//
// sessionStorage, not localStorage: another tab is another piece of work, and
// a draft from last week must never be waiting on the screen.

const PREFIX = 'salt:process:';

export type ProcessView = 'list' | 'scheme' | 'code';
export type ProcessTab = 'props' | 'process';

const key = (collectionId: string, part: string) => `${PREFIX}${collectionId}:${part}`;

export function readProcessPart(collectionId: string, part: string): string | null {
  try {
    return sessionStorage.getItem(key(collectionId, part));
  } catch {
    return null;
  }
}

export function writeProcessPart(collectionId: string, part: string, value: string | null): void {
  try {
    if (value === null) sessionStorage.removeItem(key(collectionId, part));
    else sessionStorage.setItem(key(collectionId, part), value);
  } catch {
    /* private mode or a full quota: a draft that cannot be kept is not fatal */
  }
}

/** The dialog was closed on purpose: nothing about it should come back. */
export function clearProcessSession(collectionId: string): void {
  for (const part of ['open', 'tab', 'view', 'full', 'draft']) writeProcessPart(collectionId, part, null);
}

/** Only the parts the reload should restore. */
export function processView(collectionId: string): ProcessView | null {
  const v = readProcessPart(collectionId, 'view');
  return v === 'list' || v === 'scheme' || v === 'code' ? v : null;
}

export function processTab(collectionId: string): ProcessTab | null {
  const v = readProcessPart(collectionId, 'tab');
  return v === 'props' || v === 'process' ? v : null;
}
