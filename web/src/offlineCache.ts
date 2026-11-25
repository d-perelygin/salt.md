// Offline snapshots of pages and collections the user has already opened.
//
// Two layers work together: the service worker keeps raw GET responses in the
// Cache API, and this module keeps parsed snapshots, Yjs doc states, offline
// file blobs, and the write outbox in account-scoped IndexedDB.

import type { CollectionConfig, Page } from './types';

export interface CachedCollection {
  key: string;
  config: CollectionConfig;
  rows: {
    id: string;
    title: string;
    icon: string;
    cover: string;
    props: Record<string, unknown>;
    position: number;
    tags?: string[];
  }[];
  total: number;
  savedAt: number;
}

interface CachedPage {
  id: string;
  page: Page;
  savedAt: number;
}

export type OutboxKind =
  | 'create-page'
  | 'update-page'
  | 'comment'
  | 'note'
  | 'resolve-comment'
  | 'delete-comment'
  | 'trash-page'
  | 'restore-page'
  | 'favorite'
  | 'tag-color'
  | 'prefs'
  | 'update-collection'
  | 'upload-file';

export interface OutboxOp {
  key: string;
  kind: OutboxKind;
  /** Target page; may be a temp id (see newTempId in outbox.ts). */
  pageId: string;
  /** create-page only: parent, possibly a temp id too. */
  parentId?: string | null;
  payload: Record<string, unknown>;
  /** Human-readable snapshot for the pending list. */
  label: string;
  createdAt: number;
  attempts: number;
  lastError?: string;
}

export interface CachedYDoc {
  id: string;
  update: ArrayBuffer;
  gen: number | null;
  dirty: boolean;
  savedAt: number;
}

export interface CachedUpload {
  id: string;
  blob: Blob;
  name: string;
  type: string;
  pageId: string;
  savedAt: number;
}

let accountId: string | null = null;
let persistedRequested = false;

export async function clearSwDataCache(): Promise<void> {
  try {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('salt-data')).map((k) => caches.delete(k)));
  } catch {
    /* best-effort */
  }
  try {
    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({ type: 'CLEAR_DATA' });
    }
  } catch {
    /* best-effort */
  }
}

/** Whose offline data to keep. Call on sign-in, switch and sign-out. */
export function setOfflineAccount(id: string | null): void {
  if (id !== accountId) {
    // Switching between accounts (or losing session) must clear the shared
    // Cache API data store so the next user never reads the previous user's
    // cached responses offline.
    if (accountId !== null) {
      void clearSwDataCache();
    }
    accountId = id;
    if (dbPromise) {
      void dbPromise.then((d) => {
        try {
          d?.close();
        } catch {
          /* best-effort */
        }
      });
      dbPromise = null;
    }
  }
  if (id && !persistedRequested) {
    persistedRequested = true;
    try {
      void navigator.storage?.persist?.().catch(() => {});
    } catch {
      /* best-effort */
    }
  }
  sweepLegacy();
}

export async function clearOfflineData(): Promise<void> {
  const name = DB_NAME + (accountId ? `-${accountId}` : '');
  setOfflineAccount(null);
  try {
    indexedDB.deleteDatabase('salt-offline-v1');
    indexedDB.deleteDatabase(name);
  } catch {
    /* best-effort */
  }
  await clearSwDataCache();
}

const DB_NAME = 'salt-offline-v1';
const DB_VERSION = 4;
const MAX_PAGES = 200;
const MAX_COLLECTIONS = 50;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function dbName(): string {
  return accountId ? `${DB_NAME}-${accountId}` : DB_NAME;
}

function idb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') {
        resolve(null);
        return;
      }
      const req = indexedDB.open(dbName(), DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('pages')) db.createObjectStore('pages', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('collections')) {
          db.createObjectStore('collections', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('ydocs')) db.createObjectStore('ydocs', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('yjournal')) db.createObjectStore('yjournal', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('uploads')) db.createObjectStore('uploads', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

let dbPromise: Promise<IDBDatabase | null> | null = null;
function db(): Promise<IDBDatabase | null> {
  if (!dbPromise) dbPromise = idb();
  return dbPromise;
}

let sweptLegacy = false;
function sweepLegacy(): void {
  if (sweptLegacy) return;
  sweptLegacy = true;
  try {
    indexedDB.deleteDatabase(DB_NAME);
  } catch {
    /* best-effort */
  }
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        if (!d) {
          reject(new Error('no idb'));
          return;
        }
        try {
          const t = d.transaction(store, mode);
          const req = fn(t.objectStore(store));
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error ?? new Error('idb failed'));
        } catch (e) {
          reject(e instanceof Error ? e : new Error('idb failed'));
        }
      }),
  );
}

