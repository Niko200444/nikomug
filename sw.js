// PWA service worker (robust, no install-time failures)
const CACHE_NAME = 'ets-quiz-v14';
const CORE = [
  './',
  './index.html',
  './styles.css',
  './app.js?v=14',
  './aa.json',
  './manifest.webmanifest'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil((async () => {
    try{
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(CORE);
    }catch(e){
      // Ignore install caching failure (offline first run)
      console.warn('SW install cache skip:', e);
    }
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => { if (k !== CACHE_NAME) return caches.delete(k); }));
    await self.clients.claim();
  })());
});

async function networkFirst(req){
  if (req.method !== 'GET') return fetch(req);
  try{
    const fresh = await fetch(req);
    const cache = await caches.open(CACHE_NAME);
    if (fresh.ok) await cache.put(req, fresh.clone());
    return fresh;
  }catch(e){
    const cached = await caches.match(req);
    if (cached) return cached;
    throw e;
  }
}

async function staleWhileRevalidate(req){
  if (req.method !== 'GET') return fetch(req);
  const cache = await caches.open(CACHE_NAME);
  const cached = await caches.match(req);
  const fetchPromise = fetch(req).then((resp)=>{
    if (resp.ok) cache.put(req, resp.clone());
    return resp;
  }).catch(()=>cached);
  return cached || fetchPromise;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') { event.respondWith(fetch(req)); return; }
  const url = new URL(req.url);
  const isHTML = req.mode === 'navigate' || req.destination === 'document' || url.pathname.endsWith('/');
  const isJSON = url.pathname.endsWith('.json');

  if (isHTML) {
    event.respondWith(networkFirst(req));
    return;
  }
  if (isJSON){
    event.respondWith(networkFirst(req));
    return;
  }
  event.respondWith(staleWhileRevalidate(req));
});
