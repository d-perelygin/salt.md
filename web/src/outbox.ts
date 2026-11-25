// Outbox: writes made while offline, replayed in order when back online.
//
// Every write site in the UI is optimistic already (state updates first, the
// request follows). On a network failure (or 502/503/504 gateway failure) the
// intent is journaled here in account-scoped IndexedDB and replayed by flush().
//
// Cross-tab coordination: flush() is serialized via Web Locks (`salt-outbox`)
// and outbox/remap updates are broadcast across tabs via BroadcastChannel.

import { api, ApiError, NetworkError } from './api';
import { COLLAB_SYNCED_EVENT } from './collab';
import { t } from './i18n';
import { toast } from './toast';
import {
  deleteOp,
  dropPage,
  dropUploadBlob,
  dropYDoc,
  getPage,
  getUploadBlob,
  getYDocEntry,
  listDirtyYDocs,
  listOps,
  patchCachedPage,
  putOp,
  putPage,
  putYDoc,
  remapOps,
  upsertContentOp,
  type OutboxOp,
} from './offlineCache';
import type { CollectionConfig, CommentAnchor } from './types';
export type { OutboxOp };

export const OUTBOX_EVENT = 'salt:outbox';
export const REMAP_EVENT = 'salt:page-mapped';
export const FILE_MAPPED_EVENT = 'salt:file-mapped';
export const SERVER_STATUS_EVENT = 'salt:server-status';

const bc = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('salt-outbox') : null;

export function newTempId(): string {
  const uuid =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  return `temp-${uuid}`;
}

export function isTempId(id: string): boolean {
  return id.startsWith('temp-');
}

/** A fetch that never reached the server (offline, DNS, refused) or hit a
 *  reverse-proxy/tunnel outage (502/503/504). */
export function isOfflineError(e: unknown): boolean {
  if (e instanceof NetworkError) return true;
  if (e instanceof ApiError && (e.status === 502 || e.status === 503 || e.status === 504)) return true;
  return false;
}

function setServerReachable(reachable: boolean): void {
  window.dispatchEvent(new CustomEvent(SERVER_STATUS_EVENT, { detail: reachable }));
}

function notify(pending: number, broadcast = true): void {
  window.dispatchEvent(new CustomEvent(OUTBOX_EVENT, { detail: pending }));
  if (broadcast) {
    try {
      bc?.postMessage({ type: 'outbox', pending });
    } catch {
      /* best-effort */
    }
  }
}

export async function refreshCount(): Promise<number> {
  const [ops, dirtyDocs] = await Promise.all([listOps(), listDirtyYDocs()]);
  const n = ops.length + dirtyDocs.length;
  notify(n);
  return n;
}

export function onOutboxChange(fn: (pending: number) => void): () => void {
  const h = (e: Event) => fn((e as CustomEvent<number>).detail);
  window.addEventListener(OUTBOX_EVENT, h);
  return () => window.removeEventListener(OUTBOX_EVENT, h);
}

export async function pendingCount(): Promise<number> {
  const [ops, dirtyDocs] = await Promise.all([listOps(), listDirtyYDocs()]);
  return ops.length + dirtyDocs.length;
}

export async function pendingOps(): Promise<OutboxOp[]> {
  return listOps();
}

export async function pendingDirtyDocs(): Promise<string[]> {
  return listDirtyYDocs();
}

export async function discardOp(key: string): Promise<void> {
  await deleteOp(key);
  await refreshCount();
}

export async function enqueue(op: Omit<OutboxOp, 'key' | 'createdAt' | 'attempts'>): Promise<boolean> {
  const key =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  const full: OutboxOp = { ...op, key, createdAt: Date.now(), attempts: 0 };
  try {
    if (full.kind === 'update-page' && full.payload?.materialize) {
      await upsertContentOp(full);
    } else {
      await putOp(full);
    }
    if (full.kind === 'update-page' && full.payload?.patch) {
      void patchCachedPage(full.pageId, full.payload.patch as Record<string, unknown>);
    }
    await refreshCount();
    if (typeof navigator === 'undefined' || navigator.onLine !== false) {
      scheduleRetry();
    }
    return true;
  } catch {
    toast.warning(t('Could not save offline change locally (storage full or unavailable).'));
    return false;
  }
}

export interface FlushResult {
  synced: number;
  dropped: number;
  kept: number;
}

let flushing = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryAttempt = 0;

function scheduleRetry(): void {
  if (retryTimer) return;
  const delay = Math.min(60_000, 5_000 * 2 ** retryAttempt);
  retryAttempt++;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (typeof navigator === 'undefined' || navigator.onLine !== false) {
      void flush();
    }
  }, delay);
}

