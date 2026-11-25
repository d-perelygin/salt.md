import { useEffect, useRef, type RefObject } from 'react';
import { installSheetDrag } from '../sheetSwipe';

/** The bar at the top of a bottom sheet, which is also the handle that closes
 *  it: drag it down far enough and the sheet follows the finger off the screen.
 *
 *  Every sheet in the app uses this one, so the gesture, its threshold and the
 *  way it springs back cannot drift apart from sheet to sheet. On a desktop the
 *  bar is hidden — a popover hanging off an icon has no bottom edge to drag. */
export default function SheetGrab({
  sheet,
  onDismiss,
}: {
  sheet: RefObject<HTMLElement | null>;
  onDismiss: () => void;
}) {
  const handle = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!handle.current || !sheet.current) return;
    return installSheetDrag(handle.current, sheet.current, onDismiss);
  }, [sheet, onDismiss]);
  return (
    <div className="sheet-grab sheet-drag" ref={handle} aria-hidden="true">
      <span />
    </div>
  );
}
