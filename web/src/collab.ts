import * as Y from 'yjs';
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness';
import { markYDocClean } from './offlineCache';

// Thin realtime provider for salt.md's relay protocol (see server/collab.go).
// The server replays the persisted doc, then relays updates. It never
// interprets CRDT data; compaction happens via {"snapshotRequest":seq}.

const FRAME_UPDATE = 0;
const FRAME_AWARENESS = 1;
const FRAME_SNAPSHOT = 2;

export const COLLAB_SYNCED_EVENT = 'salt:collab-synced';

export class SaltProvider {
  doc: Y.Doc;
  awareness: Awareness;
  synced = false;
  isNew = false;
  dirty = false;
  // The generation of the document this doc descends from (server/docgen.go).
  gen: number | null;
  // Set once the server has replaced the document under us. This doc is stale
  // from that moment on, and nothing derived from it may reach the server.
  replacedDoc = false;
  reset = false;

  readonly pageId: string;

  private ws: WebSocket | null = null;
  private closed = false;
  private everSynced = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private cleanTimer: ReturnType<typeof setTimeout> | null = null;
  private onSynced: (isNew: boolean) => void;
  private onReset: () => void;
  private onDirtyChange?: (dirty: boolean) => void;
  private lastMsg = 0;
  private connectStarted = 0;
  private watchdog: ReturnType<typeof setInterval> | null = null;

