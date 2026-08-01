// Pixel Fencing service worker.
//
// The whole game is a handful of static files, so everything is precached on
// install and the app runs fully offline from then on. Bump CACHE_NAME on
// every deploy — the activate handler deletes any cache that isn't this one.
var CACHE_NAME = 'pixel-fencing-v13';

var ASSETS = [
  '/',
  '/index.html',
  '/game.js',
  '/fencers.json',
  '/manifest.json',
  '/assets/PressStart2P.ttf',
  '/assets/favicon.png',
  '/assets/favicon-32.png',
  '/assets/apple-touch-icon.png',
  '/assets/icon-192.png',
  '/assets/icon-512.png',
  '/assets/icon-maskable-192.png',
  '/assets/icon-maskable-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      // addAll is atomic: one 404 and nothing is cached, which would leave the
      // app half-installed. Add individually and don't let a single missing
      // asset abort the install.
      return Promise.all(ASSETS.map(function (url) {
        return cache.add(new Request(url, { cache: 'reload' })).catch(function (err) {
          console.warn('[sw] could not precache', url, err);
        });
      }));
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    Promise.all([
      caches.keys().then(function (names) {
        return Promise.all(
          names.filter(function (n) { return n !== CACHE_NAME; })
               .map(function (n) { return caches.delete(n); })
        );
      }),
      // Serve navigations from the cache immediately rather than waiting for
      // the network to time out first.
      self.registration.navigationPreload
        ? self.registration.navigationPreload.disable()
        : Promise.resolve()
    ]).then(function () { return self.clients.claim(); })
  );
});

// Let the page ask a waiting worker to take over straight away.
self.addEventListener('message', function (event) {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;   // don't touch third parties

  // Navigations: serve the shell from cache, fall back to the network, and if
  // both fail (offline, cold cache) still hand back the cached index so the
  // game opens instead of showing the browser's offline page.
  if (req.mode === 'navigate') {
    event.respondWith(
      caches.match('/index.html').then(function (cached) {
        var network = fetch(req).then(function (res) {
          if (res && res.status === 200) {
            var clone = res.clone();
            caches.open(CACHE_NAME).then(function (c) { c.put('/index.html', clone); });
          }
          return res;
        }).catch(function () { return cached; });
        return cached || network;
      })
    );
    return;
  }

  // Everything else: cache first, refresh in the background.
  event.respondWith(
    caches.match(req).then(function (cached) {
      var network = fetch(req).then(function (res) {
        if (res && res.status === 200 && res.type === 'basic') {
          var clone = res.clone();
          caches.open(CACHE_NAME).then(function (c) { c.put(req, clone); });
        }
        return res;
      }).catch(function () { return cached; });
      if (cached) {
        event.waitUntil(network.catch(function () {}));
        return cached;
      }
      return network;
    })
  );
});
