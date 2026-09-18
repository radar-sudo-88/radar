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

// Multiple origins now serve this page: the original GitHub Pages deploy,
// the Pi running it locally, a throwaway trycloudflare.com tunnel while
// aero-sentry.co.uk's nameservers propagate, and that domain once it's live.
// Exact matches plus a pattern for the trycloudflare subdomain, which
// changes every time the throwaway tunnel is restarted.
const ALLOWED_ORIGINS = [
  'https://radar-sudo-88.github.io',
  'https://aero-sentry.co.uk',
  'https://www.aero-sentry.co.uk',
  'http://localhost:8080',
];
const ALLOWED_ORIGIN_PATTERNS = [/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/];
const UPSTREAM = 'https://opendata.adsb.fi';
// adsb.fi rate-limits public endpoints to 1 request/second per IP, and counts
// 400/401/403/404/429 responses toward that limit too - so caching here
// matters more than it did against adsb.lol. A couple of seconds keeps
// multiple tabs/viewers off adsb.fi's own rate limit.
const CACHE_SECONDS = 2;
// If adsb.fi itself is erroring/rate-limiting (a temporary IP restriction),
// cache that failure too, briefly - otherwise every poll from every client
// (multiple tabs, phone + desktop) immediately retries adsb.fi and counts as
// another failed request against the same restriction, extending it instead
// of letting it clear. Longer than CACHE_SECONDS on purpose.
const ERROR_CACHE_SECONDS = 8;

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept',
    'Vary': 'Origin',
  };
}

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  return ALLOWED_ORIGIN_PATTERNS.some((pattern) => pattern.test(origin));
}

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin');
    // Reflect the caller's own origin back only if it's on the allowlist -
    // never a blanket '*', so this worker (and its adsb.fi rate budget)
    // can't be embedded by arbitrary third-party sites.
    const allowOrigin = isAllowedOrigin(origin) ? origin : ALLOWED_ORIGINS[0];

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

    // Cache successes briefly to spread load across pollers; cache failures
    // (403/429/etc) for longer, so a rate-limit or temporary restriction gets
    // a chance to clear instead of being continuously re-triggered by every
    // client's next poll.
    const ttl = upstreamResponse.ok ? CACHE_SECONDS : ERROR_CACHE_SECONDS;
    response.headers.set('Cache-Control', `public, max-age=${ttl}`);
    // Clone before caching - a Response body can only be read once.
    await cache.put(cacheKey, response.clone());

    return response;
  },
};
