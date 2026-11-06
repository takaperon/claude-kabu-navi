// 画面の部品だけをキャッシュ。データ（raw.githubusercontent.com）は毎回取りに行く
const CACHE = 'kabunavi-v1';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon.svg', './icon-180.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  // 画面はネット優先（更新をすぐ反映）、つながらない時だけキャッシュ
  e.respondWith(fetch(e.request).then((r) => { const c = r.clone(); caches.open(CACHE).then((x) => x.put(e.request, c)); return r; }).catch(() => caches.match(e.request)));
});
