#!/usr/bin/env node
'use strict';
/*
 * simulate.js - inject fake aircraft into the radar (wraps the server's /api/simulate endpoint).
 * Run it on the Pi. No npm packages, Node 18+.
 *
 *   node deploy/simulate.js                       one fake 7700 emergency (same as "emergency")
 *   node deploy/simulate.js emergency             squawk 7700
 *   node deploy/simulate.js hijack                squawk 7500
 *   node deploy/simulate.js radiofail             squawk 7600
 *   node deploy/simulate.js qra                   squawk 7777 (Quick Reaction Alert intercept)
 *   node deploy/simulate.js military              military jet (tests the proximity chirp)
 *   node deploy/simulate.js airliner              ordinary airliner, no alert
 *   node deploy/simulate.js list                  show what's currently injected
 *   node deploy/simulate.js clear [hex]           remove everything (or just one hex)
 *
 * Options (after the preset):
 *   --postcode <UK postcode> where to put it, looked up via postcodes.io (same as the radar page).
 *                            Works with or without the space, quoted or not: --postcode "NG1 1AA"
 *   --lat <n> --lon <n>      or give coordinates directly (win over --postcode). With neither, it
 *                            lands at the server default, central England - set one of these to
 *                            somewhere inside YOUR radar circle
 *   --alt <ft>  --gs <kt>  --track <deg>
 *   --flight <callsign>  --hex <hex>  --squawk <code>  --type <ICAO type>  --category <A0-A7>
 *   --ttl <seconds>          how long it stays (default 90, server caps at 600)
 *   --count <n>              inject n of them, spread out a little
 *   --url <base>             default http://localhost:$PORT (PORT default 10004)
 *   --key <key>              simulate key (see below)
 *
 * The key (server's SIMULATE_KEY) is taken from, in order: --key, $SIMULATE_KEY,
 * ~/.radar-simulate-key, then the radar.service unit's Environment/EnvironmentFile.
 * If the server has no SIMULATE_KEY set, the endpoint 404s.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PRESETS = {
  emergency: { squawk: '7700', flight: 'TESTEMG ', t: 'B738', category: 'A3' },
  hijack:    { squawk: '7500', flight: 'TESTHJK ', t: 'B738', category: 'A3' },
  radiofail: { squawk: '7600', flight: 'TESTCOM ', t: 'B738', category: 'A3' },
  qra:       { squawk: '7777', flight: 'TESTQRA ', t: 'EUFI', category: 'A5' },
  military:  { squawk: '4321', flight: 'TESTMIL ', t: 'F35',  category: 'A5' },
  airliner:  { squawk: '2000', flight: 'TESTAIR ', t: 'B738', category: 'A3' },
};
const ALIASES = { '7700': 'emergency', '7500': 'hijack', '7600': 'radiofail', '7777': 'qra', mil: 'military' };

const DEFAULT_LAT = 52.9529; // same as server.js's default
const DEFAULT_LON = -0.9547;

const NUMERIC = ['lat', 'lon', 'alt', 'gs', 'track', 'ttl', 'count'];
const STRING = ['flight', 'hex', 'squawk', 'type', 'category', 'url', 'key', 'postcode'];

function die(msg) { console.error(`ERROR: ${msg}`); process.exit(1); }

function parseArgs(argv) {
  const opts = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { opts.help = true; continue; }
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const [rawName, inline] = a.slice(2).split(/=(.*)/s);
    const name = rawName.toLowerCase();
    if (!NUMERIC.includes(name) && !STRING.includes(name)) die(`unknown option --${name} (try --help)`);
    let val = inline !== undefined ? inline : argv[++i];
    if (val === undefined) die(`--${name} needs a value`);
    // Unquoted "--postcode NG1 1AA" arrives as two args - glue the inward code back on.
    if (name === 'postcode' && /^[a-z0-9]{2,4}$/i.test(val) && /^\d[a-z]{2}$/i.test(argv[i + 1] || '')) val += argv[++i];
    if (NUMERIC.includes(name)) {
      const n = Number(val);
      if (!Number.isFinite(n)) die(`--${name} must be a number, got "${val}"`);
      opts[name] = n;
    } else {
      opts[name] = val;
    }
  }
  return { opts, pos };
}

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
    } catch { /* unreadable (root-only) - try the next one */ }
  }
  return null;
}

function findKey(opts) {
  if (opts.key) return opts.key;
  if (process.env.SIMULATE_KEY) return process.env.SIMULATE_KEY;
  try {
    const k = fs.readFileSync(path.join(os.homedir(), '.radar-simulate-key'), 'utf8').trim();
    if (k) return k;
  } catch { /* no key file */ }
  return keyFromSystemd();
}

