// Aplicația se deschide și fără semnal: paginile proprii se iau din rețea când se poate, altfel din copia salvată;
// bibliotecile Firebase și fonturile se păstrează după prima încărcare.
const CACHE = 'vsp-v1';
self.addEventListener('install', e => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then(c => c.addAll(['./', './index.html', './config.js', './manifest.json']).catch(() => {}))); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // Firestore / Auth: niciodată din cache (le gestionează Firebase)
  if (/firestore\.googleapis|identitytoolkit|securetoken|googleapis\.com\/(identity|v1)/.test(u.href)) return;
  const libs = /gstatic\.com\/firebasejs|fonts\.(googleapis|gstatic)\.com|cdnjs\.cloudflare\.com/.test(u.href);
  if (libs) {
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).then(res => { const cp = res.clone(); caches.open(CACHE).then(c => c.put(e.request, cp)); return res; })));
    return;
  }
  if (u.origin === location.origin) {
    e.respondWith(fetch(e.request).then(res => { const cp = res.clone(); caches.open(CACHE).then(c => c.put(e.request, cp)); return res; })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('./index.html'))));
  }
});
