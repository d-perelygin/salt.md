import { useCallback, useEffect, useRef, useState } from 'react';

// Pointer-based dragging for the kanban board.
//
// Underneath this used to be the native HTML5 drag (`draggable`), and that
// feels bad for several reasons: the browser paints a pale ghost copy, there is
// no indication of WHERE the card will land, no auto-scroll, and on touch it
// does not work at all — which is why there was a separate ⋯ menu.
//
// This version uses pointer events (mouse and finger in one): a real floating
// card follows the pointer, the target column highlights, and on release the
// card moves. Hit testing goes through `data-col` on the column element rather
// than refs passed down — which keeps the caller lean.

export interface DragState {
  rowId: string;
  fromCol: string;
  title: string;
  width: number;
  // current pointer position and grab offset (where the card was taken hold of)
  x: number;
  y: number;
  dx: number;
  dy: number;
  over: string | null; // column under the pointer
  overRow: string | null; // card under the pointer, for the insertion point
  before: boolean; // ...above its middle (vs below)
  overSelf: boolean; // the pointer is over the dragged card's own spot
}

const START_THRESHOLD = 5; // px before a click becomes a drag

// On a finger the rule is different. Five pixels are crossed instantly while
// scrolling — the card stuck to the finger instead of the board scrolling. So:
// hold first, then drag. Anybody who swipes before that scrolls.
const TOUCH_HOLD_MS = 320;
// How much wobble during the hold still counts as "holding". Above that it was
// a swipe, and the drag is never armed in the first place.
const TOUCH_HOLD_SLOP = 10;

// Dragging a card into a column three screens away needs the board to keep
// moving while the pointer rests at its edge. The zone is generous on purpose:
// on a phone the last column is often half off-screen, and reaching it means
// holding the card against the very edge of the glass.
const EDGE_ZONE = 64;
const EDGE_SPEED = 18;

