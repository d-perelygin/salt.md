/** The dim layer behind a phone sheet.
 *
 *  The three page menus are popovers hanging off a topbar icon on a desktop and
 *  bottom sheets on a phone. A popover is dismissed by a click outside it, and
 *  on a desktop that click is harmless because the popover covered a corner.
 *  A sheet covers most of the screen, so the same click lands on whatever was
 *  underneath — a link, a paragraph somebody is editing — while the sheet
 *  disappears. The backdrop takes that first touch instead.
 *
 *  It renders nothing above the breakpoint: this is the phone's grammar, not a
 *  new way for the desktop to behave. */
export default function SheetBackdrop({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div
      className="sheet-backdrop"
      aria-hidden="true"
      onPointerDown={(e) => {
        // Kept off the page below and off the document-level "click outside"
        // handler that also watches these menus: one dismissal, not two.
        e.preventDefault();
        e.stopPropagation();
        onDismiss();
      }}
    />
  );
}
