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
 *   node lights/hue-bridge.js pair <bridge-ip> [profile]   one-off: press the bridge's link button, then
 *                                                          run this. profile defaults to "default" - pair
 *                                                          a second Hue-API bridge (e.g. a diyHue instance)
 *                                                          under its own name, e.g. "pair 192.168.1.55 diyhue"
 *   node lights/hue-bridge.js profiles            list the bridges you've paired
 *   node lights/hue-bridge.js list                show your lights and which of them would flash
 *   node lights/hue-bridge.js test                flash right now (checks the whole chain, ignores cooldown)
 *   node lights/hue-bridge.js serve               run the local server (default; this is what the service
 *                                                  runs - always uses the "default" profile, regardless of
 *                                                  HUE_PROFILE, so a second bridge never gets pulled into
 *                                                  military/emergency alerts by accident)
 *
 * Every command below talks to the "default" paired bridge unless you set HUE_PROFILE=<name> first, e.g.
 *   HUE_PROFILE=diyhue node lights/hue-bridge.js on lamp
 *
 * Manual control (<light> is part of a light's name, e.g. "strip", or "all"; comma-separate
 * several, e.g. "shelf,lamp" - quote it if any of the names contain spaces):
 *   on [light]   |   off [light]   |   toggle [light]
 *   color <light> <colour> [brightness]      colour = red orange yellow green cyan blue purple pink
 *                                            magenta, or a hex code like #ff8800
 *   white <light> [tone] [brightness]        tone = warm neutral cool daylight, a temperature like
 *                                            2700k, or a mirek value (153-500). Default: warm
 *   brightness <light> <0-100>               (0 switches it off)
 *   dim <light> [amount]   |   bright <light> [amount]    step brightness down/up (default 15)
 *   blink <light> [colour] [times]           manual test flash on any light, any colour - doesn't
 *                                            touch HUE_LIGHTS/HUE_INCLUDE_OFF/HUE_MAX_NM filtering,
 *                                            so it works even on lights the military alert skips.
 *                                            Restores the light's prior state afterwards.
 *   state <light>                            everything the bridge reports for that light
 *   save [snapshot]  |  restore [snapshot] [light]   snapshot/put back all lights (name defaults to
 *                                            "default" - unrelated to the bridge profile name above).
 *                                            Every flash first saves the lights as "preflash", so a
 *                                            flash that goes wrong can be undone: restore preflash
 *   help                                     this list
 *
 * Each paired bridge's address and app key are stored in ~/.radar-hue.json (mode 600, outside the repo
 * so it can never be committed), keyed by profile name. HUE_BRIDGE_IP / HUE_APP_KEY together override
 * profile lookup entirely, for a one-off bridge or to pin an exact bridge in a systemd unit.
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
 *   HUE_STATE         where save/restore snapshots live (default ~/.radar-hue-state.json)
 *   HUE_RESTORE       what specific lights should go back to after a flash, instead of the state the
 *                     bridge reported beforehand. For cheap/generic strips whose reported colour is
 *                     unreliable. Semicolon-separated:  "Book shelf=#ff9a3c@60;Lamp=warm@80"
 *                     (colour name, hex, or white tone like warm / 2700k, then @brightness).
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_FILE = process.env.HUE_CONFIG || path.join(os.homedir(), '.radar-hue.json');
const STATE_FILE = process.env.HUE_STATE || path.join(os.homedir(), '.radar-hue-state.json');
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

// Config file holds named bridge profiles - { bridges: { default: {bridge,key}, diyhue: {...} } } -
// so one Pi can talk to more than one Hue-API bridge (a real Hue bridge plus e.g. a diyHue instance
// used for something unrelated). Old flat-format files ({bridge,key}, no "bridges" key) are read as
// if they were { bridges: { default: {bridge,key} } } - no migration needed, nothing breaks.
function getProfiles(file) {
  if (file.bridges) return file.bridges;
  if (file.bridge && file.key) return { default: { bridge: file.bridge, key: file.key } };
  return {};
}

