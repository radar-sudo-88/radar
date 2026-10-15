#!/usr/bin/env node
'use strict';
// Run SQL against the sightings database.  No sqlite3 install needed (uses Node's built-in one).
//
//   node sql.js "SELECT type, COUNT(DISTINCT hex) AS planes FROM sightings GROUP BY type ORDER BY planes DESC LIMIT 10"
//   node sql.js --examples            list ready-made queries
//   node sql.js --write "DELETE ..."  allow changes (default is read-only so you can't break anything)
const fs = require('fs');
const { DB_PATH } = require('./sightings');

const EXAMPLES = [
  ['Top airlines (by callsign prefix)', "SELECT substr(callsign,1,3) AS airline, COUNT(DISTINCT hex) AS planes FROM sightings WHERE callsign GLOB '[A-Z][A-Z][A-Z][0-9]*' GROUP BY airline ORDER BY planes DESC LIMIT 10"],
  ['Most common aircraft types', 'SELECT type, COUNT(DISTINCT hex) AS planes FROM sightings WHERE type IS NOT NULL GROUP BY type ORDER BY planes DESC LIMIT 10'],
  ['Busiest hours of the day (local time)', "SELECT strftime('%H', seen_at, 'unixepoch', 'localtime') AS hour, COUNT(DISTINCT hex) AS planes FROM sightings GROUP BY hour ORDER BY hour"],
  ['Rare types (seen once or twice)', 'SELECT type, COUNT(DISTINCT hex) AS planes FROM sightings WHERE type IS NOT NULL GROUP BY type HAVING planes <= 2 ORDER BY planes, type'],
  ['Latest military sightings', "SELECT datetime(seen_at,'unixepoch','localtime') AS time, callsign, type, alt_ft FROM sightings WHERE military = 1 ORDER BY seen_at DESC LIMIT 20"],
  ['Emergency squawks', "SELECT datetime(seen_at,'unixepoch','localtime') AS time, callsign, type, squawk FROM sightings WHERE squawk IN ('7700','7600','7500') ORDER BY seen_at DESC LIMIT 20"],
  ['Highest planes seen', "SELECT callsign, type, alt_ft, datetime(seen_at,'unixepoch','localtime') AS time FROM sightings WHERE alt_ft IS NOT NULL ORDER BY alt_ft DESC LIMIT 10"],
  ['Planes per day', "SELECT date(seen_at,'unixepoch','localtime') AS day, COUNT(DISTINCT hex) AS planes FROM sightings GROUP BY day ORDER BY day DESC LIMIT 14"],
];

const args = process.argv.slice(2);
if (args[0] === '--examples' || args.length === 0) {
  console.log('Usage: node sql.js "<SQL>"   (add --write first to allow changes)\n');
  console.log('Table: sightings(id, seen_at, hex, callsign, registration, type, alt_ft, on_ground, gs_kt, lat, lon, squawk, military)\n');
  for (const [title, sql] of EXAMPLES) console.log(`-- ${title}\nnode sql.js "${sql}"\n`);
  process.exit(0);
}
const write = args[0] === '--write';
const sql = (write ? args.slice(1) : args).join(' ').trim();
if (!sql) { console.error('No SQL given.'); process.exit(1); }
if (!fs.existsSync(DB_PATH)) { console.error(`No database yet at ${DB_PATH} - start the proxy and let it see some aircraft first.`); process.exit(1); }

let DatabaseSync;
try { ({ DatabaseSync } = require('node:sqlite')); } catch (e) { console.error('Needs Node 22.5+ (node:sqlite).'); process.exit(1); }
const db = new DatabaseSync(DB_PATH, { readOnly: !write });
try {
  if (/^\s*(select|with|pragma|explain)\b/i.test(sql)) {
    const rows = db.prepare(sql).all();
    if (rows.length) console.table(rows); else console.log('(no rows)');
    console.log(`${rows.length} row${rows.length === 1 ? '' : 's'}`);
  } else {
    const r = db.prepare(sql).run();
    console.log(`OK, ${r.changes} row${r.changes === 1 ? '' : 's'} changed`);
  }
} catch (e) { console.error('SQL error:', e.message); process.exit(1); }
