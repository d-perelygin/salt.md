/* salt.md service worker: app-shell caching plus offline snapshots.
 *
 * Strategy:
 *  - Hashed /assets/* → cache-first (immutable by construction).
 *  - Navigations (index.html) → network-first (with lie-fi timeout), cache
 *    fallback, so the app shell opens offline and deploys are picked up.
 *  - Read-only API snapshots (exact whitelist in isSnapshotRequest) & /files/*
 *    → network-first (with 4s timeout) and cache fallback. Cached fallbacks
 *    carry `X-Salt-Offline: 1` so the UI knows the copy is stale and does
 *    not refresh IndexedDB timestamps from it.
 *  - EVERYTHING else (/collab, /mcp, /public, revisions, search, etc.) →
 *    network only.
 */
const SHELL = 'salt-shell-v1';
const DATA = 'salt-data-v1';
const FETCH_TIMEOUT_MS = 4000;
const MAX_DATA_ENTRIES = 250;

// Strict whitelist of GETs safe to serve stale. Revisions, shares, search,
// presence, audit and live queries stay network-only.
function isSnapshotRequest(pathname) {
  if (
    pathname === '/api/me' ||
    pathname === '/api/workspaces' ||
    pathname === '/api/pages' ||
    pathname === '/api/templates' ||
    pathname === '/api/tag-colors' ||
    pathname === '/api/comment-counts' ||
    pathname === '/api/favorites' ||
    pathname === '/api/tags' ||
    pathname === '/api/users' ||
    pathname === '/api/me/prefs'
  ) {
    return true;
  }
  if (/^\/api\/pages\/[^/]+$/.test(pathname)) return true;
  if (/^\/api\/collections(\/[^/]+(\/rows)?)?$/.test(pathname)) return true;
  if (pathname.startsWith('/files/')) return true;
  return false;
}

function fetchWithTimeout(request, ms = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(request, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

function withOfflineHeader(res) {
  const headers = new Headers(res.headers);
  headers.set('X-Salt-Offline', '1');
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

async function putDataCache(req, res) {
  try {
    const cache = await caches.open(DATA);
    await cache.put(req, res);
    const keys = await cache.keys();
    if (keys.length > MAX_DATA_ENTRIES) {
      await Promise.all(keys.slice(0, keys.length - MAX_DATA_ENTRIES).map((k) => cache.delete(k)));
    }
  } catch {
    /* quota/private mode: best-effort */
  }
}

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.add('/'))
      .catch(() => {
        /* first paint must never fail over a cache */
      })
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== SHELL && k !== DATA).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (e) => {
  if (e.data?.type === 'CLEAR_DATA') {
    e.waitUntil(caches.delete(DATA).catch(() => {}));
  }
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  // Immutable hashed assets: cache-first.
  if (url.pathname.startsWith('/assets/')) {
    e.respondWith(
      caches.open(SHELL).then(async (cache) => {
        const hit = await cache.match(e.request);
        if (hit) return hit;
        const res = await fetch(e.request);
        if (res.ok) cache.put(e.request, res.clone()).catch(() => {});
        return res;
      }),
    );
    return;
  }

  // App-shell navigations: network-first (with timeout) + cache fallback.
  if (e.request.mode === 'navigate') {
    const isServerDoc = /^\/(public|ics|api|files|collab|mcp)(\/|$)/.test(url.pathname);
    e.respondWith(
      fetchWithTimeout(e.request)
        .then((res) => {
          if (res.ok && !isServerDoc) {
            const copy = res.clone();
            caches.open(SHELL).then((c) => c.put('/', copy).catch(() => {}));
          }
          return res;
        })
        .catch(() => caches.match('/')),
    );
    return;
  }

  // Offline snapshots: network-first (with timeout), cache fallback marked with
  // X-Salt-Offline: 1.
  if (isSnapshotRequest(url.pathname)) {
    e.respondWith(
      fetchWithTimeout(e.request)
        .then(async (res) => {
          if (res.ok) {
            const copy = res.clone();
            if (url.pathname === '/api/me') {
              const probe = res.clone();
              probe
                .json()
                .then((m) => {
                  if (m && m.authenticated) return putDataCache(e.request, copy);
                })
                .catch(() => {});
            } else {
              void putDataCache(e.request, copy);
            }
          }
          return res;
        })
        .catch(async () => {
          const hit = await caches.match(e.request);
          if (hit) return withOfflineHeader(hit);
          return Response.error();
        }),
    );
  }
});