function clearRetry(): void {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  retryAttempt = 0;
}

async function runFlush(): Promise<FlushResult> {
  if (flushing) return { synced: 0, dropped: 0, kept: await pendingCount() };
  flushing = true;
  const res: FlushResult = { synced: 0, dropped: 0, kept: 0 };
  try {
    const remap = new Map<string, string>();
    const resolve = (id: string) => remap.get(id) ?? id;
    const skipped = new Set<string>();
    for (;;) {
      const ops = (await listOps()).filter((o) => !skipped.has(o.key));
      if (ops.length === 0) break;
      const op = ops[0];
      try {
        // eslint-disable-next-line no-await-in-loop
        await replay(op, resolve, remap);
        // eslint-disable-next-line no-await-in-loop
        await deleteOp(op.key);
        setServerReachable(true);
        res.synced++;
      } catch (e) {
        if (isOfflineError(e)) {
          setServerReachable(false);
          break; // still offline: keep the rest
        }
        if (e instanceof ApiError && e.code === 'doc_replaced') {
          // Server already preserved the refused copy in page history via
          // keepRefusedCopy; drop this stale op so it never blocks the queue.
          // eslint-disable-next-line no-await-in-loop
          await deleteOp(op.key);
          res.dropped++;
          toast.warning(t('“{label}” conflicted with a newer version; check Version history.', { label: op.label }));
          continue;
        }
        if (e instanceof ApiError && (e.status === 404 || e.status === 403 || e.status === 400)) {
          // eslint-disable-next-line no-await-in-loop
          await deleteOp(op.key);
          res.dropped++;
          toast(t('Could not sync “{label}”: {reason}', { label: op.label, reason: e.message }));
          continue;
        }
        op.attempts++;
        op.lastError = e instanceof Error ? e.message : String(e);
        // eslint-disable-next-line no-await-in-loop
        await putOp(op).catch(() => {});
        // Skip this op for the rest of this flush pass so an unrelated page's
        // ops are not blocked behind a single failing item.
        skipped.add(op.key);
      }
    }
  } finally {
    flushing = false;
    res.kept = await refreshCount();
    if (res.kept > 0) scheduleRetry();
    else clearRetry();
  }
  return res;
}

/** Replay queued ops in creation order, serialized across tabs via Web Locks. */
export async function flush(): Promise<FlushResult> {
  if (typeof navigator !== 'undefined' && navigator.locks?.request) {
    return navigator.locks.request('salt-outbox', { ifAvailable: true }, async (lock) => {
      if (!lock) return { synced: 0, dropped: 0, kept: await pendingCount() };
      return runFlush();
    });
  }
  return runFlush();
}

function broadcastRemap(tempId: string, realId: string): void {
  const detail = { tempId, realId };
  window.dispatchEvent(new CustomEvent(REMAP_EVENT, { detail }));
  try {
    bc?.postMessage({ type: 'remap', detail });
  } catch {
    /* best-effort */
  }
}

