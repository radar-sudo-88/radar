'use strict';
/*
 * Aero Sentry service worker.
 *
 * Deliberately small. It exists so the site is installable and the page shell still opens with no
 * signal - it does NOT cache aircraft data. The live feed, route lookups and the /api/ endpoints
 * are never touched here (they go straight to the network), so the radar is always live.
 *
 * Strategy: network-first for the page shell (index/about/CSS/JS/icons), falling back to the last
 * copy if the network is down or slow. Network-first (not cache-first) means a `git pull` on the Pi
 * shows up on the very next load - no stale wall board. Leaflet from the CDN is cache-first (successful responses only).
 *
 * Bump VERSION to drop old caches after changing this file's strategy.
 */
const VERSION = 'v3';
const SHELL_CACHE = `aero-sentry-shell-${VERSION}`;
const CDN_CACHE = `aero-sentry-cdn-${VERSION}`;
const NETWORK_TIMEOUT_MS = 4000;

// Relative on purpose: works from a site root or a subpath (GitHub Pages).
const SHELL = [
  './',
  'index.html',
  'about.html',
  'styles.css',
  'app.js',
  'manifest.webmanifest',
  'favicon.svg',
  'favicon.ico',
  'apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      // One missing file must not fail the whole install, so each add() is allowed to fail alone.
      .then((cache) => Promise.all(SHELL.map((url) => cache.add(url).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith('aero-sentry-') && key !== SHELL_CACHE && key !== CDN_CACHE)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

// Live-data paths: never intercepted. Regex (not startsWith) so it also holds under a subpath.
const LIVE_PATH_RE = /(^|\/)(api|v2)\//;

function isShellRequest(request, url) {
  if (LIVE_PATH_RE.test(url.pathname)) return false;
  if (request.mode === 'navigate') return true;
  return ['style', 'script', 'image', 'manifest', 'font'].includes(request.destination);
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

async function networkFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await withTimeout(fetch(request), NETWORK_TIMEOUT_MS);
    // Only keep good same-origin responses (an unknown path returns the 404 page - don't cache that).
    if (response.ok && response.type === 'basic') cache.put(request, response.clone());
    return response;
  } catch (err) {
    const cached = (await cache.match(request, { ignoreSearch: true }))
      || (request.mode === 'navigate' ? (await cache.match('index.html')) || (await cache.match('./')) : null);
    return cached || Response.error();
  }
}

// Leaflet from the CDN. A plain <script>/<link> request is "no-cors", which gives an opaque response
// whose status can't be read - caching that could pin a failed load (a CDN 5xx) forever. So it's
// re-requested with CORS (jsDelivr allows it), and only a genuinely OK response is kept.
async function cdnCacheFirst(request) {
  const cache = await caches.open(CDN_CACHE);
  const hit = await cache.match(request.url);
  if (hit) return hit;
  try {
    const response = await fetch(request.url, { mode: 'cors', credentials: 'omit' });
    if (response.ok) cache.put(request.url, response.clone());
    return response;
  } catch (err) {
    return fetch(request); // CORS attempt failed - let the browser do its normal thing
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    if (isShellRequest(request, url)) event.respondWith(networkFirst(request));
    return; // everything else (API, data) goes straight to the network
  }

  if (url.hostname === 'cdn.jsdelivr.net' && url.pathname.startsWith('/npm/leaflet@')) {
    event.respondWith(cdnCacheFirst(request));
  }
});
