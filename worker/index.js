// Cloudflare Worker: ADS-B CORS proxy for radar-sudo-88.github.io
//
// Neither adsb.lol nor adsb.fi sends Access-Control-Allow-Origin for browser
// requests, so this radar page (a static GitHub Pages site) can't read their
// responses directly. This worker forwards the request server-side and adds
// the header back on the way out.
//
// Upstream is adsb.fi, not adsb.lol: adsb.lol actively 403s requests from
// datacenter/cloud IP ranges (which is what a Worker's outbound fetch looks
// like to it), while adsb.fi serves them fine - see
// https://github.com/adsbfi/opendata. adsb.fi's endpoint shape differs
// (v3/lat/:lat/lon/:lon/dist/:radius, not v2/point/:lat/:lon/:radius), so
// that's translated below - the public-facing path this worker accepts
// (and what index.html requests) is unchanged.
//
// adsb.fi's terms (see the README above) restrict their open data to
// personal, non-commercial use and ask for attribution + a link to
// https://adsb.fi on any site that uses it.
//
// Deploy (no CLI/Mac needed):
//   1. https://dash.cloudflare.com -> Workers & Pages -> Create -> Create Worker
//   2. Give it a name, click "Deploy" to get a placeholder online, then "Edit code"
//   3. Replace everything in the editor with this file's contents, click "Deploy"
//   4. Copy the resulting https://<name>.<subdomain>.workers.dev URL
//   5. Paste it into WORKER_URL near the top of index.html's fetchLiveFlights()

const ALLOWED_ORIGIN = 'https://radar-sudo-88.github.io';
const UPSTREAM = 'https://opendata.adsb.fi';
// adsb.fi rate-limits public endpoints to 1 request/second per IP, and counts
// 400/401/403/404/429 responses toward that limit too - so caching here
// matters more than it did against adsb.lol. A couple of seconds keeps
// multiple tabs/viewers off adsb.fi's own rate limit.
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

    const upstreamUrl = `${UPSTREAM}/api/v3/lat/${match[1]}/lon/${match[2]}/dist/${match[3]}`;
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