  constructor(
    pageId: string,
    gen: number | null,
    onSynced: (isNew: boolean) => void,
    onReset: () => void,
    opts?: {
      initialUpdate?: Uint8Array | null;
      initialDirty?: boolean;
      onLocalUpdate?: (update: Uint8Array, dirty: boolean) => void;
      onRemoteUpdate?: () => void;
      onDirtyChange?: (dirty: boolean) => void;
    },
  ) {
    this.pageId = pageId;
    this.gen = gen;
    this.dirty = opts?.initialDirty === true;
    this.onSynced = onSynced;
    this.onReset = onReset;
    this.onDirtyChange = opts?.onDirtyChange;
    this.doc = new Y.Doc();
    this.awareness = new Awareness(this.doc);

    // Offline snapshot taken while disconnected: apply before connecting so
    // the local edits survive a reload. Only pushed when `dirty` is true AND
    // `gen` matches the server's current generation.
    if (opts?.initialUpdate && opts.initialUpdate.length > 0) {
      try {
        Y.applyUpdate(this.doc, opts.initialUpdate, 'offline');
      } catch {
        /* a corrupt snapshot must not block the fresh server state */
      }
    }

    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === 'remote') {
        try {
          opts?.onRemoteUpdate?.();
        } catch {
          /* best-effort */
        }
        return;
      }
      if (this.reset || this.replacedDoc) return;
      this.send(FRAME_UPDATE, update);
      // While the channel is down (or for a temp page), mark dirty so the next
      // clean `synced` pushes the full merged state idempotently.
      if (!this.synced || this.ws?.readyState !== WebSocket.OPEN) {
        if (!this.dirty) {
          this.dirty = true;
          this.onDirtyChange?.(true);
        }
        if (this.cleanTimer) {
          clearTimeout(this.cleanTimer);
          this.cleanTimer = null;
        }
      }
      try {
        opts?.onLocalUpdate?.(update, this.dirty);
      } catch {
        /* persistence is best-effort */
      }
    });

    this.awareness.on(
      'update',
      ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
        const me = this.doc.clientID;
        const ids = added.concat(updated, removed).filter((id) => id === me);
        if (ids.length === 0) return;
        this.send(FRAME_AWARENESS, encodeAwarenessUpdate(this.awareness, ids));
      },
    );

    // Temp pages only exist in IndexedDB until `outbox.flush()` creates them
    // on the server and remaps the id. Do not hammer `/collab/temp-...`.
    if (pageId.startsWith('temp-')) {
      return;
    }

    this.watchdog = setInterval(() => {
      const ws = this.ws;
      if (!ws) return;
      const now = Date.now();
      if (ws.readyState === WebSocket.OPEN && now - this.lastMsg > 55_000) {
        this.dropConnection(ws);
      } else if (ws.readyState === WebSocket.CONNECTING && now - this.connectStarted > 15_000) {
        this.dropConnection(ws);
      }
    }, 10_000);
    this.connect();
  }

  private markCleanConfirmed() {
    if (!this.dirty) return;
    if (!this.synced || this.ws?.readyState !== WebSocket.OPEN || this.reset || this.replacedDoc) return;
    this.dirty = false;
    if (this.cleanTimer) {
      clearTimeout(this.cleanTimer);
      this.cleanTimer = null;
    }
    void markYDocClean(this.pageId);
    this.onDirtyChange?.(false);
  }

  private dropConnection(ws: WebSocket) {
    ws.onclose = null;
    ws.onmessage = null;
    ws.onopen = null;
    try {
      ws.close();
    } catch {
      /* nothing — the socket is lost anyway */
    }
    this.handleClosed(null);
  }

  private connect() {
    if (this.closed) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const gen = this.gen === null ? '' : `?gen=${this.gen}`;
    const ws = new WebSocket(`${proto}://${location.host}/collab/${this.pageId}${gen}`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.connectStarted = Date.now();
    this.lastMsg = Date.now();

    ws.onopen = () => {
      this.lastMsg = Date.now();
    };

    ws.onmessage = (e: MessageEvent) => {
      this.lastMsg = Date.now();
      if (typeof e.data === 'string') {
        const msg = JSON.parse(e.data) as Record<string, unknown>;
        if ('ping' in msg) {
          // A server ping after synced proves the socket is genuinely alive
          // and previous sends were not dropped into a half-open pipe.
          this.markCleanConfirmed();
          return;
        }
        if ('isNew' in msg) {
          if (!this.everSynced) this.isNew = msg.isNew === true;
        } else if ('synced' in msg) {
          this.synced = true;
          this.reconnectAttempt = 0;
          // Push full merged Yjs state when we have offline edits. Yjs merges
          // full state idempotently, avoiding incremental journal races and
          // causality truncation, while `?gen=` fences off replaced docs.
          if (this.dirty && !this.reset && !this.replacedDoc) {
            const state = Y.encodeStateAsUpdate(this.doc);
            if (state.length > 0) {
              this.send(FRAME_UPDATE, state);
            }
            if (this.cleanTimer) clearTimeout(this.cleanTimer);
            this.cleanTimer = setTimeout(() => this.markCleanConfirmed(), 1500);
          }
          const first = !this.everSynced;
          this.everSynced = true;
          if (first) this.onSynced(this.isNew);
          window.dispatchEvent(new Event(COLLAB_SYNCED_EVENT));

          const st = this.awareness.getLocalState();
          if (st !== null) {
            this.awareness.setLocalState(st);
            this.awareness.setLocalState(st);
          } else {
            this.send(
              FRAME_AWARENESS,
              encodeAwarenessUpdate(this.awareness, [this.doc.clientID]),
            );
          }
        } else if ('snapshotRequest' in msg) {
          this.markCleanConfirmed();
          const seq = BigInt(msg.snapshotRequest as number);
          const snap = Y.encodeStateAsUpdate(this.doc);
          const buf = new Uint8Array(9 + snap.length);
          buf[0] = FRAME_SNAPSHOT;
          new DataView(buf.buffer).setBigUint64(1, seq);
          buf.set(snap, 9);
          if (ws.readyState === WebSocket.OPEN) ws.send(buf);
        }
        return;
      }
      const data = new Uint8Array(e.data as ArrayBuffer);
      if (data.length < 1) return;
      if (data[0] === FRAME_UPDATE) {
        Y.applyUpdate(this.doc, data.subarray(1), 'remote');
      } else if (data[0] === FRAME_AWARENESS) {
        applyAwarenessUpdate(this.awareness, data.subarray(1), 'remote');
      }
    };

    ws.onclose = (e: CloseEvent) => this.handleClosed(e);
  }

  private handleClosed(e: CloseEvent | null) {
    this.synced = false;
    if (this.cleanTimer) {
      clearTimeout(this.cleanTimer);
      this.cleanTimer = null;
    }
    removeAwarenessStates(
      this.awareness,
      [...this.awareness.getStates().keys()].filter((id) => id !== this.doc.clientID),
      'disconnect',
    );
    if (this.closed) return;
    if (e?.code === 4001) {
      this.reset = true;
      this.replaced();
      return;
    }
    const base = Math.min(30000, 1000 * 2 ** this.reconnectAttempt);
    this.reconnectAttempt++;
    const delay = Math.round(base / 2 + Math.random() * (base / 2));
    this.reconnectTimer = setTimeout(() => {
      if (!this.closed) this.connect();
    }, delay);
  }

  private send(type: number, payload: Uint8Array) {
    if (this.reset || this.replacedDoc) return;
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const buf = new Uint8Array(1 + payload.length);
    buf[0] = type;
    buf.set(payload, 1);
    this.ws.send(buf);
  }

  /** The document was replaced from outside the editor: told by a 4001, or by
   *  an autosave the server refused as stale. Fence this doc first, then let
   *  the page remount onto the new one. */
  replaced() {
    if (this.replacedDoc || this.closed) return;
    this.reset = true;
    this.replacedDoc = true;
    this.onReset();
  }

  destroy() {
    if (this.closed) return;
    this.closed = true;
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.cleanTimer) clearTimeout(this.cleanTimer);
    removeAwarenessStates(this.awareness, [this.doc.clientID], 'destroy');
    this.ws?.close();
    this.doc.destroy();
  }
}