function getConfig(profileName) {
  // HUE_BRIDGE_IP/HUE_APP_KEY together are a full override of the profile system, for a true
  // one-off or for a systemd unit that wants to pin an exact bridge without touching the config
  // file at all. Otherwise pick a named profile: HUE_PROFILE env var, an explicit argument, or
  // "default".
  if (process.env.HUE_BRIDGE_IP && process.env.HUE_APP_KEY) {
    return { bridge: process.env.HUE_BRIDGE_IP, key: process.env.HUE_APP_KEY };
  }
  const name = profileName || process.env.HUE_PROFILE || 'default';
  const profiles = getProfiles(readConfigFile());
  const cfg = profiles[name];
  if (!cfg || !cfg.bridge || !cfg.key) {
    const known = Object.keys(profiles);
    const knownMsg = known.length ? ` Known profiles: ${known.join(', ')}.` : '';
    throw new Error(`Profile '${name}' isn't paired yet.${knownMsg} Press the link button on that bridge, then run: node ${process.argv[1]} pair <bridge-ip> ${name === 'default' ? '' : name}`.trim());
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

// Send a batch of {id, body} commands at once, then retry any the bridge rejected (it drops
// commands if it's sent too many too fast). Used for restores, where a dropped command would
// leave a light stuck on the flash colour.
async function putEach(cfg, items, retries = 1) {
  let pending = items;
  for (let attempt = 0; attempt <= retries && pending.length; attempt++) {
    if (attempt) await sleep(700);
    const results = await Promise.allSettled(pending.map((i) => putLight(cfg, i.id, i.body)));
    pending = pending.filter((_, idx) => results[idx].status === 'rejected');
    if (pending.length && attempt === retries) {
      pending.forEach((i) => log(`could not restore light ${i.id} - try: node ${process.argv[1]} restore preflash`));
    }
  }
}

async function restoreLights(cfg, snaps) {
  await putEach(cfg, snaps.map((s) => ({ id: s.id, body: restoreBody(s) })));
  const wereOff = snaps.filter((s) => !s.on);
  if (wereOff.length) {
    await sleep(Math.max(500, wereOff.length * 110));
    await putEach(cfg, wereOff.map((s) => ({ id: s.id, body: { on: { on: false } } })));
  }
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}

function writeState(name, snaps) {
  const all = readState();
  all[name] = { saved: new Date().toISOString(), lights: snaps };
  fs.writeFileSync(STATE_FILE, JSON.stringify(all, null, 2), { mode: 0o600 });
}

// HUE_RESTORE: fixed "rest" looks for lights whose reported state can't be trusted (see header).
function parseLook(value) {
  const [what, bri] = value.split('@');
  const w = what.trim().toLowerCase();
  const look = {};
  if (bri != null && bri.trim() !== '') look.brightness = parseBrightness(bri.trim());
  if (WHITES[w]) look.mirek = WHITES[w];
  else if (/^\d{4,5}k$/.test(w)) look.mirek = Math.round(1e6 / parseInt(w, 10));
  else {
    const xy = hexToXy(COLOURS[w] || w);
    if (!xy) throw new Error(`HUE_RESTORE: don't understand '${what}'`);
    look.xy = xy;
  }
  return look;
}

function applyRestoreOverrides(snaps) {
  const raw = process.env.HUE_RESTORE;
  if (!raw) return snaps;
  const rules = raw.split(';').map((r) => r.trim()).filter(Boolean).map((r) => {
    const i = r.indexOf('=');
    if (i < 1) throw new Error(`HUE_RESTORE: expected name=look, got '${r}'`);
    return { name: r.slice(0, i).trim().toLowerCase(), look: parseLook(r.slice(i + 1)) };
  });
  return snaps.map((s) => {
    const n = s.name.toLowerCase();
    const rule = rules.find((r) => r.name === n) || rules.find((r) => n.includes(r.name));
    if (!rule) return s;
    const o = { ...s, on: true, ...rule.look };
    if (rule.look.xy) delete o.mirek;
    if (rule.look.mirek) delete o.xy;
    return o;
  });
}

async function flashLights(cfg) {
  const lights = selectLights(await fetchLights(cfg));
  if (!lights.length) { log('no lights to flash (none matched, or all are off - see HUE_INCLUDE_OFF)'); return 0; }
  const snaps = lights.map(snapshot);
  try { writeState('preflash', snaps); } catch (err) { log('could not save preflash state:', err.message); }

  // The bridge takes roughly 10 light commands a second, so stretch each phase for big setups.
  const phaseMs = Math.max(STEP_MS, snaps.length * 110);
  log(`flashing ${snaps.length} light(s): ${snaps.map((s) => s.name).join(', ')}`);

  try {
    for (let i = 0; i < FLASHES; i++) {
      await Promise.allSettled(snaps.map((s) => putLight(cfg, s.id, redBody())));
      await sleep(phaseMs);
      // Finish on red rather than off, so the restore below is a plain colour change on a light
      // that's already on. Some generic strips ignore a colour sent in the same command that
      // switches them on from off.
      if (i < FLASHES - 1) {
        await Promise.allSettled(snaps.map((s) => putLight(cfg, s.id, offBody())));
        await sleep(phaseMs);
      }
    }
  } finally {
    // Always put things back, even if a command above failed.
    let target = snaps;
    try { target = applyRestoreOverrides(snaps); } catch (err) { log(err.message, '- using the saved state instead'); }
    // Lights that were off must still end up off, whatever the override says.
    target = target.map((t, i) => ({ ...t, on: snaps[i].on }));
    await restoreLights(cfg, target);
    log('lights restored');
  }
  return snaps.length;
}

// --- commands ----------------------------------------------------------------------------------
async function cmdPair(bridge, profileName) {
  if (!bridge) throw new Error(`Usage: node ${process.argv[1]} pair <bridge-ip> [profile-name]`);
  const name = profileName || 'default';
  console.log(`Press the round link button on the Hue bridge now (pairing as profile "${name}"). Waiting up to 60 seconds...`);
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const res = await hueRequest(bridge, null, 'POST', '/api', { devicetype: 'radar#pi', generateclientkey: true });
    const first = Array.isArray(res) ? res[0] : null;
    if (first && first.success && first.success.username) {
      const file = readConfigFile();
      const bridges = { ...getProfiles(file), [name]: { bridge, key: first.success.username } };
      fs.writeFileSync(CONFIG_FILE, JSON.stringify({ bridges }, null, 2), { mode: 0o600 });
      fs.chmodSync(CONFIG_FILE, 0o600);
      console.log(`Paired as "${name}". Saved to ${CONFIG_FILE}. Try:  ${name === 'default' ? '' : `HUE_PROFILE=${name} `}node ${process.argv[1]} list`);
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
  // Same profile pin as cmdServe() - this is meant to test the real alert path, which always
  // uses "default", not whatever HUE_PROFILE happens to be set in the current shell.
  const n = await flashLights(getConfig('default'));
  console.log(n ? `Flashed ${n} light(s).` : 'Nothing flashed - see the message above.');
}

// --- manual control ----------------------------------------------------------------------------
const COLOURS = {
  red: '#ff0000', orange: '#ff7a00', yellow: '#ffe000', green: '#00ff00', cyan: '#00ffff',
  blue: '#0000ff', purple: '#8000ff', pink: '#ff4da6', magenta: '#ff00ff',
};
const WHITES = { warm: 400, neutral: 300, cool: 220, daylight: 153 }; // mirek: bigger = warmer

// sRGB hex -> CIE xy, using the same conversion Philips documents. The bridge pulls anything
// outside a light's own gamut back to the nearest colour it can actually make.
function hexToXy(word) {
  const m = /^#?([0-9a-f]{6})$/i.exec(word);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const lin = (v) => { v /= 255; return v > 0.04045 ? Math.pow((v + 0.055) / 1.055, 2.4) : v / 12.92; };
  const r = lin((n >> 16) & 255), g = lin((n >> 8) & 255), b = lin(n & 255);
  const X = r * 0.664511 + g * 0.154324 + b * 0.162028;
  const Y = r * 0.283881 + g * 0.668433 + b * 0.047685;
  const Z = r * 0.000088 + g * 0.07231 + b * 0.986039;
  const sum = X + Y + Z;
  return sum === 0 ? null : { x: +(X / sum).toFixed(4), y: +(Y / sum).toFixed(4) };
}

function matchLights(all, target) {
  if (!target || target.toLowerCase() === 'all') return all;
  if (target.includes(',')) {
    const seen = new Map();
    for (const part of target.split(',').map((s) => s.trim()).filter(Boolean)) {
      for (const l of matchLights(all, part)) seen.set(l.id, l);
    }
    return [...seen.values()];
  }
  const t = target.toLowerCase();
  const exact = all.filter((l) => lightName(l).toLowerCase() === t || l.id === target);
  if (exact.length) return exact;
  return all.filter((l) => lightName(l).toLowerCase().includes(t));
}

function parseBrightness(word) {
  const n = Number(word);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error(`brightness must be 0-100, got '${word}'`);
  return n;
}

// makeBody(light) returns a request body, or a string explaining why this light is skipped.
async function applyToLights(target, makeBody) {
  const cfg = getConfig();
  const lights = matchLights(await fetchLights(cfg), target);
  if (!lights.length) throw new Error(`No light matches '${target}'. Run 'list' to see the names.`);
  for (const l of lights) {
    const body = makeBody(l);
    if (typeof body === 'string') { console.log(`  ${lightName(l)}: skipped (${body})`); continue; }
    await putLight(cfg, l.id, body);
    console.log(`  ${lightName(l)}: ok`);
    await sleep(110); // stay under the bridge's ~10 commands a second
  }
}

const withBrightness = (body, bri) => (bri == null ? body : { ...body, dimming: { brightness: bri } });

async function cmdSwitch(target, on) {
  await applyToLights(target, () => ({ on: { on }, dynamics: { duration: 300 } }));
}

async function cmdColor(target, colour, briWord) {
  if (!target || !colour) throw new Error(`Usage: color <light> <colour> [brightness]   (colours: ${Object.keys(COLOURS).join(' ')} or #hex)`);
  if (WHITES[colour.toLowerCase()]) return cmdWhite(target, [colour, briWord].filter(Boolean));
  const xy = hexToXy(COLOURS[colour.toLowerCase()] || colour);
  if (!xy) throw new Error(`Unknown colour '${colour}'. Use: ${Object.keys(COLOURS).join(' ')} or a hex code like #ff8800`);
  const bri = briWord == null ? null : parseBrightness(briWord);
  await applyToLights(target, (l) =>
    l.color ? withBrightness({ on: { on: true }, color: { xy }, dynamics: { duration: 400 } }, bri) : "can't do colours");
  return undefined;
}

async function cmdWhite(target, rest = []) {
  if (!target) throw new Error('Usage: white <light> [warm|neutral|cool|daylight|2700k|mirek] [brightness]');
  let mirek = WHITES.warm;
  let bri = null;
  for (const a of rest) {
    const w = a.toLowerCase();
    if (WHITES[w]) mirek = WHITES[w];
    else if (/^\d{4,5}k$/.test(w)) mirek = Math.round(1e6 / parseInt(w, 10));
    else if (Number.isFinite(Number(w)) && Number(w) > 100) mirek = Math.round(Number(w));
    else if (Number.isFinite(Number(w))) bri = parseBrightness(w);
    else throw new Error(`Don't understand '${a}'. Use warm/neutral/cool/daylight, 2700k, a mirek value, or a brightness 0-100.`);
  }
  await applyToLights(target, (l) => {
    if (!l.color_temperature) return "can't do adjustable white";
    const schema = l.color_temperature.mirek_schema || {};
    const m = Math.min(schema.mirek_maximum || 500, Math.max(schema.mirek_minimum || 153, mirek));
    return withBrightness({ on: { on: true }, color_temperature: { mirek: m }, dynamics: { duration: 400 } }, bri);
  });
}

async function cmdBrightness(target, word) {
  if (!target || word == null) throw new Error('Usage: brightness <light> <0-100>');
  const bri = parseBrightness(word);
  await applyToLights(target, (l) => {
    if (!l.dimming) return "can't dim";
    return bri === 0 ? { on: { on: false } } : { on: { on: true }, dimming: { brightness: bri }, dynamics: { duration: 300 } };
  });
}

async function cmdToggle(target) {
  if (!target) throw new Error('Usage: toggle <light>');
  await applyToLights(target, (l) => ({ on: { on: !(l.on && l.on.on) }, dynamics: { duration: 300 } }));
}

async function cmdStep(target, word, sign) {
  if (!target) throw new Error(`Usage: ${sign > 0 ? 'bright' : 'dim'} <light> [amount]`);
  const step = word != null ? parseBrightness(word) : 15;
  await applyToLights(target, (l) => {
    if (!l.dimming) return "can't dim";
    const current = l.on && l.on.on ? l.dimming.brightness || 0 : 0;
    const next = Math.min(100, Math.max(0, current + sign * step));
    return next === 0
      ? { on: { on: false } }
      : { on: { on: true }, dimming: { brightness: next }, dynamics: { duration: 300 } };
  });
}

// Manual test flash on any light/colour, ignoring the HUE_LIGHTS/HUE_INCLUDE_OFF/HUE_MAX_NM
// filtering that the military alert path uses - so it also works on lights that filter would
// skip. Always restores whatever the light was doing before, same as the alert flash does.
async function cmdBlink(target, colourWord, timesWord) {
  if (!target) throw new Error('Usage: blink <light> [colour] [times]');
  const cfg = getConfig();
  const lights = matchLights(await fetchLights(cfg), target);
  if (!lights.length) throw new Error(`No light matches '${target}'. Run 'list' to see the names.`);

  const times = timesWord != null ? Math.max(1, parseInt(timesWord, 10) || FLASHES) : FLASHES;
  let xy = RED_XY;
  if (colourWord && colourWord.toLowerCase() !== 'red') {
    const resolved = hexToXy(COLOURS[colourWord.toLowerCase()] || colourWord);
    if (!resolved) throw new Error(`Unknown colour '${colourWord}'. Use: ${Object.keys(COLOURS).join(' ')} or a hex code like #ff8800`);
    xy = resolved;
  }

  const snaps = lights.map(snapshot);
  const onBody = (l) => (l.color
    ? { on: { on: true }, dimming: { brightness: 100 }, color: { xy }, dynamics: { duration: 0 } }
    : { on: { on: true }, dynamics: { duration: 0 } }); // white-only bulb: just blink on/off
  const phaseMs = Math.max(STEP_MS, snaps.length * 110);

  console.log(`Blinking ${snaps.length} light(s) ${times}x: ${snaps.map((s) => s.name).join(', ')}`);
  try {
    for (let i = 0; i < times; i++) {
      await Promise.allSettled(lights.map((l) => putLight(cfg, l.id, onBody(l))));
      await sleep(phaseMs);
      if (i < times - 1) {
        await Promise.allSettled(lights.map((l) => putLight(cfg, l.id, offBody())));
        await sleep(phaseMs);
      }
    }
  } finally {
    await restoreLights(cfg, snaps);
  }
  console.log('done');
}

async function cmdState(target) {
  if (!target) throw new Error('Usage: state <light>   (part of a name, or "all")');
  const cfg = getConfig();
  const lights = matchLights(await fetchLights(cfg), target);
  if (!lights.length) throw new Error(`No light matches '${target}'. Run 'list' to see the names.`);
  for (const l of lights) {
    console.log(`=== ${lightName(l)} (${l.id}) ===`);
    console.log(JSON.stringify(l, null, 2));
  }
}

async function cmdSave(name = 'default') {
  const cfg = getConfig();
  const snaps = (await fetchLights(cfg)).map(snapshot);
  writeState(name, snaps);
  console.log(`Saved ${snaps.length} light(s) as '${name}' in ${STATE_FILE}`);
}

async function cmdRestore(name = 'default', target) {
  const cfg = getConfig();
  const all = readState();
  if (!all[name]) {
    const have = Object.keys(all);
    throw new Error(`Nothing saved as '${name}'.` + (have.length ? ` Saved names: ${have.join(', ')}` : ' Nothing has been saved yet - use: save'));
  }
  const t = target && target.toLowerCase() !== 'all' ? target.toLowerCase() : null;
  const snaps = all[name].lights.filter((s) => !t || s.name.toLowerCase().includes(t));
  if (!snaps.length) throw new Error(`No saved light matches '${target}'.`);
  await restoreLights(cfg, snaps);
  console.log(`Restored ${snaps.length} light(s) from '${name}' (saved ${all[name].saved}): ${snaps.map((s) => s.name).join(', ')}`);
}

function cmdHelp() {
  const src = fs.readFileSync(__filename, 'utf8');
  console.log(src.slice(src.indexOf('/*') + 3, src.indexOf('*/')).replace(/^ \* ?/gm, '').trim());
}

function cmdServe() {
  // Always the "default" profile, ignoring HUE_PROFILE - the alert flasher must never accidentally
  // start pointing at a second bridge (e.g. diyhue) just because that env var is set in the shell
  // someone happens to launch this from.
  const cfg = getConfig('default'); // fail early with a clear message if not paired
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
// No argument at all -> help, not serve. The systemd unit (if you run one) should call this
// with an explicit "serve" argument rather than relying on a bare invocation defaulting to it.
(async () => {
  const [cmd = 'help', ...args] = process.argv.slice(2);
  try {
    if (cmd === 'pair') await cmdPair(args[0], args[1]);
    else if (cmd === 'profiles') {
      const profiles = getProfiles(readConfigFile());
      const names = Object.keys(profiles);
      if (!names.length) console.log('No bridges paired yet. Run: pair <bridge-ip> [profile-name]');
      else names.forEach((n) => console.log(`  ${n}${n === 'default' ? ' (default)' : ''} - ${profiles[n].bridge}`));
    }
    else if (cmd === 'list') await cmdList();
    else if (cmd === 'test') await cmdTest();
    else if (cmd === 'serve') cmdServe();
    else if (cmd === 'on') await cmdSwitch(args[0], true);
    else if (cmd === 'off') await cmdSwitch(args[0], false);
    else if (cmd === 'toggle') await cmdToggle(args[0]);
    else if (cmd === 'color' || cmd === 'colour') await cmdColor(args[0], args[1], args[2]);
    else if (cmd === 'white') await cmdWhite(args[0], args.slice(1));
    else if (cmd === 'brightness' || cmd === 'bri') await cmdBrightness(args[0], args[1]);
    else if (cmd === 'dim') await cmdStep(args[0], args[1], -1);
    else if (cmd === 'bright' || cmd === 'brighten') await cmdStep(args[0], args[1], 1);
    else if (cmd === 'blink' || cmd === 'flash') await cmdBlink(args[0], args[1], args[2]);
    else if (cmd === 'state') await cmdState(args[0]);
    else if (cmd === 'save') await cmdSave(args[0]);
    else if (cmd === 'restore') await cmdRestore(args[0], args[1]);
    else if (cmd === 'help' || cmd === '--help' || cmd === '-h') cmdHelp();
    else throw new Error(`Unknown command '${cmd}'. Run 'help' for the list.`);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
})();
