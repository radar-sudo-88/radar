/* Sky Ledger - Quarry of the day, badges, overhead-in-N, visibility score, phone compass.
 *
 * Self-contained add-on for app.js. app.js calls SkyLedger.tick(liveAircraft) once per poll;
 * everything else (UI, storage, compass) lives here. Uses these app.js globals when present:
 * userConfig, isMilitary(), showEasterEgg(). Pure maths is exported for node tests below.
 *
 * Fingerprints (deliberately arbitrary - see SIGNATURE below): the "Quarry" naming, the
 * 17-entry pool, the 7.3/13 hash salt, the badge names and the visibility verdict wording.
 */
(function (root) {
  'use strict';

  const SIGNATURE = 'skl-7.3-13';
  const LS = 'skl.v1.';
  const RAD = Math.PI / 180;
  const NM_FT = 6076.12;

  // A "PC" = a fine, hovering pointer (mouse/trackpad) on a non-mobile user agent. Phones and
  // tablets report coarse/no hover, so they fall through to the touch + compass experience.
  function detectDesktop(env) {
    env = env || {};
    const mobileUA = /Android|iPhone|iPad|iPod|Mobile|Silk/i.test(env.ua || '');
    return !!env.fineHover && !mobileUA;
  }

  // ---------------------------------------------------------------- maths (pure)

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // Local flat-earth offset of an aircraft from the viewer, in nautical miles.
  function offsetNM(uLat, uLon, lat, lon) {
    return { x: (lon - uLon) * 60 * Math.cos(uLat * RAD), y: (lat - uLat) * 60 };
  }

  function bearingDeg(uLat, uLon, lat, lon) {
    const dLon = (lon - uLon) * RAD;
    const y = Math.sin(dLon) * Math.cos(lat * RAD);
    const x = Math.cos(uLat * RAD) * Math.sin(lat * RAD) -
              Math.sin(uLat * RAD) * Math.cos(lat * RAD) * Math.cos(dLon);
    return (Math.atan2(y, x) / RAD + 360) % 360;
  }

  function airborneAlt(ac) {
    return typeof ac.alt_baro === 'number' && ac.alt_baro > 300 ? ac.alt_baro : null;
  }

  // Closest point of approach to the viewer, assuming straight, constant-speed flight.
  // Returns { minutes, missNM } or null if it isn't approaching / isn't airborne / too far out.
  function overheadEta(ac, uLat, uLon, horizonMin) {
    horizonMin = horizonMin || 30;
    if (airborneAlt(ac) === null) return null;
    if (typeof ac.lat !== 'number' || typeof ac.lon !== 'number') return null;
    const gs = Number(ac.gs), trk = Number(ac.track);
    if (!(gs >= 30) || !isFinite(trk)) return null;
    const p = offsetNM(uLat, uLon, ac.lat, ac.lon);
    const vx = gs * Math.sin(trk * RAD) / 60;   // NM per minute
    const vy = gs * Math.cos(trk * RAD) / 60;
    const v2 = vx * vx + vy * vy;
    const t = -(p.x * vx + p.y * vy) / v2;
    if (t <= 0 || t > horizonMin) return null;
    const mx = p.x + vx * t, my = p.y + vy * t;
    return { minutes: t, missNM: Math.sqrt(mx * mx + my * my) };
  }

  // Low-precision solar elevation in degrees (good to ~0.5 deg - plenty for a light estimate).
  function sunElevation(date, lat, lon) {
    const n = date.getTime() / 86400000 + 2440587.5 - 2451545.0;
    const L = (280.460 + 0.9856474 * n) % 360;
    const g = ((357.528 + 0.9856003 * n) % 360) * RAD;
    const lam = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD;
    const eps = (23.439 - 0.0000004 * n) * RAD;
    const ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam));
    const dec = Math.asin(Math.sin(eps) * Math.sin(lam));
    const gmstH = (18.697374558 + 24.06570982441908 * n) % 24;
    const ha = (((gmstH * 15 + lon) % 360) * RAD) - ra;
    const el = Math.asin(Math.sin(lat * RAD) * Math.sin(dec) +
                         Math.cos(lat * RAD) * Math.cos(dec) * Math.cos(ha));
    return el / RAD;
  }

  const SPAN_M = { A1: 11, A2: 20, A3: 34, A4: 48, A5: 62, A6: 70, A7: 13 };

  // "Will you actually see it?" 0-100 from apparent size, elevation above the horizon and light.
  // Heuristic only: it knows nothing about cloud, haze, trees or buildings.
  function visibility(ac, missNM, sunEl) {
    const alt = airborneAlt(ac);
    if (alt === null) return { score: 0, label: 'Radar-only', elev: 0 };
    const altNM = alt / NM_FT;
    const elev = Math.atan2(altNM, Math.max(missNM, 0.01)) / RAD;
    const slantKm = Math.hypot(missNM, altNM) * 1.852;
    const span = SPAN_M[ac.category] || 36;
    const arcmin = (span / (slantKm * 1000)) * 3437.75;
    const sizeS = clamp(Math.log10(arcmin / 0.15) / Math.log10(8 / 0.15), 0, 1);
    const elevS = clamp((elev - 8) / 52, 0, 1);
    const lightS = sunEl >= 0 ? 0.85 : sunEl >= -12 ? 1.0 : 0.65;
    const score = Math.round(100 * (0.4 * sizeS + 0.35 * elevS + 0.25 * lightS));
    const label = score >= 75 ? 'Naked-eye gift' : score >= 50 ? 'Worth a look'
                : score >= 30 ? 'Squint' : 'Radar-only';
    return { score, label, elev };
  }

  // Direction the phone's rear is pointing, from W3C deviceorientation angles (degrees).
  function rearHeading(alpha, beta, gamma) {
    const x = beta * RAD, y = gamma * RAD, z = alpha * RAD;
    const cY = Math.cos(y), cZ = Math.cos(z), sX = Math.sin(x), sY = Math.sin(y), sZ = Math.sin(z);
    const Vx = -cZ * sY - sZ * sX * cY;
    const Vy = -sZ * sY + cZ * sX * cY;
    let h = Math.atan(Vx / Vy);
    if (Vy < 0) h += Math.PI; else if (Vx < 0) h += 2 * Math.PI;
    return (h / RAD + 360) % 360;
  }

  function rearElevation(beta, gamma) {
    return Math.asin(clamp(-Math.cos(beta * RAD) * Math.cos(gamma * RAD), -1, 1)) / RAD;
  }

  // Low-pass filter on a circular quantity so 359 -> 1 doesn't spin the long way round.
  function smoothAngle(prev, next, k) {
    if (prev === null) return next;
    const d = ((next - prev + 540) % 360) - 180;
    return (prev + d * k + 360) % 360;
  }

  // ---------------------------------------------------------------- quarry of the day

  const QUARRY_POOL = [
    ['A388', 'Airbus A380'], ['B744', 'Boeing 747-400'], ['B748', 'Boeing 747-8'],
    ['B77W', 'Boeing 777-300ER'], ['B789', 'Boeing 787-9'], ['A359', 'Airbus A350-900'],
    ['A21N', 'Airbus A321neo'], ['E190', 'Embraer 190'], ['AT76', 'ATR 72-600'],
    ['DH8D', 'Dash 8 Q400'], ['C130', 'Hercules'], ['A400', 'Airbus A400M'],
    ['B752', 'Boeing 757-200'], ['A333', 'Airbus A330-300'], ['CRJ9', 'CRJ-900'],
    ['PC12', 'Pilatus PC-12'], ['B738', 'Boeing 737-800'],
  ];

  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h >>> 0;
  }

  function quarryFor(dateKey) {
    return QUARRY_POOL[fnv1a(dateKey + '|7.3|13') % QUARRY_POOL.length];
  }

  function dateKey(d) {
    d = d || new Date();
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function streakOf(claims, today) {
    let n = 0;
    const d = new Date(today + 'T12:00:00');
    if (!claims[dateKey(d)]) d.setDate(d.getDate() - 1);   // today not claimed yet: count back from yesterday
    while (claims[dateKey(d)]) { n++; d.setDate(d.getDate() - 1); }
    return n;
  }

  // ---------------------------------------------------------------- badges

  const HEAVY_TYPES = new Set(['B744', 'B748', 'A388', 'A124', 'A225', 'A346', 'B772', 'B77W', 'A359']);

  const BADGES = [
    { id: 'first-light', icon: '\ud83c\udf05', fx: 'glow', name: 'First Light', desc: 'Log your first aircraft', test: (c) => c.seenCount >= 1 },
    { id: 'rotor-head', icon: '\ud83d\ude81', fx: 'spin', name: 'Rotor Head', desc: 'Spot a helicopter', test: (c) => c.list.some((a) => a.category === 'A7') },
    { id: 'khaki-hour', icon: '\ud83c\udf96\ufe0f', fx: 'bounce', name: 'Khaki Hour', desc: 'Spot a military aircraft', test: (c) => c.list.some((a) => c.isMil(a)) },
    { id: 'squawk-witness', icon: '\ud83d\udea8', fx: 'flash', name: 'Squawk Witness', desc: 'See a 7500, 7600 or 7700 squawk',
      test: (c) => c.list.some((a) => ['7500', '7600', '7700'].includes(String(a.squawk))) },
    { id: 'heavy-metal', icon: '\ud83c\udfcb\ufe0f', fx: 'shake', name: 'Heavy Metal', desc: 'Spot a heavy jet',
      test: (c) => c.list.some((a) => a.category === 'A5' || a.category === 'A6' || HEAVY_TYPES.has(String(a.t || '').toUpperCase())) },
    { id: 'low-and-slow', icon: '\ud83d\udc22', fx: 'bounce', name: 'Low & Slow', desc: 'Aircraft under 1,500 ft and 120 kt within 3 NM',
      test: (c) => c.list.some((a) => typeof a.alt_baro === 'number' && a.alt_baro < 1500 && Number(a.gs) < 120 &&
        typeof a.lat === 'number' && c.distNM(a) <= 3) },
    { id: 'night-owl', icon: '\ud83e\udd89', fx: 'glow', name: 'Night Owl', desc: 'Log an aircraft between 01:00 and 04:00',
      test: (c) => c.list.length > 0 && c.now.getHours() >= 1 && c.now.getHours() < 4 },
    { id: 'quarry-hunter', icon: '\ud83c\udfaf', fx: 'pulse', name: 'Quarry Hunter', desc: 'Claim a Quarry of the day', test: (c) => c.claimCount >= 1 },
    { id: 'seven-sevens', icon: '7\ufe0f\u20e3', fx: 'spin', name: 'Seven Sevens', desc: 'Claim the Quarry 7 days in a row', test: (c) => c.streak >= 7 },
    { id: 'triple-digits', icon: '\ud83d\udcaf', fx: 'shake', name: 'Triple Digits', desc: 'Log 100 different aircraft', test: (c) => c.seenCount >= 100 },
  ];

  // ---------------------------------------------------------------- storage

  function load(key, fallback) {
    try { const raw = localStorage.getItem(LS + key); return raw ? JSON.parse(raw) : fallback; }
    catch (e) { return fallback; }
  }
  function save(key, val) { try { localStorage.setItem(LS + key, JSON.stringify(val)); } catch (e) { /* ignore */ } }

  // ---------------------------------------------------------------- browser part

  const S = {
    list: [], target: null, heading: null, pitch: null, compassOn: false,
    badges: load('badges', {}), claims: load('claims', {}), seen: load('seen', []),
    seenSet: null, panelOpen: false, raf: 0, chipShown: false,
    desktop: detectDesktop({
      ua: typeof navigator !== 'undefined' ? navigator.userAgent : '',
      fineHover: typeof matchMedia === 'function' && matchMedia('(hover: hover) and (pointer: fine)').matches,
    }),
  };

  function reducedMotion() {
    try { return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches; }
    catch (e) { return false; }
  }

  function station() {
    return (typeof userConfig !== 'undefined' && userConfig) ? userConfig : { lat: 52.9529, lon: -0.9547 };
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function callsign(a) { return (a.flight && a.flight.trim()) || (a.r && a.r.trim()) || String(a.hex || '').toUpperCase(); }
  function toast(msg) { if (typeof showEasterEgg === 'function') showEasterEgg(msg); }

  function distNM(a) {
    const st = station(); const p = offsetNM(st.lat, st.lon, a.lat, a.lon);
    return Math.hypot(p.x, p.y);
  }

  function tick(list) {
    S.list = Array.isArray(list) ? list : [];
    const st = station(), now = new Date(), today = dateKey(now);
    const mil = typeof isMilitary === 'function' ? isMilitary : () => false;

    // Lifetime distinct-aircraft log (capped).
    if (!S.seenSet) S.seenSet = new Set(S.seen);
    let grew = false;
    for (const a of S.list) {
      const h = String(a.hex || '').toLowerCase();
      if (h && !S.seenSet.has(h)) { S.seenSet.add(h); S.seen.push(h); grew = true; }
    }
    if (S.seen.length > 3000) { S.seen = S.seen.slice(-3000); S.seenSet = new Set(S.seen); grew = true; }
    if (grew) save('seen', S.seen);

    // Quarry claim.
    const q = quarryFor(today);
    const messages = [];
    if (!S.claims[today]) {
      const hit = S.list.find((a) => String(a.t || '').toUpperCase() === q[0]);
      if (hit) {
        S.claims[today] = { t: q[0], cs: callsign(hit), ts: Date.now() };
        save('claims', S.claims);
        messages.push({ icon: '\ud83d\udee9\ufe0f', fx: 'pulse', title: 'Quarry claimed', name: q[1] + ' (' + callsign(hit) + ')', desc: 'Quarry of the day' });
      }
    }

    // Badges.
    const ctx = {
      list: S.list, now, isMil: mil, distNM, seenCount: S.seen.length,
      claimCount: Object.keys(S.claims).length, streak: streakOf(S.claims, today),
    };
    for (const b of BADGES) {
      if (S.badges[b.id]) continue;
      let ok = false;
      try { ok = b.test(ctx); } catch (e) { ok = false; }
      if (ok) { S.badges[b.id] = Date.now(); messages.push({ icon: b.icon, fx: b.fx, title: 'Badge unlocked', name: b.name, desc: b.desc }); }
    }
    if (messages.length) { save('badges', S.badges); celebrate(messages); }

    // Overhead target = soonest pass within 2.5 NM of the viewer.
    const sunEl = sunElevation(now, st.lat, st.lon);
    let best = null;
    for (const a of S.list) {
      const e = overheadEta(a, st.lat, st.lon, 30);
      if (!e || e.missNM > 2.5) continue;
      if (!best || e.minutes < best.eta.minutes) best = { ac: a, eta: e };
    }
    if (best) best.vis = visibility(best.ac, best.eta.missNM, sunEl);
    S.target = best;

    scheduleRender();
  }

  // ---- achievement popups (queued so several unlocks play one after another)

  function celebrate(items) {
    S.achQueue = (S.achQueue || []).concat(items);
    if (!S.achBusy) nextCelebration();
  }

  // Black-out behind the achievement popups so they read clearly; it stays up for a whole queue
  // (no flicker between popups) and fades out when the last one finishes.
  function setScrim(on) {
    if (typeof document === 'undefined' || !document.body) return;
    let el = document.getElementById('skl-scrim');
    clearTimeout(S.scrimTimer);
    if (on) {
      if (!el) { el = document.createElement('div'); el.id = 'skl-scrim'; document.body.appendChild(el); }
      el.classList.remove('out');
    } else if (el) {
      el.classList.add('out');
      S.scrimTimer = setTimeout(() => el.remove(), 400);
    }
  }

  function nextCelebration() {
    const it = (S.achQueue || []).shift();
    if (!it || typeof document === 'undefined' || !document.body) { S.achBusy = false; setScrim(false); return; }
    setScrim(true);
    // Many unlocks at once (e.g. a first visit): play this one, then fold the rest into one summary.
    if (S.achQueue.length >= 2) {
      const rest = S.achQueue;
      S.achQueue = [{ icon: '\ud83c\udfc5', fx: 'pulse', title: 'More unlocked', name: '+' + rest.length + ' achievements',
                      desc: rest.map((r) => r.name).join(' \u00b7 ') }];
    }
    S.achBusy = true;
    const el = document.createElement('div');
    el.id = 'skl-ach';
    let pts = '';
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * 2 * Math.PI, r = 70 + (i % 3) * 22;
      pts += '<i class="pt" style="--x:' + Math.round(Math.cos(a) * r) + 'px;--y:' + Math.round(Math.sin(a) * r) +
             'px;background:' + (i % 2 ? '#ffb000' : '#00ff66') + ';animation-delay:' + (0.25 + (i % 4) * 0.04).toFixed(2) + 's"></i>';
    }
    el.innerHTML = pts + '<span class="ic fx-' + esc(it.fx || 'pulse') + '">' + it.icon + '</span><div class="k">' + esc(it.title) +
      '</div><div class="n">' + esc(it.name) + '</div><div class="d">' + esc(it.desc || '') + '</div>';
    document.body.appendChild(el);
    setTimeout(() => { el.remove(); nextCelebration(); }, 2800);
  }

  function clearAchievements() {
    S.badges = {}; S.claims = {}; S.seen = []; S.seenSet = null; S.achQueue = []; S.clearArmed = false;
    try { ['badges', 'claims', 'seen'].forEach((k) => localStorage.removeItem(LS + k)); } catch (e) { /* ignore */ }
    renderChip();
    if (S.panelOpen) renderPanel();
  }

  // ---- tap-a-plane animation: target-lock brackets + ping on the plane, a leader line drawn to the
  // info panel, and the panel unfolding out of the direction the plane is in. app.js calls this from
  // selectAircraft(); it never touches app state, only the DOM overlay and the panel's CSS class.

  function onSelect(ac) {
    if (typeof document === 'undefined' || reducedMotion()) return;
    const box = document.getElementById('radarContainer'), panel = document.getElementById('aircraft-detail');
    const pt = ac && ac.__pt;
    if (!box || !panel || !pt || !isFinite(pt.x) || !isFinite(pt.y)) return;
    const old = document.getElementById('skl-lock'); if (old) old.remove();

    const bR = box.getBoundingClientRect(), pR = panel.getBoundingClientRect();
    const px = pR.left - bR.left, py = pR.top - bR.top;
    const ox = clamp((pt.x - px) / Math.max(pR.width, 1) * 100, -30, 130);
    const oy = clamp((pt.y - py) / Math.max(pR.height, 1) * 100, -30, 130);
    panel.style.transformOrigin = ox.toFixed(0) + '% ' + oy.toFixed(0) + '%';
    panel.classList.remove('skl-unfold'); void panel.offsetWidth; panel.classList.add('skl-unfold');
    clearTimeout(S.unfoldTimer);
    S.unfoldTimer = setTimeout(() => { panel.classList.remove('skl-unfold'); panel.style.transformOrigin = ''; }, 1400);

    const tx = clamp(pt.x, px, px + pR.width), ty = clamp(pt.y, py, py + pR.height);
    const el = document.createElement('div');
    el.id = 'skl-lock';
    el.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + Math.round(bR.width) + ' ' + Math.round(bR.height) + '">' +
      '<line class="ldr" pathLength="1" x1="' + pt.x.toFixed(1) + '" y1="' + pt.y.toFixed(1) + '" x2="' + tx.toFixed(1) + '" y2="' + ty.toFixed(1) +
      '" stroke="#ffb000" stroke-width="1.5" stroke-dasharray="1" stroke-linecap="round"/>' +
      '<g transform="translate(' + pt.x.toFixed(1) + ' ' + pt.y.toFixed(1) + ')">' +
      '<circle class="png" r="10" fill="none" stroke="#00ff66" stroke-width="2"/>' +
      '<path class="brk" d="M-16 -8V-16H-8M8 -16H16V-8M16 8V16H8M-8 16H-16V8" fill="none" stroke="#ffb000" stroke-width="2.2" stroke-linecap="round"/>' +
      '</g></svg>';
    box.appendChild(el);
    setTimeout(() => el.remove(), 1700);
  }

  // ---- compass (device orientation)

  function onOrient(e) {
    let h = null;
    if (e.absolute === true && e.alpha != null && e.beta != null && e.gamma != null) {
      h = rearHeading(e.alpha, e.beta, e.gamma);
    } else if (typeof e.webkitCompassHeading === 'number') {
      h = e.webkitCompassHeading;   // iOS: already tilt-compensated and magnetic-north referenced
    } else { return; }
    S.heading = smoothAngle(S.heading, h, 0.25);
    if (e.beta != null && e.gamma != null) S.pitch = rearElevation(e.beta, e.gamma);
    scheduleRender();
  }

  async function enableCompass() {
    const status = document.getElementById('skl-compass-note');
    try {
      if (!window.isSecureContext) throw new Error('Compass needs HTTPS (or localhost).');
      if (typeof DeviceOrientationEvent === 'undefined') throw new Error('No orientation sensor in this browser.');
      if (typeof DeviceOrientationEvent.requestPermission === 'function') {
        const r = await DeviceOrientationEvent.requestPermission();
        if (r !== 'granted') throw new Error('Motion access was denied.');
      }
      window.addEventListener('deviceorientationabsolute', onOrient, true);
      window.addEventListener('deviceorientation', onOrient, true);
      S.compassOn = true;
      renderPanel();
    } catch (err) {
      if (status) status.textContent = err.message || 'Could not start the compass.';
    }
  }

  // ---- UI

  const CSS = `
  #skl-btn{position:fixed;right:.6rem;bottom:2.6rem;z-index:10002;background:var(--btn-bg,rgba(3,7,4,.75));
    border:1px solid var(--accent-amber-dim,#7a5a00);color:var(--accent-military,#ffb000);font-size:1rem;line-height:1;
    padding:.45rem .5rem;border-radius:50%;cursor:pointer}
  #skl-btn:hover{border-color:var(--accent-military,#ffb000)}
  #skl-btn .skl-dot{position:absolute;top:-2px;right:-2px;width:9px;height:9px;border-radius:50%;
    background:var(--accent-green,#00ff66);display:none}
  #skl-btn.live .skl-dot{display:block}
  #skl-chip{position:fixed;left:.6rem;bottom:2.6rem;z-index:10002;max-width:calc(100vw - 4.5rem);display:none;
    background:var(--btn-bg,rgba(3,7,4,.85));border:1px solid var(--accent-green,#00ff66);color:var(--accent-green,#00ff66);
    font:600 .78rem/1.3 system-ui,sans-serif;padding:.4rem .65rem;border-radius:.6rem;cursor:pointer}
  #skl-panel{position:fixed;right:.6rem;bottom:5.2rem;z-index:10005;width:min(22rem,calc(100vw - 1.2rem));
    max-height:calc(100vh - 7rem);overflow:auto;display:none;background:rgba(3,7,4,.96);color:#cfe;
    border:1px solid var(--accent-amber-dim,#7a5a00);border-radius:.8rem;padding:.8rem;font:.8rem/1.4 system-ui,sans-serif}
  #skl-panel.open{display:block}
  #skl-panel h3{margin:.1rem 0 .4rem;font-size:.8rem;letter-spacing:.08em;text-transform:uppercase;color:var(--accent-military,#ffb000)}
  #skl-panel .skl-card{border-top:1px solid rgba(255,255,255,.08);padding:.55rem 0}
  #skl-panel .skl-head{display:flex;justify-content:space-between;align-items:center}
  #skl-panel button.skl-x,#skl-panel button.skl-go{background:none;border:1px solid var(--accent-amber-dim,#7a5a00);
    color:var(--accent-military,#ffb000);border-radius:.4rem;padding:.2rem .55rem;cursor:pointer;font:inherit}
  .skl-bar{height:6px;border-radius:3px;background:rgba(255,255,255,.1);margin:.3rem 0}
  .skl-bar>i{display:block;height:100%;border-radius:3px;background:var(--accent-green,#00ff66)}
  .skl-badges{display:grid;grid-template-columns:repeat(2,1fr);gap:.35rem}
  .skl-b{border:1px solid rgba(255,255,255,.12);border-radius:.45rem;padding:.3rem .4rem;opacity:.4}
  .skl-b.on{opacity:1;border-color:var(--accent-green,#00ff66)}
  .skl-b b{display:block;font-size:.76rem}
  .skl-b span{font-size:.68rem;opacity:.8}
  .skl-note{font-size:.7rem;opacity:.7;margin-top:.25rem}
  .skl-desktop #skl-panel{width:min(26rem,calc(100vw - 1.2rem))}
  .skl-desktop .skl-b{transition:transform .15s,border-color .15s}
  .skl-desktop .skl-b:hover{transform:translateY(-2px);border-color:var(--accent-military,#ffb000)}
  .skl-kbd{border:1px solid var(--accent-amber-dim,#7a5a00);border-radius:.3rem;padding:0 .35rem;font-size:.68rem}
  @keyframes skl-pop{0%{opacity:0;transform:translateY(16px) scale(.9)}60%{opacity:1;transform:translateY(-3px) scale(1.01)}100%{opacity:1;transform:none}}
  @keyframes skl-rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
  @keyframes skl-ring{from{opacity:0;transform:rotate(-200deg) scale(.6)}to{opacity:1;transform:none}}
  @keyframes skl-fill{from{width:0}}
  @keyframes skl-ping{0%{box-shadow:0 0 0 0 rgba(255,176,0,.6)}100%{box-shadow:0 0 0 18px rgba(255,176,0,0)}}
  @keyframes skl-chip{from{opacity:0;transform:translateX(-24px)}to{opacity:1;transform:none}}
  #skl-panel.open{animation:skl-pop .42s cubic-bezier(.2,.9,.3,1.2) both;transform-origin:bottom right}
  .skl-fresh .skl-card{animation:skl-rise .5s cubic-bezier(.2,.8,.2,1) both;animation-delay:calc(var(--i,0) * 80ms)}
  .skl-fresh .skl-card svg{animation:skl-ring .9s cubic-bezier(.2,.8,.2,1) .15s both}
  .skl-fresh .skl-bar>i{animation:skl-fill .9s ease-out .3s both}
  .skl-fresh .skl-b.on{animation:skl-rise .4s both;animation-delay:calc(var(--j,0) * 45ms + .3s)}
  #skl-btn.live{animation:skl-ping 1.8s infinite}
  #skl-chip.in{animation:skl-chip .5s cubic-bezier(.2,.9,.3,1.2) both}
  @media (prefers-reduced-motion:reduce){
    #skl-panel.open,.skl-fresh .skl-card,.skl-fresh .skl-card svg,.skl-fresh .skl-bar>i,.skl-fresh .skl-b.on,
    #skl-btn.live,#skl-chip.in,#skl-ach,#skl-ach .ic,#skl-ach .pt,#skl-scrim,.skl-unfold,.skl-unfold>*,#skl-lock *{animation:none!important}
  }
  #skl-scrim{position:fixed;inset:0;z-index:20000;pointer-events:none;background:rgba(0,0,0,.85);animation:skl-scrim-in .35s ease both}
  #skl-scrim.out{animation:skl-scrim-out .35s ease both}
  @keyframes skl-scrim-in{from{opacity:0}to{opacity:1}}
  @keyframes skl-scrim-out{from{opacity:1}to{opacity:0}}
  #skl-ach{position:fixed;left:50%;top:18%;transform:translateX(-50%);z-index:20001;pointer-events:none;text-align:center;
    min-width:15rem;max-width:calc(100vw - 2rem);background:rgba(3,7,4,.96);border:1px solid var(--accent-military,#ffb000);
    border-radius:1rem;padding:.9rem 1.2rem;color:#cfe;font:.8rem/1.4 system-ui,sans-serif;box-shadow:0 0 28px rgba(255,176,0,.35);
    animation:skl-ach-in .55s cubic-bezier(.2,.9,.3,1.3) both,skl-ach-out .5s ease 2.25s forwards}
  #skl-ach .ic{display:block;font-size:2.4rem;line-height:1.2}
  #skl-ach .k{font-size:.62rem;letter-spacing:.25em;text-transform:uppercase;color:var(--accent-military,#ffb000)}
  #skl-ach .n{font-size:1.05rem;font-weight:700;color:#fff}
  #skl-ach .d{opacity:.75;font-size:.72rem}
  #skl-ach .pt{position:absolute;left:50%;top:38%;width:6px;height:6px;border-radius:50%;animation:skl-pt .9s ease-out both}
  .fx-spin{animation:skl-fx-spin .9s cubic-bezier(.2,.8,.2,1) .3s both}
  .fx-shake{animation:skl-fx-shake .7s ease .3s both}
  .fx-bounce{animation:skl-fx-bounce .9s ease .3s both}
  .fx-flash{animation:skl-fx-flash .8s steps(2,jump-none) .3s 3 both}
  .fx-glow{animation:skl-fx-glow 1.2s ease .3s 2 both}
  .fx-pulse{animation:skl-fx-pulse .6s ease .3s 3 both}
  @keyframes skl-ach-in{from{opacity:0;transform:translateX(-50%) translateY(-34px) scale(.7)}to{opacity:1;transform:translateX(-50%)}}
  @keyframes skl-ach-out{to{opacity:0;transform:translateX(-50%) translateY(-22px)}}
  @keyframes skl-pt{from{opacity:1;transform:translate(0,0) scale(1)}to{opacity:0;transform:translate(var(--x),var(--y)) scale(.2)}}
  @keyframes skl-fx-spin{from{transform:rotate(-360deg) scale(.3)}to{transform:none}}
  @keyframes skl-fx-shake{0%,100%{transform:none}20%{transform:translateX(-8px) rotate(-8deg)}40%{transform:translateX(8px) rotate(8deg)}60%{transform:translateX(-5px)}80%{transform:translateX(5px)}}
  @keyframes skl-fx-bounce{0%{transform:translateY(-26px)}40%{transform:translateY(0)}60%{transform:translateY(-12px)}80%{transform:translateY(0)}100%{transform:none}}
  @keyframes skl-fx-flash{0%{filter:brightness(1)}50%{filter:brightness(2.4) drop-shadow(0 0 10px #ff3333)}}
  @keyframes skl-fx-glow{0%,100%{filter:none}50%{filter:drop-shadow(0 0 14px #ffb000)}}
  @keyframes skl-fx-pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.35)}}
  #skl-lock{position:absolute;inset:0;z-index:10001;pointer-events:none;overflow:hidden;animation:skl-lock-out .4s ease 1.2s forwards}
  #skl-lock svg{width:100%;height:100%;display:block}
  #skl-lock .brk{animation:skl-lock-in .65s cubic-bezier(.2,.9,.3,1.2) both}
  #skl-lock .png{animation:skl-lock-ping .9s ease-out both}
  #skl-lock .ldr{stroke-dasharray:1;animation:skl-lock-line .55s ease-out .2s both}
  @keyframes skl-lock-in{from{opacity:0;transform:scale(2.8) rotate(90deg)}to{opacity:1;transform:none}}
  @keyframes skl-lock-ping{from{opacity:.9;transform:scale(1)}to{opacity:0;transform:scale(4.5)}}
  @keyframes skl-lock-line{from{stroke-dashoffset:1;opacity:1}to{stroke-dashoffset:0;opacity:.85}}
  @keyframes skl-lock-out{to{opacity:0}}
  .skl-unfold{animation:skl-unfold .55s cubic-bezier(.2,.9,.3,1.15) both}
  .skl-unfold>*{animation:skl-ad-row .4s cubic-bezier(.2,.8,.2,1) both}
  @keyframes skl-unfold{from{opacity:0;transform:scale(.5)}60%{opacity:1;transform:scale(1.025)}to{opacity:1;transform:none}}
  @keyframes skl-ad-row{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
  ${[1,2,3,4,5,6,7,8,9,10,11,12].map((n) => '.skl-unfold>*:nth-child(' + n + '){animation-delay:' + (0.18 + n * 0.05).toFixed(2) + 's}').join('\n  ')}
  #skl-boot{position:fixed;inset:0;z-index:20000;pointer-events:none;display:flex;align-items:center;justify-content:center;
    flex-direction:column;background:radial-gradient(circle at 50% 50%,rgba(0,255,102,.09),rgba(0,255,102,0) 60%),#000;
    animation:skl-boot-out .6s ease 1.5s forwards}
  #skl-boot .r,#skl-boot .sw{position:absolute;width:min(70vmin,34rem);height:min(70vmin,34rem);border-radius:50%}
  #skl-boot .r{border:1px solid rgba(0,255,102,.35);animation:skl-ringin .6s ease both}
  #skl-boot .r:nth-child(1){--s:1}#skl-boot .r:nth-child(2){--s:.66;animation-delay:.12s}#skl-boot .r:nth-child(3){--s:.33;animation-delay:.24s}
  #skl-boot .sw{background:conic-gradient(from 0deg,rgba(0,255,102,.55),rgba(0,255,102,0) 28%,rgba(0,255,102,0));animation:skl-sweep .75s linear 2}
  #skl-boot .bl{position:absolute;width:8px;height:8px;border-radius:50%;background:#00ff66;animation:skl-blip 1.5s ease both}
  #skl-boot .t{position:relative;font:700 1.1rem system-ui,sans-serif;color:#00ff66;text-transform:uppercase;
    animation:skl-title .9s cubic-bezier(.2,.8,.2,1) .2s both}
  #skl-boot .m{position:relative;margin-top:.5rem;font:.75rem system-ui,sans-serif;color:#7a5a00;animation:skl-title .9s ease .5s both}
  @keyframes skl-ringin{from{opacity:0;transform:scale(calc(var(--s,1) * .4))}to{opacity:1;transform:scale(var(--s,1))}}
  @keyframes skl-sweep{to{transform:rotate(360deg)}}
  @keyframes skl-title{from{opacity:0;letter-spacing:.9em}to{opacity:1;letter-spacing:.3em}}
  @keyframes skl-blip{0%,20%{opacity:0;transform:scale(.2)}40%{opacity:1;transform:scale(1.6)}100%{opacity:.15;transform:scale(1)}}
  @keyframes skl-boot-out{to{opacity:0;visibility:hidden}}`;

  function ensureUI() {
    if (document.getElementById('skl-btn')) return;
    const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);
    document.documentElement.classList.add(S.desktop ? 'skl-desktop' : 'skl-touch');
    const btn = document.createElement('button');
    btn.id = 'skl-btn'; btn.type = 'button'; btn.title = S.desktop ? 'Sky Ledger (press L)' : 'Sky Ledger';
    btn.innerHTML = '\ud83d\udef0<span class="skl-dot"></span>';
    btn.addEventListener('click', () => togglePanel());
    const chip = document.createElement('button'); chip.id = 'skl-chip'; chip.type = 'button';
    chip.addEventListener('click', () => togglePanel(true));
    const panel = document.createElement('div'); panel.id = 'skl-panel'; panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Sky Ledger');
    panel.addEventListener('click', (e) => {
      if (e.target.closest('.skl-x')) togglePanel(false);
      if (e.target.closest('#skl-compass-go')) enableCompass();
      if (e.target.closest('#skl-clear')) {
        if (S.clearArmed) { clearTimeout(S.clearTimer); clearAchievements(); return; }
        S.clearArmed = true; renderPanel();
        S.clearTimer = setTimeout(() => { S.clearArmed = false; if (S.panelOpen) renderPanel(); }, 3000);
      }
    });
    document.body.append(btn, chip, panel);
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = e.target && e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target && e.target.isContentEditable)) return;
      if (e.key === 'l' || e.key === 'L') togglePanel();
      else if (e.key === 'Escape' && S.panelOpen) togglePanel(false);
    });
  }

  function togglePanel(force) {
    if (S.introPending) return;
    const want = typeof force === 'boolean' ? force : !S.panelOpen;
    if (want && !S.panelOpen && bootIntro()) {
      S.introPending = true;
      setTimeout(() => { S.introPending = false; togglePanel(true); }, 1500);
      return;
    }
    S.panelOpen = want;
    const p = document.getElementById('skl-panel');
    if (p) {
      p.classList.toggle('open', S.panelOpen);
      if (S.panelOpen) {
        p.classList.add('skl-fresh');
        clearTimeout(S.freshTimer);
        S.freshTimer = setTimeout(() => p.classList.remove('skl-fresh'), 1400);
      }
    }
    if (S.panelOpen) renderPanel();
  }

  function scheduleRender() {
    if (S.raf) return;
    S.raf = requestAnimationFrame(() => { S.raf = 0; renderChip(); if (S.panelOpen) renderPanel(); });
  }

  function etaText(m) { return m < 1 ? 'now' : 'in ' + Math.round(m) + ' min'; }

  function renderChip() {
    ensureUI();
    const chip = document.getElementById('skl-chip'), btn = document.getElementById('skl-btn');
    const t = S.target;
    if (t && t.eta.minutes <= 15) {
      chip.style.display = 'block';
      chip.textContent = '\u2708 ' + callsign(t.ac) + ' overhead ' + etaText(t.eta.minutes) + ' \u00b7 ' + t.vis.label;
      btn.classList.add('live');
      if (!S.chipShown) { chip.classList.remove('in'); void chip.offsetWidth; chip.classList.add('in'); }
      S.chipShown = true;
    } else { chip.style.display = 'none'; btn.classList.remove('live'); S.chipShown = false; }
  }

  function compassSVG() {
    const st = station();
    const t = S.target;
    let pointer = null;
    if (t) {
      const a = t.ac, brg = bearingDeg(st.lat, st.lon, a.lat, a.lon);
      const alt = airborneAlt(a) || 0;
      const elev = Math.atan2(alt / NM_FT, Math.max(distNM(a), 0.05)) / RAD;
      pointer = { brg, elev };
    }
    const rot = S.compassOn && S.heading !== null ? -S.heading : 0;
    let dot = '';
    if (pointer) {
      const x = 100 + 70 * Math.sin(pointer.brg * RAD), y = 100 - 70 * Math.cos(pointer.brg * RAD);
      dot = '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="6" fill="#00ff66"/>';
    }
    return '<svg viewBox="0 0 200 200" width="150" height="150" aria-hidden="true">' +
      '<g transform="rotate(' + rot.toFixed(1) + ' 100 100)">' +
      '<circle cx="100" cy="100" r="82" fill="none" stroke="#7a5a00" stroke-width="2"/>' +
      '<text x="100" y="26" text-anchor="middle" fill="#ffb000" font-size="16" font-weight="700">N</text>' +
      '<text x="178" y="106" text-anchor="middle" fill="#7a5a00" font-size="13">E</text>' +
      '<text x="100" y="188" text-anchor="middle" fill="#7a5a00" font-size="13">S</text>' +
      '<text x="22" y="106" text-anchor="middle" fill="#7a5a00" font-size="13">W</text>' + dot + '</g>' +
      '<path d="M100 8 L94 22 L106 22 Z" fill="#ffb000"/></svg>';
  }

  function guidance() {
    const st = station(), t = S.target;
    if (!t) return 'Nothing is due overhead right now.';
    const a = t.ac, brg = bearingDeg(st.lat, st.lon, a.lat, a.lon);
    const alt = airborneAlt(a) || 0;
    const elev = Math.atan2(alt / NM_FT, Math.max(distNM(a), 0.05)) / RAD;
    if (!S.compassOn || S.heading === null) return 'Currently bearing ' + Math.round(brg) + '\u00b0, ' + Math.round(elev) + '\u00b0 above the horizon.';
    const d = ((brg - S.heading + 540) % 360) - 180;
    const turn = Math.abs(d) < 5 ? 'On target' : (d > 0 ? 'Turn right ' : 'Turn left ') + Math.round(Math.abs(d)) + '\u00b0';
    let tilt = '';
    if (S.pitch !== null) {
      const dp = elev - S.pitch;
      tilt = Math.abs(dp) < 5 ? ' \u00b7 height good' : (dp > 0 ? ' \u00b7 tilt up ' : ' \u00b7 tilt down ') + Math.round(Math.abs(dp)) + '\u00b0';
    } else { tilt = ' \u00b7 look up ' + Math.round(elev) + '\u00b0'; }
    return turn + tilt;
  }

  function renderPanel() {
    ensureUI();
    const el = document.getElementById('skl-panel');
    const today = dateKey(), q = quarryFor(today), claimed = S.claims[today];
    const streak = streakOf(S.claims, today), t = S.target;

    const over = t
      ? '<b>' + esc(callsign(t.ac)) + '</b> ' + esc(t.ac.t || '') + ' passes ' + etaText(t.eta.minutes) +
        ', about ' + t.eta.missNM.toFixed(1) + ' NM from you at ' + Math.round((airborneAlt(t.ac) || 0) / 100) * 100 + ' ft.' +
        '<div class="skl-bar"><i style="width:' + t.vis.score + '%"></i></div>' +
        '<b>' + esc(t.vis.label) + '</b> \u00b7 visibility ' + t.vis.score + '/100 <span class="skl-note">(size, height and light only - not cloud)</span>'
      : 'No aircraft due directly overhead in the next 30 minutes.';

    const compassBtn = (S.compassOn || S.desktop) ? '' :
      '<button class="skl-go" id="skl-compass-go" type="button">Enable phone compass</button>';

    const badges = BADGES.map((b, j) => '<div class="skl-b' + (S.badges[b.id] ? ' on' : '') + '" style="--j:' + j + '"><b>' + b.icon + ' ' + esc(b.name) +
      '</b><span>' + esc(b.desc) + '</span></div>').join('');

    el.innerHTML =
      '<div class="skl-head"><h3>Sky Ledger' + (S.desktop ? ' <span class="skl-kbd">L</span>' : '') + '</h3><button class="skl-x" type="button" aria-label="Close">\u2715</button></div>' +
      '<div class="skl-card" style="--i:0"><h3>Overhead</h3>' + over + '</div>' +
      '<div class="skl-card" style="--i:1"><h3>Look this way</h3><div style="display:flex;gap:.6rem;align-items:center">' + compassSVG() +
      '<div><div>' + esc(guidance()) + '</div>' + compassBtn +
      '<div class="skl-note" id="skl-compass-note">' + (S.desktop
        ? 'North-up view. Open this page on your phone for the live compass.'
        : 'Hold the phone upright, rear camera towards the sky. Wave it in a figure-8 if it drifts.') + '</div></div></div></div>' +
      '<div class="skl-card" style="--i:2"><h3>Quarry of the day</h3><b>' + esc(q[1]) + '</b> (' + q[0] + ') \u00b7 ' +
      (claimed ? 'claimed \u2713 ' + esc(claimed.cs) : 'still hunting') +
      '<div class="skl-note">Claim streak: ' + streak + ' day' + (streak === 1 ? '' : 's') + '</div></div>' +
      '<div class="skl-card" style="--i:3"><h3>Badges ' + Object.keys(S.badges).length + '/' + BADGES.length + '</h3><div class="skl-badges">' + badges + '</div>' +
      '<div style="margin-top:.5rem"><button class="skl-go" id="skl-clear" type="button">' +
      (S.clearArmed ? 'Tap again to wipe everything' : 'Clear achievements') + '</button>' +
      '<div class="skl-note">Resets badges, quarry claims, streak and your logged-aircraft count.</div></div></div>';
  }

  // Short radar-sweep splash. Plays the first time the Ledger is opened in a browser session (never
  // on page load), then the panel opens. Skipped for reduced-motion users; ?intro=1 replays it
  // on every first open. Returns true if it played.
  function bootIntro() {
    try {
      const force = /[?&]intro=1\b/.test(location.search);
      if (reducedMotion() || (!force && sessionStorage.getItem(LS + 'intro'))) return false;
      sessionStorage.setItem(LS + 'intro', '1');
    } catch (e) { return false; }
    ensureUI();
    const el = document.createElement('div');
    el.id = 'skl-boot';
    const blips = [[38, 30], [62, 58], [48, 70]].map((p) =>
      '<i class="bl" style="left:' + p[0] + '%;top:' + p[1] + '%;animation-delay:' + (0.3 + p[0] / 100).toFixed(2) + 's"></i>').join('');
    el.innerHTML = '<i class="r"></i><i class="r"></i><i class="r"></i><i class="sw"></i>' + blips +
      '<div class="t">Sky Ledger</div><div class="m">' + (S.desktop ? 'desktop mode \u00b7 press L' : 'touch mode \u00b7 compass ready') + '</div>';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2300);
    return true;
  }

  function init() {
    if (typeof document === 'undefined') return;
    const go = () => { ensureUI(); renderChip(); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else go();
    try { console.log('%cSky Ledger ' + SIGNATURE, 'color:#ffb000'); } catch (e) { /* ignore */ }
  }

  const api = {
    tick, init, onSelect, SIGNATURE,
    _t: { detectDesktop, overheadEta, sunElevation, visibility, quarryFor, streakOf, dateKey, rearHeading, rearElevation,
          smoothAngle, bearingDeg, offsetNM, BADGES, QUARRY_POOL },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SkyLedger = api;
  init();
})(typeof window !== 'undefined' ? window : globalThis);
