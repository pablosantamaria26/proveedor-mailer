// Incrementar este número con cada deploy para forzar actualización
const CACHE_VERSION = 'v4-pro';
const CACHE_NAME    = `mailer-ml-${CACHE_VERSION}`;

const STATIC_ASSETS = [
  '/proveedor-mailer/',
  '/proveedor-mailer/index.html',
  '/proveedor-mailer/manifest.json',
  '/proveedor-mailer/logo.jpeg',
  '/proveedor-mailer/icon-192.png',
  '/proveedor-mailer/icon-512.png',
  '/proveedor-mailer/apple-touch-icon.png',
];

// Instalar: pre-cachear assets estáticos y activar de inmediato
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Activar: borrar caches viejos y tomar control de todos los clientes
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// Fetch: network-first para HTML, cache-first para estáticos
// Las llamadas a la API (workers.dev, supabase.co) siempre van a la red
self.addEventListener('fetch', event => {
  const url = event.request.url;

  // Dejar pasar las llamadas a APIs externas sin tocar
  if (url.includes('workers.dev') || url.includes('supabase.co')) return;

  if (event.request.mode === 'navigate') {
    // HTML: red primero, fallback a caché si offline
    event.respondWith(
      fetch(event.request)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
          return res;
        })
        .catch(() => caches.match(event.request))
    );
  } else {
    // Otros assets: caché primero, luego red
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
          }
          return res;
        });
      })
    );
  }
});