// Same normalisation and lookup as app.js (normalizePostcode/geocodePostcode).
async function geocodePostcode(raw) {
  const compact = raw.replace(/[^a-z0-9]/gi, '').toUpperCase();
  if (compact.length < 5 || compact.length > 7) die(`"${raw}" doesn't look like a UK postcode`);
  const postcode = `${compact.slice(0, -3)} ${compact.slice(-3)}`;
  let res;
  try {
    res = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(postcode)}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    die(`postcode lookup failed (${(err.cause && err.cause.message) || err.message}) - is the Pi online? Use --lat/--lon instead`);
  }
  if (res.status === 404) die(`postcodes.io doesn't know "${postcode}"`);
  if (!res.ok) die(`postcode lookup failed: HTTP ${res.status}`);
  const result = (await res.json()).result;
  if (!result || !Number.isFinite(result.latitude) || !Number.isFinite(result.longitude)) die(`no coordinates for "${postcode}"`);
  return { postcode, lat: result.latitude, lon: result.longitude };
}

async function call(base, key, method, query, body) {
  const url = new URL('/api/simulate', base);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { 'X-Simulate-Key': key, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    const code = err.cause && err.cause.code;
    if (code === 'ECONNREFUSED') die(`nothing listening at ${base} - is it running? (systemctl status radar.service)`);
    die(`request to ${base} failed: ${(err.cause && err.cause.message) || err.message}`);
  }
  const text = await res.text();
  if (res.status === 404 && !/^\s*\{/.test(text)) die('404 - the server has no SIMULATE_KEY set (endpoint is disabled). Set it on radar.service and restart.');
  if (res.status === 401) die('401 - wrong key');
  let data;
  try { data = JSON.parse(text); } catch { die(`HTTP ${res.status}: ${text.slice(0, 200)}`); }
  if (!res.ok) die(`HTTP ${res.status}: ${data.error || text.slice(0, 200)}`);
  return data;
}

function show(ac) {
  const ttl = ac.ttlSeconds ?? ac.expiresInSeconds;
  return `${ac.hex}  ${String(ac.flight).trim() || '-'}  sq ${ac.squawk}  ${ac.t}  ${ac.alt_baro}ft ${ac.gs}kt trk ${ac.track}  ` +
    `(${Number(ac.lat).toFixed(4)}, ${Number(ac.lon).toFixed(4)})  ttl ${ttl}s`;
}

async function main() {
  const { opts, pos } = parseArgs(process.argv.slice(2));
  if (opts.help) {
    const src = fs.readFileSync(__filename, 'utf8');
    console.log(src.slice(src.indexOf('/*') + 3, src.indexOf('*/')).replace(/^ \* ?/gm, '').trim());
    return;
  }

  const cmd = (pos[0] || 'emergency').toLowerCase();
  const base = opts.url || `http://localhost:${process.env.PORT || 10004}`;
  const key = findKey(opts);
  if (!key) die('no simulate key found. Pass --key, set $SIMULATE_KEY, or put it in ~/.radar-simulate-key');

  if (cmd === 'list') {
    const { active } = await call(base, key, 'GET');
    if (!active.length) return console.log('nothing injected');
    active.forEach((ac) => console.log(show(ac)));
    return;
  }

  if (cmd === 'clear') {
    const hex = pos[1] || opts.hex;
    const data = await call(base, key, 'DELETE', hex ? { hex } : {});
    return console.log(`cleared${hex ? ` ${hex.toUpperCase()}` : ''} - ${data.active} still active`);
  }

  const presetName = PRESETS[cmd] ? cmd : ALIASES[cmd];
  if (!presetName) die(`unknown command "${cmd}" (emergency hijack radiofail qra military airliner list clear)`);
  const preset = PRESETS[presetName];

  if (opts.postcode) {
    const pc = await geocodePostcode(opts.postcode);
    console.log(`${pc.postcode} -> ${pc.lat.toFixed(4)}, ${pc.lon.toFixed(4)}`);
    if (opts.lat == null) opts.lat = pc.lat;
    if (opts.lon == null) opts.lon = pc.lon;
  }

  const count = Math.max(1, Math.floor(opts.count || 1));
  if (count > 50) die('--count max is 50');
  const aircraft = [];
  for (let i = 0; i < count; i++) {
    const ac = {
      flight: opts.flight != null ? opts.flight : preset.flight,
      squawk: opts.squawk != null ? opts.squawk : preset.squawk,
      t: opts.type != null ? opts.type : preset.t,
      category: opts.category != null ? opts.category : preset.category,
    };
    if (opts.hex && count === 1) ac.hex = opts.hex;
    if (opts.alt != null) ac.alt_baro = opts.alt;
    if (opts.gs != null) ac.gs = opts.gs;
    if (opts.track != null) ac.track = opts.track;
    if (opts.ttl != null) ac.ttlSeconds = opts.ttl;
    // Server falls back to its own default (central England) for a coordinate not given; for
    // --count > 1 spread them out around it so they don't stack on one point.
    const jitter = () => (count > 1 ? (Math.random() - 0.5) * 0.1 : 0);
    if (opts.lat != null || count > 1) ac.lat = (opts.lat != null ? opts.lat : DEFAULT_LAT) + jitter();
    if (opts.lon != null || count > 1) ac.lon = (opts.lon != null ? opts.lon : DEFAULT_LON) + jitter();
    if (count > 1 && opts.flight != null) ac.flight = `${opts.flight.trim()}${i + 1}`.padEnd(8);
    aircraft.push(ac);
  }

  const data = await call(base, key, 'POST', {}, { aircraft });
  data.created.forEach((ac) => console.log(show(ac)));
}

main().catch((err) => die(err.message));
