/** How much of the screen the on-screen keyboard is covering, as two CSS
 *  custom properties on the root element.
 *
 *  iOS keeps a `position: fixed; bottom: 0` element at the bottom of the LAYOUT
 *  viewport when the keyboard opens, which means the chat input and the last
 *  few results sit under the keys — the app looks broken exactly while somebody
 *  is typing in it. `visualViewport` is the only API that reports the part that
 *  is actually visible, so the phone surfaces read their height and their
 *  bottom offset from it:
 *
 *      bottom: var(--kb-inset, 0px);
 *      height: calc(var(--vvh, 100dvh) - 8px);
 *
 *  Both default to nothing, so a browser without visualViewport (and the whole
 *  desktop) keeps the ordinary `dvh` layout.
 *
 *  Values are rounded: an unrounded height changes every animation frame while
 *  the keyboard slides up, and each change relayouts the panel. */
export function installViewportVars(): () => void {
  const vv = window.visualViewport;
  if (!vv) return () => {};
  const root = document.documentElement;
  const apply = () => {
    const keyboard = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    root.style.setProperty('--kb-inset', `${Math.round(keyboard)}px`);
    root.style.setProperty('--vvh', `${Math.round(vv.height)}px`);
  };
  apply();
  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
  return () => {
    vv.removeEventListener('resize', apply);
    vv.removeEventListener('scroll', apply);
  };
}
