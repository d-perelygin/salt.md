// A surface a hold can move: board cards, calendar entries, Gantt bars, the
// unscheduled tray, the tabs sheet and the sidebar's rows. The stylesheet marks
// the same classes (see mobile.css) to stop the browser from starting a text
// selection; this list covers the devices where that alone is not enough.
const TOUCH_DRAG_SURFACES =
  '.board-card, .calendar-event, .cal-span, .tl-bar, .unsched-card, .tabs-sheet-card, .tree-item';

/**
 * A phone's long press on a draggable thing is the beginning of a drag, not a
 * request for the browser's menu. WebKit paints its callout on a link or a
 * selected word and Android opens the text action bar at roughly the moment a
 * hold-to-drag arms — and starting a selection cancels the pointer sequence the
 * drag runs on, so the drag never happens. The menu has nothing to offer here:
 * these surfaces are moved by holding them.
 *
 * Only touch-originated menus are cancelled, so a mouse right-click and the
 * menus hanging off it are untouched, and nothing outside a drag surface (a
 * field, the document) loses its native behaviour.
 */
export function installTouchGuards(): void {
  let fromTouch = false;
  document.addEventListener(
    'pointerdown',
    (event) => {
      fromTouch = event.pointerType === 'touch';
    },
    true,
  );
  document.addEventListener(
    'contextmenu',
    (event) => {
      if (!fromTouch) return;
      const target = event.target as Element | null;
      if (!target?.closest?.(TOUCH_DRAG_SURFACES)) return;
      // Capture phase and no propagation: the surface's own long-press menu is
      // the wrong thing to open in the middle of a drag, and it would land on
      // top of the card being carried.
      event.preventDefault();
      event.stopPropagation();
    },
    true,
  );
}
