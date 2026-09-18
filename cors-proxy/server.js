/**
 * ADS-B CORS proxy for radar-sudo-88.github.io — Node.js equivalent of the
 * Cloudflare Worker, for hosting on Wispbyte (a plain long-running Node
 * process rather than an edge/isolate runtime).
 *
 * Forwards TWO distinct upstream calls that index.html makes and can't do
 * directly from the browser due to missing CORS headers on the real APIs:
 *
 *   1. GET  /v2/point/<lat>/<lon>/<radius>
 *      -> adsb.fi (translated to its v3/lat/.../lon/.../dist/... shape).
 *      adsb.lol was tried first here too but 403s datacenter/cloud IPs -
 *      see the comment on ROUTESET_PATH below, since this proxy's own
 *      outbound requests are exactly that kind of IP.
 *
 *   2. POST /api/0/routeset
 *      -> adsb.lol, forwarded as-is (adsb.lol has no adsb.fi equivalent for
 *      this endpoint). IMPORTANT CAVEAT: adsb.lol is documented to 403
 *      requests from datacenter/cloud IP ranges, which is exactly what this
 *      server's outbound IP (Wispbyte, like Cloudflare Workers before it)
 *      looks like to it. That's *why* point-lookups were moved to adsb.fi
 *      in the first place. This route may simply get 403'd by adsb.lol in
 *      practice - check the console logs after deploying to confirm whether
 *      it actually works from this host before relying on it. If it does
 *      get 403'd, the frontend's existing fallback chain (adsbdb -> hexdb)
 *      still covers routes, just without adsb.lol's data.
 *
 * Both routes:
 *   - Only forward the exact path/method shape the frontend actually needs -
 *     this is intentionally not a general-purpose open proxy.
 *   - Lock CORS to ALLOWED_ORIGIN, reflected back only when the request's
 *     Origin actually matches it.
 *
 * Point-lookup caching (adsb.fi, rate-limited to 1 req/sec/IP, which counts
 * 4xx/429 toward the limit too): successes cached briefly (CACHE_SECONDS) to
 * spread load across pollers/tabs, failures cached longer
 * (ERROR_CACHE_SECONDS) so a temporary restriction gets a chance to clear.
 * Routeset lookups are NOT cached - each POST body is a different aircraft
 * batch, so there's nothing to key a cache on.
 *
 * Caching note: Cloudflare's `caches.default` is a distributed edge cache;
 * here it's a plain in-memory Map scoped to this one Node process, which is
 * actually a fine (if not better) fit since Wispbyte runs a single instance
 * rather than routing pollers across many edge locations.
 *
 * Logging: per-upstream stats (adsb.fi, adsb.lol) are tracked in memory -
 * success/failure counts, failure reasons (timeout, empty_body,
 * malformed_json, status_403, etc.), consecutive-failure/success streaks,
 * and average response time. Two things get logged automatically without
 * having to scroll through routine per-request lines:
 *   - The moment a streak *starts* or *breaks* (first failure after N
 *     successes, or recovery after N failures) - this is the "was it working
 *     before?" question, answered inline instead of requiring log archaeology.
 *   - A summary line every 5 minutes for each upstream, so the current state
 *     is visible even if nothing has changed recently.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// --- Static file serving -----------------------------------------------
// This proxy now also serves the site itself (index.html, 404.html, assets)
// from the repo root, one directory up from this file. Reason: the page is
// tunnelled (cloudflared) to a hostname that only forwards ONE local port.
// If the static site and this proxy ran on two different ports, the tunnel
// would only expose one of them - the other would be unreachable from
// wherever the tunnel is being viewed. Serving both from this single
// process/port means the browser always calls the proxy on the exact same
// origin it loaded the page from (see WORKER_URL = '' in index.html), so
// nothing needs to track hostnames or ports across localhost / a throwaway
// trycloudflare.com tunnel / the eventual aero-sentry.co.uk domain.
const STATIC_ROOT = path.join(__dirname, '..');
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, pathname) {
  // Strip query/hash (already done by URL parsing upstream) and prevent
  // path traversal (e.g. "/../server.js") by resolving and checking the
  // result is still inside STATIC_ROOT.
  const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  let filePath = path.join(STATIC_ROOT, safePath === '/' ? 'index.html' : safePath);
  if (!filePath.startsWith(STATIC_ROOT)) {
    send(res, 403, { 'Content-Type': 'text/plain' }, 'Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // Unknown path - serve 404.html if present, else a plain 404.
      fs.readFile(path.join(STATIC_ROOT, '404.html'), (err2, notFoundData) => {
        if (err2) {
          send(res, 404, { 'Content-Type': 'text/plain' }, 'Not found');
        } else {
          send(res, 404, { 'Content-Type': 'text/html; charset=utf-8' }, notFoundData);
        }
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    send(res, 200, { 'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream' }, data);
  });
}

// --- Config -----------------------------------------------------------
const PORT = process.env.PORT || 10004;
// Comma-separated list, e.g. ALLOWED_ORIGINS="https://a.com,http://localhost:8080".
// Falls back to a sensible default set covering the GitHub Pages deploy, the
// Pi serving it locally, a throwaway trycloudflare.com tunnel (subdomain
// changes every restart, so matched by pattern below), and aero-sentry.co.uk
// once its nameservers finish propagating.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
  : [
      'https://radar-sudo-88.github.io',
      'https://aero-sentry.co.uk',
      'https://www.aero-sentry.co.uk',
      'http://localhost:8080',
    ]);
const ALLOWED_ORIGIN_PATTERNS = [/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/];
function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  return ALLOWED_ORIGIN_PATTERNS.some((pattern) => pattern.test(origin));
}
const ADSBFI_UPSTREAM = 'https://opendata.adsb.fi';
const ADSBLOL_ROUTESET_UPSTREAM = 'https://api.adsb.lol/api/0/routeset';
const CACHE_SECONDS = 2;
const ERROR_CACHE_SECONDS = 8;
// Cap on the request body we'll buffer for the routeset POST, so a
// malformed/huge request can't be used to exhaust memory.
const MAX_BODY_BYTES = 256 * 1024;

const POINT_PATH_RE = /^\/v2\/point\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/;
const ROUTESET_PATH = '/api/0/routeset';

// path -> { body, status, contentType, expiresAt } — point-lookup cache only.
const cache = new Map();

// --- Stats / logging ---------------------------------------------------
// Answers exactly the kind of question that's come up repeatedly in
// practice ("was this working before and just stopped?", "is this a blip or
// sustained?") without having to eyeball a wall of near-identical log lines.
// Tracked per upstream (adsbFi, adsbLol) since they fail independently and
// for different reasons.
function makeEndpointStats() {
  return {
    total: 0,
    success: 0,
    failure: 0,
    failuresByReason: {}, // e.g. { timeout: 3, empty_body: 12, status_403: 1, ... }
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastFailureReason: null,
    totalDurationMs: 0, // for computing an average lazily
  };
}
const stats = {
  adsbFi: makeEndpointStats(),
  adsbLol: makeEndpointStats(),
};

function recordResult(endpoint, { ok, reason, durationMs }) {
  const s = stats[endpoint];
  s.total += 1;
  s.totalDurationMs += durationMs;

  if (ok) {
    s.success += 1;
    // A transition from failing to working is exactly the "it's back" moment
    // that's otherwise easy to miss scrolling through logs - call it out.
    if (s.consecutiveFailures > 0) {
      console.log(`[STATS] ${endpoint} RECOVERED after ${s.consecutiveFailures} consecutive failure(s) (last reason: ${s.lastFailureReason})`);
    }
    s.consecutiveFailures = 0;
    s.consecutiveSuccesses += 1;
    s.lastSuccessAt = new Date().toISOString();
  } else {
    s.failure += 1;
    s.failuresByReason[reason] = (s.failuresByReason[reason] || 0) + 1;
    s.consecutiveSuccesses = 0;
    s.consecutiveFailures += 1;
    s.lastFailureAt = new Date().toISOString();
    s.lastFailureReason = reason;
    // Same idea in reverse - the FIRST failure after a run of successes is
    // the moment something actually changed, worth a distinct log line
    // rather than blending into a long run of repeats.
    if (s.consecutiveFailures === 1) {
      console.warn(`[STATS] ${endpoint} started FAILING (reason: ${reason}) after ${s.consecutiveSuccesses} consecutive success(es)`);
    }
  }
}

function formatStatsLine(name, s) {
  const successRate = s.total ? ((s.success / s.total) * 100).toFixed(1) : '0.0';
  const avgMs = s.total ? Math.round(s.totalDurationMs / s.total) : 0;
  const reasons = Object.entries(s.failuresByReason).map(([r, n]) => `${r}=${n}`).join(', ') || 'none';
  const streak = s.consecutiveFailures > 0
    ? `${s.consecutiveFailures} failing in a row`
    : s.consecutiveSuccesses > 0
      ? `${s.consecutiveSuccesses} succeeding in a row`
      : 'no requests yet';
  return `  ${name}: ${s.total} req, ${successRate}% success, avg ${avgMs}ms, currently ${streak} | failure reasons: ${reasons} | last success: ${s.lastSuccessAt || 'never'} | last failure: ${s.lastFailureAt || 'never'}`;
}

// Periodic summary so the state of both upstreams is visible without
// scrolling - e.g. spotting "adsb.lol has been 0% for the last 15 minutes"
// at a glance instead of reading hundreds of repeated per-request lines.
setInterval(() => {
  if (stats.adsbFi.total === 0 && stats.adsbLol.total === 0) return; // nothing to report yet
  console.log(`[STATS SUMMARY] ${new Date().toISOString()}`);
  console.log(formatStatsLine('adsb.fi  (point-lookup)', stats.adsbFi));
  console.log(formatStatsLine('adsb.lol (routeset)   ', stats.adsbLol));
}, 5 * 60 * 1000).unref();

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept, Content-Type',
    'Vary': 'Origin',
  };
}

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

function readRequestBody(req, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('Request body read timed out'));
      req.destroy();
    }, timeoutMs);

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };

    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        finish(reject, new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(resolve, Buffer.concat(chunks)));
    req.on('error', (err) => finish(reject, err));
    // Covers a client-side connection drop that doesn't cleanly fire 'error' -
    // without this, an abandoned upload can otherwise hang here indefinitely.
    req.on('close', () => finish(reject, new Error('Request closed before body was fully read')));
  });
}

async function handlePointLookup(req, res, url, cors) {
  const match = url.pathname.match(POINT_PATH_RE);
  if (!match) {
    send(res, 404, { ...cors, 'Content-Type': 'text/plain' }, 'Not found');
    return;
  }

  const cacheKey = url.pathname;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    send(
      res,
      cached.status,
      {
        ...cors,
        'Content-Type': cached.contentType,
        // Deliberately no Cache-Control here: this TTL is for our own internal
        // Map, to shield adsb.fi from repeated pollers. Advertising it to the
        // client (or anything proxying in front of this server) risks a
        // downstream cache keying on the URL alone and ignoring Vary: Origin,
        // which would serve a stale response - including a stale/missing CORS
        // header - to a different context than the one that generated it.
      },
      cached.body
    );
    return;
  }

  const [, lat, lon, radius] = match;
  const upstreamUrl = `${ADSBFI_UPSTREAM}/api/v3/lat/${lat}/lon/${lon}/dist/${radius}`;
  const startedAt = Date.now();

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    let upstreamResponse;
    try {
      upstreamResponse = await fetch(upstreamUrl, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const body = await upstreamResponse.text();
    const contentType = upstreamResponse.headers.get('content-type') || 'application/json';
    const durationMs = Date.now() - startedAt;

    recordResult('adsbFi', {
      ok: upstreamResponse.ok,
      reason: upstreamResponse.ok ? null : `status_${upstreamResponse.status}`,
      durationMs,
    });

    const ttlSeconds = upstreamResponse.ok ? CACHE_SECONDS : ERROR_CACHE_SECONDS;
    cache.set(cacheKey, {
      body,
      status: upstreamResponse.status,
      contentType,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });

    send(res, upstreamResponse.status, { ...cors, 'Content-Type': contentType }, body);
  } catch (err) {
    const reason = err.name === 'AbortError' ? 'timeout' : 'network_error';
    recordResult('adsbFi', { ok: false, reason, durationMs: Date.now() - startedAt });
    console.error(`adsb.fi upstream fetch failed (${reason}):`, err);
    send(res, 502, { ...cors, 'Content-Type': 'application/json' }, JSON.stringify({ error: 'Upstream fetch failed' }));
  }
}

async function handleRouteset(req, res, cors) {
  let bodyBuffer;
  try {
    bodyBuffer = await readRequestBody(req);
  } catch (err) {
    send(res, 413, { ...cors, 'Content-Type': 'application/json' }, JSON.stringify({ error: 'Request body too large' }));
    return;
  }

  const startedAt = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    let upstreamResponse;
    try {
      upstreamResponse = await fetch(ADSBLOL_ROUTESET_UPSTREAM, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          // Node's default User-Agent (just "node") is an easy signal for a WAF to
          // flag/silently-block datacenter traffic on. adsb.lol has been observed
          // returning a "successful-looking" 200 with an empty body for every
          // request from this host - spoofing an ordinary browser UA is a cheap
          // thing to try in case that's what's triggering it.
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        },
        body: bodyBuffer,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const body = await upstreamResponse.text();
    const contentType = upstreamResponse.headers.get('content-type') || 'application/json';
    const durationMs = Date.now() - startedAt;

    // 403 here most likely means adsb.lol is rejecting this server's
    // (datacenter) IP - see the top-of-file note. Logged so it's visible in
    // the Wispbyte console rather than only showing up as a silent frontend
    // fallback to adsbdb/hexdb.
    if (upstreamResponse.status === 403) {
      recordResult('adsbLol', { ok: false, reason: 'status_403', durationMs });
      console.warn('adsb.lol routeset returned 403 - likely blocking this host\'s IP as a datacenter range.');
      send(res, 502, { ...cors, 'Content-Type': 'application/json' }, JSON.stringify({ error: 'Upstream rejected request' }));
      return;
    }

    // adsb.lol has occasionally been observed returning a 200 with a
    // truncated/empty body (rather than a clean error status) - passing that
    // through as-is would make the frontend's res.json() throw instead of
    // taking its normal "not ok -> fall back to adsbdb/hexdb" path. Catch
    // that here and turn it into a real error status with a valid JSON body,
    // so the frontend's existing fallback logic handles it the same way it
    // already handles a 403/429/etc.
    if (upstreamResponse.ok) {
      if (!body.trim()) {
        recordResult('adsbLol', { ok: false, reason: 'empty_body', durationMs });
        console.warn(`adsb.lol routeset returned 200 with an empty body - treating as a failure. Response headers: ${JSON.stringify(Object.fromEntries(upstreamResponse.headers))}`);
        send(res, 502, { ...cors, 'Content-Type': 'application/json' }, JSON.stringify({ error: 'Empty upstream response' }));
        return;
      }
      try {
        JSON.parse(body);
      } catch (parseErr) {
        recordResult('adsbLol', { ok: false, reason: 'malformed_json', durationMs });
        console.warn('adsb.lol routeset returned 200 with unparseable JSON - treating as a failure.');
        send(res, 502, { ...cors, 'Content-Type': 'application/json' }, JSON.stringify({ error: 'Malformed upstream response' }));
        return;
      }
      recordResult('adsbLol', { ok: true, reason: null, durationMs });
    } else {
      recordResult('adsbLol', { ok: false, reason: `status_${upstreamResponse.status}`, durationMs });
    }

    send(res, upstreamResponse.status, { ...cors, 'Content-Type': contentType }, body);
  } catch (err) {
    const reason = err.name === 'AbortError' ? 'timeout' : 'network_error';
    recordResult('adsbLol', { ok: false, reason, durationMs: Date.now() - startedAt });
    console.error(`adsb.lol routeset upstream fetch failed (${reason}):`, err);
    send(res, 502, { ...cors, 'Content-Type': 'application/json' }, JSON.stringify({ error: 'Upstream fetch failed' }));
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const origin = req.headers.origin;
    // Reflect the caller's own origin back only if it's on the allowlist -
    // never a blanket wildcard, so this proxy (and its adsb.fi/adsb.lol rate
    // budget) can't be embedded by arbitrary third-party sites.
    const allowOrigin = isAllowedOrigin(origin) ? origin : ALLOWED_ORIGINS[0];
    const cors = corsHeaders(allowOrigin);
    // Temporary debug line - check the Wispbyte console after a request to
    // confirm this process actually set the header, vs. something in front of
    // it stripping it before it reaches the browser. Safe to remove once CORS
    // is confirmed working end-to-end.
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} | Origin: ${origin || '(none)'} | sending ACAO: ${cors['Access-Control-Allow-Origin']}`);

    if (req.method === 'OPTIONS') {
      send(res, 204, cors, null);
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'GET' && POINT_PATH_RE.test(url.pathname)) {
      await handlePointLookup(req, res, url, cors);
      return;
    }

    if (req.method === 'POST' && url.pathname === ROUTESET_PATH) {
      await handleRouteset(req, res, cors);
      return;
    }

    // Anything else GET - serve it as a static file from the repo root
    // (index.html, 404.html, spritesheet assets, etc). CORS headers aren't
    // needed here since these are same-origin page loads, not cross-origin
    // API calls, but including them is harmless.
    if (req.method === 'GET') {
      serveStatic(req, res, url.pathname);
      return;
    }

    send(res, 404, { ...cors, 'Content-Type': 'text/plain' }, 'Not found');
  } catch (err) {
    // Catch-all so a single malformed request (e.g. something that makes
    // `new URL(req.url, ...)` throw) can't become an unhandled rejection -
    // on Node 15+, an unhandled rejection from an http request listener
    // crashes the whole process by default, taking down every other
    // in-flight request with it. Always respond with *something* instead.
    console.error('Unhandled error in request handler:', err);
    try {
      if (!res.headersSent) {
        send(res, 500, { 'Content-Type': 'application/json' }, JSON.stringify({ error: 'Internal error' }));
      }
    } catch (sendErr) {
      // Response already broken (e.g. connection gone) - nothing more to do.
    }
  }
});

// Last-resort safety nets: log and keep running rather than let the process
// die. Without these, any error that isn't caught above - anywhere in the
// process, not just in the request handler - takes the entire server down
// (and everyone's requests with it) until Wispbyte notices and restarts it.
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (server kept running):', err);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection (server kept running):', err);
});

// Periodic sweep so the point-lookup cache doesn't grow unbounded over a
// long uptime - entries expire on their own via expiresAt, this just
// reclaims memory.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
}, 60_000).unref();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`ADS-B CORS proxy listening on 0.0.0.0:${PORT}`);
  console.log(`Allowed origins: ${ALLOWED_ORIGINS.join(', ')} (+ *.trycloudflare.com)`);
  console.log(`Point-lookup upstream: ${ADSBFI_UPSTREAM}`);
  console.log(`Routeset upstream: ${ADSBLOL_ROUTESET_UPSTREAM}`);
});
