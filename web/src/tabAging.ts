import type { PageMeta } from './types';

/** When each tab was last looked at, and the tabs that aged out.
 *
 *  A phone accumulates documents the way Chrome accumulates tabs: every link
 *  followed, every mention tapped, and after a fortnight the sheet is a wall of
 *  things nobody will open again. The strip on the desktop has the same problem
 *  but shows it as a scrollbar; a grid of cards makes it obvious.
 *
 *  Closing is not deleting: a tab that ages out is kept in a small archive and
 *  can be reopened from the same sheet, so the automatic pass is reversible by
 *  one tap and does not need a confirmation dialog nobody reads. */

const USED_KEY = 'salt-tab-used';
const ARCHIVE_KEY = 'salt-tab-archive';
/** A week. Long enough that a project picked up on Monday is still there on
 *  Friday, short enough that the sheet stops being a museum. */
export const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const ARCHIVE_MAX = 24;

export type TabUsage = Record<string, number>;
export type ArchivedTab = { id: string; title: string; icon?: string | null; at: number };

export function loadUsage(): TabUsage {
  try {
    const raw = JSON.parse(localStorage.getItem(USED_KEY) ?? '{}');
    if (!raw || typeof raw !== 'object') return {};
    const out: TabUsage = {};
    for (const [id, at] of Object.entries(raw)) {
      if (typeof at === 'number' && Number.isFinite(at)) out[id] = at;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveUsage(usage: TabUsage): void {
  try {
    localStorage.setItem(USED_KEY, JSON.stringify(usage));
  } catch {
    /* best-effort persistence */
  }
}

export function loadArchive(): ArchivedTab[] {
  try {
    const raw = JSON.parse(localStorage.getItem(ARCHIVE_KEY) ?? '[]');
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (entry): entry is ArchivedTab =>
        !!entry && typeof entry.id === 'string' && typeof entry.at === 'number',
    );
  } catch {
    return [];
  }
}

export function saveArchive(archive: ArchivedTab[]): void {
  try {
    localStorage.setItem(ARCHIVE_KEY, JSON.stringify(archive.slice(0, ARCHIVE_MAX)));
  } catch {
    /* best-effort persistence */
  }
}

/** The tabs nobody has opened for a week.
 *
 *  A tab with no timestamp is left alone: it was opened before this file
 *  existed, and guessing that it is old because it has no date would close
 *  somebody's work the first time they run the new build. */
export function staleTabs(
  tabs: string[],
  usage: TabUsage,
  keep: { active?: string | null; pinned?: string[] } = {},
  now = Date.now(),
): string[] {
  const pinned = new Set(keep.pinned ?? []);
  return tabs.filter((id) => {
    if (id === keep.active || pinned.has(id)) return false;
    const at = usage[id];
    return typeof at === 'number' && now - at > STALE_AFTER_MS;
  });
}

/** Archive entries for tabs that are about to leave the strip, newest first,
 *  without duplicates and capped. */
export function archiveTabs(
  archive: ArchivedTab[],
  ids: string[],
  pagesById: Map<string, PageMeta>,
  now = Date.now(),
): ArchivedTab[] {
  const fresh = ids
    .filter((id) => !archive.some((entry) => entry.id === id))
    .map((id) => {
      const page = pagesById.get(id);
      return { id, title: page?.title || '', icon: page?.icon ?? null, at: now };
    });
  return [...fresh, ...archive].slice(0, ARCHIVE_MAX);
}
