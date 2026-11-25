/** Drag a bottom sheet down to close it, from its grab handle.
 *
 *  A sheet on a phone that can only be closed by hitting a small × is the one
 *  gesture people try first and nothing happens: every iOS and Android sheet
 *  they have ever used slides away under the finger. This is that gesture.
 *
 *  It is deliberately limited to the handle. Taking the drag from anywhere
 *  inside the sheet would fight the list it contains — the browser has decided
 *  by the time the pointer moves whether the touch is a scroll or ours, and
 *  `touch-action` has to be set before the finger lands. The handle is the one
 *  strip that is ours by definition: no scroller, no buttons, and it already
 *  draws the bar that invites the gesture.
 *
 *  Closing is a translate to the sheet's own height plus a margin, so a sheet
 *  leaves the screen completely rather than fading while still covering the
 *  page underneath. */
export function installSheetDrag(
  handle: HTMLElement,
  sheet: HTMLElement,
  onDismiss: () => void,
): () => void {
  let startY = 0;
  let startTime = 0;
  let offset = 0;
  let dragging = false;
  let closing = false;

  const settle = (transition: string) => {
    sheet.style.transition = transition;
    sheet.style.transform = '';
  };

  const onDown = (e: PointerEvent) => {
    if (closing || e.button !== 0) return;
    dragging = true;
    offset = 0;
    startY = e.clientY;
    startTime = performance.now();
    sheet.style.transition = 'none';
    handle.setPointerCapture?.(e.pointerId);
  };

  const onMove = (e: PointerEvent) => {
    if (!dragging) return;
    // Upward drags do nothing: a sheet grows upward only by opening further,
    // and pretending otherwise makes the handle feel disconnected.
    offset = Math.max(0, e.clientY - startY);
    sheet.style.transform = `translateY(${offset}px)`;
  };

  const onUp = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    handle.releasePointerCapture?.(e.pointerId);
    const height = sheet.getBoundingClientRect().height;
    const velocity = offset / Math.max(1, performance.now() - startTime);
    // A quarter of the sheet, or a flick: the two ways people mean "close".
    const shouldClose = offset > Math.max(72, height * 0.25) || (offset > 24 && velocity > 0.55);
    if (shouldClose) {
      closing = true;
      sheet.style.transition = 'transform 180ms ease-in';
      sheet.style.transform = `translateY(${height + 24}px)`;
      window.setTimeout(() => {
        onDismiss();
        // The AI panel is hidden rather than unmounted, so its inline transform
        // would survive the close and put it off-screen on the next open.
        requestAnimationFrame(() => {
          sheet.style.transition = '';
          sheet.style.transform = '';
        });
      }, 170);
      return;
    }
    settle('transform 200ms cubic-bezier(0.16, 1, 0.3, 1)');
    window.setTimeout(() => {
      if (!dragging) sheet.style.transition = '';
    }, 220);
  };

  const onCancel = () => {
    if (!dragging) return;
    dragging = false;
    settle('transform 160ms ease-out');
    window.setTimeout(() => {
      if (!dragging) sheet.style.transition = '';
    }, 180);
  };

  handle.addEventListener('pointerdown', onDown);
  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', onUp);
  handle.addEventListener('pointercancel', onCancel);
  return () => {
    handle.removeEventListener('pointerdown', onDown);
    handle.removeEventListener('pointermove', onMove);
    handle.removeEventListener('pointerup', onUp);
    handle.removeEventListener('pointercancel', onCancel);
  };
}
