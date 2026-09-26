#!/usr/bin/env node
/**
 * plane-sim - fly a fake aircraft with WASD that shows up live on the actual radar site, for
 * everyone currently viewing it. Personal/admin tool - not linked from the radar app itself.
 *
 * How it fits together: cors-proxy/server.js already has a "simulate" feature (see the comment
 * block above SIMULATE_KEY in server.js) that splices fake aircraft into every point-lookup
 * response server-side, gated by a shared SIMULATE_KEY. This is a small standalone server that:
 *   - serves a page with a compass/speed readout and WASD instructions
 *   - keeps the authoritative flight state (lat/lon/alt/gs/track) IN THIS PROCESS, not in the
 *     browser, and updates it by real elapsed time each time the browser reports which keys are
 *     currently held
 *   - periodically POSTs the current state to cors-proxy's /api/simulate under one fixed hex, so
 *     it appears - and moves - on the live radar for every viewer, not just you
 *
 * The SIMULATE_KEY itself never reaches the browser: it's resolved server-side (same order as
 * deploy/simulate.js - env var, ~/.radar-simulate-key file, or the radar.service systemd unit)
 * and used only in this process's own outgoing requests. That matters here specifically because,
 * unlike pi-tools, a leaked SIMULATE_KEY would let anyone reach your PUBLIC internet-facing site
 * (not just your LAN) and inject aircraft onto it - so keep this page itself LAN-only regardless.
 *
 * Run:
 *   node plane-sim/server.js
 *   PORT=1113 PROXY_URL=http://localhost:10004 node plane-sim/server.js
 *
 * Needs cors-proxy's own SIMULATE_KEY to already be set (see the comment above SIMULATE_KEY in
 * cors-proxy/server.js for how to generate and set one) - if it isn't, this refuses to start and
 * says so, since without it every POST would just 404 against the proxy.
 */
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { URL } = require('url');

const PORT = process.env.PORT || 1113;
const PROXY_URL = process.env.PROXY_URL || 'http://localhost:10004';
const HEX = 'SIMWASD1';
const PUSH_INTERVAL_MS = 800;       // how often we tell cors-proxy about the new position
const SIM_TTL_SECONDS = 15;         // expires this fast server-side if we ever stop pushing
const TICK_MS = 100;                // local physics resolution
const MAX_GS = 500;                 // knots
const MIN_GS = 0;
const ACCEL_PER_TICK = 4;           // knots per 100ms held
const TURN_PER_TICK = 2.5;          // degrees per 100ms held
const CLIMB_PER_TICK = 60;          // feet per 100ms held
const MAX_ALT = 45000;
const MIN_ALT = 0;
const DEFAULT_LAT = 52.9529;        // same default as cors-proxy itself
const DEFAULT_LON = -0.9547;
const INDEX_HTML_PATH = path.join(__dirname, 'index.html');

