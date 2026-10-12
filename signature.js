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
    { id: 'first-light', name: 'First Light', desc: 'Log your first aircraft', test: (c) => c.seenCount >= 1 },
    { id: 'rotor-head', name: 'Rotor Head', desc: 'Spot a helicopter', test: (c) => c.list.some((a) => a.category === 'A7') },
    { id: 'khaki-hour', name: 'Khaki Hour', desc: 'Spot a military aircraft', test: (c) => c.list.some((a) => c.isMil(a)) },
    { id: 'squawk-witness', name: 'Squawk Witness', desc: 'See a 7500, 7600 or 7700 squawk',
      test: (c) => c.list.some((a) => ['7500', '7600', '7700'].includes(String(a.squawk))) },
    { id: 'heavy-metal', name: 'Heavy Metal', desc: 'Spot a heavy jet',
      test: (c) => c.list.some((a) => a.category === 'A5' || a.category === 'A6' || HEAVY_TYPES.has(String(a.t || '').toUpperCase())) },
    { id: 'low-and-slow', name: 'Low & Slow', desc: 'Aircraft under 1,500 ft and 120 kt within 3 NM',
      test: (c) => c.list.some((a) => typeof a.alt_baro === 'number' && a.alt_baro < 1500 && Number(a.gs) < 120 &&
        typeof a.lat === 'number' && c.distNM(a) <= 3) },
    { id: 'night-owl', name: 'Night Owl', desc: 'Log an aircraft between 01:00 and 04:00',
      test: (c) => c.list.length > 0 && c.now.getHours() >= 1 && c.now.getHours() < 4 },
    { id: 'quarry-hunter', name: 'Quarry Hunter', desc: 'Claim a Quarry of the day', test: (c) => c.claimCount >= 1 },
    { id: 'seven-sevens', name: 'Seven Sevens', desc: 'Claim the Quarry 7 days in a row', test: (c) => c.streak >= 7 },
    { id: 'triple-digits', name: 'Triple Digits', desc: 'Log 100 different aircraft', test: (c) => c.seenCount >= 100 },
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
        messages.push('Quarry claimed: ' + q[1] + ' (' + callsign(hit) + ')');
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
      if (ok) { S.badges[b.id] = Date.now(); messages.push('Badge: ' + b.name); }
    }
    if (messages.length) { save('badges', S.badges); toast(messages.join('  \u00b7  ')); }

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
    #skl-btn.live,#skl-chip.in{animation:none!important}
  }
  #skl-boot{position:fixed;inset:0;z-index:20000;pointer-events:none;display:flex;align-items:center;justify-content:center;
    flex-direction:column;background:radial-gradient(circle at 50% 50%,rgba(0,255,102,.1),rgba(2,6,3,.96) 70%);
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
    S.panelOpen = typeof force === 'boolean' ? force : !S.panelOpen;
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

    const badges = BADGES.map((b, j) => '<div class="skl-b' + (S.badges[b.id] ? ' on' : '') + '" style="--j:' + j + '"><b>' + esc(b.name) +
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
      '<div class="skl-card" style="--i:3"><h3>Badges ' + Object.keys(S.badges).length + '/' + BADGES.length + '</h3><div class="skl-badges">' + badges + '</div></div>';
  }

  // Short radar-sweep splash, once per browser session. Skipped for reduced-motion users and on the
  // localhost wall board (so a kiosk reload isn't interrupted); add ?intro=1 to force it.
  function bootIntro() {
    try {
      const force = /[?&]intro=1\b/.test(location.search);
      const kiosk = ['localhost', '127.0.0.1'].includes(location.hostname);
      if (reducedMotion() || (!force && (kiosk || sessionStorage.getItem(LS + 'intro')))) return;
      sessionStorage.setItem(LS + 'intro', '1');
    } catch (e) { return; }
    ensureUI();
    const el = document.createElement('div');
    el.id = 'skl-boot';
    const blips = [[38, 30], [62, 58], [48, 70]].map((p) =>
      '<i class="bl" style="left:' + p[0] + '%;top:' + p[1] + '%;animation-delay:' + (0.3 + p[0] / 100).toFixed(2) + 's"></i>').join('');
    el.innerHTML = '<i class="r"></i><i class="r"></i><i class="r"></i><i class="sw"></i>' + blips +
      '<div class="t">Sky Ledger</div><div class="m">' + (S.desktop ? 'desktop mode \u00b7 press L' : 'touch mode \u00b7 compass ready') + '</div>';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2300);
  }

  function init() {
    if (typeof document === 'undefined') return;
    const go = () => { ensureUI(); renderChip(); bootIntro(); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else go();
    try { console.log('%cSky Ledger ' + SIGNATURE, 'color:#ffb000'); } catch (e) { /* ignore */ }
  }

  const api = {
    tick, init, SIGNATURE,
    _t: { detectDesktop, overheadEta, sunElevation, visibility, quarryFor, streakOf, dateKey, rearHeading, rearElevation,
          smoothAngle, bearingDeg, offsetNM, BADGES, QUARRY_POOL },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SkyLedger = api;
  init();
})(typeof window !== 'undefined' ? window : globalThis);