function txAll<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => Promise<T> | T): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        if (!d) {
          reject(new Error('no idb'));
          return;
        }
        try {
          const t = d.transaction(store, mode);
          let out: T;
          t.oncomplete = () => resolve(out);
          t.onerror = () => reject(t.error ?? new Error('idb tx failed'));
          t.onabort = () => reject(t.error ?? new Error('idb tx aborted'));
          Promise.resolve(fn(t.objectStore(store))).then(
            (v) => {
              out = v;
            },
            (err) => {
              try {
                t.abort();
              } catch {
                /* ignore */
              }
              reject(err);
            },
          );
        } catch (e) {
          reject(e instanceof Error ? e : new Error('idb failed'));
        }
      }),
  );
}

function prune(store: string, limit: number, keep?: (row: Record<string, unknown>) => boolean): void {
  void db().then((d) => {
    if (!d) return;
    try {
      const t = d.transaction(store, 'readwrite');
      const s = t.objectStore(store);
      const all = s.getAll();
      all.onsuccess = () => {
        const rows = ((all.result ?? []) as Record<string, unknown>[]).filter((r) => !keep?.(r));
        if (rows.length <= limit) return;
        rows
          .sort((a, b) => ((a.savedAt as number) ?? 0) - ((b.savedAt as number) ?? 0))
          .slice(0, rows.length - limit)
          .forEach((r) => {
            const k = (r.id ?? r.key) as string;
            if (k) s.delete(k);
          });
      };
    } catch {
      /* cache eviction is best-effort */
    }
  });
}

function fresh(savedAt: number): boolean {
  return Date.now() - savedAt < MAX_AGE_MS;
}

export async function putPage(page: Page): Promise<void> {
  try {
    const entry: CachedPage = { id: page.id, page, savedAt: Date.now() };
    await tx('pages', 'readwrite', (s) => s.put(entry));
    prune('pages', MAX_PAGES);
  } catch {
    /* offline cache is best-effort */
  }
}

export async function getPage(id: string): Promise<Page | null> {
  try {
    const entry = await tx<CachedPage | undefined>('pages', 'readonly', (s) => s.get(id));
    if (!entry || !fresh(entry.savedAt)) return null;
    return entry.page;
  } catch {
    return null;
  }
}

export async function patchCachedPage(id: string, patch: Record<string, unknown>): Promise<void> {
  try {
    await txAll('pages', 'readwrite', (s) => {
      const req = s.get(id);
      req.onsuccess = () => {
        const entry = req.result as CachedPage | undefined;
        if (!entry) return;
        const page = { ...entry.page };
        if (typeof patch.title === 'string') page.title = patch.title;
        if (typeof patch.icon === 'string') page.icon = patch.icon;
        if (typeof patch.cover === 'string') page.cover = patch.cover;
        if (typeof patch.position === 'number') page.position = patch.position;
        if (typeof patch.visibility === 'string') page.visibility = patch.visibility as Page['visibility'];
        if (typeof patch.workspaceId === 'string') page.workspaceId = patch.workspaceId;
        if (patch.propsPatch && typeof patch.propsPatch === 'object') {
          page.props = { ...(page.props ?? {}), ...(patch.propsPatch as Record<string, unknown>) };
        }
        if (Array.isArray(patch.content)) page.content = patch.content;
        page.updatedAt = new Date().toISOString();
        s.put({ id, page, savedAt: Date.now() } satisfies CachedPage);
      };
    });
  } catch {
    /* best-effort */
  }
}

export async function listCachedPages(): Promise<Page[]> {
  try {
    const entries = await tx<CachedPage[]>('pages', 'readonly', (s) => s.getAll());
    return (entries ?? []).filter((e) => fresh(e.savedAt)).map((e) => e.page);
  } catch {
    return [];
  }
}

export async function dropPage(id: string): Promise<void> {
  try {
    await tx('pages', 'readwrite', (s) => s.delete(id));
  } catch {
    /* best-effort */
  }
}

export function collectionKey(collectionId: string, filterKey: string): string {
  return `${collectionId}|${filterKey}`;
}

export async function putCollectionSnapshot(snap: Omit<CachedCollection, 'savedAt'>): Promise<void> {
  try {
    await tx('collections', 'readwrite', (s) => s.put({ ...snap, savedAt: Date.now() }));
    prune('collections', MAX_COLLECTIONS);
  } catch {
    /* best-effort */
  }
}

export async function getCollectionSnapshot(key: string): Promise<CachedCollection | null> {
  try {
    const entry = await tx<CachedCollection | undefined>('collections', 'readonly', (s) => s.get(key));
    if (!entry || !fresh(entry.savedAt)) return null;
    return entry;
  } catch {
    return null;
  }
}

