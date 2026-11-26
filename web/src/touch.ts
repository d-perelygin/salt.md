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

// Input types that take no text: focusing them means a click, not a keyboard.
const NON_TEXT_INPUTS = new Set([
  'checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'color', 'range', 'image',
]);

function isTypingTarget(el: Element | null): boolean {
  if (!el) return false;
  // Only real form fields: the document editor is a contenteditable and has
  // its own keyboard bar (`mobile-editing`); counting it here hid the dock on
  // every page open, keyboard or not.
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(el.type);
  return false;
}

/**
 * Tell the stylesheet when a keyboard owns the bottom edge.
 *
 * The phone dock sits under the page in normal flow, so while somebody types
 * in a chat or a field it is the one strip the keyboard covers — half visible,
 * stealing the room the composer needs. `mobile-typing` is set from focus, not
 * from the on-screen keyboard (the platform does not report that reliably
 * before the layout settles), and mobile.css hides the dock only below the
 * breakpoint. Blur is deferred one tick because focus moves out before the
 * next field is focused, which would otherwise flash the dock between fields.
 */
export function installTypingState(): void {
  const sync = () =>
    document.body.classList.toggle('mobile-typing', isTypingTarget(document.activeElement));
  document.addEventListener('focusin', sync, true);
  document.addEventListener('focusout', () => window.setTimeout(sync, 0), true);
  window.addEventListener('pageshow', sync);
}
