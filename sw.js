const CACHE = 'hekomi-shell-v15-complete-mal-mobile-pwa';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg', '/Anime%20Manga%20Duality%20Emblem.ico', '/assets/folio-night-scene.svg', '/assets/hekomi-social.svg', '/assets/hekomi-manga-mark.svg', '/assets/hekomi-anime-mark.svg', '/assets/hekomi-dual-mark.svg', '/assets/hekomi-chan.js'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok && SHELL.includes(url.pathname)) caches.open(CACHE).then(c => c.put(event.request, response.clone()));
    return response;
  }).catch(async () => (await caches.match(event.request)) || (await caches.match('/index.html'))));
});
