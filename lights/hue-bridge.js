#!/usr/bin/env node
'use strict';
/*
 * hue-bridge.js - flashes your Philips Hue lights red when the radar sees military traffic.
 *
 * LOCAL ONLY. This is a separate little server that listens on 127.0.0.1 (this Pi, nothing else)
 * on its own port. The Cloudflare tunnel only forwards the radar's port (10004), so this can't be
 * reached from the internet. app.js pings it only when the page is being viewed on localhost.
 *
 * Talks to the Hue bridge over your LAN with the local v2 API. No cloud, no extra npm packages.
 *
 *   node lights/hue-bridge.js pair <bridge-ip>   one-off: press the bridge's link button, then run this
 *   node lights/hue-bridge.js list               show your lights and which of them would flash
 *   node lights/hue-bridge.js test               flash right now (checks the whole chain, ignores cooldown)
 *   node lights/hue-bridge.js serve              run the local server (default; this is what the service runs)
 *
 * The bridge address and app key are stored in ~/.radar-hue.json (mode 600, outside the repo so it
 * can never be committed). HUE_BRIDGE_IP / HUE_APP_KEY env vars override it.
 *
 * Optional env vars:
 *   LIGHTS_PORT       port for this server (default 10005)
 *   PORT              the radar server's port, used to recognise the page's Origin (default 10004)
 *   HUE_LIGHTS        only flash lights whose name contains one of these, comma-separated
 *                     (e.g. "living,hall"). Default: every colour-capable light.
 *   HUE_INCLUDE_OFF   1 = also flash lights that are currently off (they're switched back off afterwards,
 *                     with a brief blip of their normal colour while their old state is written back).
 *                     Default 0: lights you've switched off are left alone.
 *   HUE_MAX_NM        only flash for aircraft this close, in nautical miles (default 35 = every
 *                     radar military alert; set 5 to flash only for the close-in ones)
 *   HUE_FLASHES       number of red flashes (default 3)
 *   HUE_STEP_MS       length of each on / off phase in ms (default 600)
 *   HUE_COOLDOWN_MS   minimum gap between flashes (default 20000)
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_FILE = process.env.HUE_CONFIG || path.join(os.homedir(), '.radar-hue.json');
const LIGHTS_PORT = Number(process.env.LIGHTS_PORT || 10005);
const RADAR_PORT = Number(process.env.PORT || 10004);
const NAME_FILTER = (process.env.HUE_LIGHTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const INCLUDE_OFF = process.env.HUE_INCLUDE_OFF === '1';
const MAX_NM = Number(process.env.HUE_MAX_NM || 35);
const FLASHES = Math.max(1, Number(process.env.HUE_FLASHES || 3));
const STEP_MS = Math.max(150, Number(process.env.HUE_STEP_MS || 600));
const COOLDOWN_MS = Math.max(0, Number(process.env.HUE_COOLDOWN_MS || 20000));

// Only the radar page itself may trigger a flash (browsers always send Origin on cross-site POSTs,
// so this stops some other web page in the Pi's browser from firing it). curl has no Origin.
const ALLOWED_ORIGINS = new Set([
  `http://localhost:${RADAR_PORT}`,
  `http://127.0.0.1:${RADAR_PORT}`,
]);

const RED_XY = { x: 0.675, y: 0.322 }; // deep red, inside the Hue colour gamut
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

// --- config ------------------------------------------------------------------------------------
function readConfigFile() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}

function getConfig() {
  const file = readConfigFile();
  const cfg = {
    bridge: process.env.HUE_BRIDGE_IP || file.bridge,
    key: process.env.HUE_APP_KEY || file.key,
  };
  if (!cfg.bridge || !cfg.key) {
    throw new Error(`Not paired yet. Press the link button on the Hue bridge, then run: node ${process.argv[1]} pair <bridge-ip>`);
  }
  return cfg;
}

// --- Hue bridge HTTP ---------------------------------------------------------------------------
// The bridge has a self-signed certificate, so verification is off. That's the normal way to talk to
// it on your own LAN; the app key is what authenticates you.
function hueRequest(bridge, key, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const [host, port] = bridge.split(':');
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = {};
    if (key) headers['hue-application-key'] = key;
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = https.request(
      { host, port: port ? Number(port) : 443, method, path: urlPath, headers, rejectUnauthorized: false, timeout: 5000 },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch { /* not JSON */ }
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
          else reject(new Error(`Hue ${method} ${urlPath} -> HTTP ${res.statusCode} ${text.slice(0, 200)}`));
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error(`Hue ${method} ${urlPath} timed out`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function fetchLights(cfg) {
  const res = await hueRequest(cfg.bridge, cfg.key, 'GET', '/clip/v2/resource/light');
  return (res && res.data) || [];
}

async function putLight(cfg, id, body) {
  const res = await hueRequest(cfg.bridge, cfg.key, 'PUT', `/clip/v2/resource/light/${id}`, body);
  if (res && res.errors && res.errors.length) log(`warning: light ${id}:`, JSON.stringify(res.errors));
}

// --- choosing lights + saving/restoring their state --------------------------------------------
function lightName(l) { return (l.metadata && l.metadata.name) || l.id; }

function selectLights(all) {
  return all.filter((l) => {
    if (!l.color) return false; // white-only bulbs can't go red
    if (!INCLUDE_OFF && !(l.on && l.on.on)) return false;
    if (NAME_FILTER.length && !NAME_FILTER.some((f) => lightName(l).toLowerCase().includes(f))) return false;
    return true;
  });
}

function snapshot(l) {
  const s = { id: l.id, name: lightName(l), on: !!(l.on && l.on.on) };
  if (l.dimming && l.dimming.brightness != null) s.brightness = l.dimming.brightness;
  if (l.color_temperature && l.color_temperature.mirek_valid && l.color_temperature.mirek != null) {
    s.mirek = l.color_temperature.mirek; // light was in white / colour-temperature mode
  } else if (l.color && l.color.xy) {
    s.xy = l.color.xy; // light was in a colour
  }
  return s;
}

const redBody = () => ({ on: { on: true }, dimming: { brightness: 100 }, color: { xy: RED_XY }, dynamics: { duration: 0 } });
const offBody = () => ({ on: { on: false }, dynamics: { duration: 0 } });

function restoreBody(s) {
  // Always switches on first: for lights that were on this is the real restore; for lights that were
  // off it writes their old colour/brightness back (a light's stored colour is what it comes on
  // with next time). Those get switched off again straight after.
  const body = { on: { on: true }, dynamics: { duration: 400 } };
  if (s.brightness != null) body.dimming = { brightness: s.brightness };
  if (s.mirek != null) body.color_temperature = { mirek: s.mirek };
  else if (s.xy) body.color = { xy: s.xy };
  return body;
}

async function flashLights(cfg) {
  const lights = selectLights(await fetchLights(cfg));
  if (!lights.length) { log('no lights to flash (none matched, or all are off - see HUE_INCLUDE_OFF)'); return 0; }
  const snaps = lights.map(snapshot);

  // The bridge takes roughly 10 light commands a second, so stretch each phase for big setups.
  const phaseMs = Math.max(STEP_MS, snaps.length * 110);
  log(`flashing ${snaps.length} light(s): ${snaps.map((s) => s.name).join(', ')}`);

  try {
    for (let i = 0; i < FLASHES; i++) {
      await Promise.allSettled(snaps.map((s) => putLight(cfg, s.id, redBody())));
      await sleep(phaseMs);
      await Promise.allSettled(snaps.map((s) => putLight(cfg, s.id, offBody())));
      await sleep(phaseMs);
    }
  } finally {
    // Always put things back, even if a command above failed.
    await Promise.allSettled(snaps.map((s) => putLight(cfg, s.id, restoreBody(s))));
    const wereOff = snaps.filter((s) => !s.on);
    if (wereOff.length) {
      await sleep(Math.max(500, wereOff.length * 110));
      await Promise.allSettled(wereOff.map((s) => putLight(cfg, s.id, { on: { on: false } })));
    }
    log('lights restored');
  }
  return snaps.length;
}

// --- commands ----------------------------------------------------------------------------------
async function cmdPair(bridge) {
  if (!bridge) throw new Error(`Usage: node ${process.argv[1]} pair <bridge-ip>`);
  console.log(`Press the round link button on the Hue bridge now. Waiting up to 60 seconds...`);
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const res = await hueRequest(bridge, null, 'POST', '/api', { devicetype: 'radar#pi', generateclientkey: true });
    const first = Array.isArray(res) ? res[0] : null;
    if (first && first.success && first.success.username) {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify({ bridge, key: first.success.username }, null, 2), { mode: 0o600 });
      fs.chmodSync(CONFIG_FILE, 0o600);
      console.log(`Paired. Saved to ${CONFIG_FILE}. Try:  node ${process.argv[1]} list`);
      return;
    }
    if (first && first.error && first.error.type !== 101) throw new Error(`Bridge said: ${first.error.description}`);
    await sleep(2000); // type 101 = link button not pressed yet
  }
  throw new Error('Timed out - the link button was not pressed. Run the command again and press it first.');
}

