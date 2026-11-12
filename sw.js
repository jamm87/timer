// Service worker: permite usar la webapp sin conexión.
// Al publicar cambios, sube la versión aquí y en los ?v= de index.html.
const CACHE = 'fichaje-v8';
const ASSETS = [
  './',
  'index.html',
  'styles.css?v=8',
  'merge.js?v=8',
  'i18n.js?v=8',
  'app.js?v=8',
  'sync.js?v=8',
  'backup.js?v=8',
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
  // Solo los ficheros de la app: las llamadas a otros servidores (sincronización) no se cachean
  if (new URL(event.request.url).origin !== self.location.origin) return;
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