async function replay(
  op: OutboxOp,
  resolve: (id: string) => string,
  remap: Map<string, string>,
): Promise<void> {
  const pageId = resolve(op.pageId);
  switch (op.kind) {
    case 'create-page': {
      const p = op.payload as {
        title: string;
        type: 'doc' | 'collection';
        props?: Record<string, unknown>;
        workspaceId?: string;
      };
      const parentId = op.parentId == null ? null : resolve(op.parentId);
      const created = await api.createPage(parentId, p.title, p.type, p.props, p.workspaceId, op.key);
      remap.set(op.pageId, created.id);
      const realGen = created.docGen ?? 0;
      // Persist the temp->real mapping in IDB so subsequent flushes after an
      // interruption never send `temp-...` to the server.
      await remapOps(op.pageId, created.id, realGen);
      const snap = await getYDocEntry(op.pageId);
      if (snap && snap.update.length > 0) {
        await putYDoc(created.id, snap.update, { gen: realGen, dirty: true });
      }
      await dropYDoc(op.pageId);
      const cached = await getPage(op.pageId);
      if (cached) {
        await putPage({ ...cached, id: created.id, docGen: realGen });
        await dropPage(op.pageId);
      }
      broadcastRemap(op.pageId, created.id);
      break;
    }
    case 'update-page': {
      const p = op.payload as { patch: Record<string, unknown>; materialize?: boolean; gen?: number | null };
      await api.updatePage(
        pageId,
        p.patch,
        p.materialize ? { materialize: true, gen: p.gen ?? null } : undefined,
      );
      break;
    }
    case 'comment': {
      const p = op.payload as { body: string; blockId?: string; anchor?: CommentAnchor };
      await api.createComment(pageId, p.body, p.blockId ?? '', p.anchor, op.key);
      break;
    }
    case 'note': {
      const p = op.payload as { body: string };
      await api.addNote(pageId, p.body, op.key);
      break;
    }
    case 'resolve-comment': {
      const p = op.payload as { commentId: string; resolved: boolean };
      await api.resolveComment(p.commentId, p.resolved);
      break;
    }
    case 'delete-comment': {
      const p = op.payload as { commentId: string };
      await api.deleteComment(p.commentId);
      break;
    }
    case 'trash-page': {
      await api.trashPage(pageId);
      break;
    }
    case 'restore-page': {
      await api.restorePage(pageId);
      break;
    }
    case 'favorite': {
      const p = op.payload as { add: boolean };
      if (p.add) await api.addFavorite(pageId);
      else await api.removeFavorite(pageId);
      break;
    }
    case 'tag-color': {
      const p = op.payload as { workspaceId: string; tag: string; color: string };
      await api.setTagColor(p.workspaceId, p.tag, p.color);
      break;
    }
    case 'prefs': {
      const p = op.payload as { prefs: Record<string, string> };
      await api.putPrefs(p.prefs as never);
      break;
    }
    case 'update-collection': {
      const p = op.payload as { patch: Partial<CollectionConfig> };
      await api.putCollection(pageId, p.patch);
      break;
    }
    case 'upload-file': {
      const p = op.payload as { uploadId: string; tempUrl: string };
      const cached = await getUploadBlob(p.uploadId);
      if (!cached) break;
      const file = new File([cached.blob], cached.name, { type: cached.type });
      const realUrl = await api.upload(file, pageId);
      await dropUploadBlob(p.uploadId);
      window.dispatchEvent(
        new CustomEvent(FILE_MAPPED_EVENT, { detail: { tempUrl: p.tempUrl, realUrl, pageId } }),
      );
      break;
    }
  }
}

/** updatePage with an offline fallback: temp ids never reach the network,
 *  anything else tries the server first and journals on a network/gateway
 *  failure. Returns true when the write landed or was queued. */
export async function savePageUpdate(
  pageId: string,
  patch: Record<string, unknown>,
  opts: { materialize?: boolean; gen?: number | null; label?: string } = {},
): Promise<boolean> {
  const label = opts.label ?? t('Change');
  if (isTempId(pageId)) {
    const ok = await enqueue({
      kind: 'update-page',
      pageId,
      payload: { patch, materialize: opts.materialize, gen: opts.gen ?? 0 },
      label,
    });
    if (ok) toast.warning(t('Will sync when the connection is back'));
    return ok;
  }
  try {
    await api.updatePage(
      pageId,
      patch,
      opts.materialize ? { materialize: true, gen: opts.gen ?? null } : undefined,
    );
    setServerReachable(true);
    return true;
  } catch (e) {
    if (isOfflineError(e)) {
      setServerReachable(false);
      const ok = await enqueue({
        kind: 'update-page',
        pageId,
        payload: { patch, materialize: opts.materialize, gen: opts.gen ?? null },
        label,
      });
      if (ok) toast.warning(t('Will sync when the connection is back'));
      return ok;
    }
    return false;
  }
}

let initialized = false;

/** Registered once from App: flush on reconnect, collab sync, visibility,
 *  and boot, plus listen to cross-tab BroadcastChannel events. */
export function initOutbox(): void {
  if (initialized) return;
  initialized = true;
  if (bc) {
    bc.onmessage = (e: MessageEvent) => {
      const msg = e.data as { type?: string; pending?: number; detail?: { tempId: string; realId: string } } | null;
      if (!msg) return;
      if (msg.type === 'outbox' && typeof msg.pending === 'number') {
        notify(msg.pending, false);
      } else if (msg.type === 'remap' && msg.detail) {
        window.dispatchEvent(new CustomEvent(REMAP_EVENT, { detail: msg.detail }));
      }
    };
  }
  const triggerFlush = () => {
    clearRetry();
    void flush();
  };
  window.addEventListener('online', triggerFlush);
  window.addEventListener(COLLAB_SYNCED_EVENT, triggerFlush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && navigator.onLine !== false) {
      void flush();
    }
  });
  window.setTimeout(() => {
    void flush();
  }, 3000);
}
