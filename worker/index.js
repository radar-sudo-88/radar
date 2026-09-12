// Cloudflare Worker: adsb.lol CORS proxy for radar-sudo-88.github.io
//
// api.adsb.lol does not send Access-Control-Allow-Origin for browser requests,
// so this radar page (a static GitHub Pages site) can't read its responses
// directly. This worker forwards the one request shape the page needs to
// adsb.lol and adds the header back on the way out.
//
// Deploy (no CLI/Mac needed):
//   1. https://dash.cloudflare.com -> Workers & Pages -> Create -> Create Worker
//   2. Give it a name, click "Deploy" to get a placeholder online, then "Edit code"
//   3. Replace everything in the editor with this file's contents, click "Deploy"
//   4. Copy the resulting https://<name>.<subdomain>.workers.dev URL
//   5. Paste it into WORKER_URL near the top of index.html's fetchLiveFlights()

const ALLOWED_ORIGIN = 'https://radar-sudo-88.github.io';
const UPSTREAM = 'https://api.adsb.lol';
// Cache each unique point query for a couple of seconds at the edge, so
// multiple tabs/viewers polling the same location don't each cost a fresh
// hit against adsb.lol's rate limit.
const CACHE_SECONDS = 2;

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept',
    'Vary': 'Origin',
  };
}

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin');
    const allowOrigin = origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(allowOrigin) });
    }
    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405, headers: corsHeaders(allowOrigin) });
    }

    const url = new URL(request.url);
    // Only ever forward the exact /v2/point/<lat>/<lon>/<radius> shape the
    // radar page needs - this worker is intentionally not a general-purpose
    // open proxy, so it can't be repurposed to fetch arbitrary URLs.
    const match = url.pathname.match(/^\/v2\/point\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
    if (!match) {
      return new Response('Not found', { status: 404, headers: corsHeaders(allowOrigin) });
    }

    const cache = caches.default;
    const cacheKey = new Request(url.toString(), request);
    const cached = await cache.match(cacheKey);
    if (cached) {
      const response = new Response(cached.body, cached);
      Object.entries(corsHeaders(allowOrigin)).forEach(([k, v]) => response.headers.set(k, v));
      return response;
    }

    const upstreamUrl = `${UPSTREAM}/v2/point/${match[1]}/${match[2]}/${match[3]}`;
    const upstreamResponse = await fetch(upstreamUrl, {
      headers: { Accept: 'application/json' },
      cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true },
    });

    const response = new Response(upstreamResponse.body, upstreamResponse);
    Object.entries(corsHeaders(allowOrigin)).forEach(([k, v]) => response.headers.set(k, v));
    response.headers.set('Cache-Control', `public, max-age=${CACHE_SECONDS}`);

    if (upstreamResponse.ok) {
      // Clone before caching - a Response body can only be read once.
      await cache.put(cacheKey, response.clone());
    }

    return response;
  },
};
