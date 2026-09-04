/* Offline cache for the draft board.
 *
 * Two requirements pull against each other: the tool has to work with no signal
 * at the draft venue, and it has to pick up new code when there is signal. The
 * first version only did the former -- the shell was served cache-first with no
 * revalidation, so once a phone had loaded the app it kept that copy for good.
 * A service worker only reinstalls when its own bytes change, so shipping new
 * app.js alone never reached anyone.
 *
 * Now the shell is stale-while-revalidate: the cached copy answers instantly,
 * and a background fetch refreshes it for next time. Nothing swaps underneath a
 * running page -- reloading is always the user's call, because code changing
 * mid-draft is worse than code being a day old.
 */

const CACHE = 'ffdraft-v2';
const SHELL = [
  './', 'index.html', 'assets/style.css', 'assets/app.js',
  'assets/engine.js', 'assets/planner.js', 'data/board.json',
  'manifest.webmanifest',
];

// Only these are worth telling the user about; a changed board.json is data,
// not a new version of the app.
const CODE = /\.(?:js|css|html)$|\/$/;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('message', (e) => {
  if (e.data === 'skip-waiting') return self.skipWaiting();

  // Force the shell back to the network before the page reloads.
  // Stale-while-revalidate refreshes the cache *behind* a load, so a plain
  // reload would serve the old copy one more time and only run the new code on
  // the reload after that -- which makes a "Reload" button a lie.
  if (e.data && e.data.type === 'refresh-shell') {
    e.waitUntil((async () => {
      const cache = await caches.open(CACHE);
      await Promise.all(SHELL.map(async (url) => {
        try {
          const res = await fetch(new Request(url, { cache: 'reload' }));
          if (res.ok) await cache.put(url, res);
        } catch { /* offline: keep whatever is already cached */ }
      }));
      if (e.source) e.source.postMessage({ type: 'shell-refreshed' });
    })());
  }
});

async function announce(url) {
  const clients = await self.clients.matchAll({ type: 'window' });
  for (const c of clients) c.postMessage({ type: 'update-ready', url });
}

/** Did the server's copy actually change? ETag first, length as a fallback. */
function changed(cached, fresh) {
  if (!cached) return false;
  const a = cached.headers.get('etag');
  const b = fresh.headers.get('etag');
  if (a && b) return a !== b;
  return cached.headers.get('content-length') !== fresh.headers.get('content-length');
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req);

  const network = fetch(req).then(async (res) => {
    if (res && res.ok && res.type !== 'opaque') {
      const isNew = changed(cached, res);
      await cache.put(req, res.clone());
      if (isNew && CODE.test(new URL(req.url).pathname)) announce(req.url);
    }
    return res;
  }).catch(() => null);

  // Cached copy wins on speed; the fetch keeps running to refresh it.
  if (cached) return cached;
  const res = await network;
  return res || new Response('offline', { status: 503, statusText: 'offline' });
}

async function networkFirst(req) {
  try {
    const res = await fetch(req);
    if (res && res.ok) (await caches.open(CACHE)).put(req, res.clone());
    return res;
  } catch {
    const hit = await caches.match(req);
    return hit || new Response('offline', { status: 503, statusText: 'offline' });
  }
}

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;

  // The board is data and should be as current as the network allows; the
  // cache is its fallback, which is what makes the venue-with-no-signal case
  // work after one good load.
  e.respondWith(url.pathname.endsWith('board.json')
    ? networkFirst(e.request)
    : staleWhileRevalidate(e.request));
});