async function cmdList() {
  const cfg = getConfig();
  const all = await fetchLights(cfg);
  const chosen = new Set(selectLights(all).map((l) => l.id));
  console.log(`${all.length} light(s) on the bridge:\n`);
  for (const l of all) {
    const state = l.on && l.on.on ? 'on ' : 'off';
    const colour = l.color ? 'colour' : 'white ';
    console.log(`  ${chosen.has(l.id) ? 'FLASH' : '  -  '}  ${state}  ${colour}  ${lightName(l)}`);
  }
  console.log(`\nFLASH = will flash on the next alert. Lights that are off are skipped unless HUE_INCLUDE_OFF=1.`);
}

async function cmdTest() {
  const n = await flashLights(getConfig());
  console.log(n ? `Flashed ${n} light(s).` : 'Nothing flashed - see the message above.');
}

function cmdServe() {
  const cfg = getConfig(); // fail early with a clear message if not paired
  let busy = false;
  let lastStart = 0;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const reply = (code, text) => { res.writeHead(code, { 'Content-Type': 'text/plain' }); res.end(text + '\n'); };

    if (req.method === 'GET' && url.pathname === '/health') return reply(200, 'ok');

    if (req.method === 'POST' && url.pathname === '/flash') {
      const origin = req.headers.origin;
      if (origin && !ALLOWED_ORIGINS.has(origin)) { log(`rejected flash from origin ${origin}`); return reply(403, 'forbidden'); }

      const dist = Number(url.searchParams.get('dist'));
      if (Number.isFinite(dist) && dist > MAX_NM) return reply(204, '');
      if (busy || Date.now() - lastStart < COOLDOWN_MS) return reply(202, 'cooling down');

      busy = true;
      lastStart = Date.now();
      reply(202, 'flashing');
      flashLights(cfg)
        .catch((err) => log('flash failed:', err.message))
        .finally(() => { busy = false; });
      return undefined;
    }
    return reply(404, 'not found');
  });

  // 127.0.0.1 only: not reachable from the LAN, let alone the internet.
  server.listen(LIGHTS_PORT, '127.0.0.1', () => {
    log(`hue bridge listening on 127.0.0.1:${LIGHTS_PORT} (max ${MAX_NM} NM, ${FLASHES} flashes, cooldown ${COOLDOWN_MS / 1000}s)`);
  });
}

// --- main --------------------------------------------------------------------------------------
(async () => {
  const [cmd = 'serve', arg] = process.argv.slice(2);
  try {
    if (cmd === 'pair') await cmdPair(arg);
    else if (cmd === 'list') await cmdList();
    else if (cmd === 'test') await cmdTest();
    else if (cmd === 'serve') cmdServe();
    else throw new Error(`Unknown command '${cmd}'. Use: pair <bridge-ip> | list | test | serve`);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
})();