export async function putYDoc(
  pageId: string,
  update: Uint8Array,
  opts?: { gen?: number | null; dirty?: boolean },
): Promise<void> {
  try {
    const copy = new Uint8Array(update.length);
    copy.set(update);
    await txAll('ydocs', 'readwrite', (s) => {
      const req = s.get(pageId);
      req.onsuccess = () => {
        const prev = req.result as CachedYDoc | undefined;
        const entry: CachedYDoc = {
          id: pageId,
          update: copy.buffer,
          gen: opts?.gen !== undefined ? opts.gen : (prev?.gen ?? null),
          dirty: opts?.dirty !== undefined ? opts.dirty : (prev?.dirty ?? false),
          savedAt: Date.now(),
        };
        s.put(entry);
      };
    });
    prune('ydocs', MAX_PAGES, (r) => r.dirty === true);
  } catch {
    /* best-effort */
  }
}

export async function getYDocEntry(
  pageId: string,
): Promise<{ update: Uint8Array; gen: number | null; dirty: boolean } | null> {
  try {
    const entry = await tx<CachedYDoc | undefined>('ydocs', 'readonly', (s) => s.get(pageId));
    if (!entry || !fresh(entry.savedAt)) return null;
    return {
      update: new Uint8Array(entry.update),
      gen: entry.gen ?? null,
      dirty: entry.dirty === true,
    };
  } catch {
    return null;
  }
}

export async function getYDoc(pageId: string): Promise<Uint8Array | null> {
  const entry = await getYDocEntry(pageId);
  return entry ? entry.update : null;
}

export async function markYDocClean(pageId: string): Promise<void> {
  try {
    await txAll('ydocs', 'readwrite', (s) => {
      const req = s.get(pageId);
      req.onsuccess = () => {
        const prev = req.result as CachedYDoc | undefined;
        if (!prev || !prev.dirty) return;
        s.put({ ...prev, dirty: false });
      };
    });
  } catch {
    /* best-effort */
  }
}

export async function listDirtyYDocs(): Promise<string[]> {
  try {
    const all = await tx<CachedYDoc[]>('ydocs', 'readonly', (s) => s.getAll());
    return (all ?? []).filter((e) => e.dirty && fresh(e.savedAt)).map((e) => e.id);
  } catch {
    return [];
  }
}

export async function dropYDoc(pageId: string): Promise<void> {
  try {
    await tx('ydocs', 'readwrite', (s) => s.delete(pageId));
  } catch {
    /* best-effort */
  }
}

export async function clearJournal(pageId: string): Promise<void> {
  try {
    await tx('yjournal', 'readwrite', (s) => s.delete(pageId));
  } catch {
    /* best-effort */
  }
}

export async function putOp(op: OutboxOp): Promise<void> {
  // Never swallow quota/IDB errors here: the caller needs to know if the op
  // failed to persist so it does not falsely promise "Will sync".
  await tx('outbox', 'readwrite', (s) => s.put(op));
}

export async function upsertContentOp(op: OutboxOp): Promise<void> {
  await txAll('outbox', 'readwrite', (s) => {
    const req = s.getAll();
    req.onsuccess = () => {
      const existing = (req.result ?? []) as OutboxOp[];
      for (const prev of existing) {
        if (prev.kind === 'update-page' && prev.pageId === op.pageId && prev.payload?.materialize) {
          s.delete(prev.key);
        }
      }
      s.put(op);
    };
  });
}

export async function remapOps(tempId: string, realId: string, realGen?: number): Promise<void> {
  try {
    await txAll('outbox', 'readwrite', (s) => {
      const req = s.getAll();
      req.onsuccess = () => {
        const ops = (req.result ?? []) as OutboxOp[];
        for (const op of ops) {
          let changed = false;
          if (op.pageId === tempId) {
            op.pageId = realId;
            changed = true;
            if (op.kind === 'update-page' && op.payload?.materialize && realGen !== undefined) {
              op.payload = { ...op.payload, gen: realGen };
            }
          }
          if (op.parentId === tempId) {
            op.parentId = realId;
            changed = true;
          }
          if (changed) s.put(op);
        }
      };
    });
  } catch {
    /* best-effort */
  }
}

export async function deleteOp(key: string): Promise<void> {
  try {
    await tx('outbox', 'readwrite', (s) => s.delete(key));
  } catch {
    /* best-effort */
  }
}

export async function listOps(): Promise<OutboxOp[]> {
  try {
    const ops = await tx<OutboxOp[]>('outbox', 'readonly', (s) => s.getAll());
    return (ops ?? []).sort((a, b) => a.createdAt - b.createdAt);
  } catch {
    return [];
  }
}

export async function putUploadBlob(upload: Omit<CachedUpload, 'savedAt'>): Promise<void> {
  await tx('uploads', 'readwrite', (s) => s.put({ ...upload, savedAt: Date.now() }));
}

export async function getUploadBlob(id: string): Promise<CachedUpload | null> {
  try {
    const entry = await tx<CachedUpload | undefined>('uploads', 'readonly', (s) => s.get(id));
    return entry ?? null;
  } catch {
    return null;
  }
}

export async function dropUploadBlob(id: string): Promise<void> {
  try {
    await tx('uploads', 'readwrite', (s) => s.delete(id));
  } catch {
    /* best-effort */
  }
}
