import { idList } from './components/PropertyValue';

// Shared dependency (blocker) logic for the timeline and the row editor.
//
// Direction: the relation is OUTGOING — a row lists the tasks IT blocks.
// depProp points at a self-relation; blockedBy is derived by reversing it.
// A row is blocked when it starts on or before a blocker's end: the blocker
// must finish first.

export const dayNum = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
};

export const isoDay = (n: number) => new Date(n * 86400000).toISOString().slice(0, 10);

export interface DepNode {
  id: string;
  start: number;
  end: number;
  /** Ids of the tasks this one blocks (outgoing). Unknown ids already dropped. */
  deps: string[];
}

export function depListOf(props: Record<string, unknown>, depProp: string, selfId: string, known: Set<string>): string[] {
  if (!depProp) return [];
  return idList(props[depProp]).filter((id) => id !== selfId && known.has(id));
}

/** Reverse index: for each row, the rows blocking it. */
export function blockedByMap(nodes: DepNode[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const n of nodes) {
    for (const s of n.deps) {
      const arr = out.get(s);
      if (arr) arr.push(n.id);
      else out.set(s, [n.id]);
    }
  }
  return out;
}

export interface Violation {
  predId: string;
  selfId: string;
}

/** Rows starting on/before a blocker's end. */
export function findViolations(byId: Map<string, DepNode>, blockedBy: Map<string, string[]>): Violation[] {
  const out: Violation[] = [];
  for (const [selfId, preds] of blockedBy) {
    const self = byId.get(selfId);
    if (!self) continue;
    for (const pid of preds) {
      const pred = byId.get(pid);
      if (pred && self.start <= pred.end) out.push({ predId: pid, selfId });
    }
  }
  return out;
}

/** Adding `to` to `from`'s blocked list closes a loop when `to` already
 *  (transitively) blocks `from`. */
export function wouldCreateCycle(from: string, to: string, depOf: (id: string) => string[]): boolean {
  if (from === to) return true;
  const seen = new Set<string>([to]);
  const stack = [to];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const next of depOf(cur)) {
      if (next === from) return true;
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return false;
}

/** First start day that clears every blocker, keeping duration out of it. */
export function shiftTarget(self: DepNode, preds: DepNode[]): number | null {
  if (!preds.length) return null;
  const after = Math.max(...preds.map((p) => p.end)) + 1;
  return after > self.start ? after : null;
}

export interface ArrowGeom {
  key: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  bad: boolean;
}

/** Notion-shaped dependency path in pixels: a short horizontal stub out of
 *  the blocker, a smooth turn into a straight diagonal, a turn back to
 *  horizontal and a short stub into the target. Tangents stay horizontal at
 *  both ends however narrow the gap, so tight links bend hard and wide links
 *  run straight like Notion's. The head is a separate chevron polyline so it
 *  never distorts. Entry always runs left-to-right, even when the target
 *  sits left of the blocker's end. */
export function arrowPathD(x1: number, y1: number, x2e: number, y2: number): string {
  const stub = 7;
  const p0x = x1 + stub;
  const p3x = x2e - stub;
  // Wide, Notion-like bends: the turn zone grows with the gap.
  const k = Math.min(60, Math.max(16, Math.abs(p3x - p0x) * 0.45));
  const f = (n: number) => Math.round(n * 100) / 100;
  return `M ${f(x1)} ${f(y1)} L ${f(p0x)} ${f(y1)} C ${f(p0x + k)} ${f(y1)}, ${f(p3x - k)} ${f(y2)}, ${f(p3x)} ${f(y2)} L ${f(x2e)} ${f(y2)}`;
}

/** Chevron head for an arrow entering at (x2, y2) left-to-right. */
export function arrowHeadPoints(x2: number, y2: number): string {
  return `${x2 - 5},${y2 - 6} ${x2 + 1},${y2} ${x2 - 5},${y2 + 6}`;
}
