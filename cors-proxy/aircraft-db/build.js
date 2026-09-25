#!/usr/bin/env node
/**
 * One-off/occasional build step: turns the OpenSky aircraft metadata CSV into a small
 * JSON lookup keyed by icao24, which server.js loads at startup for GET
 * /v2/aircraft-info/<hex>.
 *
 * The CSV isn't fetched automatically here because OpenSky's own download page
 * (https://opensky-network.org/data/aircraft) requires a free login. Log in there, download
 * "aircraft-database-complete-YYYY-MM.csv.gz" (or the unzipped .csv), put it on the Pi, then run:
 *
 *   node aircraft-db/build.js /path/to/aircraft-database-complete-2026-09.csv
 *
 * Writes aircraft-db/lookup.json (gitignored - it's large and regenerable, don't commit it).
 * Re-run this every few months to pick up newly registered aircraft; built/registration data for
 * existing ones barely changes, so there's no need for anything fancier than a manual re-run.
 */
const fs = require('fs');
const readline = require('readline');
const path = require('path');

const KEEP = ['icao24', 'registration', 'manufacturericao', 'manufacturername', 'model', 'typecode', 'built', 'operator'];

async function main() {
  const csvPath = process.argv[2];
  if (!csvPath) {
    console.error('Usage: node build.js /path/to/aircraft-database-complete-YYYY-MM.csv');
    process.exit(1);
  }
  const outPath = path.join(__dirname, 'lookup.json');
  const rl = readline.createInterface({ input: fs.createReadStream(csvPath), crlfDelay: Infinity });

  let header = null;
  let idx = null;
  const out = {};
  let total = 0;
  let kept = 0;

  for await (const line of rl) {
    if (!line) continue;
    const fields = parseCsvLine(line);
    if (!header) {
      header = fields.map((h) => h.replace(/^['"]|['"]$/g, '').toLowerCase());
      idx = Object.fromEntries(KEEP.map((k) => [k, header.indexOf(k)]));
      const missing = KEEP.filter((k) => idx[k] === -1);
      if (missing.length) console.warn(`Warning: columns not found in CSV: ${missing.join(', ')}`);
      continue;
    }
    total++;
    const hex = strip(fields[idx.icao24]).toLowerCase();
    if (!hex) continue;
    const rec = {};
    for (const k of KEEP) {
      if (k === 'icao24' || idx[k] === -1) continue;
      const v = strip(fields[idx[k]]);
      if (v) rec[k] = v;
    }
    if (Object.keys(rec).length === 0) continue; // nothing useful beyond the hex itself
    out[hex] = rec;
    kept++;
    if (kept % 100000 === 0) console.log(`  ...${kept} kept / ${total} rows read`);
  }

  fs.writeFileSync(outPath, JSON.stringify(out));
  const sizeMB = (fs.statSync(outPath).size / (1024 * 1024)).toFixed(1);
  console.log(`Done: ${kept} aircraft kept of ${total} rows -> ${outPath} (${sizeMB} MB)`);
}

function strip(v) {
  if (v == null) return '';
  return v.replace(/^['"]|['"]$/g, '').trim();
}

// Minimal CSV line parser - handles quoted fields with embedded commas, which OpenSky's
// export doesn't actually use (values are simple and comma-free) but this is cheap insurance.
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else cur += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

main().catch((err) => { console.error(err); process.exit(1); });
