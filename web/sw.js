// Caches the shell so the app opens instantly. Model calls always go to the network.
const CACHE = 'whatsthis-v13';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest',
               'icon-192.png', 'icon-512.png', 'icon.svg',
               'fonts/andika.css',
               'fonts/andika-400-latin.woff2', 'fonts/andika-700-latin.woff2'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks =>
    Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || e.request.url.includes('/api/')) return;
  e.respondWith(
    fetch(e.request).then(r => {
      const copy = r.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return r;
    }).catch(() => caches.match(e.request))
  );
});
