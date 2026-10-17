// Session undo stacks for collection views. One stack per view, alive while
// the page is open — nothing durable, no authors, no conflicts: somebody
// else's rows arriving over SSE never land here, only your own writes.
//
// A step is a pair of closures over the write paths the action itself used,
// so undoing journals offline exactly like doing (an amend, not a cancel).
// The topbar lives outside the collection tree, so stacks announce
// themselves (salt:undo-state) and take orders (salt:undo-request /
// salt:redo-request) over window events — the same bus the peek uses.

export type UndoStep = {
  label: string;
  undo: () => void | Promise<unknown>;
  redo: () => void | Promise<unknown>;
};

type Stack = { undo: UndoStep[]; redo: UndoStep[] };

// A hundred steps back is amnesia-proof enough; beyond that the oldest goes.
const CAP = 100;

const stacks = new Map<string, Stack>();

// One serialized lane per view. Do, undo and redo join the same tail in
// issue order, so a redo pressed a beat after its undo can never pop a stack
// the undo has not pushed back to yet — no matter how late the network
// answers. Without this, rapid undo→redo→undo silently operates on stale
// stacks (the push lands with the response, the server state the test — or
// a fast hand — reads lands earlier).
const tails = new Map<string, Promise<unknown>>();

export function series<T>(viewId: string | undefined, fn: () => Promise<T>): Promise<T> {
  if (!viewId) return fn();
  const run = (tails.get(viewId) ?? Promise.resolve()).catch(() => {}).then(fn);
  tails.set(viewId, run.catch(() => {}));
  return run;
}

// The active (rendered, non-embed) view of each collection page, so the
// topbar's buttons address the view you are looking at.
const activeViews = new Map<string, string>();

function stackFor(viewId: string): Stack {
  let s = stacks.get(viewId);
  if (!s) {
    s = { undo: [], redo: [] };
    stacks.set(viewId, s);
  }
  return s;
}

function emit(viewId: string) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent('salt:undo-state', { detail: { viewId, canUndo: canUndo(viewId), canRedo: canRedo(viewId) } }),
  );
}

export function pushUndo(viewId: string, step: UndoStep) {
  const s = stackFor(viewId);
  s.undo.push(step);
  if (s.undo.length > CAP) s.undo.shift();
  // A new action burns the redo tail, like everywhere else.
  s.redo = [];
  emit(viewId);
}

export function canUndo(viewId: string): boolean {
  return (stacks.get(viewId)?.undo.length ?? 0) > 0;
}

export function canRedo(viewId: string): boolean {
  return (stacks.get(viewId)?.redo.length ?? 0) > 0;
}

export async function undoView(viewId: string): Promise<boolean> {
  return series(viewId, async () => {
    const s = stacks.get(viewId);
    const step = s?.undo.pop();
    if (!s || !step) return false;
    await step.undo();
    s.redo.push(step);
    emit(viewId);
    return true;
  });
}

export async function redoView(viewId: string): Promise<boolean> {
  return series(viewId, async () => {
    const s = stacks.get(viewId);
    const step = s?.redo.pop();
    if (!s || !step) return false;
    await step.redo();
    s.undo.push(step);
    emit(viewId);
    return true;
  });
}

export function clearUndo(viewId: string) {
  if (stacks.delete(viewId)) emit(viewId);
}

// The current states, for whoever renders the buttons (the topbar lives
// outside the collection tree and cannot read the stacks).
export function announceUndo(viewId: string) {
  emit(viewId);
}

export function setActiveView(collectionId: string, viewId: string) {
  activeViews.set(collectionId, viewId);
}

export function clearActiveView(collectionId: string, viewId: string) {
  if (activeViews.get(collectionId) === viewId) activeViews.delete(collectionId);
}

export function activeViewOf(collectionId: string): string | undefined {
  return activeViews.get(collectionId);
}