export function useBoardDrag(
  onMove: (rowId: string, fromCol: string, toCol: string, beforeId: string | null, before: boolean, overSelf: boolean) => void,
) {
  const [drag, setDrag] = useState<DragState | null>(null);
  // Which card is armed after the hold but has not moved yet. On the iPhone
  // there is no navigator.vibrate — without a visible signal nothing at all
  // happens between the hold and the first movement, and nobody knows whether
  // the card is on the finger now.
  const [armedRow, setArmedRow] = useState<string | null>(null);

  // Live data for the window listeners, so they do not have to be rebound on
  // every position update.
  const live = useRef<{
    rowId: string;
    fromCol: string;
    title: string;
    width: number;
    dx: number;
    dy: number;
    startX: number;
    startY: number;
    started: boolean;
    over: string | null;
    overRow: string | null;
    before: boolean;
    overSelf: boolean;
    touch: boolean;
    // armed: on a finger only true after TOUCH_HOLD_MS. Before that every
    // movement belongs to scrolling.
    armed: boolean;
    holdTimer: number | null;
    // The horizontal scroller the board lives in, and where the pointer was
    // last seen. The board has to keep scrolling while the finger HOLDS at its
    // edge — and a finger that does not move produces no pointermove at all.
    board: HTMLElement | null;
    lastX: number;
    lastY: number;
    frame: number | null;
  } | null>(null);
  // Whether a drag really happened — this tells a click (navigate) from a drag
  // (move). A ref, because the pointerup handler needs it straight away.
  const draggedRef = useRef(false);

  const colUnder = (x: number, y: number): string | null => {
    for (const el of document.elementsFromPoint(x, y)) {
      const col = (el as HTMLElement).closest?.('[data-col]');
      if (col) return col.getAttribute('data-col');
    }
    return null;
  };

  useEffect(() => {
    /** What the pointer is over: the column, the card under it, and which half. */
    const hitTest = (x: number, y: number) => {
      const l = live.current;
      if (!l) return null;
      // The card under the pointer, for dropping between cards rather than
      // just into a column. The dragged card's own spot counts as itself, so
      // dropping it back where it was reads as the no-op it is.
      let overRow: string | null = null;
      let before = false;
      let overSelf = false;
      for (const el of document.elementsFromPoint(x, y)) {
        const card = (el as HTMLElement).closest?.('.board-card[data-row]');
        if (!card) continue;
        const id = card.getAttribute('data-row');
        if (!id) continue;
        if (id === l.rowId) {
          overSelf = true;
          break;
        }
        overRow = id;
        const r = (card as HTMLElement).getBoundingClientRect();
        before = y < r.top + r.height / 2;
        break;
      }
      return { over: colUnder(x, y), overRow, before, overSelf };
    };

    const publish = (x: number, y: number) => {
      const l = live.current;
      const hit = hitTest(x, y);
      if (!l || !hit) return;
      l.lastX = x;
      l.lastY = y;
      l.over = hit.over;
      l.overRow = hit.overRow;
      l.before = hit.before;
      l.overSelf = hit.overSelf;
      setDrag({
        rowId: l.rowId,
        fromCol: l.fromCol,
        title: l.title,
        width: l.width,
        x,
        y,
        dx: l.dx,
        dy: l.dy,
        over: l.over,
        overRow: l.overRow,
        before: l.before,
        overSelf: l.overSelf,
      });
    };

    /** Keeps both scrollers moving while the pointer rests at an edge, and
     *  re-reads what is under it as the board slides beneath the card. */
    const tick = () => {
      const l = live.current;
      if (!l || !l.started) {
        if (l) l.frame = requestAnimationFrame(tick);
        return;
      }
      let scrolled = false;
      const board = l.board;
      if (board) {
        const r = board.getBoundingClientRect();
        if (l.lastY >= r.top && l.lastY <= r.bottom) {
          const fromLeft = l.lastX - r.left;
          const fromRight = r.right - l.lastX;
          // Up to EDGE_SPEED at the very edge, easing off towards the zone's
          // inner boundary: a constant speed at 1px inside feels like a jump.
          if (fromLeft < EDGE_ZONE) {
            board.scrollLeft -= Math.ceil(EDGE_SPEED * (1 - Math.max(0, fromLeft) / EDGE_ZONE));
            scrolled = true;
          } else if (fromRight < EDGE_ZONE) {
            board.scrollLeft += Math.ceil(EDGE_SPEED * (1 - Math.max(0, fromRight) / EDGE_ZONE));
            scrolled = true;
          }
        }
      }
      // The column's own list, so a long column can be crossed without letting
      // go either.
      for (const el of document.elementsFromPoint(l.lastX, l.lastY)) {
        const cards = (el as HTMLElement).closest?.('.board-cards') as HTMLElement | null;
        if (!cards) continue;
        const r = cards.getBoundingClientRect();
        if (l.lastY - r.top < 40) {
          cards.scrollTop -= 12;
          scrolled = true;
        } else if (r.bottom - l.lastY < 40) {
          cards.scrollTop += 12;
          scrolled = true;
        }
        break;
      }
      if (scrolled) publish(l.lastX, l.lastY);
      l.frame = requestAnimationFrame(tick);
    };

    const onPointerMove = (e: PointerEvent) => {
      const l = live.current;
      if (!l) return;
      const moved = Math.hypot(e.clientX - l.startX, e.clientY - l.startY);
      if (!l.started) {
        if (l.touch && !l.armed) {
          // Still inside the hold window: whoever swipes wants to scroll. Give
          // the drag up entirely, or the card snaps shut mid-scroll later.
          if (moved > TOUCH_HOLD_SLOP) {
            if (l.holdTimer) clearTimeout(l.holdTimer);
            if (l.frame) cancelAnimationFrame(l.frame);
            live.current = null;
            setArmedRow(null);
          }
          return;
        }
        if (moved < START_THRESHOLD) return;
        l.started = true;
        draggedRef.current = true;
        // Armed for real: the edge scroll only belongs to a drag in progress.
        l.frame = requestAnimationFrame(tick);
      }
      publish(e.clientX, e.clientY);
    };

    const onPointerUp = () => {
      const l = live.current;
      if (l?.holdTimer) clearTimeout(l.holdTimer);
      if (l?.frame) cancelAnimationFrame(l.frame);
      if (l?.board) {
        l.board.style.scrollSnapType = l.board.dataset.prevSnap ?? '';
        delete l.board.dataset.prevSnap;
      }
      live.current = null;
      setDrag(null);
      setArmedRow(null);
      if (l && l.started && l.over) {
        onMove(l.rowId, l.fromCol, l.over, l.overRow, l.before, l.overSelf);
      }
      // draggedRef stays set until the next click, so the card's click
      // handler can suppress navigation.
    };

    // The moment a real drag starts, the page must not scroll along. That
    // cannot be done through `touch-action`: the value is read when the gesture
    // begins, and changing it later has no effect on the running gesture. So the
    // hard way — passive: false, so preventDefault is allowed.
    const onTouchMove = (e: TouchEvent) => {
      if (live.current?.started) e.preventDefault();
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      window.removeEventListener('touchmove', onTouchMove);
    };
  }, [onMove]);

  const startDrag = useCallback(
    (e: React.PointerEvent, rowId: string, fromCol: string, title: string) => {
      // Left mouse button or finger only, and not on a control of the card
      // (the ⋯ menu, a select chip, a checkbox) — there you want to click, not
      // drag. A checkbox was missing from this list, so its toggle was swallowed
      // by the drag that started on top of it.
      if (e.button !== 0) return;
      if ((e.target as Element).closest?.('.card-move, .card-prop-edit, a, button, input, select, textarea, label')) return;
      const card = (e.currentTarget as HTMLElement).getBoundingClientRect();
      draggedRef.current = false;
      const touch = e.pointerType === 'touch' || e.pointerType === 'pen';
      // The browser can start selecting the text around the card before the
      // drag threshold is met, so a drag painted a blue selection over the
      // page behind it (#142). Kept for a finger: there the press is also how
      // a long list is scrolled before the hold wins.
      if (!touch) e.preventDefault();
      live.current = {
        rowId,
        fromCol,
        title,
        width: card.width,
        dx: e.clientX - card.left,
        dy: e.clientY - card.top,
        startX: e.clientX,
        startY: e.clientY,
        started: false,
        over: fromCol,
        overRow: null,
        before: false,
        overSelf: false,
        touch,
        armed: !touch, // mouse: armed at once. Finger: only after the hold.
        holdTimer: null,
        board: (e.currentTarget as HTMLElement).closest('.board') as HTMLElement | null,
        lastX: e.clientX,
        lastY: e.clientY,
        frame: null,
      };
      // Columns snap into place on a phone (`scroll-snap-type`), and a snapped
      // scroller undoes a 15px programmatic step by snapping straight back:
      // the edge scroll looked like it did nothing. An inline style, not a
      // class — the board's className belongs to React and is rewritten on
      // every drag render, which removed the marker a frame later.
      if (live.current.board) {
        live.current.board.dataset.prevSnap = live.current.board.style.scrollSnapType;
        live.current.board.style.scrollSnapType = 'none';
      }
      if (touch) {
        const l = live.current;
        l.holdTimer = window.setTimeout(() => {
          if (live.current !== l) return;
          l.armed = true;
          setArmedRow(l.rowId);
          navigator.vibrate?.(12);
        }, TOUCH_HOLD_MS);
      }
    },
    [],
  );

  // The card click asks this: if a drag just happened, do NOT navigate.
  const consumeClick = useCallback(() => {
    if (draggedRef.current) {
      draggedRef.current = false;
      return true; // the click belonged to a drag: swallow it
    }
    return false;
  }, []);

  return { drag, armedRow, startDrag, consumeClick };
}
