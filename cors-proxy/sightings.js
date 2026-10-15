'use strict';
/**
 * Sightings log: a small SQLite database of the aircraft this proxy has seen.
 *
 * Uses Node's built-in `node:sqlite` (Node 22.5+; no packages to install or compile). If it isn't
 * available, or anything goes wrong, logging switches itself off and the proxy carries on exactly
 * as before - the log can never break a response.
 *
 * What is stored: the aircraft (hex, callsign, registration, type, altitude, speed, position,
 * squawk, military flag) and when. It does NOT store anything about the visitor: not their
 * location, IP or browser. Each plane is logged at most once every 10 minutes, and rows older than
 * 30 days are deleted hourly.
 *
 * Env:  SIGHTINGS=off               turn it off
 *       SIGHTINGS_DB=/path/x.db     database file (default: cors-proxy/data/radar.db)
 *       SIGHTINGS_RETENTION_DAYS=N  how long to keep rows (default 30)
 * Query it with:  node sql.js "SELECT ..."   (see: node sql.js --examples)
 */
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.SIGHTINGS_DB || path.join(__dirname, 'data', 'radar.db');
const RETENTION_DAYS = Number(process.env.SIGHTINGS_RETENTION_DAYS) || 30;
const DEDUPE_SECONDS = 10 * 60;

let db = null;
let insert = null;
const lastLogged = new Map(); // hex -> unix seconds it was last written

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS sightings (
    id           INTEGER PRIMARY KEY,
    seen_at      INTEGER NOT NULL,            -- unix seconds (UTC)
    hex          TEXT    NOT NULL,            -- 24-bit ICAO address, e.g. 406a2f
    callsign     TEXT,
    registration TEXT,
    type         TEXT,                        -- ICAO type code, e.g. A320
    alt_ft       INTEGER,
    on_ground    INTEGER NOT NULL DEFAULT 0,
    gs_kt        REAL,
    lat          REAL,
    lon          REAL,
    squawk       TEXT,
    military     INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_sightings_seen_at ON sightings(seen_at);
  CREATE INDEX IF NOT EXISTS idx_sightings_hex     ON sightings(hex);
  CREATE INDEX IF NOT EXISTS idx_sightings_type    ON sightings(type);
`;

function init() {
  if (db || process.env.SIGHTINGS === 'off') return;
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch (e) {
    console.log('Sightings log: off (needs Node 22.5+ for node:sqlite)');
    return;
  }
  try {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    db = new DatabaseSync(DB_PATH);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    db.exec(SCHEMA);
    insert = db.prepare(
      `INSERT INTO sightings (seen_at, hex, callsign, registration, type, alt_ft, on_ground, gs_kt, lat, lon, squawk, military)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    setInterval(prune, 60 * 60 * 1000).unref();
    prune();
    console.log(`Sightings log: on (${DB_PATH}, keeping ${RETENTION_DAYS} days)`);
  } catch (e) {
    db = null; insert = null;
    console.error('Sightings log: off (could not open database):', e.message);
  }
}

function prune() {
  if (!db) return;
  try {
    const now = Math.floor(Date.now() / 1000);
    db.prepare('DELETE FROM sightings WHERE seen_at < ?').run(now - RETENTION_DAYS * 86400);
    for (const [hex, t] of lastLogged) if (now - t >= DEDUPE_SECONDS) lastLogged.delete(hex);
  } catch (e) { console.error('Sightings prune failed:', e.message); }
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 16) : null);

// `aircraft` is the `ac` array from an adsb.fi / readsb style response.
function record(aircraft) {
  if (!db || !Array.isArray(aircraft)) return;
  const now = Math.floor(Date.now() / 1000);
  const rows = [];
  for (const ac of aircraft) {
    if (!ac || typeof ac.hex !== 'string' || !/^~?[0-9a-f]{6}$/i.test(ac.hex)) continue;
    const hex = ac.hex.toLowerCase();
    const last = lastLogged.get(hex);
    if (last !== undefined && now - last < DEDUPE_SECONDS) continue;
    lastLogged.set(hex, now);
    const onGround = ac.alt_baro === 'ground' ? 1 : 0;
    rows.push([
      now, hex, str(ac.flight), str(ac.r), str(ac.t),
      onGround ? 0 : (num(ac.alt_baro) === null ? null : Math.round(ac.alt_baro)), onGround,
      num(ac.gs), num(ac.lat), num(ac.lon), str(ac.squawk),
      typeof ac.dbFlags === 'number' && (ac.dbFlags & 1) ? 1 : 0,
    ]);
  }
  if (!rows.length) return;
  try {
    db.exec('BEGIN');
    for (const r of rows) insert.run(...r);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* nothing to roll back */ }
    console.error('Sightings write failed:', e.message);
  }
}

module.exports = { init, record, DB_PATH };
