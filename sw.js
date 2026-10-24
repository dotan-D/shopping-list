'use strict';
const CACHE = 'shopping-list-shell-v4';
const SHELL = ['./', './index.html', './style.css', './app.js', './catalog.js', './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png', './icons/apple-touch-icon.png'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('shopping-list-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  url.hash = '';
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  const isNavigation = event.request.mode === 'navigate' && [new URL('./', self.registration.scope).pathname, new URL('./index.html', self.registration.scope).pathname].includes(url.pathname);
  if (!isNavigation && !SHELL.some(path => new URL(path, self.registration.scope).href === url.href)) return;
  const cacheKey = isNavigation ? new URL('./index.html', self.registration.scope).href : url.href;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) {
      const copy = response.clone();
      event.waitUntil(caches.open(CACHE).then(cache => cache.put(cacheKey, copy)));
    }
    return response;
  }).catch(async () => (await caches.match(cacheKey)) || Response.error()));
});
