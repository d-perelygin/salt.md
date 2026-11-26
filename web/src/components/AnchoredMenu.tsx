import { useLayoutEffect, useRef, type ReactNode } from 'react';

/** A `.menu` that the list it opens from cannot cut off.
 *
 *  The sidebar's tree scrolls, and a scroller clips whatever hangs out of it:
 *  the ⋯ menu of a row near its bottom vanished under the Templates section
 *  below (#21). Moving the menu into a portal would free it, but it would also
 *  take it out of the row's DOM, where the outside-click handling looks for it
 *  (useMenuDismiss). So it stays where it is and only changes how it is
 *  positioned: fixed, at exactly the place the stylesheet put it, which no
 *  scroller clips. Where that place runs off the screen it opens above its row
 *  instead, and it follows the row while the list scrolls. */
export default function AnchoredMenu({ className = 'menu', children }: { className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const menu = ref.current;
    const anchor = menu?.parentElement;
    if (!menu || !anchor) return;
    // Where CSS put it, relative to its anchor. Kept, so it opens exactly
    // where it always did.
    const laid = menu.getBoundingClientRect();
    const first = anchor.getBoundingClientRect();
    const dx = laid.left - first.left;
    const dy = laid.top - first.top;
    const place = () => {
      const a = anchor.getBoundingClientRect();
      menu.style.position = 'fixed';
      menu.style.right = 'auto';
      menu.style.bottom = 'auto';
      menu.style.top = '0px';
      menu.style.left = '0px';
      // The cap goes on BEFORE measuring: on a phone the rows are 44px, and a
      // menu with a dozen of them (a page's ⋯ plus every workspace) would run
      // the height of the screen, fail to fit under its row, and get flipped
      // above it — where it touches the top edge, the corner a thumb reaches
      // last. Capped, it fits below far more often and scrolls when it cannot.
      const phone = window.matchMedia('(max-width: 768px)').matches;
      const cap = phone ? Math.round(window.innerHeight * 0.6) : window.innerHeight - 16;
      menu.style.maxHeight = `${cap}px`;
      menu.style.overflowY = 'auto';
      // Where (0, 0) really is: on a phone the drawer is moved by a transform,
      // and a transformed ancestor becomes the origin of `fixed`.
      const origin = menu.getBoundingClientRect();
      let top = a.top + dy;
      if (phone) {
        // The row's own bottom edge is the natural place for a menu hanging off
        // it; the CSS offset is a desktop convention.
        const below = a.bottom + 4;
        top = below + origin.height <= window.innerHeight - 8 ? below : a.top - origin.height - 4;
      }
      if (top + origin.height > window.innerHeight - 8) top = Math.max(8, a.top - origin.height - 4);
      top = Math.max(8, top);
      const left = Math.max(8, Math.min(a.left + dx, window.innerWidth - origin.width - 8));
      menu.style.top = `${top - origin.top}px`;
      menu.style.left = `${left - origin.left}px`;
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, []);
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
