/* Cache everything on first load so the tool works with no signal at the
   draft. Network-first for the board (a pre-draft refresh should be picked
   up), cache-first for code, and the cache always answers if the network
   does not. */

const CACHE = 'ffdraft-v1';
const SHELL = [
  './', 'index.html', 'assets/style.css', 'assets/app.js',
  'assets/engine.js', 'assets/planner.js', 'data/board.json',
  'manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const isBoard = e.request.url.includes('board.json');
  e.respondWith(
    isBoard
      ? fetch(e.request)
          .then((r) => { caches.open(CACHE).then((c) => c.put(e.request, r.clone())); return r; })
          .catch(() => caches.match(e.request))
      : caches.match(e.request).then((hit) => hit || fetch(e.request))
  );
});
