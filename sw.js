// Service worker: permite usar la webapp sin conexión.
// Al publicar cambios, sube la versión aquí y en los ?v= de index.html.
const CACHE = 'fichaje-v6';
const ASSETS = [
  './',
  'index.html',
  'styles.css?v=6',
  'i18n.js?v=6',
  'app.js?v=6',
  'backup.js?v=6',
  'manifest.webmanifest',
  'icons/icon-32.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// Red primero (para recibir actualizaciones) y caché si no hay conexión
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    // no-cache: revalida con el servidor en vez de usar la caché HTTP del navegador
    fetch(event.request, { cache: 'no-cache' })
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true }))
  );
});
