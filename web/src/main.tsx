import React from 'react';
import ReactDOM from 'react-dom/client';
import '@blocknote/core/fonts/inter.css';
import '@blocknote/mantine/style.css';
// The fonts live in the binary, not at a CDN: a self-hosted instance should
// look complete with no outward network access, and a fetch from Google gives
// away every page view to a third party. The browser loads a font file only
// once it is actually used — so including them costs nothing as long as nobody
// has switched them on.
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './styles.css';
// The website's look, layered on top — see the head of theme.css for why it is
// a file of its own rather than edits in styles.css.
import './theme.css';
// Notion-style AI chat look, layered above both.
import './aiChat.css';
// The phone shell, and nothing else — see the head of mobile.css. Last, so its
// one media query wins over the rules it is replacing.
import './mobile.css';
import App from './App';
import { installRingHover } from './ring';
import { installViewportVars } from './viewport';
import { installTouchGuards, installTypingState } from './touch';
import { installNavIndex } from './navStack';
import { initLocale, useLocale } from './i18n';
import ErrorBoundary from './components/ErrorBoundary';
import UpdateBanner from './components/UpdateBanner';
import ActivityLogHost from './components/ActivityLogHost';
import { checkForNewVersion } from './pwa';

installRingHover();
// The keyboard's height, for the phone sheets that have to sit above it.
installViewportVars();
// A long press on a draggable card is a drag, not the browser's menu.
installTouchGuards();
// While a field has the keyboard, the phone's dock steps out of its way.
installTypingState();
// The position in the history stack, for the back and forward arrows in the
// tabs sheet — the ones a browser would otherwise provide.
installNavIndex();

/** Remount the whole tree when the language changes.
 *
 *  The alternative is a useLocale() call in every component that translates
 *  anything — roughly forty of them, each one a chance to forget, and forgetting
 *  shows up as a pane that stays in the old language until you click something.
 *  Changing language is a once-in-a-blue-moon action, so paying for it with a
 *  remount is the right trade: one subscription instead of forty, and no way to
 *  get it wrong. */
function Root() {
  const locale = useLocale();
  return (
    <ErrorBoundary key={locale}>
      <App />
      {/* Outside App on purpose: app-wide chrome that fetches its own data, so
          it needs nothing from App's state — and App.tsx is what a wiki
          screenshot is stamped against, which this way stays untouched. */}
      <UpdateBanner />
      <ActivityLogHost />
    </ErrorBoundary>
  );
}

// Load the language before the first paint. Rendering first and translating
// afterwards would show every non-English user a flash of English on every
// load.
//
// A callback rather than top-level await on purpose: await here would force the
// build target up to ES2022 and drop Safari 14, which still runs the iOS
// home-screen app on older iPads. `finally` so a broken catalog costs the user
// English, never a blank page.
initLocale().finally(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <Root />
    </React.StrictMode>,
  );
});

// PWA app-shell caching. Service workers only run in secure contexts (HTTPS or
// localhost) — on a plain-HTTP LAN deployment this is a silent no-op, and the
// manifest/apple-touch-icon still give an installable home-screen app on iOS.
if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* offline shell is a nice-to-have; never break the app over it */
    });
  });
  // An installed window can stay open for days without navigating, and a
  // navigation is the only time the browser looks for a new build on its own.
  // Ask when the window comes back to the foreground instead — at most once
  // in ten minutes, since every answer is a network call. Never on a gesture:
  // a worker that swaps under running JavaScript can leave the page asking for
  // a chunk the new build no longer has.
  let lastAsked = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (Date.now() - lastAsked < 10 * 60_000) return;
    lastAsked = Date.now();
    void checkForNewVersion();
  });
}