function keyFromSystemd() {
  const show = (prop) => {
    try {
      return execFileSync('systemctl', ['show', 'radar.service', '-p', prop, '--value'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch { return ''; }
  };
  const fromEnv = /SIMULATE_KEY=([^\s"']+)/.exec(show('Environment'));
  if (fromEnv) return fromEnv[1];
  for (const m of show('EnvironmentFiles').matchAll(/(\/[^\s()]+)/g)) {
    try {
      const hit = /^\s*SIMULATE_KEY=["']?([^\s"']+)/m.exec(fs.readFileSync(m[1], 'utf8'));
      if (hit) return hit[1];
    } catch { /* unreadable - try the next one */ }
  }
  return null;
}

function findKey() {
  if (process.env.SIMULATE_KEY) return process.env.SIMULATE_KEY;
  try {
    const k = fs.readFileSync(path.join(os.homedir(), '.radar-simulate-key'), 'utf8').trim();
    if (k) return k;
  } catch { /* no key file */ }
  return keyFromSystemd();
}

const SIMULATE_KEY = findKey();
if (!SIMULATE_KEY) {
  console.error(
    'ERROR: no SIMULATE_KEY found (checked $SIMULATE_KEY, ~/.radar-simulate-key, and the ' +
    "radar.service unit). Set one on cors-proxy first - see the comment above SIMULATE_KEY in " +
    'cors-proxy/server.js - then restart both it and this.'
  );
  process.exit(1);
}

// --- Flight state, owned by this process -----------------------------------------------------
let state = {
  flying: false,
  lat: DEFAULT_LAT,
  lon: DEFAULT_LON,
  alt: 10000,
  gs: 0,
  track: 0,
};
let heldKeys = { w: false, a: false, s: false, d: false, up: false, down: false };
let lastPushedAt = 0;
let lastError = null;

function tick(dtMs) {
  if (!state.flying) return;
  const steps = dtMs / 100; // scale the per-100ms constants to whatever dt actually elapsed
  if (heldKeys.w) state.gs = Math.min(MAX_GS, state.gs + ACCEL_PER_TICK * steps);
  if (heldKeys.s) state.gs = Math.max(MIN_GS, state.gs - ACCEL_PER_TICK * steps);
  if (heldKeys.a) state.track = (state.track - TURN_PER_TICK * steps + 360) % 360;
  if (heldKeys.d) state.track = (state.track + TURN_PER_TICK * steps) % 360;
  if (heldKeys.up) state.alt = Math.min(MAX_ALT, state.alt + CLIMB_PER_TICK * steps);
  if (heldKeys.down) state.alt = Math.max(MIN_ALT, state.alt - CLIMB_PER_TICK * steps);

  if (state.gs > 0) {
    const distanceNm = state.gs * (dtMs / 3600000);
    const trackRad = (state.track * Math.PI) / 180;
    const latRad = (state.lat * Math.PI) / 180;
    state.lat += (distanceNm / 60) * Math.cos(trackRad);
    state.lon += (distanceNm / 60) * Math.sin(trackRad) / Math.max(0.01, Math.cos(latRad));
  }
}

function pushToProxy() {
  if (!state.flying) return;
  const body = JSON.stringify({
    hex: HEX,
    flight: 'WASD1   ',
    lat: state.lat,
    lon: state.lon,
    alt_baro: Math.round(state.alt),
    gs: Math.round(state.gs),
    track: Math.round(state.track),
    squawk: '1200',
    t: 'F16',
    category: 'A5',
    ttlSeconds: SIM_TTL_SECONDS,
  });
  const target = new URL('/api/simulate', PROXY_URL);
  const mod = target.protocol === 'https:' ? https : http;
  const req = mod.request(target, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-Simulate-Key': SIMULATE_KEY },
  }, (res) => {
    if (res.statusCode !== 200) lastError = `proxy returned ${res.statusCode}`;
    else lastError = null;
    res.resume();
  });
  req.on('error', (err) => { lastError = err.message; });
  req.write(body);
  req.end();
}

function clearFromProxy() {
  const target = new URL('/api/simulate', PROXY_URL);
  target.searchParams.set('hex', HEX);
  const mod = target.protocol === 'https:' ? https : http;
  const req = mod.request(target, { method: 'DELETE', headers: { 'X-Simulate-Key': SIMULATE_KEY } }, (res) => res.resume());
  req.on('error', () => {}); // best-effort - it'll expire on its own via SIM_TTL_SECONDS anyway
  req.end();
}

let lastTickAt = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = now - lastTickAt;
  lastTickAt = now;
  tick(dt);
  if (state.flying && now - lastPushedAt >= PUSH_INTERVAL_MS) {
    lastPushedAt = now;
    pushToProxy();
  }
}, TICK_MS);

// --- HTTP -------------------------------------------------------------------------------------
function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 10000) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(INDEX_HTML_PATH, 'utf8'));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/state') {
      sendJson(res, 200, { ...state, lastError });
      return;
    }

    // Client posts which keys are CURRENTLY held (not individual keydown/keyup events) every
    // ~100ms while the tab is open - simplest way to stay correct even if a message is dropped.
    if (req.method === 'POST' && url.pathname === '/api/keys') {
      const body = JSON.parse((await readBody(req)) || '{}');
      for (const k of Object.keys(heldKeys)) heldKeys[k] = !!body[k];
      sendJson(res, 200, { ...state, lastError });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/start') {
      const body = JSON.parse((await readBody(req)) || '{}');
      state.lat = Number.isFinite(body.lat) ? body.lat : DEFAULT_LAT;
      state.lon = Number.isFinite(body.lon) ? body.lon : DEFAULT_LON;
      state.alt = 10000;
      state.gs = 150;
      state.track = 0;
      state.flying = true;
      lastTickAt = Date.now();
      pushToProxy();
      sendJson(res, 200, { ...state, lastError });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/stop') {
      state.flying = false;
      heldKeys = { w: false, a: false, s: false, d: false, up: false, down: false };
      clearFromProxy();
      sendJson(res, 200, { ...state, lastError });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`plane-sim listening on 0.0.0.0:${PORT} (hex ${HEX}, target ${PROXY_URL})`);
  console.log('SIMULATE_KEY found - ready. LAN-only, please: this can put a fake aircraft on the live public site.');
});

process.on('SIGINT', () => { clearFromProxy(); process.exit(0); });
process.on('SIGTERM', () => { clearFromProxy(); process.exit(0); });
