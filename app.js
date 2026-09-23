if (new URLSearchParams(window.location.search).get('debug') === '1') {
      const erudaScript = document.createElement('script');
      erudaScript.src = 'https://cdn.jsdelivr.net/npm/eruda';
      erudaScript.onload = () => window.eruda && window.eruda.init();
      document.head.appendChild(erudaScript);
    }

// Node.js CORS proxy (see cors-proxy/server.js) - forwards both the
    // adsb.fi point-lookup and the adsb.lol routeset POST, since neither
    // upstream sends Access-Control-Allow-Origin for browser requests from
    // arbitrary origins. Shared at module scope since both fetchLiveFlights()
    // and queryAdsbLolRoute() need it.
    //
    // Self-hosted on the Pi now: server.js serves this page itself AND the
    // proxy routes from one process on one port, so WORKER_URL is just ''
    // (same origin the page was loaded from) rather than a separate
    // hostname/port. That matters because the page is reached through a
    // cloudflared tunnel, which only forwards one local port - a second port
    // for the proxy wouldn't be reachable from wherever the tunnel is being
    // viewed. Same-origin works unchanged on localhost, through the
    // throwaway trycloudflare.com tunnel, and once aero-sentry.co.uk is live.
    const WORKER_URL = location.origin;
    // No second instance when self-hosting on the Pi.
    const WORKER_URL_BACKUP = null;
    const ROUTESET_PATH = '/api/0/routeset';
    const userConfig = { lat: 52.9529, lon: -0.9547, radiusNM: 35 };

    // ---------------------------------------------------------------------
    // User settings: units, theme and feature toggles (the ⚙️ panel)
    // ---------------------------------------------------------------------
    // Saved in localStorage. A shared link's query params (see buildShareLink) override the saved
    // values for that visit only - they aren't written back until someone changes a setting in
    // the panel. Every storage access is wrapped in try/catch: some browsers (private mode,
    // locked-down kiosk profiles) throw on localStorage.
    const SETTINGS_KEY = 'radarSettings';
    const SETTINGS_DEFAULTS = {
      speed: 'kts', alt: 'ft', dist: 'nm', theme: 'green',
      rareAlerts: true, shareLocation: true
    };
    const SPEED_UNITS = {
      kts: { label: 'kts', perKt: 1, spoken: 'knots' },
      mph: { label: 'mph', perKt: 1.15078, spoken: 'miles per hour' },
      kmh: { label: 'km/h', perKt: 1.852, spoken: 'kilometres per hour' }
    };
    const ALT_UNITS = {
      ft: { label: 'ft', perFt: 1, spoken: 'feet' },
      m: { label: 'm', perFt: 0.3048, spoken: 'metres' }
    };
    const DIST_UNITS = {
      nm: { label: 'NM', perNm: 1, spoken: 'nautical miles' },
      mi: { label: 'mi', perNm: 1.15078, spoken: 'miles' },
      km: { label: 'km', perNm: 1.852, spoken: 'kilometres' }
    };
    // accent/rgb drive the highlight colour everywhere (CSS variables + the canvas scope); the
    // rest tint the dark panels to match. Amber (military) and red (emergency) are meaningful
    // colours, so they deliberately stay the same in every theme.
    const THEMES = {
      green:  { label: 'Green',  accent: '#00ff66', rgb: '0, 255, 102',   bg: '#030704', card: 'rgba(5, 15, 9, 0.95)',   border: '#0f381f', dim: '#2b7a4b', input: '#061a0d', tint: 'rgba(10, 30, 18, 0.8)', soft: 'rgba(15, 56, 31, 0.6)', btn: 'rgba(3, 7, 4, 0.75)' },
      ice:    { label: 'Ice',    accent: '#4dd0ff', rgb: '77, 208, 255',  bg: '#030608', card: 'rgba(5, 10, 16, 0.95)',  border: '#0f2f42', dim: '#2b6a85', input: '#06131c', tint: 'rgba(10, 28, 40, 0.8)', soft: 'rgba(15, 47, 66, 0.6)', btn: 'rgba(3, 6, 8, 0.75)' },
      violet: { label: 'Violet', accent: '#c792ff', rgb: '199, 146, 255', bg: '#06030a', card: 'rgba(12, 6, 20, 0.95)',  border: '#2c1a45', dim: '#6a4a8c', input: '#0f0719', tint: 'rgba(26, 14, 42, 0.8)', soft: 'rgba(44, 26, 69, 0.6)', btn: 'rgba(6, 3, 10, 0.75)' },
      mono:   { label: 'Mono',   accent: '#e8e8e8', rgb: '232, 232, 232', bg: '#050505', card: 'rgba(12, 12, 12, 0.95)', border: '#2a2a2a', dim: '#7a7a7a', input: '#101010', tint: 'rgba(28, 28, 28, 0.8)', soft: 'rgba(42, 42, 42, 0.6)', btn: 'rgba(5, 5, 5, 0.75)' }
    };

    function sanitizeSettings(raw) {
      const out = Object.assign({}, SETTINGS_DEFAULTS);
      if (!raw || typeof raw !== 'object') return out;
      const has = (obj, key) => typeof key === 'string' && Object.prototype.hasOwnProperty.call(obj, key);
      if (has(SPEED_UNITS, raw.speed)) out.speed = raw.speed;
      if (has(ALT_UNITS, raw.alt)) out.alt = raw.alt;
      if (has(DIST_UNITS, raw.dist)) out.dist = raw.dist;
      if (has(THEMES, raw.theme)) out.theme = raw.theme;
      ['rareAlerts', 'shareLocation'].forEach((k) => {
        if (typeof raw[k] === 'boolean') out[k] = raw[k];
      });
      return out;
    }
    function readStoredSettings() {
      try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'); } catch (e) { return null; }
    }
    // Settings a shared link can carry - see buildShareLink() for the writing side.
    function readUrlSettings() {
      const q = new URLSearchParams(window.location.search);
      const o = {};
      if (q.get('spd')) o.speed = q.get('spd');
      if (q.get('alt')) o.alt = q.get('alt');
      if (q.get('dst')) o.dist = q.get('dst');
      if (q.get('theme')) o.theme = q.get('theme');
      if (q.has('rare')) o.rareAlerts = q.get('rare') !== '0';
      return o;
    }
    const settings = sanitizeSettings(Object.assign({}, readStoredSettings(), readUrlSettings()));
    function saveSettings() {
      try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {}
    }

    // --- Unit formatting. Everything upstream (ADS-B) is knots / feet / nautical miles; these
    // convert at the last moment for display and for speech.
    function fmtSpeed(kts) {
      const u = SPEED_UNITS[settings.speed];
      return `${Math.round(kts * u.perKt)} ${u.label}`;
    }
    // Chosen unit first, then a familiar second one (mph if you picked knots, otherwise knots).
    function fmtSpeedBoth(kts) {
      const second = settings.speed === 'kts' ? SPEED_UNITS.mph : SPEED_UNITS.kts;
      return `${fmtSpeed(kts)} · ${Math.round(kts * second.perKt)} ${second.label}`;
    }
    function fmtAlt(ft, plain) {
      const u = ALT_UNITS[settings.alt];
      const v = Math.round(ft * u.perFt);
      return `${plain ? v : v.toLocaleString('en-GB')} ${u.label}`;
    }
    // ADS-B altitude is a number, the string 'ground', or missing.
    function fmtAltOrGround(alt, plain) {
      const n = Number(alt);
      return (alt && Number.isFinite(n)) ? fmtAlt(n, plain) : 'Ground';
    }
    function fmtDist(nm, digits) {
      const u = DIST_UNITS[settings.dist];
      return `${(nm * u.perNm).toFixed(digits === undefined ? 1 : digits)} ${u.label}`;
    }
    // Vertical rate arrives in ft/min. Metric shows the aviation-standard m/s.
    function fmtVRate(ftPerMin, short) {
      if (settings.alt === 'm') return `${(Math.abs(ftPerMin) * 0.3048 / 60).toFixed(1)} m/s`;
      return `${Math.round(Math.abs(ftPerMin))} ${short ? 'ft/m' : 'ft/min'}`;
    }
    function spokenAlt(ft) {
      const n = Number(ft);
      if (!ft || !Number.isFinite(n)) return 'ground level';
      const u = ALT_UNITS[settings.alt];
      return `${Math.round(n * u.perFt)} ${u.spoken}`;
    }
    function spokenSpeed(kts) {
      const u = SPEED_UNITS[settings.speed];
      const main = `${Math.round(kts * u.perKt)} ${u.spoken}`;
      // Keep the original "knots, or miles per hour" phrasing when knots are selected.
      return settings.speed === 'kts' ? `${main}, or ${Math.round(kts * SPEED_UNITS.mph.perKt)} miles per hour` : main;
    }
    function spokenDist(nm) {
      const u = DIST_UNITS[settings.dist];
      return `${(nm * u.perNm).toFixed(1)} ${u.spoken}`;
    }
    // Altitude-legend label for band i (bands are defined in feet; see ALTITUDE_BANDS).
    function altitudeBandLabel(i) {
      const u = ALT_UNITS[settings.alt];
      const round = (ft) => {
        const v = ft * u.perFt;
        return (settings.alt === 'm' ? Math.round(v / 10) * 10 : Math.round(v)).toLocaleString('en-GB');
      };
      const lo = i === 0 ? null : ALTITUDE_BANDS[i - 1].maxFt;
      const hi = ALTITUDE_BANDS[i].maxFt;
      if (lo === null) return `< ${round(hi)} ${u.label}`;
      if (hi === Infinity) return `${round(lo)}+ ${u.label}`;
      return `${round(lo)}–${round(hi)} ${u.label}`;
    }

    // --- Theme. CSS reads the variables; the canvas scope reads accentRgba()/currentTheme().
    function currentTheme() { return THEMES[settings.theme] || THEMES.green; }
    function accentRgba(alpha) { return `rgba(${currentTheme().rgb}, ${alpha})`; }
    function applyTheme() {
      const t = currentTheme();
      const st = document.documentElement.style;
      st.setProperty('--accent-green', t.accent);
      st.setProperty('--text-main', t.accent);
      st.setProperty('--accent-rgb', t.rgb);
      st.setProperty('--bg-color', t.bg);
      st.setProperty('--card-bg', t.card);
      st.setProperty('--card-border', t.border);
      st.setProperty('--text-dim', t.dim);
      st.setProperty('--input-bg', t.input);
      st.setProperty('--tint-bg', t.tint);
      st.setProperty('--border-soft', t.soft);
      st.setProperty('--btn-bg', t.btn);
      document.documentElement.dataset.theme = settings.theme;
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', t.bg);
    }
    applyTheme();
    let settingsOpen = false; // the ⚙️ panel; the debug keyboard shortcuts stay quiet while it's open

    // --- Postcode-based station location ---------------------------------
    // Supports linking to e.g. {site}/radar/AB12 3CD - looks for a URL path
    // segment immediately after one literally named "radar" and, if present,
    // treats it as a UK postcode to geocode and re-centre the station on.
    // Falls back to the hardcoded userConfig above whenever there's no such
    // segment, the segment isn't a plausible postcode shape, or the lookup
    // fails for any reason (network error, unmatched postcode, etc.) - this
    // never blocks the radar from starting with its normal default.
    //
    // Uses postcodes.io: free, no API key, and (unlike the ADS-B APIs above)
    // it actually sends Access-Control-Allow-Origin, so no proxy is needed
    // here.
    function extractPostcodeFromPath() {
      const segments = window.location.pathname.split('/').map(decodeURIComponent).filter(Boolean);
      const radarIndex = segments.findIndex((seg) => seg.toLowerCase() === 'radar');
      if (radarIndex === -1 || radarIndex === segments.length - 1) return null;
      return segments[radarIndex + 1];
    }

    // UK postcodes: an outward code (2-4 chars) followed by an inward code
    // that's always exactly 3 characters (a digit then 2 letters). Accepts
    // input with or without a space between the two (a link typed/shared
    // without the space is common) and re-inserts it in the right place.
    function normalizePostcode(raw) {
      const compact = raw.replace(/[^a-z0-9]/gi, '').toUpperCase();
      if (compact.length < 5 || compact.length > 7) return null;
      return `${compact.slice(0, -3)} ${compact.slice(-3)}`;
    }

    function formatStationLabel(lat, lon) {
      const latDir = lat >= 0 ? 'N' : 'S';
      const lonDir = lon >= 0 ? 'E' : 'W';
      return `Station: ${Math.abs(lat).toFixed(4)}° ${latDir}, ${Math.abs(lon).toFixed(4)}° ${lonDir}`;
    }

    // --- Cookies (postcode only) -------------------------------------------
    function setCookie(name, value, days) {
      const expires = new Date(Date.now() + days * 86400000).toUTCString();
      document.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/; SameSite=Lax`;
    }
    function getCookie(name) {
      const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
      return match ? decodeURIComponent(match[1]) : null;
    }
    const POSTCODE_COOKIE = 'radar_postcode';
    // Bump the _v1 suffix (and update the note in the postcode overlay + about.html) if the
    // cookie notice's wording ever changes materially - that's what re-forces everyone with a
    // saved postcode through the overlay once, the same way this version did.
    const PRIVACY_ACK_COOKIE = 'radar_privacy_ack_v1';

    // Shared by the URL-based override below, the saved-cookie lookup, and the manual
    // postcode-entry form - one place that actually talks to postcodes.io.
    async function geocodePostcode(rawInput) {
      const postcode = normalizePostcode(rawInput);
      if (!postcode) return { error: 'not-a-postcode' };
      try {
        const res = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(postcode)}`, {
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) return { error: 'lookup-failed' };
        const data = await res.json();
        const result = data && data.result;
        if (!result || !Number.isFinite(result.latitude) || !Number.isFinite(result.longitude)) {
          return { error: 'no-result' };
        }
        return { postcode, lat: result.latitude, lon: result.longitude };
      } catch (err) {
        return { error: 'network' };
      }
    }

    // Set once resolveStationCoords() finishes with neither a URL postcode nor a saved cookie to
    // go on - i.e. a genuine first visit. startFeed() checks this and shows the postcode-entry
    // overlay instead of proceeding, before ever touching the hardcoded default coordinates.
    let needsPostcodePrompt = false;
    // True only when someone with an already-saved postcode is being made to see the cookie
    // notice and re-confirm for the first time (see resolveStationCoords) - changes the overlay's
    // wording so it's clear this isn't a first visit. False for an ordinary first visit or a
    // manual "change location" tap.
    let forcedReconsent = false;

    async function resolveStationCoords() {
      // ?pc= is what shared links use (see buildShareLink): unlike the old /radar/<postcode> path
      // it loads the normal index.html on any server. The path form is still honoured.
      const rawSegment = new URLSearchParams(window.location.search).get('pc') || extractPostcodeFromPath();
      if (rawSegment) {
        const result = await geocodePostcode(rawSegment);
        if (!result.error) {
          userConfig.lat = result.lat;
          userConfig.lon = result.lon;
          setCookie(POSTCODE_COOKIE, result.postcode, 365);
          console.log(`[STATION] Centred on ${result.postcode} (${result.lat}, ${result.lon}) from URL`);
          return;
        }
        console.warn('[STATION] URL segment postcode lookup failed, falling back:', rawSegment, result.error);
        // Fall through - an unmatched/bad URL postcode still gives the saved cookie (or the
        // first-visit prompt) a chance, rather than silently keeping the hardcoded default.
      }

      const cookiePostcode = getCookie(POSTCODE_COOKIE);
      if (cookiePostcode) {
        if (!getCookie(PRIVACY_ACK_COOKIE)) {
          // Saved before the cookie notice existed. ?autostart=1 is the unattended kiosk display
          // (deploy/kiosk.sh) - there's no one there to answer a prompt, so it keeps working as
          // before rather than silently reverting to the hardcoded default; everyone else gets
          // made to see the notice and re-confirm once (handlePostcodeSubmit sets this cookie,
          // so it's only ever this one time per device).
          if (new URLSearchParams(window.location.search).get('autostart') === '1') {
            setCookie(PRIVACY_ACK_COOKIE, '1', 365);
          } else {
            forcedReconsent = true;
            needsPostcodePrompt = true;
            return;
          }
        }
        const result = await geocodePostcode(cookiePostcode);
        if (!result.error) {
          userConfig.lat = result.lat;
          userConfig.lon = result.lon;
          console.log(`[STATION] Centred on ${result.postcode} (${result.lat}, ${result.lon}) from saved location`);
          return;
        }
        // A blip on a postcode that worked before shouldn't force a re-prompt every visit -
        // just keep the hardcoded default for this one load and try again next time.
        console.warn('[STATION] Saved postcode lookup failed, keeping default coordinates:', cookiePostcode, result.error);
        return;
      }

      // No URL postcode, no saved cookie - this is a first visit. Don't silently fall back to
      // the hardcoded default; startFeed() will show the postcode-entry overlay instead.
      // Exception: ?autostart=1 is the unattended kiosk launcher (deploy/kiosk.sh) - it has no
      // one present to answer a prompt, so it keeps the hardcoded default silently, same as
      // before this feature existed.
      if (new URLSearchParams(window.location.search).get('autostart') === '1') {
        console.log('[STATION] No saved postcode yet, but autostart=1 - keeping default coordinates.');
        return;
      }
      needsPostcodePrompt = true;
    }

    // Kicked off immediately at script load - this is a plain network
    // request, not something that needs to wait on the start-overlay tap
    // gesture. startFeed() awaits this before initialising the map, so the
    // very first render is already centred correctly instead of snapping
    // over afterwards.
    const stationReadyPromise = resolveStationCoords();

    // Re-centres everything that depends on userConfig.lat/lon: the Leaflet map, the range
    // circle, the cached projection the canvas radar sweep uses, and the status-bar label. Safe
    // to call before the map exists yet (first-visit prompt, before startFeed() has run) - it
    // just updates userConfig in that case, and initMap() picks up the new values when it runs.
    function recenterStation(lat, lon) {
      userConfig.lat = lat;
      userConfig.lon = lon;
      if (map && radarCircle) {
        map.setView([lat, lon], 10);
        radarCircle.setLatLng([lat, lon]);
        map.fitBounds(radarCircle.getBounds(), { padding: [0, 0] });
        recomputeMapProjectionCache();
      }
      const statusBar = document.getElementById('status-bar');
      if (statusBar) statusBar.textContent = formatStationLabel(lat, lon);
    }

    // --- Postcode-entry overlay (first visit, and the corner "change location" button) -------
    // focusInput: pass true ONLY when called synchronously from a tap/click handler (the 📍 button).
    // iOS Safari opens the keyboard only for a focus() made inside the gesture's own event handler;
    // the old setTimeout(focus, 50) lost that, leaving the field "focused" but with no keyboard (and
    // a later tap on it then does nothing). The first-visit path isn't a direct gesture, so it skips
    // focus and the person just taps the field.
    function showPostcodeOverlay(prefill, focusInput) {
      const overlay = document.getElementById('postcode-overlay');
      const input = document.getElementById('postcode-input');
      const err = document.getElementById('postcode-error');
      if (!overlay) return;
      if (input) input.value = prefill || '';
      if (err) err.style.display = 'none';
      const titleEl = document.getElementById('postcode-title');
      const subEl = document.getElementById('postcode-sub');
      if (titleEl) titleEl.textContent = forcedReconsent ? 'Confirm Your Location' : 'Set Your Location';
      if (subEl) {
        subEl.textContent = forcedReconsent
          ? "We've updated how we explain the postcode cookie below - please confirm to carry on."
          : 'Enter a UK postcode to centre the radar on your area';
      }
      // Cancel is offered whenever a location is already set (the 📍 button); on a genuine first
      // visit - or this forced re-confirm - the prompt is mandatory, so no way out - hiding it
      // there would leave a dead screen.
      const cancelBtn = document.getElementById('postcode-cancel');
      if (cancelBtn) cancelBtn.hidden = needsPostcodePrompt;
      overlay.classList.remove('hidden');
      if (input && focusInput) {
        input.focus();
        // The current postcode is prefilled - select it so typing a new one REPLACES it. On a phone
        // there's no easy select-all, and without this the new postcode got appended to the old one
        // ("NG1 1AANG7 2RD") and was rejected as "not a postcode".
        input.select();
        try { input.setSelectionRange(0, input.value.length); } catch (e) {}
      }
    }
    function hidePostcodeOverlay() {
      const overlay = document.getElementById('postcode-overlay');
      const input = document.getElementById('postcode-input');
      if (input) input.blur(); // drops the phone keyboard
      if (overlay) overlay.classList.add('hidden');
    }

    async function handlePostcodeSubmit(e) {
      e.preventDefault();
      const input = document.getElementById('postcode-input');
      const err = document.getElementById('postcode-error');
      const submitBtn = e.target.querySelector('button[type="submit"]');
      const raw = input ? input.value.trim() : '';
      if (!raw) return;

      // Unlock audio/speech NOW, synchronously inside the tap. Once we've awaited the postcode
      // lookup below, iOS no longer counts this as a user gesture and would leave the alerts silent
      // (only matters on first visit - after that startFeed has already run).
      if (!feedStarted) unlockAudioFromGesture();

      if (submitBtn) submitBtn.disabled = true;
      const result = await geocodePostcode(raw);
      if (submitBtn) submitBtn.disabled = false;

      if (result.error) {
        if (err) {
          err.textContent = result.error === 'not-a-postcode'
            ? "That doesn't look like a UK postcode."
            : result.error === 'network'
              ? "Couldn't reach the postcode lookup - check your connection and try again."
              : "Couldn't find that postcode - double check it and try again.";
          err.style.display = 'block';
        }
        return;
      }

      setCookie(POSTCODE_COOKIE, result.postcode, 365);
      setCookie(PRIVACY_ACK_COOKIE, '1', 365);
      needsPostcodePrompt = false;
      forcedReconsent = false;
      hidePostcodeOverlay();

      if (feedStarted) {
        // "Change location" after the radar's already running - recentre live.
        recenterStation(result.lat, result.lon);
      } else {
        // First-visit path: this submit click is itself the user gesture the browser needs to
        // unlock audio/speech, same as tapping the normal start-overlay would have been.
        userConfig.lat = result.lat;
        userConfig.lon = result.lon;
        startFeed();
      }
    }

    let map = null;
    let canvas = null;
    let ctx = null;
    let liveAircraft = [];
    let lockedAircraft = null;
    // Aircraft the user tapped on the scope (see "Aircraft detail panel" below). Tracked by hex, not by
    // object: liveAircraft is rebuilt from fresh JSON on every poll. selectedSnapshot is the last
    // record seen, so the panel survives the aircraft briefly (or permanently) leaving the feed.
    let selectedHex = null;
    let selectedSnapshot = null;
    let selectedLostSince = 0;
    let isFetching = false;
    let radarCircle = null;
    let pollBackoffUntil = 0;
    let consecutive429s = 0;
    let aircraftPollTimer = null;
    const AIRCRAFT_POLL_MS = 2500;
    const AIRCRAFT_STALE_GRACE_MS = 5000;
    const aircraftTrails = {};
    // How long a trail survives after we stop receiving its aircraft. Generous enough that a
    // brief dropout in one poll doesn't clear a live aircraft's trail, short enough that
    // departed traffic doesn't leave permanent ghost lines on the scope.
    const TRAIL_RETENTION_MS = 120000;
    // hex -> Date.now() of the last time the sweep beam passed this aircraft's bearing (CRT-style
    // "blip brightens on sweep pass, fades until the next one" - see drawRadarScope). The locked
    // aircraft is exempt and always drawn at full brightness regardless of this.
    const aircraftLastSweepHit = {};
    // hex -> Date.now() the first time this aircraft was seen this session - used for the
    // scrollboard's "Flight Time" (time tracked, not a real off-block/departure timestamp,
    // which ADS-B doesn't give us - see updateNearestScrollboard).
    const aircraftFirstSeenAt = {};

    // Home-use kiosk: audio alerts are always on, no mute toggle.
    const audioAlertsEnabled = true;
    const pulsed35Hexes = new Map(); // hex -> ms timestamp of last chirp, not a plain Set - see hexIsCoolingDown()
    const pulsed5Hexes = new Map();
    const announcedEmergencyHexes = new Set();
    // Without this, an aircraft's hex chirps once, ever, then goes silent for the rest of the
    // page's life - fine for a quick tab but not for a kiosk that runs for days. Re-chirping
    // after a cooldown lets the same aircraft trigger again on a later pass, while a single
    // continuous approach still only chirps once (12s poll interval << this cooldown).
    const CHIRP_REPEAT_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes
    function hexIsCoolingDown(map, hex) {
      const last = map.get(hex);
      return last !== undefined && (Date.now() - last) < CHIRP_REPEAT_COOLDOWN_MS;
    }
    let audioCtx = null;
    let feedStarted = false;

    // Debug/testing hook: a synthetic aircraft that gets merged into every poll's results
    // for a limited time, so the emergency-lock path (scrollboard override, red pulse, tone,
    // speech) can be exercised without waiting for a real squawk. See triggerTestSquawk().
    let testAircraft = null;
    let testAircraftExpiryAt = 0;

    // Simple in-memory photo cache so we don't re-fetch the same aircraft's photo every 12s poll
    const photoCache = {}; // key -> url string, or null for known-empty

    // ---------------------------------------------------------------------
    // Radar-scope aircraft silhouettes
    // ---------------------------------------------------------------------
    // An earlier version fetched a pw-silhouettes spritesheet.json at runtime. If that
    // JSON file was not physically deployed beside this HTML file, the web server
    // returned the site's HTML page instead of JSON, producing:
    //   Unexpected token '<', "<!DOCTYPE ..." is not valid JSON
    //
    // To make that failure mode impossible, the real plane-watch/pw-silhouettes artwork
    // (https://github.com/plane-watch/pw-silhouettes, CC BY-NC-SA 4.0, non-commercial use -
    // fine for this personal/home kiosk) is baked directly into this file as PW_SILHOUETTES
    // below, rather than being fetched separately at runtime. There is nothing extra to
    // deploy and nothing that can 404: if this file loads, the shapes are here.
    //
    // PW_SILHOUETTES = {
    //   shapes: { "<ICAO designator>": { d: "<svg path data>", a: [anchorX, anchorY] } },
    //   designators: { "<any ICAO designator, incl. aliases>": "<key into shapes>" },
    //   categories: { "A1".."A7": "<key into shapes>" }  // ADS-B emitter-category fallback
    // }
    // Path data is in the original 18.520833 x 18.520833 viewBox units, nose pointing up
    // (track 0), and `a` is the rotation anchor point in those same units - see
    // resolvePwSilhouetteShape()/drawPwSilhouette() below for how it's used.
    const PW_SILHOUETTES = {"shapes":{"B190D":{"d":"m 5.53037,5.7488729 0.5271892,-0.040795 0.3734257,-0.012552 0.5930879,0.00628 0.5052229,0.021966 0.5146371,0.040794 -0.2541804,0.034515 -0.7719558,0.028242 -0.2918367,-0.00628 -0.3420454,-0.012552 -0.3797019,-0.018828 z m 10.310889,5.7488729 0.52719,-0.040795 0.373425,-0.012552 0.593088,0.00628 0.505223,0.021966 0.514637,0.040794 -0.25418,0.034515 -0.771956,0.028242 -0.291837,-0.00628 -0.342045,-0.012552 -0.379702,-0.018828 z M 9.1712103,1.4276 9.1198563,1.443839 9.0717973,1.476912 9.0035843,1.6081701 8.9131503,1.8076412 8.8273673,2.0071122 8.70076,2.4386104 8.620145,2.7641719 8.566918,3.0618282 8.501289,3.5139969 8.466149,3.8948522 8.445995,4.2405676 8.440825,4.5940343 8.431005,6.5324173 8.410851,6.7169021 8.425837,6.936527 8.423257,7.0982742 7.1132595,7.2042109 7.1080895,6.8052688 7.0956875,6.3582677 7.1282435,6.3913407 7.1613165,6.4518027 7.3127284,6.345866 V 6.295223 L 7.2724204,6.222359 7.2269454,6.166548 7.1814704,6.12624 7.1184254,6.12107 7.0579644,6.133989 6.9995704,5.9267665 6.9644304,5.7955084 6.9292904,5.6921555 6.8657284,5.5634812 6.8254204,5.5076712 6.7980314,5.4776992 h -0.030489 l -0.073381,0.088367 -0.055294,0.1105876 -0.042891,0.096118 -0.027905,0.1059367 -0.045475,0.1286743 -0.029972,0.1266073 -0.043408,-0.015503 -0.057878,0.00775 -0.057878,0.025322 -0.040308,0.045475 -0.030489,0.055294 -0.025321,0.053227 -0.014986,0.040308 0.1715658,0.1136881 0.01757,-0.035657 0.015503,-0.042891 0.022221,-0.025321 0.015503,-0.00207 -0.012919,0.1462443 -0.022738,0.2826701 -0.012402,0.4061768 -0.6738607,0.2299601 -4.4198852,0.2475301 -0.065629,0.00982 -0.048059,0.022738 -0.042891,0.03514 -0.037724,0.048059 -0.01757,0.070797 -0.020154,0.2475301 -0.022738,0.098185 -0.01757,0.1441773 -0.012919,0.234611 0.020154,-0.00517 0.022738,-0.078031 0.037724,-0.07338 5.0937458,0.8175211 1.9967773,0.00258 0.09095,0.093534 0.05271,0.083199 0.05581,0.07338 V 13.17594 l 0.014986,0.156579 0.055811,0.257349 0.088367,0.468188 -0.9172567,0.523483 -0.033073,0.03307 -0.021704,0.05219 v 0.31936 l 0.024805,0.01395 1.0929565,-0.184485 0.1875854,0.991154 -2.2665282,0.853694 -0.035657,0.02481 -0.022221,0.03566 -0.016536,0.06356 -0.00827,0.589111 2.3817667,-0.264066 0.00827,0.120923 0.024805,0.129707 0.047026,0.13746 0.1578569,0.0084 0.155819,-0.011 0.047026,-0.137976 0.024805,-0.129191 0.00827,-0.12144 2.381766,0.264583 -0.0083,-0.589111 -0.01654,-0.06356 -0.0217,-0.03566 -0.03617,-0.0248 -2.2660111,-0.853695 0.1870687,-0.991671 1.0934724,0.184485 0.02429,-0.01344 v -0.31936 l -0.0217,-0.05271 -0.03307,-0.03307 -0.9172559,-0.522965 0.088883,-0.468189 0.055294,-0.257349 0.014986,-0.156579 V 9.4883096 l 0.055811,-0.073381 0.05271,-0.083199 0.09095,-0.093534 1.996777,-0.00258 5.093746,-0.8175211 0.03772,0.072864 0.02274,0.078548 0.02015,0.00517 -0.0129,-0.235134 -0.01757,-0.1436605 -0.02274,-0.098702 -0.02015,-0.2470133 -0.01757,-0.070797 -0.03772,-0.048059 -0.04289,-0.03514 -0.04806,-0.022738 -0.06563,-0.010335 -4.419886,-0.2470133 -0.67386,-0.2299602 -0.0124,-0.4061767 -0.02274,-0.2826701 -0.01292,-0.146761 0.0155,0.00258 0.02274,0.025321 0.01499,0.042891 0.01757,0.03514 0.171566,-0.1131714 -0.01499,-0.040824 -0.02532,-0.05271 -0.03049,-0.05581 -0.04031,-0.044958 -0.05788,-0.025322 -0.05788,-0.00775 -0.04289,0.014986 -0.03049,-0.1260905 -0.04547,-0.1286743 -0.02791,-0.1059367 -0.04289,-0.096118 -0.05529,-0.1111044 -0.07338,-0.088367 h -0.02997 l -0.0279,0.030489 -0.04031,0.055294 -0.06305,0.1291911 -0.03566,0.1033529 -0.03514,0.1312581 -0.05839,0.2067057 -0.06046,-0.012402 -0.06305,0.00517 -0.04548,0.040308 -0.04547,0.055294 -0.04031,0.073381 v 0.050643 l 0.151412,0.1059367 0.03307,-0.060461 0.03256,-0.033073 -0.0124,0.4470011 -0.0052,0.3984253 L 9.9172239,7.095174 9.9146401,6.9339436 9.9296263,6.7143187 9.9094725,6.5298339 9.899654,4.5914509 9.8944863,4.2379841 9.8743325,3.8922688 9.8391925,3.5108967 9.7735635,3.0592447 9.7203367,2.7615885 9.6397215,2.436027 9.513631,2.004012 9.4273314,1.804541 9.3368976,1.6055867 9.2686847,1.4743286 9.2206256,1.4412557 Z","a":[9.26,7.673]},"A388":{"d":"m 9.2606396,1.2545096 -0.074858,0.013388 -0.086816,0.047025 -0.069246,0.060461 -0.057878,0.078032 -0.038241,0.062528 -0.05116,0.095601 -0.062528,0.133842 -0.080099,0.1896525 -0.094051,0.3012736 -0.071314,0.2966227 -0.049093,0.2656169 -0.037724,0.3591512 -0.013436,0.3054077 v 1.896525 l -0.011368,0.109038 -0.033073,0.1297078 -0.042375,0.1291911 -0.087333,0.1586466 -0.088883,0.1245402 -0.098185,0.098185 -1.9233968,1.5730305 0.013436,-0.1338419 0.00879,-0.1297079 0.00465,-0.135909 -0.00465,-0.1519287 -0.010852,-0.153479 -0.031523,-0.2144572 V 6.7316462 L 6.149791,6.7089085 H 5.5296739 l -0.018087,0.01602 -0.00465,0.046509 -0.022221,0.1204061 -0.015503,0.1384928 -0.011369,0.1586467 v 0.153479 l 0.00878,0.1943034 0.01602,0.2387451 0.028939,0.1896525 h 0.066667 L 5.6232082,8.1232925 3.9566433,9.3748956 3.9654283,9.2544895 3.9788642,9.1072117 3.9767971,8.9067072 3.9747301,8.7211888 3.9519924,8.5516901 3.9344224,8.431284 3.9297716,8.3909764 3.9096177,8.3780573 H 3.2982856 l -0.019637,0.01757 -0.00672,0.047026 -0.013436,0.1049032 -0.018087,0.129191 -0.00879,0.1359091 -0.00207,0.1384928 0.00413,0.1782837 0.0093,0.1829345 0.012919,0.1317749 0.022738,0.1917196 h 0.06873 l 0.044958,0.1560628 -2.3714315,1.7802531 -0.073897,0.05168 -0.0645955,0.05581 -0.0625285,0.06201 -0.0444417,0.05839 -0.0470255,0.0801 -0.0356567,0.09612 -0.0222209,0.10697 -0.0108521,0.176217 -0.0268717,0.464054 0.0242879,0.0021 0.008785,-0.02015 2.8401366,-1.170988 -0.00465,0.138493 0.013436,0.12454 0.031523,0.111621 0.042375,0.131775 h 0.028939 l 0.035657,-0.100252 0.031006,-0.111621 0.022221,-0.116272 0.00258,-0.14056 0.00207,-0.120406 0.7027994,-0.258899 -0.00258,0.133842 0.0093,0.107487 0.033073,0.133842 0.049093,0.131258 h 0.026872 l 0.042375,-0.129191 0.03359,-0.129191 0.013436,-0.131775 v -0.194303 l 0.7002156,-0.260966 0.00258,0.176216 0.015503,0.118339 0.031006,0.106971 0.038241,0.104903 H 5.435609 L 5.473333,11.255439 5.513641,11.10196 5.529144,10.968118 v -0.194304 l 0.6981486,-0.260966 0.00672,0.0801 0.020154,0.09405 0.026872,0.09147 0.035657,0.09147 h 0.020154 l 0.03359,-0.06718 0.028939,-0.100252 0.022221,-0.111621 0.01757,-0.106971 v -0.05374 l 0.087333,-0.03359 0.6154663,-0.131258 -0.00207,0.06666 0.018087,0.09353 0.026355,0.08268 0.042375,0.109554 h 0.024805 l 0.037724,-0.09405 0.031523,-0.113688 0.01757,-0.09353 0.00672,-0.09612 0.9549805,-0.196371 0.01757,0.250114 0.035657,0.323495 0.053744,0.501778 0.062528,0.56689 v 0.796334 l 0.015503,0.394808 0.018087,0.258898 0.046509,0.474907 0.040308,0.310059 0.062528,0.355017 0.042375,0.187069 -2.5678019,2.047936 -0.055811,0.05374 -0.039791,0.05788 -0.03359,0.06718 -0.022221,0.08475 -0.044958,0.448035 3.0943847,-1.148767 0.1762166,0.890385 h 0.026872 l 0.013436,0.263033 h 0.015503 0.011369 0.010852 l 0.013436,-0.263033 h 0.026872 l 0.1762167,-0.890385 3.0943845,1.148767 -0.04496,-0.448035 -0.02222,-0.08475 -0.03359,-0.06718 -0.03979,-0.05788 -0.05581,-0.05374 -2.5678021,-2.047936 0.042375,-0.187069 0.062528,-0.355017 0.040307,-0.310059 0.04651,-0.474907 0.01809,-0.258898 0.0155,-0.394808 v -0.796334 l 0.06253,-0.56689 0.05374,-0.501778 0.03566,-0.323495 0.01757,-0.250114 0.95498,0.196371 0.0067,0.09612 0.01757,0.09353 0.03152,0.113688 0.03772,0.09405 h 0.02481 l 0.04237,-0.109554 0.02636,-0.08268 0.01809,-0.09353 -0.0021,-0.06666 0.615467,0.131258 0.08733,0.03359 v 0.05374 l 0.01757,0.106971 0.02222,0.111621 0.02894,0.100252 0.03359,0.06718 h 0.02015 l 0.03566,-0.09147 0.02687,-0.09147 0.02015,-0.09405 0.0067,-0.0801 0.698149,0.260966 v 0.194304 l 0.0155,0.133842 0.04031,0.153479 0.03772,0.104903 h 0.02894 l 0.03824,-0.104903 0.03101,-0.106971 0.0155,-0.118339 0.0026,-0.176216 0.700216,0.260966 v 0.194303 l 0.01344,0.131775 0.03359,0.129191 0.04238,0.129191 h 0.02687 l 0.04909,-0.131258 0.03307,-0.133842 0.0093,-0.107487 -0.0026,-0.133842 0.7028,0.258899 0.0021,0.120406 0.0026,0.14056 0.02222,0.116272 0.03101,0.111621 0.03566,0.100252 h 0.02894 l 0.04237,-0.131775 0.03152,-0.111621 0.01344,-0.12454 -0.0047,-0.138493 2.840137,1.170988 0.0088,0.02015 0.02429,-0.0021 -0.02687,-0.464054 -0.01085,-0.176217 -0.02222,-0.10697 -0.03566,-0.09612 -0.04703,-0.0801 -0.04444,-0.05839 -0.06253,-0.06201 -0.0646,-0.05581 -0.0739,-0.05168 -2.371432,-1.7802531 0.04496,-0.1560628 h 0.06873 l 0.02274,-0.1917196 0.01292,-0.1317749 0.0093,-0.1829345 0.0041,-0.1782837 -0.0021,-0.1384928 -0.0088,-0.1359091 -0.01809,-0.129191 -0.01344,-0.1049032 -0.0067,-0.047026 -0.01964,-0.01757 H 14.61115 l -0.02015,0.012919 -0.0046,0.040308 -0.01757,0.1204061 -0.02222,0.1694987 -0.0026,0.1855184 -0.0021,0.2005045 0.01344,0.1472778 0.0088,0.1204061 -1.666565,-1.2516031 0.04496,-0.1581299 h 0.06666 l 0.02894,-0.1896525 0.01602,-0.2387451 0.0088,-0.1943034 v -0.153479 l -0.01137,-0.1586467 -0.0155,-0.1384928 -0.02222,-0.1204061 -0.0047,-0.046509 -0.01757,-0.01602 h -0.620634 l -0.01964,0.022738 v 0.031006 l -0.03152,0.2144572 -0.01085,0.153479 -0.0047,0.1519287 0.0047,0.135909 0.0088,0.1297079 0.01344,0.1338419 -1.923397,-1.5730305 -0.09819,-0.098185 -0.08888,-0.1245402 -0.08733,-0.1586466 -0.04237,-0.1291911 -0.03307,-0.1297078 -0.01137,-0.1090373 V 3.4631119 L 10.033275,3.1577042 9.9955507,2.798553 9.9464587,2.5329361 9.875145,2.2363134 9.7810939,1.9350398 9.7009954,1.7453873 9.6384669,1.6115453 9.5873073,1.5159439 9.5490667,1.4534155 9.4911891,1.375384 9.4219427,1.3149226 9.3351263,1.2678971 Z","a":[9.26,7.937]},"AS50":{"d":"m 10.22003,14.582238 0.01438,2.574182 m 9.6338688,3.5456883 0.1169806,0.021283 0.2598816,0.090183 0.222932,0.1486214 0.164546,0.1857772 0.12739,0.2494722 0.12739,0.3980937 0.0637,0.4193254 0.02654,0.042463 0.0053,0.1698535 0.03716,0.095542 v 1.5222021 h 0.09201 V 5.2801297 l 0.03175,-0.037035 0.04233,0.00529 0.03703,0.026453 V 6.893797 h 0.09523 V 6.6927499 h 0.04762 V 4.5553026 h 0.07936 v 2.1427379 l 0.03226,-0.00864 v 0.1409126 h 0.07884 v 0.5819782 h 0.06878 V 7.5868807 H 11.062876 V 7.2694381 h -0.06878 V 7.8196722 9.0047915 H 10.877701 V 8.7720002 H 10.49677 l -0.03174,0.3809312 -0.02116,0.2856984 -0.03703,0.1640121 -0.03703,0.1216863 -0.04232,0.1481397 -0.04233,0.1428491 -0.0582,0.190466 -0.06878,0.174593 -0.06878,0.121687 -0.03174,0.04762 v 0.04762 l 0.09523,0.0053 v 0.513199 h -0.111105 l -0.1269768,2.793496 h 1.3808758 v 0.640176 h -1.4338 l -0.058198,1.290933 h 0.22221 v -0.04762 h 0.137559 v 0.216919 h -0.137559 v -0.06349 H 9.7983954 L 9.6714184,17.660394 9.4227548,14.533583 H 8.0101352 V 13.91457 H 9.3963013 L 9.2375801,11.105203 H 9.1106029 V 10.602585 H 9.2111265 L 9.1106029,10.332759 9.0206609,10.010026 8.9360096,9.7137457 8.8672304,9.3486866 8.7931603,8.7667083 H 8.3910664 V 9.031244 H 8.2958336 V 8.5762427 L 8.248217,8.6767664 8.1741472,8.6979304 8.105368,8.6503141 8.0577514,8.5603719 8.0365874,8.5180463 V 7.6715325 l 0.031744,-0.084651 0.07407,-0.021164 0.1111049,0.010581 V 5.2801289 l 0.031745,-0.037035 0.052907,-0.010581 0.031744,0.037035 0.015872,0.068779 V 6.9202503 H 8.5127517 L 8.4757166,6.4229233 V 5.5340839 L 8.5021697,5.2113505 8.5392045,4.9309427 8.6026931,4.5817559 8.7243795,4.2537319 8.8883915,4.0050682 9.0947292,3.7828585 9.3169393,3.6558815 9.5074048,3.5765206 Z M 7.5545775,1.7631998 7.2135131,1.8748209 7.1995601,1.9047929 8.8991979,6.6486893 9.2862544,7.037296 9.4273311,7.4212519 a 0.47714043,0.47714043 0 0 0 -0.2464966,0.4175456 0.47714043,0.47714043 0 0 0 0.1467611,0.344165 l -3.8235392,4.5480435 0.2671672,0.239262 0.033073,-0.0026 L 9.0624958,9.1239907 9.2051227,8.5943073 9.469706,8.277014 a 0.47714043,0.47714043 0 0 0 0.188619,0.038757 0.47714043,0.47714043 0 0 0 0.473356,-0.4180623 l -0.0067,0.1111043 5.850289,1.0376628 0.0739,-0.3513998 -0.0186,-0.027389 -4.958354,-0.8996866 -0.5302,0.1410766 -0.406694,-0.07028 A 0.47714043,0.47714043 0 0 0 9.658325,7.3618244 0.47714043,0.47714043 0 0 0 9.5058795,7.3866291 l 0.075448,-0.037724 z","a":[8.202,5.821]},"R44":{"d":"m 10.115171,15.727172 -0.0083,2.325644 M 9.2836709,4.3656249 9.1131387,4.3769937 8.9431232,4.4374552 8.7576048,4.5774983 8.6247964,4.7438964 8.4847533,4.9862589 8.4015543,5.2854654 8.3410933,5.7851765 8.3555623,6.9447956 8.2956173,6.9437656 8.2274043,6.9401456 8.09873,6.9287766 8.022766,6.8796836 8.004162,6.1562136 8.000032,6.0389081 7.985046,5.9861981 7.920967,5.9820681 7.890478,6.0048061 7.859989,6.0694021 v 0.109554 l 0.060978,3.0747477 0.014986,0.060461 0.045475,0.064079 H 8.041889 L 8.072378,9.3291508 V 9.105904 l 0.1550293,0.037724 0.2082561,0.00775 0.037724,0.1927531 0.083199,0.306958 0.1178223,0.4087609 0.135909,0.348299 0.1173055,0.348299 0.1100708,0.333313 0.098185,0.401526 0.049609,0.386023 0.029972,0.253731 0.041858,0.378789 0.026355,0.450101 v 0.734839 l -0.9425781,0.02636 -0.022738,0.03772 0.014986,0.567924 0.049093,0.03411 0.9430949,-0.01499 0.075448,1.469161 0.026872,0.579293 0.086816,0.07183 -0.030489,0.07183 -0.056327,0.04548 -0.064596,0.04547 -0.014986,-0.02635 -0.00413,-0.07235 -0.00723,-0.05633 -0.049609,-0.03049 -0.026355,0.03772 0.026355,0.70435 0.075964,0.851628 v -0.843877 l 0.045475,0.0036 0.045475,0.05323 0.049093,0.0832 0.037724,0.07183 v 0.09457 l 0.015503,0.117305 0.029972,0.06046 h 0.053227 l 0.037724,-0.05271 0.041858,-0.110071 0.05271,-0.33693 v -0.234611 h 0.2800862 l 0.09095,-0.06408 -0.06408,-0.06098 -0.3069582,0.0078 -0.014986,-2.487703 0.9766852,-0.0186 0.04547,-0.03049 -0.0186,-0.613399 -0.03824,-0.0186 -0.9616988,0.02997 -0.00362,-1.487765 0.022738,-0.333313 0.060462,-0.496094 0.1400431,-0.609265 0.2728517,-0.9844359 0.09818,-0.4242635 0.02274,-0.2501139 h 0.234611 l 0.140559,-0.044958 0.0036,0.1968872 0.01137,0.05271 0.03411,0.030489 h 0.04134 l 0.03411,-0.011369 0.03049,-0.038241 0.0036,-0.056327 -0.117305,-3.2375284 -0.02274,-0.045475 -0.03772,-0.022738 -0.02274,0.015503 -0.02636,0.045475 V 6.8300739 L 10.374044,6.9096556 10.351306,6.5313842 10.328568,6.1525959 10.305831,5.7438353 10.234,5.3195718 10.131681,5.0053791 9.9993895,4.782137 9.8102537,4.5625121 9.6206012,4.4452066 9.4464517,4.3769937 Z m 1.5244551,2.6944092 0.05736,1.8009236 -0.182417,0.027389 -0.117306,0.031006 h -0.176216 l 0.02739,-0.4025594 -0.0036,-0.4418335 -0.0078,-0.4382162 -0.01602,-0.3400309 -0.0036,-0.179834 0.152446,-0.05116 z m -2.8778608,0.075448 0.210323,0.034107 0.1421102,0.018087 0.074414,-0.00723 V 7.492049 7.9033934 l 0.00362,0.4501017 0.01757,0.3296957 0.024805,0.2547648 -0.1415934,0.00362 -0.1100708,-0.01757 -0.1963705,-0.037724 z M 7.2321166,1.3022461 6.7747802,1.4774292 8.636682,7.0104247 8.8594074,7.3127318 8.9188353,7.4558755 9.1296751,7.72666 9.2536986,8.0982136 A 0.25601381,0.25601381 0 0 0 9.1420775,8.3095702 0.25601381,0.25601381 0 0 0 9.3828896,8.5653685 l 0.080615,0.3648356 -0.020154,0.083716 2.1244184,6.3009069 0.457337,-0.175183 L 10.163721,9.6066486 9.9404783,9.3043415 9.8810504,9.1611978 9.6702106,8.8904133 9.5461872,8.5183429 A 0.25601381,0.25601381 0 0 0 9.6536741,8.3095702 0.25601381,0.25601381 0 0 0 9.4175129,8.0542886 l -0.081132,-0.3674194 0.020154,-0.083716 z","a":[9.26,5.292]},"A139":{"d":"M 7.5356367 2.79769 L 7.3278975 2.8354138 L 7.1894047 2.9170625 L 7.0509118 3.0307507 L 6.9181034 3.2069673 L 6.7858117 3.4276257 L 6.6473189 3.7175305 L 6.5465499 4.0513602 L 6.451982 4.4921602 L 6.3827356 4.9272757 L 6.3326094 5.3995983 L 6.3326094 7.8697317 L 5.9982629 7.9513805 L 5.910413 8.033546 L 5.8788904 8.1405162 L 5.8788904 9.1104828 L 5.9166142 9.1926484 L 6.0235844 9.2872162 L 6.4266605 9.3750662 L 7.0379927 11.146017 L 7.3154951 14.604721 L 5.7274784 14.642445 L 5.5951867 14.693088 L 5.4752974 14.780938 L 5.3998498 14.900827 L 5.3745284 15.03932 L 5.3745284 15.184531 L 7.3718225 15.329225 L 7.3971439 15.757622 L 7.2648522 15.789145 L 7.1832035 15.833587 L 7.1449629 15.921436 L 7.1449629 16.154497 L 7.1832035 16.362753 L 7.2772546 16.545171 L 7.3847416 16.64594 L 7.4793094 16.684181 L 7.5108321 16.677463 L 7.5423547 16.684181 L 7.6364058 16.64594 L 7.7438928 16.545171 L 7.8384606 16.362753 L 7.8761844 16.154497 L 7.8761844 16.044943 L 8.2332686 16.044943 L 8.2332686 15.950892 L 7.8761844 15.950892 L 7.8761844 15.921436 L 7.8384606 15.833587 L 7.7562951 15.789145 L 7.6240034 15.757622 L 7.6493249 15.329225 L 9.646619 15.184531 L 9.646619 15.03932 L 9.6212975 14.900827 L 9.5458499 14.780938 L 9.4259606 14.693088 L 9.2936689 14.642445 L 7.706169 14.604721 L 7.9831546 11.146017 L 8.5944868 9.3750662 L 8.997563 9.2872162 L 9.1045332 9.1926484 L 9.142257 9.1104828 L 9.142257 8.1405162 L 9.1107344 8.033546 L 9.0228844 7.9513805 L 8.6890547 7.8692149 L 8.6890547 5.3995983 L 8.6384118 4.9272757 L 8.5691654 4.4921602 L 8.4745975 4.0513602 L 8.3738285 3.7175305 L 8.2353356 3.4276257 L 8.103044 3.2069673 L 7.9707523 3.0307507 L 7.8317427 2.9170625 L 7.6932499 2.8354138 L 7.5356367 2.79769 z  m 8.02935,14.724399 v 2.550377 M 7.6444945,1.0790039 7.5897175,1.0929565 7.4842976,1.2025106 7.39128,1.3363525 7.3406371,1.453658 l -0.013953,0.1152385 0.020154,0.1214396 0.070797,0.2490804 0.095085,0.2831868 1.7471801,5.1340535 0.058911,-0.025838 0.1483113,0.4030761 a 0.30463785,0.30463785 0 0 0 -0.034106,0.042375 l -0.4413167,0.00775 -0.00155,-0.072864 -5.1557576,0.072347 -0.2320272,0.018604 -0.2666504,0.015503 -0.1896525,-0.0062 -0.1829345,-0.01912 -0.1178223,-0.032039 -0.1064534,-0.025838 -0.1095541,-0.016536 -0.063045,0.011369 -0.034107,0.039791 -0.00362,0.056844 0.071314,0.1338419 0.098185,0.1297079 0.096118,0.084233 0.10542,0.049093 0.1219563,0.018604 0.258899,0.0093 0.2986897,-0.00258 5.422408,-0.075448 -0.00672,-0.064079 0.4263306,-0.016536 a 0.30463785,0.30463785 0 0 0 0.032556,0.047026 L 9.325012,8.5596841 9.2552489,8.5390135 7.7307941,13.464811 l -0.053743,0.225826 -0.067696,0.258899 -0.064596,0.178284 -0.074931,0.168465 -0.066663,0.101802 -0.057361,0.09302 -0.049609,0.09922 -0.00878,0.06356 0.027389,0.04496 0.05271,0.02067 0.1493449,-0.02635 0.1539958,-0.05374 0.109554,-0.06511 0.079582,-0.08475 0.054777,-0.110588 0.0894,-0.242879 0.0894,-0.285254 1.6045532,-5.1805623 -0.063045,-0.012919 0.1080038,-0.3824055 0.2702672,0.1891357 -0.041341,0.059945 4.213696,2.9719111 0.198438,0.12144 0.224792,0.144177 0.149862,0.116272 0.136942,0.123506 0.07597,0.09457 0.07131,0.08372 0.07855,0.07752 0.05788,0.02842 0.05116,-0.0124 0.03617,-0.04341 0.02067,-0.150378 -0.0031,-0.162781 -0.02791,-0.125057 -0.05633,-0.101802 -0.08785,-0.0863 L 14.90865,11.443746 14.664738,11.27063 10.234,8.1436888 10.201961,8.1994994 9.974068,8.0470539 a 0.30463785,0.30463785 0 0 0 0.00568,-0.017053 l 0.307992,-0.2320272 0.04444,0.057878 4.12843,-3.0887003 0.176216,-0.151412 0.206706,-0.1689819 0.157096,-0.1064534 0.159681,-0.092501 0.113688,-0.042892 0.101286,-0.041858 0.09818,-0.05116 0.04496,-0.045992 0.0041,-0.05271 -0.03049,-0.047542 -0.136425,-0.066146 -0.156063,-0.047542 -0.127124,-0.011886 -0.114205,0.022221 -0.109037,0.056844 -0.214974,0.1441772 -0.240296,0.1782837 -4.342887,3.2478637 0.04341,0.048059 L 9.8789834,7.707023 A 0.30463785,0.30463785 0 0 0 9.7725299,7.6517292 L 9.6262856,7.2274657 9.6950153,7.2031778 8.0331013,2.3218221 7.9442178,2.1073649 7.8465493,1.8582845 7.7943561,1.6763834 7.7555988,1.4960327 7.7493976,1.3745931 7.7416462,1.265039 7.7235594,1.1560018 7.6930703,1.0991577 Z","a":[9.79,6.085]},"B06":{"d":"m 10.115171,15.727172 -0.0083,2.325644 M 9.2836709,4.3656249 9.1131387,4.3769937 8.9431232,4.4374552 8.7576048,4.5774983 8.6247964,4.7438964 8.4847533,4.9862589 8.4015543,5.2854654 8.3410933,5.7851765 8.3555623,6.9447956 8.2956173,6.9437656 8.2274043,6.9401456 8.09873,6.9287766 8.022766,6.8796836 8.004162,6.1562136 8.000032,6.0389081 7.985046,5.9861981 7.920967,5.9820681 7.890478,6.0048061 7.859989,6.0694021 v 0.109554 l 0.060978,3.0747477 0.014986,0.060461 0.045475,0.064079 H 8.041889 L 8.072378,9.3291508 V 9.105904 l 0.1550293,0.037724 0.2082561,0.00775 0.037724,0.1927531 0.083199,0.306958 0.1178223,0.4087609 0.135909,0.348299 0.1173055,0.348299 0.1100708,0.333313 0.098185,0.401526 0.049609,0.386023 0.029972,0.253731 0.041858,0.378789 0.026355,0.450101 v 0.734839 l -0.9425781,0.02636 -0.022738,0.03772 0.014986,0.567924 0.049093,0.03411 0.9430949,-0.01499 0.075448,1.469161 0.026872,0.579293 0.086816,0.07183 -0.030489,0.07183 -0.056327,0.04548 -0.064596,0.04547 -0.014986,-0.02635 -0.00413,-0.07235 -0.00723,-0.05633 -0.049609,-0.03049 -0.026355,0.03772 0.026355,0.70435 0.075964,0.851628 v -0.843877 l 0.045475,0.0036 0.045475,0.05323 0.049093,0.0832 0.037724,0.07183 v 0.09457 l 0.015503,0.117305 0.029972,0.06046 h 0.053227 l 0.037724,-0.05271 0.041858,-0.110071 0.05271,-0.33693 v -0.234611 h 0.2800862 l 0.09095,-0.06408 -0.06408,-0.06098 -0.3069582,0.0078 -0.014986,-2.487703 0.9766852,-0.0186 0.04547,-0.03049 -0.0186,-0.613399 -0.03824,-0.0186 -0.9616988,0.02997 -0.00362,-1.487765 0.022738,-0.333313 0.060462,-0.496094 0.1400431,-0.609265 0.2728517,-0.9844359 0.09818,-0.4242635 0.02274,-0.2501139 h 0.234611 l 0.140559,-0.044958 0.0036,0.1968872 0.01137,0.05271 0.03411,0.030489 h 0.04134 l 0.03411,-0.011369 0.03049,-0.038241 0.0036,-0.056327 -0.117305,-3.2375284 -0.02274,-0.045475 -0.03772,-0.022738 -0.02274,0.015503 -0.02636,0.045475 V 6.8300739 L 10.374044,6.9096556 10.351306,6.5313842 10.328568,6.1525959 10.305831,5.7438353 10.234,5.3195718 10.131681,5.0053791 9.9993895,4.782137 9.8102537,4.5625121 9.6206012,4.4452066 9.4464517,4.3769937 Z m 1.5244551,2.6944092 0.05736,1.8009236 -0.182417,0.027389 -0.117306,0.031006 h -0.176216 l 0.02739,-0.4025594 -0.0036,-0.4418335 -0.0078,-0.4382162 -0.01602,-0.3400309 -0.0036,-0.179834 0.152446,-0.05116 z m -2.8778608,0.075448 0.210323,0.034107 0.1421102,0.018087 0.074414,-0.00723 V 7.492049 7.9033934 l 0.00362,0.4501017 0.01757,0.3296957 0.024805,0.2547648 -0.1415934,0.00362 -0.1100708,-0.01757 -0.1963705,-0.037724 z M 7.2321166,1.3022461 6.7747802,1.4774292 8.636682,7.0104247 8.8594074,7.3127318 8.9188353,7.4558755 9.1296751,7.72666 9.2536986,8.0982136 A 0.25601381,0.25601381 0 0 0 9.1420775,8.3095702 0.25601381,0.25601381 0 0 0 9.3828896,8.5653685 l 0.080615,0.3648356 -0.020154,0.083716 2.1244184,6.3009069 0.457337,-0.175183 L 10.163721,9.6066486 9.9404783,9.3043415 9.8810504,9.1611978 9.6702106,8.8904133 9.5461872,8.5183429 A 0.25601381,0.25601381 0 0 0 9.6536741,8.3095702 0.25601381,0.25601381 0 0 0 9.4175129,8.0542886 l -0.081132,-0.3674194 0.020154,-0.083716 z","a":[9.26,8.202]},"A148":{"d":"m 9.2649087,0.67840365 -0.061495,0.008268 -0.053227,0.026355 -0.052193,0.045992 -0.287321,0.48885905 -0.058394,0.1142049 -0.085783,0.1813843 -0.094051,0.2351278 -0.051677,0.1452107 -0.07028,0.2444296 -0.064079,0.2831868 -0.034623,0.206189 -0.023254,0.1912028 -0.011369,0.1674316 -0.00465,0.1545126 -0.00155,0.2129069 -0.0031,0.3209106 -0.00465,0.3627686 -0.0031,0.3488159 -0.00465,0.3555338 -0.0031,0.4159953 -0.0062,0.4304647 -0.00155,0.1545125 L 7.9652465,5.9462991 7.5523518,6.1685078 7.3141234,6.2971821 V 4.6073628 L 7.3032714,4.5742899 7.2691649,4.5319152 7.2438435,4.514862 H 6.405135 L 6.361727,4.522612 6.324003,4.547934 6.29248,4.586691 6.28783,4.604261 v 1.6836182 l 0.0062,0.090434 0.014469,0.098702 0.017053,0.087333 0.023254,0.080098 0.02067,0.064079 0.029456,0.074931 -5.40897215,2.9098999 -0.0320393,0.03359 -0.0692465,0.099219 -0.0578776,0.0987 -0.0465088,0.1157549 -0.0170532,0.05995 -0.0485758,0.401526 0.002067,0.02067 0.0170532,0.01137 0.0242879,-0.0036 7.39541415,-2.0324341 v 0.6061645 l 0.034107,0.2247925 0.039274,0.1824178 0.047026,0.1881022 0.027388,0.07028 0.01912,1.8634521 0.2790527,2.070675 0.3855062,1.592667 -2.2996012,1.677934 -0.058911,0.04134 -0.047542,0.04754 -0.029972,0.04496 -0.026355,0.05736 -0.01602,0.07131 v 0.555522 l 2.6370483,-0.877983 0.0062,0.353984 0.1033529,0.58291 0.1100708,-0.58291 0.00672,-0.353984 2.6370484,0.877983 v -0.555522 l -0.01602,-0.07131 -0.02635,-0.05736 -0.02997,-0.04496 -0.04754,-0.04754 -0.05891,-0.04134 -2.2996017,-1.677934 0.3855065,-1.592667 0.2790522,-2.070675 0.01912,-1.8634521 0.02739,-0.07028 0.04703,-0.1881022 0.03927,-0.1824178 0.03359,-0.2247925 v -0.606185 l 7.395931,2.0324346 0.02429,0.0036 0.01705,-0.01137 0.0015,-0.02067 -0.04858,-0.401526 -0.01654,-0.05995 -0.04703,-0.1157554 -0.05788,-0.0987 -0.06873,-0.099219 -0.03204,-0.03359 -5.409489,-2.9098999 0.02997,-0.074931 0.02015,-0.064079 0.02377,-0.080098 0.01705,-0.087333 0.01395,-0.098702 0.0067,-0.090434 V 4.6042622 l -0.0052,-0.01757 -0.03101,-0.038757 -0.03772,-0.025322 -0.04392,-0.00775 h -0.838191 l -0.02532,0.017053 -0.03411,0.042375 -0.01137,0.033073 V 6.2971821 L 10.969197,6.1685078 10.556303,5.9462991 10.236942,5.7726663 l -0.0016,-0.1545125 -0.0062,-0.4304647 -0.0031,-0.4159953 -0.0047,-0.3555338 -0.0031,-0.3488159 -0.0047,-0.3627686 -0.0031,-0.3209106 -0.0015,-0.2129069 -0.0052,-0.1545126 L 10.193017,2.8488138 10.169763,2.657611 10.13514,2.451422 10.071061,2.1682352 10.000781,1.9238056 9.9491052,1.7785949 9.8550532,1.5434671 9.7692707,1.3620828 9.7108764,1.2478779 9.4230386,0.75901888 l -0.051676,-0.045992 -0.053227,-0.026355 z","a":[9.26,6.879]},"P28A":{"d":"M 7.591287,3.6654734 H 10.9725 M 9.2335565,3.4601848 9.1823851,3.5305338 9.0831663,3.7480916 9.0402749,3.9511799 9.0263223,4.008024 8.700244,4.0364461 8.6294473,4.0597004 8.5917235,4.1025919 8.5679523,4.225065 8.4403115,5.775358 8.3881183,6.687447 7.2822427,7.1463337 1.5776814,7.1649372 1.5115356,7.2073119 1.4216186,7.321 l -0.061495,0.1322917 -0.051676,0.179834 -0.047542,0.245463 -0.0093,0.1937866 -0.0093,0.1183391 -0.03824,0.033073 -0.018604,0.075448 0.00465,0.075448 0.028422,0.042891 0.028422,0.037724 v 0.3214274 l 0.028422,0.3023071 0.042375,0.2175578 0.061495,0.2030884 0.070797,0.1514119 0.075448,0.084749 0.052193,0.038241 h 0.080099 l 6.7634114,0.027905 0.037724,0.458886 0.1421102,1.214396 0.1746664,1.384929 0.1984375,1.427303 -2.6416992,-0.0047 -0.099219,0.0186 -0.094568,0.06615 -0.061495,0.08992 -0.042375,0.132292 -0.014469,0.118339 0.014469,0.113171 0.127124,0.534335 0.028422,0.08992 0.052193,0.04702 0.042375,0.02842 h 0.042891 l 2.9300537,0.03307 0.038757,0.10387 0.0093,-0.10387 2.9305704,-0.03307 h 0.04237 l 0.04237,-0.02842 0.05219,-0.04702 0.02842,-0.08992 0.127641,-0.534335 0.01395,-0.113171 -0.01395,-0.118339 -0.04237,-0.132292 -0.06149,-0.08992 -0.09457,-0.06615 -0.09922,-0.0186 -2.6422158,0.0047 0.1984375,-1.427303 0.1751831,-1.384929 0.1415932,-1.214396 0.03772,-0.458886 6.763412,-0.027905 h 0.0801 l 0.05219,-0.038241 0.07545,-0.084749 0.0708,-0.1514119 0.0615,-0.2030884 0.04289,-0.2175578 0.02842,-0.3023071 V 8.4552977 l 0.02791,-0.037724 0.02842,-0.042891 0.0047,-0.075448 -0.0186,-0.075448 -0.03772,-0.033073 -0.0098,-0.1183391 L 17.302895,7.878588 17.255355,7.633125 17.203675,7.453291 17.142106,7.321 17.052189,7.2073119 16.986043,7.1649372 11.281482,7.1463337 10.175606,6.687447 10.123413,5.775358 9.9957721,4.225065 9.9725177,4.1025919 9.9347939,4.0597004 9.8634805,4.0364461 9.5374022,4.008024 9.5234495,3.9511799 9.4810749,3.7480916 9.3813393,3.5305338 9.3278072,3.4597058 c -0.013585,-0.014046 -0.084893,-0.012772 -0.094251,4.79e-4 z","a":[9.26,7.673]},"C208":{"d":"m 9.3124369,3.9495892 -0.049984,0.015393 -0.04614,0.073077 -0.053838,0.1192169 -0.042296,0.1615088 -0.030782,0.180712 -0.1846718,0.033849 -0.09228,0.08847 -0.088436,0.3537652 -0.096129,0.488412 -0.03848,0.3268658 -0.00386,0.2576369 -0.0269,0.019241 -0.045471,0.1268757 -0.00386,0.6191357 -0.030785,0.2691816 v 0.1961417 l -1.6971315,0.068295 c 0,0 -0.6291636,0.031528 -0.943872,0.044646 -0.6450981,0.026887 -1.9357148,0.069789 -1.9357148,0.069789 l -1.4384857,0.057609 -0.3999053,0.023089 -0.096166,0.073077 0.00612,0.6952757 V 8.672314 l 0.099976,0.011542 0.057684,0.038442 1.7205192,0.1038992 1.9460636,0.1293416 1.5804924,0.1177591 0.7060735,0.018081 0.3592198,-0.072145 -0.0016,0.3792825 0.013823,0.369307 0.1222054,1.0459776 0.1906125,1.376692 0.1230647,0.803734 -0.8190878,0.115368 -0.8267846,0.103824 -0.7345047,0.09613 -0.1269131,0.0039 -0.084584,0.0423 -0.00384,0.661428 0.073077,0.06922 0.6652758,0.0192 0.7691003,0.04618 0.7691009,0.0269 0.426842,0.0039 0.099976,0.06538 0.042296,0.296081 0.030622,0.02502 0.032666,-0.02502 0.042286,-0.296081 0.1000145,-0.06538 0.426842,-0.0039 0.7690998,-0.0269 0.7691,-0.04618 0.665276,-0.0192 0.07304,-0.06922 -0.0039,-0.661428 -0.08458,-0.0423 -0.126913,-0.0039 -0.734467,-0.09613 -0.826784,-0.103824 -0.8190883,-0.115368 0.1230279,-0.803734 0.2461293,-1.376692 0.1499646,-1.0459776 0.034636,-0.29993 0.0192,-0.330713 1.219032,-0.049993 1.580492,-0.069224 1.842015,-0.080738 1.69971,-0.069233 0.05768,-0.03848 0.09998,-0.011504 v -0.3615 l 0.0269,-0.6883271 -0.09613,-0.073077 -0.399944,-0.023051 -1.334362,-0.092318 -1.634366,-0.096128 V 7.07213 l -0.03844,-0.1115205 -0.09613,-0.061495 h -0.08462 l -0.08458,0.069192 -0.02694,0.069229 -0.01536,0.1269132 -0.0039,0.2691816 -0.853722,-0.030786 -1.815077,-0.130724 V 7.0759784 l -0.03068,-0.2691815 -0.0039,-0.6190982 -0.0039,-0.1269131 -0.0269,-0.019241 -0.0039,-0.2576369 L 9.9622233,5.4570421 9.8660954,4.9686674 9.7776597,4.6148649 9.6853422,4.526433 9.5353775,4.4994962 9.5046332,4.3187841 9.4622998,4.1572753 9.408462,4.0380584 9.3623221,3.9649817 Z","a":[9.26,7.937]},"C402":{"d":"M 5.0272174,4.6082058 H 7.4350722 m 11.05423,4.6082058 h 2.407854 M 9.2448006,1.8383134 9.1384601,1.8923909 9.0340737,2.0065958 8.94364,2.1254516 8.8340859,2.2965006 8.7250487,2.5150919 8.6511514,2.7006103 8.5844888,2.933671 8.5038735,3.3806721 8.4227415,3.9372273 8.3731322,4.4622598 8.3374754,4.990393 8.3137043,5.5298949 8.2971678,6.2528482 6.8300739,6.2786864 6.7918334,6.2311441 6.7897663,5.7676065 6.7799478,5.1423217 V 5.0353515 L 6.7541096,4.9686889 6.7112181,4.9190795 6.6709105,4.8973754 H 6.4926268 l -0.059945,-0.034623 -0.00465,-0.084233 -0.021187,-0.1281575 -0.035657,-0.099736 -0.054777,-0.109554 -0.085266,-0.109554 -0.081132,0.095085 -0.061495,0.1260905 -0.059945,0.2046387 -0.0093,0.1116211 -0.047542,0.026355 H 5.7908609 l -0.035657,0.023771 -0.044958,0.042375 -0.026355,0.059428 -0.0093,0.135909 -0.0093,1.0862386 -0.059428,0.064079 -4.5981689,0.2666504 -0.0310059,0.030489 -0.002067,0.2428793 -0.0382406,0.040308 -0.0211873,0.066663 v 0.061495 l 0.0304891,0.057361 0.0356567,0.054777 0.002584,0.7105509 0.0118856,0.03359 0.0330729,0.016536 0.078548,0.0093 4.5480427,0.5229655 0.1235067,0.1214396 0.042891,0.3116089 0.014469,0.030489 0.1069702,0.047542 0.2878377,0.1193726 0.3607015,-0.1483114 0.029456,-0.023254 0.018603,-0.029972 0.024805,-0.1875855 0.1596801,-0.1762166 H 8.2062173 L 8.3075031,8.55555 v 0.4583699 l 0.00982,0.1875855 0.016537,0.2444295 0.03824,0.3405477 0.054777,0.3865394 0.066663,0.402043 0.064595,0.359151 0.066663,0.338481 0.2687174,1.422135 -2.6840738,0.305408 -0.037724,0.01654 -0.03669,0.0217 -0.029972,0.03152 -0.020154,0.03824 -0.011369,0.04806 -0.00155,0.219108 0.012919,0.126607 0.03514,0.194303 0.0863,0.355017 2.9429728,0.28112 0.018603,0.317294 0.024805,0.327111 0.061586,0.450102 0.041767,-0.450102 0.025322,-0.327111 0.018087,-0.317294 2.9429725,-0.28112 0.08682,-0.355017 0.03462,-0.194303 0.01344,-0.126607 -0.0021,-0.219108 -0.01137,-0.04806 -0.02015,-0.03824 -0.02946,-0.03152 -0.03669,-0.0217 -0.03824,-0.01654 -2.6840741,-0.305408 0.2692342,-1.422135 0.066146,-0.338481 0.065112,-0.359151 0.066146,-0.402043 0.05478,-0.3865394 0.03824,-0.3405477 0.01654,-0.2444295 0.01033,-0.1875855 V 8.55555 l 0.101286,-0.069763 h 1.381828 l 0.159163,0.1762166 0.02532,0.1875855 0.01809,0.029972 0.02997,0.023254 0.360701,0.1483114 0.287321,-0.1193726 0.107487,-0.047542 0.01395,-0.030489 0.04289,-0.3116089 0.123507,-0.1214396 4.548043,-0.5229655 0.07855,-0.0093 0.03307,-0.016536 0.01188,-0.03359 0.0026,-0.7105509 0.03566,-0.054777 0.03101,-0.057361 V 6.954099 l -0.0217,-0.066663 -0.03772,-0.040308 -0.0026,-0.2428793 -0.03101,-0.030489 -4.597652,-0.2666504 -0.05943,-0.064079 -0.0098,-1.0862386 -0.0093,-0.135909 -0.02635,-0.059428 -0.04496,-0.042375 -0.03566,-0.023771 h -0.180868 l -0.04754,-0.026355 -0.0093,-0.1116211 -0.05943,-0.2046387 -0.06201,-0.1260905 -0.08062,-0.095085 -0.08578,0.109554 -0.05478,0.109554 -0.03566,0.099736 -0.02119,0.1281575 -0.0041,0.084233 -0.05994,0.034623 H 11.8184 l -0.04082,0.021704 -0.04237,0.049609 -0.02636,0.066663 v 0.1069702 l -0.0093,0.6252848 -0.0026,0.4635376 -0.03824,0.047542 L 10.192143,6.2528482 10.175606,5.5298949 10.151835,4.990393 10.116178,4.4622598 10.066052,3.9372273 9.9854368,3.3806721 9.9043048,2.933671 9.8376422,2.7006103 9.7642617,2.5150919 9.6547077,2.2965006 9.5451536,2.1254516 9.4552366,2.0065958 9.3503335,1.8923909 Z","a":[9.26,7.937]},"A225":{"d":"M 9.2856148,0.36781281 9.1694661,0.39842529 9.0196045,0.55448812 8.8511393,0.81907145 8.7167806,1.137915 8.6180786,1.4882812 8.5255778,1.9569865 8.4909546,2.1549072 8.4366943,2.6933757 8.433077,5.4601318 8.334375,5.6161947 8.1116496,5.8327189 7.3592407,6.3908244 7.3561401,5.810498 7.3080811,5.4534139 7.2476196,5.3960531 H 6.7628947 l -0.060461,0.060461 -0.03514,0.3700032 v 0.4046265 l 0.028939,0.2744019 h 0.133842 V 6.7473918 L 5.8451213,7.4202189 5.8580404,7.0729533 5.8358195,6.6869303 5.8006795,6.4414673 5.7366007,6.4161458 H 5.2684123 l -0.074931,0.074931 -0.027388,0.3648356 v 0.2583821 l 0.01912,0.4046265 0.05426,0.057361 h 0.0894 V 7.7705851 L 4.2803589,8.5007731 4.3025798,8.1183675 V 7.7168416 L 4.2772583,7.4677612 4.2354004,7.314799 4.174939,7.2801758 H 3.744991 L 3.6907308,7.3308187 3.661792,7.4935994 3.63337,7.7359619 v 0.4330485 l 0.044442,0.2904216 h 0.092501 v 0.1813842 h 0.098702 v 0.1307414 l -2.0525879,1.4247194 -1.03611247,0.711068 -0.13694255,0.140043 -0.098702,0.213423 -0.0671794,0.245463 -0.0191203,0.197921 v 0.299207 L 2.2148519,11.331091 v 0.143144 l 0.063562,0.05116 v -0.223242 l 0.8764323,-0.312126 v 0.172082 l 0.060978,0.05736 v -0.251664 l 0.6945312,-0.267684 v 0.165365 h 0.07028 V 10.671183 L 4.7103068,10.38748 v 0.136942 l 0.06873,0.06873 v -0.234094 l 0.6547404,-0.248564 v 0.210323 l 0.111621,-0.02584 V 10.068636 L 6.2115072,9.8076701 v 0.1751831 l 0.080098,0.066663 V 9.7756307 l 0.2036052,-0.082682 h 0.4273641 l 0.041341,0.2485636 0.046509,-0.012402 0.049093,-0.2361613 h 0.9818522 v 0.2072225 h 0.082682 V 9.6893311 h 0.2645834 v 1.3673579 l 0.044958,0.685747 0.0093,0.729671 0.092501,0.917773 0.03514,0.695048 0.041341,0.449585 -0.146761,0.146245 -1.848466,1.074353 -0.7617106,0.442867 -0.1436605,-0.353467 h -0.05116 l -0.1912028,0.522449 -0.053743,0.360184 v 0.334864 l 0.063562,0.398425 0.1209228,0.159163 0.07338,0.529167 0.092501,-0.510046 2.9993001,-1.099675 h 0.1400431 l 0.048059,0.408244 0.05426,0.08578 H 9.2785034 9.562207 l 0.05426,-0.08578 0.047542,-0.408244 h 0.1400431 l 2.9993003,1.099675 0.0925,0.510046 0.07338,-0.529167 0.12144,-0.159163 0.06356,-0.398425 v -0.334864 l -0.05426,-0.360184 -0.191203,-0.522449 h -0.05116 l -0.143144,0.353467 -0.76171,-0.442867 -1.848983,-1.074353 -0.146761,-0.146245 0.041858,-0.449585 0.03514,-0.695048 0.09198,-0.917773 0.0098,-0.729671 0.04444,-0.685747 V 9.6893311 h 0.264583 v 0.2108398 h 0.0832 V 9.6929484 h 0.981335 l 0.04961,0.2361613 0.04599,0.012402 0.04186,-0.2485636 h 0.426848 l 0.204122,0.082682 v 0.2738853 l 0.07958,-0.066663 V 9.8076701 l 0.666109,0.2609659 v 0.226343 l 0.111622,0.02584 v -0.210323 l 0.655257,0.248564 v 0.234094 l 0.06821,-0.06873 V 10.38748 l 0.730188,0.283703 v 0.194304 h 0.06976 v -0.165365 l 0.695048,0.267684 v 0.251664 l 0.06046,-0.05736 v -0.172082 l 0.876433,0.312126 v 0.223242 l 0.06408,-0.05116 v -0.143144 l 1.755965,0.672311 v -0.299207 l -0.01912,-0.197921 -0.06666,-0.245463 -0.09922,-0.213423 -0.136943,-0.140043 -1.035595,-0.711068 -2.053105,-1.4247194 V 8.6408162 h 0.09922 V 8.459432 h 0.0925 l 0.04444,-0.2904216 V 7.7359619 L 14.9071,7.4935994 14.878678,7.3308187 14.824418,7.2801758 h -0.430465 l -0.06046,0.034623 -0.04134,0.1529622 -0.02532,0.2490804 v 0.4015259 l 0.02222,0.3824056 -1.048515,-0.730188 V 7.5762817 h 0.08888 l 0.05426,-0.057361 0.01912,-0.4046265 V 6.8559123 l -0.02687,-0.3648356 -0.07493,-0.074931 h -0.468705 l -0.06356,0.025322 -0.03514,0.245463 -0.02222,0.386023 0.0124,0.3472656 -0.984953,-0.6728271 V 6.5055461 h 0.134359 l 0.02842,-0.2744019 V 5.8265177 l -0.03514,-0.3700032 -0.06046,-0.060461 h -0.484725 l -0.06046,0.057361 -0.04754,0.3570841 -0.0031,0.5803264 L 10.45776,5.8327189 10.234517,5.6161947 10.135815,5.4601318 10.132715,2.6933757 10.078455,2.1549072 10.043315,1.9569865 9.9508138,1.4882812 9.8521118,1.137915 9.7182699,0.81907145 9.5492879,0.55448812 9.3994263,0.39842529 Z","a":[9.26,7.408]},"AN12":{"d":"M 3.6624855,6.2093816 H 5.8790506 M 5.8943906,5.7206715 H 8.1109558 M 12.50138,5.7206715 H 10.284814 M 14.733242,6.2093816 H 12.516677 M 9.1989215,1.4366048 9.1053872,1.4598592 8.9539753,1.6257405 8.8284015,1.8438151 8.7064452,2.1213175 8.5772541,2.4499796 8.5178262,2.6830403 8.4439289,3.0266886 8.3958698,3.2886881 8.340576,3.6731607 8.2888996,4.1056925 8.2480752,4.5382242 8.2113849,5.461682 v 1.2712402 l -0.051676,0.037207 -0.037207,0.081132 -0.00723,0.096118 -0.8428426,0.151412 V 6.3634358 L 7.2615721,6.0642292 H 7.165454 L 7.1396158,5.720581 7.1060261,5.6466837 7.0026732,5.5211099 l -0.118339,0.1400432 -0.03669,0.05581 -0.048059,0.3364136 H 6.7220702 V 7.2062784 L 5.0513712,7.5127196 V 6.5112304 L 4.9557698,6.4487019 4.9516357,6.2492308 4.9149454,6.1159057 4.863269,6.0161701 4.7707681,5.9314208 4.6596638,6.0347737 4.6079874,6.15673 v 0.2955892 l -0.088367,0.073897 V 7.557161 L 4.4679444,7.597985 0.62063404,8.34781 0.55810554,8.385017 0.53226734,8.458914 v 0.4842082 l 0.0847493,0.1700155 7.50186756,-0.1591634 0.014469,0.1477946 0.040824,0.118339 0.073897,0.1369425 0.00723,0.9865036 -0.00362,2.309419 0.040824,0.52865 0.092501,0.668693 0.1663981,0.753959 -0.00413,0.136943 -0.073897,0.0739 -1.9249471,0.505912 -0.066663,0.02997 -0.048059,0.07028 -0.025838,0.10697 0.025838,0.121956 0.029456,0.199471 0.066663,0.04806 2.4169067,0.185002 0.040308,0.07751 -0.00362,0.173632 0.040824,0.06253 v 0.08527 l 0.1219564,0.08475 0.05271,0.02222 0.050643,-0.02222 0.1219564,-0.08475 v -0.08527 l 0.040824,-0.06253 -0.00362,-0.173632 0.040308,-0.07751 2.4169063,-0.185002 0.06666,-0.04806 0.02945,-0.199471 0.02584,-0.121956 -0.02584,-0.10697 -0.04806,-0.07028 -0.06666,-0.02997 -1.9249472,-0.505912 -0.073897,-0.0739 -0.00362,-0.136943 0.1658812,-0.753959 0.0925,-0.668693 0.04082,-0.52865 -0.0036,-2.309419 0.0072,-0.9865036 0.0739,-0.1369425 0.04082,-0.118339 0.01447,-0.1477946 7.501867,0.1591634 0.08475,-0.1700155 V 8.458915 L 17.837627,8.385018 17.775097,8.347811 13.928304,7.597986 13.876114,7.557162 V 6.5262165 l -0.08837,-0.073897 V 6.15673 L 13.736064,6.0347737 13.62496,5.9314208 13.53246,6.0161698 13.48078,6.1159058 13.44409,6.2492309 13.44049,6.448702 13.34437,6.51123 V 7.5127196 L 11.673706,7.2062784 V 6.0533772 h -0.07752 l -0.04806,-0.3364136 -0.03669,-0.05581 -0.118339,-0.1400432 -0.103353,0.1255738 -0.03359,0.073897 -0.02584,0.3436482 h -0.09612 l -0.01085,0.2992066 v 0.7353556 l -0.842843,-0.151412 -0.0072,-0.096118 -0.03669,-0.081132 -0.05219,-0.037207 V 5.461682 L 10.147701,4.5382242 10.106876,4.1056925 10.0552,3.6731607 9.9999062,3.2886881 9.9518472,3.0266886 9.8779499,2.6830403 9.818522,2.4499796 9.6893309,2.1213175 9.5673745,1.8438151 9.4418008,1.6257405 9.2903888,1.4598592 Z","a":[9.26,8.202]},"E290":{"d":"m 9.2513734,0.91984863 -0.059428,0.020154 -0.099219,0.08785 -0.1105876,0.1457275 -0.079065,0.1436605 -0.079582,0.2030884 -0.06873,0.2098063 -0.07028,0.30024 -0.057361,0.3663859 -0.037724,0.333313 -0.019637,0.2868042 -0.00672,0.1963705 v 3.1455443 l -0.024805,0.065112 -0.038241,0.073381 -0.057878,0.088883 -0.063562,0.070797 -0.063562,0.050643 -0.7425903,0.3953247 0.022738,-0.1188557 0.012919,-0.3167766 V 6.3252034 L 7.5930767,6.1246988 7.55742,5.9825886 7.5191794,5.8993896 7.4509666,5.8156737 7.1440085,5.8027546 l -0.1669148,-0.00517 -0.3147095,0.023254 -0.063045,0.048059 -0.043408,0.098702 -0.032556,0.1167888 -0.025321,0.1772501 -0.00517,0.4335653 0.030489,0.2914551 0.055811,0.407727 h 0.1390096 v 0.1043864 l 0.028939,0.049609 -4.5201375,2.4820197 -0.0863,0.06615 -0.1136882,0.131775 -0.3271118,0.47904 -0.1240234,0.212907 -0.027905,0.124023 v 0.144694 l 0.026355,0.0155 0.026355,-0.02635 v -0.07286 l 0.532784,-0.377755 0.1240234,-0.0584 2.111499,-0.7095175 0.00982,0.1467615 0.035657,0.177767 0.050643,-0.200504 0.00775,-0.1545135 1.3632243,-0.4485514 0.00775,0.1772501 0.038241,0.1901693 0.058394,-0.1948202 0.012402,-0.2056722 0.9353434,-0.2733683 h 0.5348511 l 0.045475,0.2382284 0.050643,-0.2361613 H 8.36357 l 0.1948202,0.4335652 v 3.5129639 l 0.015503,0.403077 0.027905,0.281119 0.05581,0.443901 0.088367,0.458887 0.1674317,0.762744 -1.7616496,1.196309 -0.055811,0.111621 -0.055811,0.182418 -0.040308,0.172083 v 0.182417 l 2.0556884,-0.527099 0.03514,0.327112 0.045992,0.288871 0.055294,0.200504 h 0.068213 0.06873 l 0.055294,-0.200504 0.045992,-0.288871 0.03514,-0.327112 2.0556883,0.527099 V 17.13488 l -0.04031,-0.172083 -0.05581,-0.182418 -0.05581,-0.111621 -1.7616491,-1.196309 0.1674317,-0.762744 0.088367,-0.458887 0.05581,-0.443901 0.027905,-0.281119 0.015503,-0.403077 V 9.6097573 L 10.157261,9.1761921 h 0.844393 l 0.05064,0.2361613 0.04548,-0.2382284 h 0.534851 l 0.935343,0.2733683 0.01292,0.2056722 0.05788,0.1948202 0.03824,-0.1901693 0.0078,-0.1772501 1.363224,0.4485514 0.0078,0.1545133 0.05064,0.200504 0.03566,-0.177767 0.0098,-0.1467613 2.111499,0.7095173 0.124024,0.0584 0.532784,0.377755 v 0.07286 l 0.02636,0.02635 0.02635,-0.0155 v -0.144694 l -0.02791,-0.124023 -0.124023,-0.212907 -0.327112,-0.47904 -0.113688,-0.131775 -0.0863,-0.06615 -4.520137,-2.4820195 0.02894,-0.049609 V 7.3943887 h 0.139009 l 0.05581,-0.407727 0.03049,-0.2914551 -0.0052,-0.4335653 -0.02532,-0.1772501 -0.03256,-0.1167888 -0.04341,-0.098702 -0.06304,-0.048059 -0.314709,-0.023254 -0.166915,0.00517 -0.306958,0.012919 -0.06821,0.083716 -0.03824,0.083199 -0.03514,0.1421102 -0.0155,0.2005046 v 0.3420979 l 0.01292,0.3167766 0.02274,0.1188557 -0.74259,-0.3953247 -0.06356,-0.050643 -0.06356,-0.070797 -0.05788,-0.088883 -0.03824,-0.073381 -0.024805,-0.065112 V 3.2132487 L 9.9510723,3.0168782 9.9314353,2.730074 9.8937115,2.396761 9.8363506,2.0303751 9.7660707,1.7301351 9.697341,1.5203288 9.6177593,1.3172404 9.5386944,1.1735799 9.4281068,1.0278524 l -0.099219,-0.08785 z","a":[9.26,7.673]},"A343":{"d":"m 9.2612538,0.63315983 -0.047026,0.0124023 -0.058911,0.0496094 -0.057878,0.0749308 -0.060461,0.097152 L 8.9754828,0.99541196 8.85456,1.2811826 8.764643,1.5359474 8.69798,1.754022 8.638035,1.9943174 8.599794,2.1731178 8.569822,2.3452003 8.541917,2.521417 8.517112,2.7741147 8.503676,2.9560158 8.492307,3.198895 V 7.0637753 L 7.056219,7.945892 7.069655,7.8301368 7.082057,7.7278174 7.089807,7.6141293 7.096007,7.4901058 V 7.3753839 L 7.0846425,7.234824 7.0722402,7.0529229 7.0686228,6.9774753 7.046402,6.9552545 H 6.5022491 l -0.024805,0.01602 -0.0062,0.085266 -0.00982,0.1255737 -0.0062,0.1069702 -0.00258,0.099736 v 0.151412 l 0.00258,0.1038696 0.00982,0.1059367 0.023254,0.2030884 0.027388,0.1648478 0.028422,0.1353922 -2.1714436,1.3477214 0.010852,-0.1012858 0.013436,-0.133842 0.00362,-0.1555461 0.00258,-0.1720825 -0.00103,-0.1860351 -0.012402,-0.1638143 -0.00465,-0.059428 -0.019637,-0.01602 H 3.8171418 l -0.024805,0.020154 -0.014469,0.1586467 -0.00775,0.2242757 v 0.1958536 l 0.00517,0.1539958 0.013436,0.1390096 0.011369,0.1131714 0.027905,0.1638148 0.024805,0.134359 -2.4153564,1.4965487 -0.022221,0.01964 -0.01602,0.02584 -0.0062,0.05064 -0.00103,0.08268 -0.2046386,0.466638 v 0.219108 l 0.1912028,-0.136426 2.6282633,-1.14825 -0.00103,0.05788 0.00982,0.05684 0.013436,0.05891 0.013436,0.05323 0.012402,0.03307 0.014986,0.03721 0.01602,0.03411 0.022221,0.0015 0.014469,-0.02739 0.011369,-0.03824 0.011886,-0.03824 0.013953,-0.04651 0.011886,-0.05323 0.00878,-0.06253 0.013436,-0.136941 0.2428793,-0.0801 -0.00258,0.05581 0.012402,0.07752 0.013436,0.05426 0.013436,0.04186 0.011369,0.03566 0.014469,0.04186 0.014986,0.02222 0.024805,-0.0015 0.0062,-0.02325 0.00982,-0.03049 0.010852,-0.03824 0.014986,-0.04082 0.012402,-0.05064 0.013436,-0.06511 0.00878,-0.03721 0.00362,-0.103353 0.6955647,-0.241329 v 0.05064 l 0.00982,0.06666 0.013953,0.05995 0.012402,0.04341 0.014469,0.04186 0.011369,0.03669 0.014469,0.02842 0.024805,-0.001 0.00982,-0.02377 0.014986,-0.03411 0.010852,-0.03979 0.01602,-0.04547 0.014986,-0.05994 0.00982,-0.05684 0.010852,-0.133325 0.6888468,-0.235127 0.00103,0.05064 0.00982,0.06304 0.013436,0.05788 0.013953,0.04289 0.013436,0.03824 0.010852,0.03669 0.01757,0.03979 0.026872,-0.0015 0.00982,-0.03669 0.014986,-0.03462 0.012402,-0.04548 0.011886,-0.04909 0.012402,-0.05064 0.012402,-0.0801 0.00878,-0.09715 0.657841,-0.2330597 h 0.1188558 l -0.00258,0.07545 0.00155,0.06615 0.013436,0.06304 0.012402,0.04806 0.013436,0.04548 0.00982,0.04082 0.014986,0.03204 0.022221,0.02325 0.027905,-0.03824 0.00517,-0.02739 0.00982,-0.03669 0.013436,-0.04806 0.013436,-0.04702 0.011369,-0.07493 0.012402,-0.1219557 H 8.366753 l 0.00155,0.05788 0.00982,0.08268 0.010852,0.06666 0.01757,0.07596 0.011886,0.04806 0.013953,0.05581 0.011886,0.05995 0.024805,0.06666 0.019637,0.05529 v 1.697571 l 0.00775,0.264583 0.0062,0.176217 0.013436,0.238745 0.013436,0.191203 0.026872,0.278019 0.024805,0.208256 0.029455,0.233061 0.022221,0.173632 0.024805,0.152446 0.023254,0.147795 0.05426,0.338997 0.024805,0.178284 0.1674317,1.085205 -2.1678263,1.288293 -0.026872,0.02584 -0.03824,0.05168 -0.027389,0.07906 -0.00723,0.07751 -0.041858,0.450618 2.497522,-0.709517 0.07183,0.695048 0.022221,0.01809 0.05426,0.0021 0.048059,-0.0021 0.021704,-0.01809 0.07183,-0.695048 2.4975226,0.709517 -0.04186,-0.450618 -0.0072,-0.07751 -0.02739,-0.07906 -0.03772,-0.05168 -0.02739,-0.02584 -2.1678263,-1.288293 0.1674316,-1.085205 0.024805,-0.178284 0.05426,-0.338997 0.023254,-0.147795 0.024805,-0.152446 0.022221,-0.173632 0.029455,-0.233061 0.024805,-0.208256 0.026872,-0.278019 0.013436,-0.191203 0.01395,-0.238745 0.0062,-0.176217 0.0072,-0.264583 v -1.697571 l 0.01964,-0.05529 0.0248,-0.06666 0.01189,-0.06046 0.01395,-0.05529 0.0124,-0.04806 0.01705,-0.07596 0.01085,-0.06666 0.01034,-0.08268 10e-4,-0.05788 h 1.029395 l 0.0124,0.1219557 0.01137,0.07493 0.01344,0.04702 0.01344,0.04806 0.0098,0.03669 0.0052,0.02739 0.02842,0.03824 0.0217,-0.02325 0.01499,-0.03204 0.0098,-0.04082 0.01343,-0.04548 0.0124,-0.04806 0.01395,-0.06304 10e-4,-0.06615 -0.0026,-0.07545 h 0.119373 l 0.657324,0.2330597 0.0088,0.09715 0.0124,0.0801 0.0124,0.05064 0.01189,0.04909 0.0124,0.04548 0.01499,0.03462 0.0098,0.03669 0.02739,0.0015 0.01705,-0.03979 0.01085,-0.03669 0.01395,-0.03824 0.01343,-0.04289 0.01344,-0.05788 0.0098,-0.06304 10e-4,-0.05064 0.688847,0.235128 0.01085,0.133325 0.0098,0.05684 0.01499,0.05994 0.01602,0.04547 0.01085,0.03979 0.01499,0.03411 0.0098,0.02377 0.02481,10e-4 0.01447,-0.02842 0.01137,-0.03669 0.01499,-0.04186 0.01189,-0.04341 0.01395,-0.05995 0.0098,-0.06666 v -0.05064 l 0.695565,0.241329 0.0041,0.103353 0.0083,0.03721 0.01344,0.06511 0.0124,0.05064 0.01499,0.04082 0.01085,0.03824 0.0098,0.03049 0.0062,0.02325 0.02481,0.0015 0.01499,-0.02222 0.01447,-0.04186 0.01137,-0.03566 0.01344,-0.04186 0.01344,-0.05426 0.0124,-0.07752 -0.0026,-0.05581 0.242879,0.0801 0.01344,0.136942 0.0088,0.06253 0.01188,0.05323 0.01395,0.04651 0.0124,0.03824 0.01085,0.03824 0.01499,0.02739 0.0217,-0.0015 0.01602,-0.03411 0.01499,-0.03721 0.0124,-0.03307 0.01344,-0.05323 0.01344,-0.05891 0.01033,-0.05684 -0.0015,-0.05788 2.628263,1.14825 0.191203,0.136426 v -0.219108 l -0.204639,-0.466638 -0.001,-0.08268 -0.0062,-0.05064 -0.01602,-0.02584 -0.02222,-0.01964 -2.415357,-1.4965487 0.02481,-0.134359 0.02842,-0.1638148 0.01085,-0.1131714 0.01344,-0.1390096 0.0052,-0.1539958 V 9.0161106 L 14.74298,8.7918349 14.72851,8.6331882 14.7037,8.6130342 h -0.54777 l -0.02015,0.01602 -0.0047,0.059428 -0.0124,0.1638143 -10e-4,0.1860351 0.0026,0.1720825 0.0036,0.1555461 0.01344,0.133842 0.01085,0.1012858 -2.171444,-1.3477214 0.02842,-0.1353922 0.02739,-0.1648478 0.02326,-0.2030884 0.0098,-0.1059367 0.0026,-0.1038696 v -0.151412 l -0.0026,-0.099736 -0.0062,-0.1069702 -0.0098,-0.1255737 -0.0062,-0.085266 -0.0248,-0.01602 h -0.544153 l -0.02222,0.022221 -0.0036,0.075448 -0.0124,0.1819011 -0.01085,0.1405599 v 0.1147216 l 0.0057,0.1240235 0.0078,0.1136881 0.0124,0.1023194 0.01343,0.1157552 -1.436088,-0.8821167 V 3.1988947 L 10.01728,2.9560155 10.003844,2.7741144 9.9790394,2.5214167 9.9511342,2.3452 9.9211618,2.1731175 9.883438,1.9943171 9.8229766,1.7540217 9.756314,1.5359471 9.666397,1.2811823 9.5454742,0.99541166 9.4839792,0.86725406 9.4240346,0.77010236 9.366157,0.69517155 9.3067291,0.64556217 Z","a":[9.26,8.467]},"A337":{"d":"M 9.2708478,0.52658284 9.2113239,0.54983723 9.0779987,0.68626301 8.9379556,0.93275959 8.7483031,1.4061157 8.4583983,2.2685953 8.3819172,2.392102 8.2951008,2.5884724 8.2150023,2.8814778 8.1354206,3.348116 8.1085488,3.6576578 V 7.1659707 L 7.0393635,7.7721353 7.0590005,7.5592284 h 0.096635 l 0.03669,-0.2532145 0.03669,-0.2800863 0.029972,-0.2232422 V 6.4729898 L 7.2424519,6.2962564 7.2124795,6.1763671 7.1556355,6.0962686 H 6.426481 l -0.050126,0.040308 -0.043408,0.083199 -0.029972,0.243396 v 0.3395141 l 0.020154,0.2666504 0.043408,0.4697388 h 0.1028361 l 0.029972,0.5395019 -4.1775227,2.4386105 -0.059945,0.04703 -0.056327,0.06976 -0.026872,0.07338 V 11.5533 H 2.2820312 V 11.443229 L 3.584794,10.977108 v 0.163297 l 0.029972,0.129708 0.035657,-0.0093 0.031006,-0.09715 0.012919,-0.226342 0.7431071,-0.270268 v 0.210323 l 0.029972,0.116272 0.050126,-0.126607 0.029972,-0.242879 0.5426025,-0.196888 0.00362,0.236678 0.033073,0.0801 h 0.020154 l 0.043408,-0.149862 0.00672,-0.203605 0.7596435,-0.283187 -0.00362,0.163298 0.029972,0.110071 0.029972,0.05013 0.046509,-0.0801 0.026872,-0.293005 0.3064412,-0.1167889 h 1.0097575 l 0.00982,0.2165239 0.039791,0.116789 0.050126,-0.100252 0.020154,-0.2361615 h 0.5896281 v 2.0184815 l 0.026355,0.340031 0.047026,0.45992 0.1064535,0.532784 0.4929931,2.52181 -1.9590535,1.412834 v -0.236678 l -0.016536,-0.0832 -0.029972,-0.04703 -0.039791,0.03669 -0.013436,0.266651 0.00982,0.666109 -0.013436,0.213423 h 0.059945 l 2.2722127,-0.822688 0.1198893,0.639237 0.059945,0.173633 0.03359,0.0863 0.033073,-0.0863 0.059945,-0.173633 0.1198894,-0.639237 2.2722131,0.822688 h 0.05994 l -0.01344,-0.213423 0.01034,-0.666109 -0.01344,-0.266651 -0.04031,-0.03669 -0.02997,0.04703 -0.01654,0.0832 v 0.236678 l -1.9590532,-1.412834 0.4935102,-2.52181 0.106453,-0.532784 0.04651,-0.45992 0.02687,-0.340031 V 9.9378945 h 0.589628 l 0.01964,0.2361615 0.05013,0.100252 0.04031,-0.116789 0.0098,-0.2165239 h 1.009241 l 0.306441,0.1167889 0.02687,0.293005 0.04651,0.0801 0.02997,-0.05013 0.02997,-0.110071 -0.0031,-0.163298 0.759643,0.283187 0.0067,0.203605 0.04289,0.149862 H 13.409 l 0.03359,-0.0801 0.0031,-0.236678 0.543119,0.196888 0.02997,0.242879 0.04961,0.126607 0.03049,-0.116272 v -0.210323 l 0.74259,0.270268 0.01344,0.226342 0.03049,0.09715 0.03617,0.0093 0.02997,-0.129708 v -0.163297 l 1.302763,0.466121 V 11.5533 h 0.102836 v -0.845943 l -0.02635,-0.07338 -0.05684,-0.06976 -0.05995,-0.04703 -4.177523,-2.4386105 0.02997,-0.5395019 H 12.1698 l 0.04341,-0.4697388 0.01964,-0.2666504 V 6.4631713 l -0.02997,-0.243396 -0.04341,-0.083199 -0.04961,-0.040308 h -0.729671 l -0.05684,0.080099 -0.02997,0.1198893 -0.01654,0.1767334 v 0.3296956 l 0.02997,0.2232422 0.03669,0.2800863 0.03669,0.2532145 h 0.09664 L 11.496972,7.7721353 10.42727,7.1659707 V 3.6576578 l -0.02636,-0.3095418 -0.0801,-0.4666382 -0.0801,-0.2930054 -0.0863,-0.1963704 -0.077,-0.1235067 L 9.7875161,1.4061157 9.5978636,0.93275959 9.4578205,0.68626301 9.3244953,0.54983723 Z","a":[9.26,8.467]},"RV9":{"d":"m 9.2607824,3.3615696 c -0.1744544,0 -0.3386896,0.5690992 -0.3386896,0.758099 H 8.5889784 c -0.073468,0 -0.068176,-0.00235 -0.094438,0.1445753 L 8.2846594,5.696884 8.2478805,6.4788933 H 1.9661026 c -0.1971498,0 -0.5329138,0.1241945 -0.5741916,0.4929441 L 1.138758,9.0138011 H 8.3239016 L 8.929283,12.753563 H 6.5251471 c -0.1191896,0 -0.2151044,0.119178 -0.2151044,0.215106 v 1.407016 h 2.5421082 l 0.238331,-0.556277 0.068106,0.181684 0.051063,0.692367 c -0.028374,0.09651 -0.016492,0.0561 -0.028374,0.09651 l 0.011385,0.204394 0.067761,0.100027 0.067831,-0.100027 0.011317,-0.204394 c -0.028388,-0.09651 -0.02212,-0.0752 -0.028388,-0.09651 l 0.051063,-0.692367 0.068106,-0.181684 0.238331,0.556277 h 2.5421901 v -1.407016 c 0,-0.09593 -0.09592,-0.215106 -0.215104,-0.215106 H 9.5915505 L 10.197015,9.0138011 h 7.18506 L 17.128915,6.9718374 C 17.087651,6.6030878 16.751963,6.4788933 16.554814,6.4788933 H 10.272946 L 10.236236,5.696884 10.026272,4.2642439 C 10.000051,4.1173011 10.005295,4.1196686 9.9318276,4.1196686 H 9.5988028 c 0,-0.1889998 -0.1637245,-0.758099 -0.3381721,-0.758099 z","a":[9.26,7.673]},"B772":{"d":"m 9.2979582,0.73265369 c -0.1276474,0 -0.2621337,0.22794202 -0.3236783,0.37382411 L 8.8238385,1.4529499 C 8.6737053,1.774663 8.479646,2.5255531 8.479646,4.0309746 v 2.3992258 c 0,0.1897569 -0.1524787,0.331697 -0.2327874,0.3895941 L 7.221524,7.4865423 C 7.250202,7.3461037 7.264576,7.1886792 7.264476,6.868353 7.264476,6.3939723 7.21031,6.1567819 7.1767,6.1567819 H 6.2410132 c -0.033991,0 -0.097118,0.295223 -0.097118,0.6742179 0,0.3942762 0.033575,0.758263 0.076572,0.758263 h 0.1213971 c 0,0.069101 0.097117,0.3529837 0.1195284,0.3922043 L 1.5028071,11.266648 C 1.2824258,11.421661 1.2712204,11.421661 1.23947,11.972616 l 2.8388139,-0.941291 c 0,0.07844 0.024025,0.243329 0.063427,0.253885 0.031967,-0.0086 0.046865,-0.201329 0.046865,-0.288306 l 1.3427301,-0.44743 c 0,0.07938 0.018929,0.249375 0.04748,0.257026 0.029753,-0.0079 0.061439,-0.210356 0.061439,-0.290442 l 0.7566573,-0.256516 h 0.5700972 c 0,0.119125 0.032517,0.289006 0.059559,0.30462 0.030629,-0.01702 0.059523,-0.172991 0.059523,-0.30007 h 1.393799 v 3.278192 c 0,0.330316 0.1143677,1.114011 0.2773126,1.722127 0.013607,0.05076 -0.013471,0.08669 -0.035562,0.106393 l -2.312852,1.863892 c -0.032833,0.03283 -0.04298,0.212539 -0.04298,0.308062 0,0.113434 0.00955,0.345077 0.04298,0.337913 l 2.6483769,-0.93135 c 0.015523,-0.006 -0.00243,-0.200598 -0.015523,-0.273435 l 0.2268677,0.939708 h 0.065668 l 0.226867,-0.940903 c -0.01791,0.07523 -0.010754,0.272243 -0.010754,0.272243 l 2.6459913,0.940901 c 0.01313,0.0084 0.02747,-0.222091 0.02747,-0.331942 0,-0.128956 -0.0048,-0.291345 -0.0215,-0.31045 L 9.872657,15.369608 c -0.026,-0.02484 -0.03762,-0.05978 -0.02505,-0.0959 0.147617,-0.614398 0.279692,-1.399618 0.279692,-1.731231 v -3.280995 h 1.390253 c 0,0.09801 0.03097,0.285869 0.05613,0.297285 0.02297,-0.01122 0.0517,-0.196653 0.0517,-0.295891 h 0.57584 l 0.769091,0.258542 c 0,0.107071 0.03237,0.263291 0.05353,0.275515 0.02633,-0.007 0.05632,-0.136733 0.05632,-0.243339 l 1.325174,0.440507 c 0,0.108378 0.03631,0.279876 0.06268,0.295102 0.02525,-0.01458 0.05071,-0.149999 0.05071,-0.263029 l 2.83241,0.947246 c -0.0086,-0.543472 -0.02025,-0.556636 -0.26014,-0.71168 L 12.14197,7.9896502 c 0.03128,-0.067764 0.127714,-0.3310166 0.127714,-0.396177 h 0.117289 c 0.02345,0 0.07038,-0.3336243 0.07038,-0.7506535 0,-0.4144236 -0.05473,-0.6880986 -0.101652,-0.6880986 h -0.922678 c -0.04179,0 -0.09904,0.2189402 -0.09904,0.7011299 0,0.3050072 0.02158,0.5627941 0.0391,0.6281515 L 10.351342,6.8141485 C 10.244479,6.7463854 10.132401,6.6629753 10.132401,6.4857376 V 4.0304759 c 0,-1.5039126 -0.206371,-2.254913 -0.357544,-2.5753304 L 9.6293585,1.1086625 C 9.5694111,0.96009607 9.4382858,0.73265369 9.2979402,0.73265369 Z","a":[9.26,8.467]},"A332":{"d":"m 9.2888196,0.73793945 -0.040805,0.007751 -0.053227,0.0377238 -0.066663,0.0821655 -0.07028,0.10645345 -0.056844,0.1198898 -0.057361,0.1255737 -0.066663,0.1632976 -0.068213,0.1788004 -0.07028,0.2072225 -0.053227,0.1808675 -0.060978,0.2511475 -0.06873,0.3689697 -0.037724,0.1958537 -0.024805,0.2588989 -0.021187,0.3364136 V 6.5928792 L 6.7830485,7.6253743 6.9029378,7.0683024 h 0.1100708 l 0.032556,-0.2418457 0.03359,-0.3999756 V 6.0962687 L 7.0652018,5.8993815 7.0393636,5.6534017 7.0207601,5.6394491 H 6.2275269 l -0.027905,0.020154 -0.022221,0.243396 -0.01602,0.1674316 v 0.3121257 l 0.018087,0.3219441 0.042375,0.3622518 h 0.1167888 l 0.1369425,0.6583578 h 0.050126 l 0.00207,0.05271 -5.55314939,3.4349319 -0.0604614,0.03617 -0.0418579,0.02997 -0.0180868,0.04031 -0.0103353,0.150895 -0.21342367,0.469222 v 0.241846 l 0.2056722,-0.147278 3.28352056,-1.393197 -0.00207,0.09664 0.020154,0.08837 0.032556,0.10697 0.027905,0.06821 h 0.020154 l 0.034106,-0.09663 0.034623,-0.122473 0.021704,-0.112655 v -0.09508 l 0.7513753,-0.253215 0.00207,0.0925 0.027905,0.118856 0.029972,0.09664 0.022221,0.04186 h 0.024288 l 0.046509,-0.14056 0.029972,-0.147278 0.00827,-0.130742 0.7487916,-0.2557976 v 0.090951 l 0.026355,0.100252 0.038241,0.120923 0.022221,0.04031 h 0.022221 l 0.034107,-0.102836 0.034106,-0.130741 0.020154,-0.100769 v -0.0863 L 6.9044881,9.678479 h 0.1245402 l 0.00413,0.1348755 0.020154,0.1188558 0.038241,0.1126547 0.024288,0.05219 h 0.029972 l 0.032039,-0.1188557 0.040308,-0.1508952 0.010335,-0.1508952 h 1.1032919 l 0.01602,0.1550293 0.026355,0.142627 0.032039,0.1291908 0.062528,0.19327 v 1.733228 l 0.023771,0.426847 0.042375,0.533818 0.042375,0.374137 0.056327,0.401009 0.090951,0.573608 0.080098,0.527617 0.078548,0.505395 0.048576,0.319877 -2.2954672,1.365292 -0.058394,0.05219 -0.045992,0.0708 -0.022221,0.07855 -0.05271,0.54932 2.6799398,-0.762744 0.076481,0.752926 0.075955,9.6e-5 0.07494,-9.6e-5 0.076481,-0.752926 2.6799392,0.762744 -0.05271,-0.54932 -0.0217,-0.07855 -0.04651,-0.0708 -0.05839,-0.05219 -2.2954667,-1.365292 0.048576,-0.319877 0.078548,-0.505395 0.080615,-0.527617 0.090434,-0.573608 0.056327,-0.401009 0.04237,-0.374137 0.04237,-0.533818 0.02377,-0.426847 v -1.733228 l 0.06253,-0.19327 0.03256,-0.1291908 0.02584,-0.142627 0.01602,-0.1550293 h 1.103809 l 0.0098,0.1508952 0.04031,0.1508952 0.03204,0.1188557 h 0.03049 l 0.02377,-0.05219 0.03824,-0.1126547 0.02015,-0.1188558 0.0041,-0.1348755 h 0.125057 l 0.706417,0.2495972 v 0.0863 l 0.02015,0.100769 0.03411,0.130741 0.03462,0.102836 h 0.02222 l 0.0217,-0.04031 0.03824,-0.120923 0.02636,-0.100252 v -0.090951 l 0.748791,0.2557978 0.0083,0.130742 0.03049,0.147278 0.04599,0.14056 h 0.02429 l 0.02222,-0.04186 0.02997,-0.09664 0.02842,-0.118856 0.0021,-0.0925 0.750858,0.253215 v 0.09508 l 0.02222,0.112655 0.03411,0.122473 0.03411,0.09663 h 0.02015 l 0.02842,-0.06821 0.03204,-0.10697 0.02015,-0.08837 -0.0021,-0.09664 3.284037,1.393197 0.205156,0.147278 V 11.9393 l -0.213424,-0.469222 -0.0098,-0.150895 -0.01809,-0.04031 -0.04237,-0.02997 -0.06046,-0.03617 -5.55315,-3.4349321 0.0021,-0.05271 h 0.05064 l 0.136943,-0.6583578 h 0.116789 l 0.04186,-0.3622518 0.01809,-0.3219441 V 6.0704305 l -0.01602,-0.1674316 -0.02222,-0.243396 -0.02791,-0.020154 h -0.793234 l -0.01809,0.013953 -0.02636,0.2459798 -0.01395,0.1968872 v 0.3302124 l 0.03359,0.3999756 0.03256,0.2418457 h 0.110587 L 11.794629,7.6253743 10.105843,6.5928792 V 3.3589681 L 10.084656,3.0225545 10.060368,2.7636556 10.022127,2.5678019 9.9533976,2.1988322 9.8929362,1.9476847 9.8397095,1.7668172 9.7689128,1.5595947 9.7006999,1.3807943 9.6340373,1.2174967 9.5771932,1.091923 9.5198324,0.97203369 9.4495524,0.86558024 9.3828898,0.78341471 9.3296631,0.74569092 Z","a":[9.26,8.202]},"AS65":{"d":"m 9.0577924,2.8104269 0.2039112,0.053194 0.1418511,0.097523 0.1152543,0.2305081 0.1063882,0.3989565 0.079791,0.3191653 0.019947,0.097523 h 0.086441 V 3.681482 l 0.034275,-0.019788 0.038194,0.038194 V 4.1203348 H 9.7603985 l 0.115254,0.3258145 0.2349405,0.6316811 0.18618,0.9996077 0.03325,0.5474568 v 1.2611459 h 0.500912 V 7.3252853 l 0.04211,-0.2992173 0.07093,-0.2105604 0.05098,-0.097523 V 6.4342824 h 0.124119 v 0.2881352 l 0.05098,0.095306 0.07757,0.1906124 0.07979,0.3235981 v 2.2297237 l -0.0399,0.3723595 -0.07757,0.2726207 -0.12412,0.181747 -0.130769,-0.201695 -0.09531,-0.2947849 v -0.817861 h -0.609517 v 0.1795306 l -0.123012,0.1230114 -0.02549,0.2848107 -0.04211,0.2992173 -0.0399,0.2482399 -0.042112,0.310299 -0.055411,0.294785 -0.024381,0.283702 -0.046545,0.3103 -0.059844,0.516427 -0.011083,0.372359 -0.044329,0.330248 -0.037679,0.283702 -0.037679,0.30365 0.08262,0.0477 v 0.12518 l -0.03327,0.05762 v 0.203913 l -0.045226,0.07833 -0.072752,0.0195 -0.095388,0.739981 h 1.3741818 v -0.234941 h 0.04433 l 0.201695,1.31434 -0.0399,0.06428 h -0.04433 l -0.04876,-0.381225 H 9.3747376 l -0.022164,1.941588 -0.028814,0.328031 -0.03103,0.137419 -0.1241163,0.190611 -0.066493,-0.130769 -0.1019556,-0.07536 -0.086441,-0.454367 -0.066493,-1.934939 H 7.3039158 l 0.012539,0.383657 -0.075228,-0.03134 -0.1629939,-1.360373 0.068959,-0.02507 0.068959,0.269567 h 1.5421732 l -0.1316487,-0.739742 -0.068959,0.0063 -0.054029,-0.200739 -0.00443,-0.274837 0.044328,-0.0399 -0.1130376,-0.9176 L 8.3840008,11.95983 8.2776124,11.144186 8.228851,10.76296 8.175657,10.377303 7.9850443,9.2735229 7.8813499,9.245738 V 9.0145258 H 7.292481 V 9.7171789 L 7.2467801,9.974247 7.1496653,10.21989 7.0754013,10.317005 7.0011372,10.237028 6.8583215,9.9685344 6.801195,9.6943284 V 7.1350716 L 6.8468963,6.8837158 6.9325855,6.7066244 V 6.3924301 h 0.1142527 v 0.337045 l 0.097114,0.1371029 0.079977,0.2513557 0.034276,0.1942293 v 0.5740763 h 0.575884 V 6.467939 L 7.8829961,5.9116229 7.9930366,5.3308535 8.0786237,4.8906914 8.2070043,4.5544562 8.3170451,4.2915816 8.353725,4.1020674 H 8.255911 l -0.00364,0.032378 H 8.2095091 L 8.1924038,4.1104981 V 3.670882 h 0.02908 l 0.02908,0.3079023 H 8.3959615 L 8.4658549,3.5872308 8.5534275,3.2855924 8.6539737,3.0682827 8.7577634,2.9190852 8.9102044,2.8379994 Z M 11.869044,1.6675984 11.75794,1.6986044 11.646318,1.8190105 10.906312,3.352767 10.919752,3.5041789 9.3725601,6.8884684 9.3772101,7.623824 9.2702368,7.8470661 9.0981542,8.0785765 A 0.39011139,0.39011139 0 0 0 8.8134171,8.2020832 L 8.5612361,8.141105 2.6670224,5.4394612 l -0.2139405,0.035657 -0.080098,0.088884 -0.075964,0.1338419 0.031006,0.1116211 0.120406,0.1111043 1.5337565,0.7405233 0.1519287,-0.013436 3.3837728,1.5471924 0.7353556,-0.00465 0.2232422,0.1069702 0.2315104,0.1715658 a 0.39011139,0.39011139 0 0 0 0.1235067,0.2847371 l -0.060978,0.2526978 -2.7016439,5.8936969 0.035657,0.213941 0.0894,0.08061 0.1333252,0.07545 0.1116211,-0.03101 0.11162,-0.120401 L 7.2905127,13.5847 7.2770768,13.433288 8.8242691,10.049516 8.8196183,9.3136432 8.9265885,9.0909178 9.0981542,8.8588906 A 0.39011139,0.39011139 0 0 0 9.3828914,8.735384 l 0.2526977,0.060978 5.8942129,2.701644 0.213941,-0.03566 0.0801,-0.08888 0.07597,-0.133842 -0.03152,-0.111621 -0.120406,-0.111105 -1.533757,-0.740006 -0.151412,0.01292 L 10.678936,8.7431354 9.9430639,8.7472695 9.7203385,8.6402993 9.4883113,8.4687336 A 0.39011139,0.39011139 0 0 0 9.3653214,8.1839964 l 0.060978,-0.2526977 2.7016436,-5.893697 -0.03566,-0.2139404 -0.0894,-0.080615 z","a":[8.996,6.615]},"H25A":{"d":"m 9.2325614,1.0941919 c -0.3314944,0 -1.0853965,1.958358 -1.0853965,3.5954301 v 2.5576297 c -0.076498,0.00765 -0.2065609,0.056125 -0.2575602,0.079077 L 1.4280426,10.172072 c -0.073949,0.03825 -0.2040155,0.09176 -0.2040155,0.288113 v 0.844074 c 0,0.02039 -0.00253,0.03571 0.028074,0.03315 l 5.9592081,-0.527884 c -0.022949,0.558439 0.022976,1.56822 0.4462682,2.547402 h 0.2754084 c 0.1835969,0 0.2830206,0.418232 0.3034204,0.51258 h 0.4666572 l 0.232027,0.956183 -2.8992869,1.218887 c -0.083518,0.04235 -0.213373,0.161375 -0.213373,0.428233 v 0.851078 l 3.3104779,-0.468827 c 0.03967,0.250629 0.09377,0.176732 0.1118,0.54276 0,0.01623 0.0071,0.02882 0.01519,0.02882 0.0081,0 0.01623,-0.01259 0.01623,-0.02882 0.01803,-0.366028 0.07213,-0.292131 0.1118,-0.54276 l 3.3104786,0.468827 V 16.47281 c 0,-0.266858 -0.129855,-0.385881 -0.213374,-0.428233 L 9.5857464,14.82569 9.8177734,13.869507 H 10.28443 c 0.0204,-0.09435 0.119823,-0.51258 0.303421,-0.51258 h 0.275408 c 0.423292,-0.979182 0.469218,-1.988963 0.446268,-2.547402 l 5.959209,0.527886 c 0.0306,0.0025 0.02807,-0.01276 0.02807,-0.03315 v -0.844076 c 0,-0.196348 -0.130067,-0.249864 -0.204016,-0.288113 L 10.631232,7.3263295 c -0.05101,-0.02295 -0.232066,-0.071428 -0.308564,-0.079077 l -0.01012,-2.5576301 c 0,-1.6370721 -0.7484486,-3.59543 -1.0799436,-3.59543 z","a":[9.26,8.996]},"A306":{"d":"m 9.2609337,0.36503372 -0.048576,0.005684 -0.05426,0.0320394 -0.067179,0.0671794 -0.061495,0.0780314 -0.071313,0.11368815 -0.069246,0.1317749 L 8.8030817,0.99031818 8.686293,1.2895247 8.5850072,1.6445418 8.5090432,1.9592512 8.4377292,2.3313215 8.3958712,2.628461 l -0.039274,0.3906739 -0.01912,0.326595 -0.00465,0.2397787 V 6.299038 l -0.00723,0.049609 -0.018604,0.046509 -0.027905,0.052193 -0.044442,0.058394 -0.060461,0.043925 -0.022738,0.014469 -1.2634888,0.7425903 0.010852,-0.079065 0.00672,-0.079582 0.00103,-0.068213 h 0.1503785 l 0.012919,-0.1353922 0.014986,-0.1684652 0.018604,-0.2444295 0.0062,-0.1286744 V 6.0370389 l -0.0093,-0.1901693 -0.011886,-0.144694 -0.01757,-0.1374593 -0.011886,-0.030489 -0.018604,-0.013953 H 6.2337283 l -0.024805,0.014986 -0.014986,0.031523 -0.00672,0.07028 -0.020154,0.1653646 -0.00672,0.1462443 v 0.4878255 l 0.0031,0.1477946 0.00982,0.151412 0.018604,0.1891357 0.020154,0.1529623 h 0.1493449 l 0.041341,0.5090128 -2.256193,1.3301514 -1.9983277,1.1746055 -0.155546,0.09198 -0.057361,0.05529 -0.032556,0.06666 -0.013953,0.08785 v 0.819589 l 0.7632609,-0.285254 0.6154663,-0.22531 v 0.125574 l 0.014986,0.07338 0.023771,0.04754 h 0.01757 l 0.025838,-0.100252 0.013953,-0.108004 v -0.06821 l 0.7420736,-0.279053 v 0.131775 l 0.034623,0.111621 h 0.01912 l 0.034623,-0.117822 0.00568,-0.02532 v -0.126091 l 0.5901449,-0.221692 v 0.08423 l 0.011885,0.07028 0.028422,0.07906 h 0.017053 l 0.025322,-0.08113 0.018087,-0.08372 V 10.113276 L 5.7732913,9.7809964 v 0.1038697 l 0.017053,0.080098 0.022738,0.049609 h 0.018604 l 0.027905,-0.091984 0.012919,-0.081132 v -0.094051 l 0.3886068,-0.146761 h 1.0640177 v 0.1178222 l 0.013953,0.081132 0.026872,0.072347 h 0.019637 l 0.025838,-0.07028 0.014986,-0.091984 V 9.5996122 H 8.334892 v 2.3099368 l 0.014469,0.374137 0.023771,0.454236 0.035657,0.381372 0.040824,0.415479 0.035657,0.377238 0.03359,0.35605 0.044442,0.409794 0.064595,0.535368 0.091984,0.576192 -2.0598225,1.537891 -0.032556,0.03256 -0.018604,0.03669 -0.011886,0.05633 v 0.695565 h 0.027388 l 2.3931356,-0.867648 0.1493449,0.803569 0.012919,0.07235 h 0.082166 0.078548 l 0.013436,-0.07235 0.1488281,-0.803569 2.3931349,0.867648 h 0.02739 v -0.695565 l -0.01189,-0.05633 -0.0186,-0.03669 -0.03256,-0.03256 -2.0598227,-1.537891 0.091984,-0.576192 0.064596,-0.535368 0.044441,-0.409794 0.03359,-0.35605 0.03566,-0.377238 0.04134,-0.415479 0.03566,-0.381372 0.02377,-0.454236 0.01395,-0.374137 V 9.5996122 h 0.908471 V 9.709683 l 0.01499,0.091984 0.02584,0.07028 h 0.01964 L 11.181232,9.7996 11.195182,9.718468 V 9.6006457 h 1.064535 l 0.38809,0.146761 v 0.094568 l 0.01292,0.080615 0.02791,0.091984 h 0.0186 l 0.02274,-0.049609 0.01705,-0.080098 V 9.7809964 l 0.882634,0.3322796 v 0.101286 l 0.0186,0.08372 0.0248,0.08113 h 0.01705 l 0.02842,-0.07906 0.01189,-0.07028 v -0.08423 l 0.590661,0.221692 v 0.126091 l 0.0052,0.02532 0.03462,0.117822 h 0.01964 l 0.03462,-0.111621 v -0.131775 l 0.741556,0.279053 v 0.06821 l 0.01395,0.108004 0.02636,0.100252 h 0.01705 l 0.02377,-0.04754 0.01499,-0.07338 v -0.125574 l 0.615466,0.22531 0.763777,0.285254 v -0.819589 l -0.01447,-0.08785 -0.03204,-0.06666 -0.05736,-0.05529 -0.156063,-0.09198 -1.998328,-1.1746055 -2.255676,-1.3301514 0.04082,-0.5090128 h 0.149344 l 0.02067,-0.1524455 0.01809,-0.1896525 0.0098,-0.151412 0.0031,-0.1477946 V 5.9486722 l -0.0062,-0.1462443 -0.02067,-0.1653646 -0.0067,-0.07028 -0.01499,-0.031523 -0.02481,-0.014986 h -0.806669 l -0.0186,0.013953 -0.01189,0.030489 -0.01705,0.1374593 -0.01189,0.144694 -0.0098,0.1901693 V 6.402908 l 0.0062,0.1286744 0.0186,0.2444295 0.01499,0.1684652 0.01292,0.1353922 h 0.150378 l 10e-4,0.068213 0.0067,0.079582 0.01085,0.079065 L 10.369365,6.564139 10.346625,6.54967 10.286165,6.505745 10.241725,6.447351 10.213305,6.395158 10.195215,6.348649 10.187415,6.29904 V 3.585509 L 10.183358,3.3457303 10.16372,3.0191353 10.124963,2.6284614 10.082588,2.3313219 10.011275,1.9592516 9.9353111,1.6445422 9.8340253,1.2895251 9.7172366,0.99031855 9.6314537,0.79343134 9.5622073,0.66165644 9.4908938,0.54796829 9.4293989,0.46993688 9.3622195,0.40275752 9.308476,0.37071813 Z","a":[9.26,7.937]},"A35K":{"d":"m 9.2599285,0.44279778 -0.076998,0.0273885 -0.096635,0.13074137 -0.085783,0.16743164 -0.0894,0.2087728 L 8.7994914,1.345585 8.7286944,1.6251545 8.6692664,1.9269449 8.6057044,2.2659423 8.5571284,2.5677326 v 3.959965 L 8.482715,6.6729083 7.1902874,7.6826658 7.2233603,7.5596759 7.2311118,7.2914752 7.2274945,6.866695 7.2161256,6.6620563 7.1716839,6.5871255 7.0409425,6.5276976 H 6.5045412 l -0.1229899,0.052193 -0.040824,0.078031 -0.022221,0.2160075 -0.044958,0.2537312 v 0.3240113 l 0.044958,0.3017903 0.052193,0.2160075 0.1415934,0.025838 0.025838,0.059945 0.026355,0.1043864 -4.3103311,3.0173872 -0.2459798,0.190168 -0.1715658,0.145211 -0.1415934,0.141593 -0.1038696,0.167432 -0.063562,0.178801 -0.00723,0.409794 0.037207,-0.148828 0.044442,-0.108003 0.085783,-0.0894 0.1043864,-0.09354 0.2196248,-0.118855 0.3017904,-0.130741 2.8091308,-1.150834 0.040824,0.1788 0.078548,-0.223759 0.9162231,-0.368453 0.063045,0.174667 0.082166,-0.216008 0.5364013,-0.1638139 0.5291667,-0.063045 h 1.07642 l 0.00775,0.4097949 0.040824,0.271818 0.070797,0.260449 v 2.94349 l 0.00362,0.417028 0.03359,0.379822 0.044442,0.27957 0.037207,0.193786 0.1307414,0.532784 0.081649,0.398426 -1.6913696,1.311547 -0.1224731,0.178801 -0.070797,0.230994 -0.03359,0.156062 0.00362,0.178801 2.0975464,-0.756026 0.029456,0.14521 0.05581,0.163815 0.081132,0.08888 0.1111043,-0.08888 0.055811,-0.163815 0.029455,-0.14521 2.0975461,0.756026 0.0036,-0.178801 -0.03359,-0.156062 -0.0708,-0.230994 -0.122473,-0.178801 -1.6913695,-1.311547 0.081649,-0.398426 0.1307413,-0.532784 0.037207,-0.193786 0.04444,-0.27957 0.03359,-0.379822 0.0036,-0.417028 v -2.94349 l 0.0708,-0.260449 0.04134,-0.271818 0.0072,-0.4097949 h 1.07642 l 0.529167,0.063045 0.536401,0.1638139 0.08217,0.216008 0.06305,-0.174667 0.91674,0.368453 0.07803,0.223759 0.04082,-0.1788 2.809131,1.150834 0.30179,0.130741 0.219625,0.118855 0.104386,0.09354 0.08578,0.0894 0.04444,0.108003 0.03721,0.148828 -0.0072,-0.409794 -0.06356,-0.178801 -0.10387,-0.167432 -0.141593,-0.141593 -0.171566,-0.145211 -0.24598,-0.190168 -4.310331,-3.0173872 0.02635,-0.1043864 0.02584,-0.059945 0.141594,-0.025838 0.05219,-0.2160075 0.04496,-0.3017903 V 7.1276609 l -0.04496,-0.2537312 -0.02222,-0.2160075 -0.04082,-0.078031 -0.12299,-0.052193 h -0.536401 l -0.130742,0.059428 -0.04444,0.074931 -0.01137,0.2046387 -0.0036,0.4247802 0.0078,0.2682007 0.03307,0.1229899 -1.292428,-1.0097575 -0.07441,-0.1452107 V 2.5677326 L 9.9151854,2.2659423 9.8516236,1.9269449 9.7921957,1.6251545 9.721399,1.345585 9.6097779,0.97713209 9.5203777,0.76835929 9.4345948,0.60092765 9.3379599,0.47018628 Z","a":[9.26,8.202]},"A310":{"d":"M 9.2922781,0.43985831 9.174117,0.57464193 8.9617269,0.90278727 8.7586385,1.3621908 8.6397827,1.786971 8.4930216,2.4334432 8.4211914,2.8334188 8.3648641,3.4173625 8.3178385,4.0204264 V 5.8699259 L 8.2573771,6.0285726 8.1498901,6.1991048 7.9979614,6.3577515 6.845577,7.0290283 6.8641805,6.8073364 6.9659831,6.7246541 7.009908,6.503479 7.0481486,6.0662964 V 5.7686401 L 7.0228271,5.4771851 7.009908,5.2622111 6.9592651,5.1986491 6.838859,5.1671265 H 6.2626668 l -0.1012858,0.050643 -0.050643,0.069763 -0.044442,0.2532145 -0.012402,0.3229777 0.0062,0.5131469 0.044442,0.3353801 0.095085,0.107487 0.031523,0.2723348 0.025321,0.2785359 -4.7304607,2.8179155 -0.1136881,0.09508 -0.063562,0.09509 -0.018603,0.272334 0.012402,0.468706 0.031523,0.265617 0.069763,-0.278536 1.6908529,-0.620634 v 0.234611 l 0.050643,0.113688 h 0.050643 l 0.056844,-0.132809 v -0.272334 l 1.0510986,-0.405144 0.012919,0.341582 h 0.069763 l 0.025321,-0.3798222 1.1017416,-0.4366659 -0.0062,0.3100586 0.03514,0.061495 h 0.034106 L 5.6683879,9.831958 V 9.5172485 L 6.1174561,9.327596 h 1.183907 v 0.3415812 l 0.075964,0.082682 0.056844,-0.088883 V 9.5110474 l 0.063562,-0.1963705 h 0.7978841 l 0.031523,2.3114871 0.069763,0.854728 0.069763,0.715719 0.2470133,1.823661 -2.1151164,1.532206 -0.1648478,0.126607 -0.107487,0.126608 -0.012919,0.21549 v 0.56379 l 0.063562,0.04392 2.6530681,-0.962215 0.1395263,0.588595 0.069763,0.190169 0.050643,0.08216 0.0062,0.151929 0.02198,0.03194 0.021945,-0.03194 0.00672,-0.151929 0.050643,-0.08216 0.069246,-0.190169 0.1395264,-0.588595 2.653068,0.962215 0.06356,-0.04392 v -0.56379 l -0.01292,-0.21549 -0.107487,-0.126608 -0.164848,-0.126607 -2.1145995,-1.532206 0.2470135,-1.823661 0.06925,-0.715719 0.06976,-0.854728 0.03152,-2.3114871 h 0.797884 l 0.06356,0.1963705 v 0.1519287 l 0.05684,0.088883 0.07597,-0.082682 V 9.327596 h 1.184423 l 0.448552,0.1896525 V 9.831958 l 0.05168,0.088883 h 0.03411 l 0.03566,-0.061495 -0.0067,-0.3100586 1.101741,0.4366659 0.02532,0.3798222 h 0.06976 l 0.01292,-0.341582 1.051099,0.405144 v 0.272334 l 0.05684,0.132809 h 0.05064 l 0.05064,-0.113688 v -0.234611 l 1.690853,0.620634 0.06976,0.278536 0.03152,-0.265617 0.01292,-0.468706 -0.01912,-0.272334 -0.06356,-0.09509 -0.113688,-0.09508 -4.730461,-2.8179155 0.02532,-0.2785359 0.03152,-0.2723348 0.09508,-0.107487 0.04444,-0.3353801 0.0062,-0.5131469 -0.0124,-0.3229777 -0.04444,-0.2532145 -0.05064,-0.069763 -0.101286,-0.050643 h -0.576192 l -0.120406,0.031523 -0.05064,0.063562 -0.01292,0.214974 -0.02532,0.291455 v 0.2976563 l 0.03824,0.4371826 0.04444,0.2211751 0.101286,0.082682 0.01912,0.2216919 L 10.63811,6.3577515 10.486182,6.1991048 10.378695,6.0285726 10.318233,5.8699259 V 4.0204264 L 10.271208,3.4173625 10.21488,2.8334188 10.14305,2.4334432 9.9962891,1.786971 9.8774333,1.3621908 9.6748617,0.90278727 9.4619548,0.57464193 9.3405151,0.4402832 c -0.016079,-0.00991 -0.032158,-0.010052 -0.048237,-4.2489e-4 z","a":[9.26,7.408]},"C182":{"d":"M 9.260394,3.541363 9.0025797,4.0420528 C 8.7111288,4.0588673 8.6065127,4.1373458 8.5915666,4.3073589 L 8.472013,6.1326269 H 5.804104 L 1.4248505,6.2783796 C 1.315675,6.2797362 1.1175331,6.351065 1.1069645,6.6047111 v 1.4293745 l 0.3355489,0.029105 4.3516013,0.6314586 h 2.7504567 l 0.4386201,3.7201427 -2.0397194,0.311757 c -0.18495,0.03963 -0.1876168,0.393555 -0.1876168,0.499372 0,0.119044 0.068685,0.605064 0.1426649,0.679044 l 1.8865203,0.251003 0.322336,-0.660563 c 0.026421,0.483511 0.092458,1.503386 0.1030252,1.503386 0,0.04227 0.1000291,0.04492 0.1000291,0 0.010571,0 0.076604,-1.019875 0.1030252,-1.503386 l 0.3223359,0.660563 1.8865201,-0.251003 c 0.07398,-0.07398 0.142665,-0.560001 0.142665,-0.679044 0,-0.105817 -0.0027,-0.459741 -0.187616,-0.499372 L 9.5376419,12.414792 9.976262,8.6946493 h 2.750457 L 17.07832,8.0631907 17.413869,8.0340857 V 6.6047111 C 17.403247,6.3510653 17.205158,6.2797309 17.095983,6.2783796 L 12.71673,6.1326269 H 10.04882 L 9.9292668,4.3073589 C 9.9143208,4.1373457 9.8097038,4.0588673 9.5182534,4.0420528 Z","a":[9.26,7.144]},"B412":{"d":"M 9.2001887,3.7050262 9.0755451,3.7347919 8.8923005,3.8157172 8.6839411,3.9901252 8.5523212,4.1519758 8.4458161,4.3561493 8.3476826,4.6584565 8.2755939,5.0114582 8.2030402,5.3519026 8.0714204,6.122088 H 7.995611 V 5.3514374 L 7.984449,5.2756274 7.964915,5.2309794 7.930963,5.2198174 7.897477,5.2449314 7.875153,5.3039974 7.877943,5.3709704 7.861199,5.5197986 V 9.464209 L 7.889104,9.500486 H 7.953752 L 7.978866,9.444676 V 8.7354168 h 0.109297 l 0.137201,0.4427638 0.1599902,0.5018298 v 0.1260388 l 0.058601,0.1655713 0.1627807,0.2520775 0.044648,0.143247 h 0.067438 l 0.1023194,0.106505 0.086041,1.437122 0.088832,1.180394 0.015813,0.323701 h -1.139465 l 0.020464,0.778091 1.1817883,-9e-4 0.016744,0.524619 -0.071624,0.03813 0.013953,0.362769 0.08232,0.04372 0.063252,1.266434 0.010697,0.150688 0.049299,0.184175 0.044184,0.101389 0.044184,-0.101389 0.049299,-0.184175 0.05488,-0.03813 h 0.15906 l 0.033021,0.03534 0.016743,1.002729 0.030231,0.03302 0.021859,-0.03302 0.016278,-0.909246 0.057671,-0.03581 0.02744,-0.06837 0.011162,-0.09906 -0.011162,-0.08232 -0.049299,-0.05488 -0.00837,0.03023 h -0.049299 v -0.337654 l -0.02465,-0.563222 -0.016278,-0.07953 -0.033021,0.0079 v 1.076646 H 9.4950544 l -0.1074353,-0.03534 0.063252,-1.266434 0.08232,-0.04372 0.013953,-0.362768 -0.071624,-0.03813 0.016743,-0.524619 1.1673709,-0.0056 V 13.394668 H 9.5336567 l 0.02279,-0.317191 0.061392,-1.19388 0.073019,-1.444098 0.061857,-0.07255 h 0.066973 l 0.045112,-0.143248 0.1623148,-0.2520775 0.05907,-0.1655713 V 9.6800104 l 0.159525,-0.5018298 0.137666,-0.4427637 h 0.109295 V 9.444676 l 0.02512,0.055811 h 0.06465 L 10.610347,9.46421 V 5.5197993 l -0.01674,-0.1488283 0.0028,-0.066973 -0.02232,-0.059066 -0.03395,-0.025114 -0.03349,0.011162 -0.01953,0.044648 -0.01116,0.07581 v 0.7706505 h -0.07581 L 10.26803,5.3519026 10.195942,5.0114582 10.123387,4.6584565 10.025719,4.3561493 9.9192145,4.1519758 9.7875946,3.9901252 9.5787702,3.8157172 9.3959907,3.7347919 Z m 14.041986,2.8371722 -0.08372,0.00605 L 9.9464213,6.9662225 9.7585259,7.1657452 9.6608574,7.4052654 9.5329583,7.5354901 9.4106402,7.5322345 9.2608819,7.6819928 9.4808684,7.9029095 9.611093,7.7726849 9.643184,7.5908355 l 0.099529,-0.096273 0.049765,-0.042788 0.1962672,-0.089297 0.07488,-0.056741 0.313469,-0.2283582 3.193293,-3.2663122 0.273472,-0.3185853 0.309748,-0.3730005 0.02372,-0.1018542 -0.02372,-0.084181 -0.05441,-0.0786 z M 9.4808684,7.9029095 9.2599516,8.122431 l 0.1302246,0.1302247 0.1818494,0.032091 0.096273,0.099994 0.042788,0.049765 0.088832,0.1962671 0.057206,0.074414 0.2278934,0.3139343 3.266777,3.1928279 0.318585,0.273472 0.373001,0.309749 0.101854,0.02418 0.08419,-0.02418 0.07814,-0.05395 0.01814,-0.0572 -0.006,-0.08372 L 10.196638,8.5884492 9.9966512,8.4000884 9.7575957,8.30242 9.627371,8.1745209 9.6306267,8.0526678 Z M 9.2599516,8.122431 9.0399651,7.9019794 8.9102056,8.032204 8.8781145,8.2140533 8.7781206,8.3103265 8.728356,8.3526499 8.532089,8.441947 8.4572099,8.4991528 8.1437406,8.727046 l -3.1928283,3.266313 -0.2739368,0.31905 -0.3092835,0.372535 -0.024185,0.102319 0.024185,0.08419 0.053951,0.07814 0.057206,0.01814 0.083716,-0.006 L 8.5744126,8.8386877 8.7627733,8.6386999 8.8604417,8.3991797 8.9883409,8.268955 9.1101939,8.272672 Z M 9.0399651,7.9019794 9.2608819,7.6819928 9.1306572,7.5517682 8.9488079,7.5196771 8.8525347,7.4201483 8.8097466,7.3703839 8.7209148,7.1741169 8.663709,7.0992376 8.4358159,6.7857685 5.1690385,3.5924749 4.8504534,3.3190034 4.477918,3.0092548 4.3755986,2.9855353 l -0.084181,0.023719 -0.078134,0.054415 -0.018139,0.057206 0.00605,0.083716 4.1230041,4.011383 0.1999879,0.1883606 0.2395202,0.097668 0.1297595,0.1278992 -0.00326,0.1223181 z","a":[9.26,7.937]},"C210":{"d":"M 7.7144824,1.9146761 H 10.806351 m 9.2260099,1.6283243 -0.022221,0.00723 -0.040824,0.057361 -0.078548,0.1896525 -0.060461,0.2113566 0.0031,0.030489 -0.011886,0.056844 -0.030489,0.018087 -0.048059,0.042375 -0.057361,0.036174 -0.1023193,0.033073 -0.063562,0.030489 -0.048059,0.039274 -0.045475,0.048059 -0.026872,0.075448 -0.048576,0.2351277 -0.041858,0.4273641 -0.039274,0.35295 -0.060461,0.7601603 -0.021704,0.3638021 -0.0093,0.1085205 -0.011885,0.042375 -0.024288,0.029972 -0.078031,0.0093 -6.6393879,-0.023771 -0.075448,0.012402 -0.069763,0.026872 -0.069246,0.051677 -0.042375,0.063045 -0.026872,0.087333 -0.018087,0.03359 -0.039274,0.033073 -0.036174,0.081649 -0.024288,0.1297079 -0.036174,0.2532145 -0.024288,0.3317627 -0.036174,0.6635253 0.030489,0.012402 7.3065307,0.714685 0.5074625,3.9077715 -2.4463623,0.306441 -0.048059,0.01499 -0.039274,0.02429 -0.042375,0.04496 -0.011886,0.04858 -0.0062,0.07855 0.015503,0.01499 0.059945,0.0057 h 0.1839681 l 0.027388,0.0062 0.021187,0.02119 v 0.03617 l -0.304891,0.01499 -0.014986,0.03617 -0.0062,0.473873 0.021187,0.328662 0.012402,0.05426 0.033073,0.03617 0.048059,0.03049 2.5011393,0.402043 0.085783,-0.379822 0.011369,-0.252698 0.030489,-0.268201 0.1127891,0.750321 -0.010775,0.148254 -0.00375,0.172082 -0.00163,0.17503 0.0093,0.191949 0.024594,0.20906 0.022144,0.139967 0.013207,0.06542 0.036978,0.03005 0.036633,-0.03454 0.013207,-0.06165 0.024288,-0.14211 0.018087,-0.213941 0.00878,-0.187068 v -0.178284 l -0.011886,-0.171566 -0.011886,-0.139009 0.091045,-0.76048 0.02316,0.271621 0.012402,0.241328 0.1023193,0.401526 2.5223266,-0.416512 0.04806,-0.02997 0.03307,-0.03617 0.0124,-0.05426 0.02119,-0.329179 -0.0062,-0.473356 -0.01499,-0.03617 -0.304891,-0.0155 v -0.03617 l 0.02119,-0.02067 0.02739,-0.0062 h 0.183968 l 0.06046,-0.0062 0.01499,-0.01499 -0.0062,-0.07855 -0.01189,-0.04806 -0.04237,-0.04547 -0.03927,-0.02377 -0.04806,-0.0155 -2.4737504,-0.310576 0.4614704,-3.9067377 7.306531,-0.7152019 0.03049,-0.011885 -0.03617,-0.6635254 -0.02429,-0.3317627 -0.03617,-0.2537313 -0.02429,-0.1297078 -0.03617,-0.081132 -0.03927,-0.03359 -0.01809,-0.033073 -0.02687,-0.087333 -0.04237,-0.063562 -0.06925,-0.05116 -0.06976,-0.027389 -0.07545,-0.011886 -6.676078,0.018087 -0.07855,-0.00879 -0.02377,-0.030489 -0.0124,-0.041858 -0.0088,-0.1090373 -0.02739,-0.35295 L 10.01511,3.5145596 9.97584,3.1616096 9.9158903,2.7424682 9.8673145,2.5068237 9.8404427,2.4313761 9.7949675,2.383317 9.7469084,2.3440429 9.6833464,2.3140706 9.581027,2.2804809 9.5236662,2.2443074 9.4750903,2.2024495 9.445118,2.1843628 9.4332324,2.1270019 9.4358163,2.0965128 9.3758716,1.885673 9.2973234,1.6955037 9.2502979,1.6340087 Z","a":[9.26,7.144]},"AS55":{"d":"M 11.000865,17.262181 V 14.670468 M 10.318802,3.0246215 10.052671,3.0545939 9.8242615,3.159497 9.5881002,3.3615519 9.3333354,3.7403401 9.1757223,4.21628 9.1193949,4.845699 v 0.5694742 l 0.00413,0.7048666 0.040824,0.4010091 H 9.020693 V 4.8358804 L 8.9685,4.7836874 8.920958,4.7707684 8.875999,4.8157264 V 6.7572102 H 8.6284688 v 1.8851562 h 0.2811198 v 0.093534 h 0.1126547 v -0.243396 h 0.4159952 l 0.029972,0.7865153 0.022221,0.3524333 0.05271,0.1576131 -0.079065,0.079065 0.2139405,0.3705199 0.1384928,-0.138492 -0.018603,0.138492 0.089917,0.134876 v 0.344682 L 10.10538,13.854968 H 8.632603 v 0.693498 h 1.517734 l 0.254765,3.253031 h 0.02997 l 0.104903,-1.78387 h 0.251147 v 0.07493 l 0.276469,0.0026 0.06615,-0.06615 v -0.07338 l -0.07648,-0.07648 h -0.495065 l 0.04547,-1.319299 h 1.554945 v -0.689894 l -1.51412,-0.01499 0.153996,-3.136759 V 10.3172 l 0.06356,-0.08578 -0.01137,-0.101286 0.164847,0.119889 0.168982,-0.3596678 -0.08268,-0.071314 0.0677,-0.1725993 0.04496,-0.3560506 0.01085,-0.813387 h 0.41548 v 0.2036051 l 0.05323,0.053227 h 0.04703 l 0.05013,-0.050643 -0.03359,-1.7688843 h 0.0677 v 0.3302124 h 0.368969 V 7.0925902 l -0.07286,-0.07338 V 6.4760904 h -0.08682 V 6.3019408 l -0.03307,0.0093 V 4.0581502 h -0.077 l -0.05891,0.034106 v 0.1198893 l 0.05684,0.014986 v 2.0799763 h -0.04858 v 0.1762167 h -0.123502 v -1.686202 h -0.109037 v 1.6789673 h -0.11989 V 4.9056436 L 11.465503,4.5873168 11.394189,4.2198974 11.259314,3.7852986 11.128572,3.5155476 10.933235,3.2902384 10.708442,3.1031697 10.53636,3.0282389 Z M 8.9974386,6.6833129 h 0.1746663 l 0.048059,0.5353678 0.026355,0.2278931 H 8.9871033 Z M 11.483073,6.922058 h 0.164331 v 1.4309204 h -0.397392 l 0.132291,-0.5829102 0.05839,-0.4190958 z M 8.9974386,8.0827106 h 0.3550171 l 0.063562,0.2702678 H 8.9922709 Z M 8.3029073,1.1766723 7.9055156,1.3146484 9.5488261,6.211507 9.9513855,6.6357706 10.066623,7.0621011 a 0.50880235,0.50880235 0 0 0 -0.2315095,0.4268473 0.50880235,0.50880235 0 0 0 0.15968,0.37052 L 6.0084738,12.608532 6.3366191,12.900504 9.7074727,8.8511392 9.8506165,8.2894164 10.137935,7.9545531 a 0.50880235,0.50880235 0 0 0 0.205672,0.043408 0.50880235,0.50880235 0 0 0 0.476457,-0.3302124 l 6.183602,1.5812988 0.108003,-0.4030762 -5.25756,-1.3678751 -0.5302,0.090434 -0.471289,-0.079582 a 0.50880235,0.50880235 0 0 0 -0.509013,-0.5090128 0.50880235,0.50880235 0 0 0 -0.0832,0.00723 z","a":[9.26,5.027]},"PC21":{"d":"m 9.2600589,1.0833331 -0.028481,0.00613 -0.03866,0.038667 -0.077327,0.1546557 -0.089215,0.2438711 -0.071407,0.2498349 -0.068405,0.2944217 -0.169505,-0.023771 -0.1992835,-0.017852 -0.2854966,0.00295 -0.2617221,0.023818 -0.3152753,0.062439 -0.1189536,0.035704 -0.00597,0.077327 0.437191,0.011886 0.2111708,0.00295 0.2022449,0.023818 0.2022456,0.0059 h 0.1368047 l 0.074363,-0.014849 0.065402,-0.020815 -0.074324,0.5085546 -0.044626,-0.014849 -0.092178,-0.00597 -0.089255,0.011886 -0.089215,0.038667 -0.068405,0.053555 -0.068405,0.062439 -0.056519,0.074363 -0.032701,0.080289 -0.032701,0.08029 -0.00303,0.026774 0.068405,0.020815 0.068405,0.050553 0.062477,0.065441 0.032701,0.083291 c 0.062485,0.011887 0.055801,0.010616 0.062485,0.011887 L 8.5326308,3.266449 8.5593658,3.198044 8.6129208,3.129639 8.6723958,3.088016 8.7170218,3.0672 l 0.017813,0.00295 0.00597,0.023818 -0.083252,0.4698913 -0.074363,0.5621084 -0.020816,0.234946 -0.03274,0.5055925 -0.00892,0.511557 0.00303,0.8862691 -0.044626,0.047589 L 7.9467576,6.4278974 7.3103232,6.5736279 6.3199497,6.7937246 5.2165462,7.0435192 3.9287484,7.3290563 3.3012397,7.4777482 3.2090227,7.5074862 3.1019563,7.5640052 2.9889663,7.6651474 2.9146003,7.7662501 2.807534,7.9744192 2.742094,8.1766641 2.691543,8.4235369 2.667769,8.7001084 l -0.01489,0.2736093 -0.00296,0.288499 1.0706632,0.041623 0.8357178,0.014888 0.8030174,0.020815 1.1628804,0.032701 1.1598785,0.035704 0.6275486,0.017852 0.2200564,0.3063089 0.00597,0.3390504 0.026774,0.535372 0.023771,0.353898 0.035704,0.362825 0.068405,0.868459 0.071361,0.82383 0.035704,0.350938 -0.1691846,1.811923 -0.00597,0.07032 -0.07569,0.08593 -0.443915,0.130921 -0.8468847,0.243431 -0.7364563,0.212732 -0.1288798,0.270047 -0.047029,0.222979 -0.014329,0.507313 0.030699,0.0225 0.703676,0.02045 1.0555738,0.03478 0.9451055,0.03886 0.092057,0.002 0.036821,0.286417 0.01021,0.0409 0.00816,0.02658 0.01841,0.02458 0.030668,0.0171 0.030653,-0.0171 0.01841,-0.02458 0.00821,-0.02658 0.01021,-0.0409 0.036821,-0.286417 0.092057,-0.002 0.9451058,-0.03886 1.055534,-0.03478 0.703716,-0.02045 0.0307,-0.0225 -0.01433,-0.507313 -0.04707,-0.222979 -0.128879,-0.270046 -0.736416,-0.212732 -0.846925,-0.243431 -0.4438742,-0.130921 -0.07569,-0.08593 -0.006,-0.07032 -0.169145,-1.811923 0.035665,-0.350937 0.071407,-0.82383 0.068405,-0.868459 0.03566,-0.362825 0.02381,-0.353899 0.02677,-0.535371 0.0059,-0.3390514 0.2200962,-0.3063089 0.62751,-0.017852 1.159918,-0.035704 1.16288,-0.032701 0.802977,-0.020815 0.835758,-0.014888 1.070663,-0.041623 -0.0029,-0.288499 -0.01491,-0.2736093 -0.02377,-0.2765715 -0.05059,-0.2468728 -0.0654,-0.2022449 L 15.606277,7.7662496 15.531914,7.6651469 15.418883,7.5640047 15.311818,7.5074857 15.21964,7.4777482 14.592092,7.3290563 13.304294,7.0435192 12.200931,6.7937246 11.210557,6.5736279 10.574082,6.4278974 10.041713,6.3119058 9.997123,6.2643168 10.000023,5.3780477 9.991123,4.8664907 9.958423,4.3608982 9.937603,4.1259522 9.863243,3.5638438 9.77995,3.0939525 l 0.00597,-0.023818 0.017852,-0.00295 0.044587,0.020816 0.059514,0.041623 0.05352,0.068405 0.02677,0.068405 0.02974,0.1219553 c 0.06244,-0.011887 0.02911,-0.00554 0.06244,-0.011887 l 0.03274,-0.083291 0.06244,-0.065441 0.06841,-0.050553 0.06841,-0.020815 -0.0029,-0.026774 -0.0327,-0.08029 -0.03274,-0.080289 -0.05651,-0.074363 -0.0684,-0.062439 -0.0684,-0.053555 -0.08922,-0.038667 -0.08922,-0.011886 -0.092217,0.00597 L 9.735449,2.7489576 9.661086,2.240403 9.726527,2.261218 9.80089,2.276067 h 0.136805 l 0.202206,-0.0059 0.202245,-0.023818 0.211171,-0.00295 0.43719,-0.011886 -0.006,-0.077327 L 10.865554,2.1184942 10.550319,2.0560556 10.288596,2.0322377 10.00306,2.0292897 9.8038156,2.0471415 9.6342702,2.0709128 9.5658652,1.7764911 9.4945042,1.5266562 9.4052892,1.2827851 9.3279622,1.1281294 9.2893022,1.0894622 Z","a":[9.26,7.673]},"EC45":{"d":"M 9.3544678,3.256132 9.1586141,3.272668 8.9436401,3.328479 8.8170329,3.396175 8.7327999,3.452502 8.6511509,3.536735 8.5834549,3.613733 8.5204099,3.7145021 8.4620159,3.8312908 8.4056889,3.9878704 8.3565959,4.1351482 8.3054359,4.4343548 8.2795979,4.604887 8.2398069,4.7640504 8.2139689,4.922697 v 0.179834 l 0.011886,0.208256 0.023254,0.1472779 0.0093,0.072347 -0.00672,0.076998 -0.021187,0.1405599 -0.018603,0.1493449 H 8.099764 V 5.1263021 L 8.092534,4.9650716 8.081165,4.8550008 8.069279,4.8033248 8.041374,4.7893718 8.008301,4.8079758 7.994348,4.8968588 7.987628,4.9976279 V 5.1283691 5.9257365 H 7.88479 V 5.3619466 L 7.88221,5.2989016 7.87549,5.2663456 7.845001,5.2477416 l -0.042375,0.00465 -0.027905,0.03514 -0.00672,0.055811 V 5.789827 8.7777583 l 0.00568,0.056844 0.032556,0.024288 0.040308,0.00258 0.029972,-0.026872 0.00775,-0.051677 V 8.4568481 h 0.1054199 v 0.1808676 h 0.107487 V 8.4299764 h 0.1405599 v 0.1317749 l 0.010852,0.2377116 0.021704,0.164331 0.018603,0.1105876 0.078031,0.3886068 0.048576,0.1669149 0.040824,0.097152 0.00775,0.078548 0.016537,0.097152 0.03514,0.088884 0.00258,0.07028 0.029456,0.07286 0.05426,0.09147 0.05116,0.08113 0.1157552,0.153479 0.05426,0.118856 0.069763,0.170015 0.078548,0.148312 0.072864,0.148311 0.037724,0.04341 0.010852,1.121896 0.00517,0.901237 0.00827,0.941028 0.010852,0.124023 -0.059428,0.02997 H 7.676534 v 0.07545 l 0.00827,0.05374 -0.00258,0.05168 -0.010852,0.03772 -0.024288,0.01602 H 7.614528 l -0.010852,0.01085 v 0.06201 l 0.013436,0.0186 0.065112,0.100252 0.013436,0.223759 1.4242025,0.01344 -0.00568,0.09147 -0.024288,0.08372 -0.045475,0.134875 -0.024288,0.06511 -0.00827,0.120922 v 2.079977 l 0.00827,0.161747 0.03514,0.129708 0.042891,0.132292 0.021704,0.0646 h 0.245463 0.2242757 l 0.021704,-0.0646 0.042891,-0.132292 0.03514,-0.129708 0.00827,-0.161747 v -2.079977 l -0.00827,-0.120922 -0.024288,-0.06511 -0.045475,-0.134875 -0.024288,-0.08372 -0.00568,-0.09147 1.4242028,-0.01344 0.01344,-0.223759 0.06511,-0.100252 0.01344,-0.0186 v -0.06201 l -0.01085,-0.01085 h -0.03256 l -0.02429,-0.01602 -0.01085,-0.03772 -0.0026,-0.05168 0.0083,-0.05374 v -0.07545 H 9.6516073 l -0.059428,-0.02997 0.010852,-0.124023 0.00827,-0.941028 0.00517,-0.901237 0.010852,-1.121896 0.037724,-0.04341 0.072864,-0.148311 0.078548,-0.148312 0.069763,-0.170015 0.05426,-0.118856 0.1157557,-0.153479 0.05116,-0.08113 0.05426,-0.09147 0.02946,-0.07286 0.0026,-0.07028 0.03514,-0.088884 0.01654,-0.097152 0.0078,-0.078548 0.04082,-0.097152 0.04858,-0.1669149 0.07803,-0.3886068 0.01912,-0.1105876 0.02119,-0.164331 0.01085,-0.2377116 V 8.4299764 h 0.14056 v 0.2077393 h 0.107487 V 8.4568481 h 0.10542 v 0.3260783 l 0.0078,0.051677 0.02997,0.026872 0.04031,-0.00258 0.03256,-0.024288 0.0057,-0.056844 V 5.7898275 5.3433431 l -0.0067,-0.055811 -0.0279,-0.03514 -0.04238,-0.00465 -0.03049,0.018604 -0.0067,0.032556 -0.0026,0.063562 V 5.9257365 H 10.721826 V 5.1283691 4.9976278 l -0.0067,-0.1007691 -0.01395,-0.088367 -0.03307,-0.01912 -0.02791,0.013953 -0.01137,0.051676 -0.01189,0.1100708 -0.0072,0.1612305 V 5.8973145 H 10.49755 l -0.0186,-0.1493449 -0.02119,-0.1400432 -0.0067,-0.077515 0.0093,-0.072347 0.02326,-0.1472779 0.01188,-0.208256 V 4.9226969 L 10.469645,4.7640503 10.429854,4.6048869 10.404016,4.4343547 10.352856,4.1351481 10.303764,3.9878703 10.247437,3.8312907 10.189042,3.714502 10.125997,3.6137329 10.058301,3.536735 9.976652,3.4525024 9.8924194,3.3961751 9.7663289,3.328479 9.5508382,3.2726685 Z M 4.4756958 2.6577189 L 4.4100667 2.7342 L 4.4059326 2.8654582 L 4.4173014 3.0142863 L 4.7625 3.348116 L 5.0400024 3.6033976 L 5.773291 4.3051636 L 6.5272502 5.0229492 L 7.5943685 6.0497599 L 8.2759806 6.6951986 L 8.9100505 7.2977458 L 8.9214193 7.3447713 L 8.9643107 7.3855957 L 9.0604289 7.4460571 L 9.1012533 7.4233195 A 0.32212207 0.32212207 0 0 0 9.0459595 7.6026367 A 0.32212207 0.32212207 0 0 0 9.0526774 7.6667155 L 9.0289062 7.6238241 L 8.9632772 7.7457804 L 8.8821452 7.8832397 L 8.8842122 7.9690226 L 8.8640584 8.0051961 L 8.4444458 8.3731323 L 8.3808838 8.4093058 L 8.1442057 8.4294596 L 7.5752482 9.0366577 L 7.0316121 9.6050985 L 6.2373454 10.438123 L 5.4699504 11.229806 L 4.8219279 11.936222 L 4.6689657 12.125875 L 4.5108358 12.333614 L 4.3935303 12.482442 L 4.4700114 12.548071 L 4.6007528 12.552205 L 4.7500977 12.541353 L 5.0839274 12.195638 L 5.339209 11.918136 L 6.0409749 11.184847 L 6.7582438 10.430888 L 7.7850545 9.3637695 L 8.4304932 8.6821574 L 9.0330404 8.0480876 L 9.0805827 8.0367187 L 9.1214071 7.9938273 L 9.1818685 7.8977091 L 9.1482788 7.8377645 A 0.32212207 0.32212207 0 0 0 9.3679036 7.9250977 A 0.32212207 0.32212207 0 0 0 9.4443848 7.9152791 L 9.3973592 7.9416341 L 9.5187988 8.0077799 L 9.6567749 8.0889119 L 9.7425578 8.0863281 L 9.7787313 8.1069987 L 10.146151 8.5266113 L 10.182324 8.5896566 L 10.202995 8.8268514 L 10.809676 9.3952922 L 11.378634 9.939445 L 12.211141 10.733712 L 13.003341 11.501107 L 13.709757 12.148612 L 13.89941 12.302091 L 14.107149 12.460221 L 14.255977 12.577527 L 14.32109 12.500529 L 14.325741 12.369788 L 14.314372 12.220959 L 13.969173 11.88713 L 13.691671 11.631848 L 12.958382 10.930082 L 12.204423 10.212297 L 11.137305 9.1854858 L 10.455693 8.5400472 L 9.8216227 7.9375 L 9.8102539 7.8899577 L 9.7673625 7.8496501 L 9.6712443 7.7891886 L 9.5937297 7.8325968 A 0.32212207 0.32212207 0 0 0 9.6898478 7.6026367 L 9.7559937 7.4811971 L 9.8371257 7.343221 L 9.8350586 7.2574382 L 9.8552124 7.2217814 L 10.274825 6.8538452 L 10.33787 6.8176717 L 10.575065 6.7975179 L 11.143506 6.1903198 L 11.687659 5.6213623 L 12.481925 4.788855 L 13.24932 3.9966553 L 13.896826 3.2902384 L 14.050305 3.1005859 L 14.208435 2.8933634 L 14.325741 2.7440186 L 14.249259 2.6789062 L 14.118001 2.6742554 L 13.969173 2.6856242 L 13.635343 3.0308228 L 13.380062 3.3083252 L 12.678296 4.0416138 L 11.96051 4.7955729 L 10.9337 5.863208 L 10.288261 6.5443034 L 9.6857137 7.17889 L 9.6386882 7.189742 L 9.5978638 7.2326335 L 9.5374023 7.3287516 L 9.5384359 7.3303019 A 0.32212207 0.32212207 0 0 0 9.3679036 7.2806925 A 0.32212207 0.32212207 0 0 0 9.318811 7.2848267 L 9.3182943 7.2848267 L 9.2128743 7.2274658 L 9.0748983 7.1463338 L 8.9891154 7.1484009 L 8.9529419 7.1282471 L 8.5850057 6.7086344 L 8.549349 6.6450724 L 8.5286784 6.4083944 L 7.9219971 5.8394368 L 7.3530396 5.2958008 L 6.5205322 4.501534 L 5.7283325 3.734139 L 5.0219157 3.0866333 L 4.8322632 2.9331543 L 4.6245239 2.7750244 L 4.4756958 2.6577189 z ","a":[9.26,7.408]},"A359":{"d":"M 9.2613469,0.21181357 9.1821801,0.24798708 9.0452376,0.41748577 8.8824568,0.76991903 8.7584334,1.1941825 8.6406111,1.7357515 8.5687809,2.0933524 8.5129703,2.5320853 8.4685286,3.0447155 v 3.06958 L 8.0856063,6.5008352 7.0004012,7.3261078 7.0412256,7.1550589 7.0670638,6.9059785 7.0970361,6.619691 V 6.1256643 L 7.0634464,6.0140433 6.974563,5.9060395 6.766307,5.8579804 H 6.3575464 l -0.1932699,0.048059 -0.081649,0.093018 -0.026355,0.1002523 -0.018603,0.245463 v 0.304891 l 0.029972,0.3679362 0.044442,0.3043741 0.048576,0.160197 h 0.1260902 l 0.070797,0.2113566 0.07028,0.059945 -4.9387165,3.5450044 -0.2676839,0.237711 -0.1669149,0.182418 -0.11162114,0.181901 -0.0558105,0.256315 v 0.304891 l 0.0744141,-0.171049 0.12609044,-0.141077 0.1524455,-0.118855 0.1896525,-0.118856 2.5305948,-1.09244 0.03359,0.04082 0.048059,-0.07441 0.7622274,-0.286287 v 0.148828 l 0.044442,0.05581 0.066663,-0.07803 0.00413,-0.171049 1.0366292,-0.412894 0.00723,0.163814 h 0.052193 L 6.0826197,9.9977815 6.573029,9.7972765 h 0.631486 l 0.011369,0.19327 0.052193,0.04444 L 7.312519,9.9161305 7.323371,9.789523 h 1.0629842 l 0.070797,0.542603 v 2.471684 l 0.029456,0.427364 0.041341,0.300757 0.073897,0.710034 0.1229899,0.672827 0.1188558,0.720887 -1.7244425,1.367358 -0.1224732,0.15968 -0.1002522,0.204639 -0.0894,0.26355 -0.00723,0.252697 0.00362,0.100769 0.059428,-0.104386 2.1962483,-0.802535 0.044442,0.237712 0.1188557,0.186035 0.03893,0.266587 0.037035,-0.266587 0.1188558,-0.186035 0.044442,-0.237712 2.1967652,0.802535 0.05943,0.104386 0.0036,-0.100769 -0.0078,-0.252697 -0.08888,-0.26355 -0.100252,-0.204639 -0.12299,-0.15968 -1.7239257,-1.367358 0.1188558,-0.720887 0.1224731,-0.672827 0.074414,-0.710034 0.040824,-0.300757 0.02946,-0.427364 v -2.471684 l 0.0708,-0.542603 h 1.062984 l 0.01085,0.1266075 0.04496,0.1188565 0.05168,-0.04444 0.01137,-0.19327 h 0.632003 l 0.490409,0.200505 0.06666,0.2082565 h 0.05219 l 0.0072,-0.163814 1.037146,0.412894 0.0036,0.171049 0.06666,0.07803 0.04496,-0.05581 v -0.148828 l 0.761711,0.286287 0.04806,0.07441 0.03359,-0.04082 2.530595,1.09244 0.189653,0.118856 0.152445,0.118855 0.126607,0.141077 0.0739,0.171049 v -0.304892 l -0.05519,-0.256315 -0.111621,-0.181901 -0.167432,-0.182418 -0.267684,-0.237711 -4.938716,-3.5450041 0.0708,-0.059945 0.07028,-0.2113566 h 0.126608 l 0.04806,-0.160197 0.04496,-0.3043741 0.02946,-0.3679362 V 6.344772 l -0.0186,-0.245463 -0.02584,-0.1002523 -0.08165,-0.093018 -0.193269,-0.048059 H 11.75515 l -0.208256,0.048059 -0.0894,0.1080038 -0.03307,0.111621 v 0.4940267 l 0.02946,0.2862875 0.02584,0.2490804 0.04082,0.1710489 -1.084693,-0.8252718 -0.382923,-0.3865397 v -3.06958 L 10.008486,2.5320853 9.9526757,2.0933524 9.8803287,1.7357515 9.7630232,1.1941825 9.6389998,0.76991903 9.4757023,0.41748577 9.3387597,0.24798708 Z","a":[9.26,7.937]},"AN28":{"d":"m 6.4164498,6.3988573 h 2.134526 m 10.626577,6.3988573 h 2.134526 m 9.589004,4.5916554 -0.085191,0.025117 -0.1317749,0.096635 -0.1317749,0.1452108 -0.079065,0.153479 -0.12299,0.2899048 -0.1142049,0.4878255 -0.021704,0.2635498 -0.022221,0.1405599 0.01757,0.1669148 0.022221,0.091984 v 1.3311849 l -1.137915,-0.01757 0.00413,-0.1183391 V 7.454842 L 7.7819538,7.2879271 V 7.1778563 L 7.7731688,7.0326455 7.7597329,6.9096556 7.7292438,6.7913166 7.698238,6.7076008 7.636743,6.6419717 V 6.5277668 L 7.588684,6.3959919 7.531323,6.3169269 7.487398,6.2993569 7.425903,6.3257119 7.386629,6.3959919 7.355623,6.496761 7.338053,6.6285359 7.285343,6.6988159 7.232633,6.8569458 7.219714,7.0372965 V 7.437272 l 0.012919,0.2764689 -0.030489,0.057361 -2.482019,0.114205 -3.2421793,0.1493448 -0.109554,0.01757 -0.066146,0.08785 -0.012919,0.1054199 0.00413,0.1932698 0.022221,0.197404 0.039274,0.1979207 0.043925,0.1405599 0.08785,0.021704 5.5965575,0.3824056 1.8805054,0.026355 V 10.0552 l 0.012919,0.254765 0.022221,0.302824 0.048059,0.422196 0.07028,0.399459 0.2682007,1.471745 -1.7177246,0.250114 -0.00879,-0.118339 -0.01757,-0.09664 -0.022221,-0.05271 h -0.04805 l -0.022221,0.06149 -0.021704,0.214974 v 0.329695 l 0.043925,0.56224 0.030489,0.311609 0.061495,-0.377755 0.01757,-0.21084 h 0.039791 l 0.2108399,0.540536 1.7637166,0.0217 1.5549438,-0.0217 0.21084,-0.540536 h 0.03979 l 0.01757,0.21084 0.0615,0.377755 0.03049,-0.311609 0.04392,-0.56224 v -0.329695 l -0.0217,-0.214974 -0.02222,-0.06149 h -0.04806 l -0.02222,0.05271 -0.01757,0.09664 -0.0088,0.118339 -1.7177248,-0.250114 0.2682008,-1.471745 0.07028,-0.399459 0.04806,-0.422196 0.02222,-0.302824 0.01292,-0.254765 V 9.4051105 l 1.880505,-0.026355 5.596041,-0.3824056 0.08785,-0.021704 0.04392,-0.1405599 0.03979,-0.1979207 0.0217,-0.197404 0.0047,-0.1932698 -0.01344,-0.1054199 -0.06563,-0.08785 -0.110071,-0.01757 -3.241662,-0.1493448 -2.482019,-0.114205 -0.03049,-0.057361 0.01292,-0.2764689 V 7.0372964 l -0.01292,-0.1803507 -0.05271,-0.1581299 -0.05271,-0.07028 -0.01757,-0.1317749 -0.03101,-0.1007691 -0.03927,-0.07028 -0.06149,-0.026355 -0.04393,0.01757 -0.05736,0.079065 -0.04806,0.1317749 v 0.1142049 l -0.0615,0.065629 -0.03101,0.083716 -0.03049,0.118339 -0.01344,0.1229899 -0.0088,0.1452108 v 0.1100708 l -0.0041,0.1669149 v 0.1932698 l 0.0041,0.1183391 -1.137915,0.01757 V 6.452836 L 10.28361,6.3608519 10.30118,6.1939371 10.278959,6.0533772 10.257255,5.7898274 10.14305,5.3020019 10.02006,5.0120971 9.9409951,4.8586181 9.8092202,4.7134073 9.6774453,4.6167724 Z","a":[9.26,8.202]},"A119":{"d":"m 8.7623136,14.997507 -0.016317,0.907642 -0.026515,0.365096 -0.095863,0.01632 v 0.03263 l 0.089744,0.01428 -0.00204,0.0204 -0.089744,0.02652 -0.028555,0.03263 v 0.04283 l -0.085665,0.01836 0.083626,0.0102 0.00816,0.05507 0.028555,0.03875 0.061189,0.0204 v 0.01224 l -0.063229,0.0102 -0.00204,0.04079 0.087705,0.01428 0.038753,0.450761 0.014277,0.648607 0.00408,0.579259 0.012237,-0.605774 0.010197,-0.715916 0.022437,-0.05915 0.00408,-0.291669 0.018357,-0.01632 0.063229,0.002 0.016317,-0.01632 -0.00408,-0.02856 -0.087705,-0.0041 -0.020397,-0.02856 v -0.256995 l 0.1060614,-0.0082 -0.00408,-0.04283 -0.085665,-0.03263 -0.026515,-0.324304 z M 9.307442,2.2158855 9.2226927,2.2303548 9.0960854,2.3052855 8.9627603,2.4318928 8.8609577,2.5807212 8.7731077,2.7683065 8.6465005,3.08715 8.5333291,3.4556031 8.4790689,3.667993 8.4408283,3.9367104 8.393286,4.4023153 8.3369587,4.7568157 8.239807,5.4012206 8.2144855,5.7557209 v 1.1777059 l 0.01602,0.587561 0.018087,0.1989543 0.049609,0.4314982 0.083716,0.7343221 0.099219,0.958081 0.045475,0.5064286 0.090434,0.842843 0.1105876,0.773079 0.097152,0.976168 -0.049609,0.05633 -0.1312581,0.01395 -0.036173,0.03359 0.034106,0.395841 0.047542,0.04031 0.1059367,-0.01344 0.07028,0.02946 0.079065,0.743623 -1.5301392,0.04031 -0.099219,0.01395 -0.085783,0.06098 -0.1219564,0.166915 v 0.273368 h 0.2981731 l 1.6112711,0.129191 0.1421102,1.51412 h -0.359152 v 0.05168 h 0.3663859 l 0.1012858,1.367358 0.040824,0.01344 0.034106,-0.01137 0.1085205,-1.384928 0.099219,-0.998905 0.040824,-0.549321 1.0392123,-0.0677 0.583427,-0.05219 0.280087,-0.05168 0.02687,-0.04341 V 14.5557 l -0.03049,-0.01964 -0.0026,-0.06821 -0.05684,-0.07235 -0.0615,-0.05684 -0.07906,-0.03979 -0.077,-0.01757 -1.5482251,-0.04186 0.072347,-0.722437 0.076998,-0.03721 0.1142049,0.01085 0.039791,-0.02635 0.032556,-0.417029 -0.03514,-0.031 -0.1028361,-0.01085 -0.068213,0.02222 0.096635,-1.036629 0.08785,-0.610815 0.061495,-0.489376 0.05064,-0.507463 0.04806,-0.6149492 0.189136,-1.6117879 0.04599,-0.4154785 0.01757,-0.2392619 V 5.586739 L 10.37456,5.4022541 10.330635,5.0947794 10.271207,4.6668987 10.223148,4.249353 10.14615,3.724837 10.095507,3.4984944 10.005591,3.1843018 9.8805335,2.8416867 9.7859657,2.6442831 9.7001828,2.4970052 9.5906287,2.3652304 9.482625,2.2794474 9.381856,2.2313882 Z M 8.239807,5.4012206 8.252209,5.3159546 8.0382686,5.2647946 v -0.096118 l -0.01912,-0.6092651 -0.057878,-0.04961 -0.049609,0.04961 v 0.6092651 0.00155 0.2837036 0.00103 3.212207 0.00155 0.2831868 0.00155 l -0.011369,0.4578532 0.046509,0.1043864 h 0.046509 l 0.044442,-0.098702 V 8.953459 8.9519085 h 5.17e-4 V 8.8557905 L 8.25221,8.8046305 8.239808,8.7198815 8.0382699,8.7581225 v -0.09095 h -5.17e-4 l 5.17e-4,-3.212207 v -0.00103 -0.09095 z m 2.402437,-0.8914186 -0.04961,0.04961 v 0.6108153 0.096118 l -0.214458,0.05116 0.01292,0.084749 0.201539,-0.038241 v 0.09095 3.2137572 0.090434 l -0.201539,-0.038241 -0.01292,0.085266 0.214458,0.05116 v 0.096118 l -0.01137,0.4578532 0.04651,0.1043864 h 0.04651 l 0.04444,-0.098702 V 8.9534585 8.6687213 5.4549641 5.1702269 l -0.0186,-0.6108153 z m 4.2545206,2.4784016 -0.1400431,0.1359091 0.023771,0.2284098 0.03669,0.1576131 0.049609,0.107487 0.1074869,0.1100708 4.4054158,4.18114 0.073381,0.00878 0.047542,0.084233 0.1121378,-0.00878 0.1178223,0.055294 a 0.26186976,0.26186976 0 0 0 -0.044442,0.1462443 l -0.2847372,0.2382284 -0.00672,0.047542 -0.021187,0.01912 0.00207,0.1162719 -0.040824,0.056327 -0.1209228,0.017053 -0.6056478,0.4376993 -2.3662638,2.5388631 -0.060461,0.0088 -0.1576131,0.176733 -0.00207,0.04961 -0.8728149,0.939477 -0.073381,0.07338 -0.023771,0.07338 -0.025838,0.05581 -0.079582,0.06873 -0.10542,0.08423 -0.099219,0.04961 0.135909,0.140043 0.2284098,-0.02377 0.1570964,-0.03669 0.1080037,-0.04961 0.1095541,-0.107487 4.1816568,-4.4054159 0.00827,-0.073381 0.084233,-0.047542 -0.00879,-0.1121378 0.055811,-0.1173055 a 0.26186976,0.26186976 0 0 0 0.1457275,0.044442 l 0.2382283,0.2842204 0.047542,0.00672 0.01912,0.021187 0.1167888,-0.00207 0.05581,0.041341 0.01757,0.1204061 0.4371828,0.6056478 2.538863,2.3667808 0.0088,0.05994 0.176733,0.157614 0.04961,0.0021 0.939477,0.872815 0.07338,0.07338 0.07338,0.02377 0.05581,0.02584 0.06925,0.07958 0.08423,0.10542 0.04909,0.09922 0.14056,-0.135392 -0.02377,-0.228927 -0.03669,-0.157096 -0.04961,-0.108004 -0.108003,-0.109554 -4.405416,-4.181657 -0.073381,-0.00827 -0.047025,-0.084233 -0.1121379,0.00879 -0.1178222,-0.055811 a 0.26186976,0.26186976 0 0 0 0.044442,-0.1457275 l 0.2847371,-0.2382283 0.0062,-0.047542 0.021704,-0.01912 -0.00207,-0.116272 0.040824,-0.056327 0.1209228,-0.017053 0.605648,-0.4376994 2.366264,-2.5388631 0.06046,-0.00879 0.157096,-0.1767334 0.0021,-0.049609 0.873332,-0.9394776 0.07286,-0.073381 0.02377,-0.07338 0.02584,-0.055811 0.0801,-0.069246 0.10542,-0.083716 0.09922,-0.049609 -0.135909,-0.1400431 -0.228409,0.023254 -0.157614,0.03669 -0.107486,0.049609 -0.110071,0.1080038 -4.1811403,4.4054157 -0.00878,0.073381 -0.083716,0.047026 0.00827,0.1121379 -0.055294,0.1178222 A 0.26186976,0.26186976 0 0 0 9.305375,7.4228026 L 9.0671466,7.1385822 9.0201211,7.1318643 9.0004841,7.1101602 8.8842121,7.1122272 8.8278848,7.0714029 8.8108315,6.9509968 8.3731322,6.345349 5.8342691,3.9785685 5.8260009,3.918107 5.6492675,3.7610107 5.5996581,3.7589436 4.6596638,2.8861287 4.5862833,2.8127482 4.5134195,2.788977 4.4570922,2.7631388 4.3883626,2.6835571 4.30413,2.5776204 Z","a":[9.26,5.027]},"AC90":{"d":"M 5.3831245,7.5844285 H 8.1995088 m 10.167845,7.5844285 h 2.816384 M 9.1570636 3.0866332 L 9.0278726 3.2256428 L 8.9033324 3.3997924 L 8.7741413 3.6385375 L 8.6449502 3.9516967 L 8.575187 4.2498697 L 8.500773 4.6720662 L 8.4661497 5.0250162 L 8.4361774 5.4575479 L 8.4361774 7.6889362 L 8.4165404 8.4645995 L 7.1142943 8.4645995 L 7.0941405 8.1814126 L 7.0745035 7.987626 L 7.0445311 7.8434488 L 6.9499633 7.8134764 L 6.9551309 7.6992715 L 6.9303262 7.5349405 L 6.8755492 7.3711262 L 6.7913166 7.2517536 L 6.7117349 7.3313353 L 6.6471394 7.4553588 L 6.617167 7.5897175 L 6.59753 7.7338947 L 6.59753 7.8083088 L 6.5277668 7.8331135 L 6.4977945 7.9772907 L 6.4729898 8.1814126 L 6.4331989 8.4594318 L 1.2640055 8.4299762 L 1.1647868 8.4346271 L 1.1100097 8.4547809 L 1.0753865 8.5193765 L 1.0702189 8.6635537 L 1.0650513 8.9467406 L 1.0898559 9.0759316 L 1.1198283 9.1307087 L 6.3339802 10.49755 L 6.3882404 10.765751 L 6.3934081 11.302669 L 6.4182128 11.422042 L 6.4533527 11.466483 L 6.56239 11.511442 L 6.6719441 11.531079 L 6.9055215 11.536247 L 7.0496988 11.511442 L 7.1639037 11.446846 L 7.1985269 11.397237 L 7.2233316 11.332641 L 7.2186807 11.069092 L 7.2336669 10.716142 L 8.1080321 10.959538 L 8.500773 10.949719 L 8.5653685 11.750187 L 8.6149779 12.261784 L 8.6547687 12.773897 L 8.6899087 13.191443 L 8.8687092 15.124658 L 6.0750813 15.686381 L 6.0750813 15.970084 L 9.2449136 16.571081 L 12.291756 15.970084 L 12.291756 15.686381 L 9.4986448 15.124658 L 9.6774453 13.191443 L 9.7120685 12.773897 L 9.7518594 12.261784 L 9.8014687 11.750187 L 9.8660643 10.949719 L 10.258805 10.959538 L 11.133687 10.716142 L 11.148673 11.069092 L 11.143506 11.332641 L 11.16831 11.397237 L 11.20345 11.446846 L 11.317655 11.511442 L 11.461832 11.536247 L 11.69541 11.531079 L 11.804447 11.511442 L 11.914001 11.466483 L 11.948624 11.422042 L 11.973429 11.302669 L 11.978597 10.765751 L 12.033374 10.49755 L 17.247009 9.1307087 L 17.276981 9.0759316 L 17.301786 8.9467406 L 17.296618 8.6635537 L 17.291967 8.5193765 L 17.256827 8.4547809 L 17.202567 8.4346271 L 17.102832 8.4299762 L 11.933638 8.4594318 L 11.893847 8.1814126 L 11.869043 7.9772907 L 11.839587 7.8331135 L 11.769824 7.8083088 L 11.769824 7.7338947 L 11.74967 7.5897175 L 11.720215 7.4553588 L 11.655619 7.3313353 L 11.576037 7.2517536 L 11.491288 7.3711262 L 11.436511 7.5349405 L 11.411706 7.6992715 L 11.416874 7.8134764 L 11.322306 7.8434488 L 11.292851 7.987626 L 11.272697 8.1814126 L 11.25306 8.4645995 L 9.9508136 8.4645995 L 9.9306598 7.6889362 L 9.9306598 5.4575479 L 9.9012042 5.0250162 L 9.8660643 4.6720662 L 9.7916502 4.2498697 L 9.721887 3.9511799 L 9.592696 3.6385375 L 9.4635049 3.3997924 L 9.3394814 3.2256428 L 9.2102904 3.0866332 L 9.1570636 3.0866332 z ","a":[9.26,9.525]},"A140":{"d":"m 9.3038249,1.7290934 -0.045992,0.00879 -0.045992,0.021704 -0.054777,0.030489 -0.061495,0.07028 L 9.0159871,1.9642212 8.930721,2.0779093 8.8418376,2.2153687 8.777242,2.3254395 8.6919759,2.4970052 8.5937907,2.6804565 8.514209,2.8918132 8.4470296,3.102653 8.397937,3.2923055 8.346261,3.5217489 8.312154,3.7088175 8.287866,3.8984701 8.263578,4.1428996 8.251176,4.3847453 8.244976,5.1407715 v 3.3134928 l -0.4800741,0.0093 -0.578776,0.012402 -0.6056478,0.0031 V 7.9219971 l -0.0093,-0.1343588 -0.018087,-0.0093 V 7.6527629 l -0.012402,-0.079582 -0.0093,-0.060978 -0.011886,-0.03669 -0.015503,-0.042891 -0.015503,-0.045992 V 7.2305664 l 0.2144572,-0.0093 0.4128947,-0.0093 0.2449463,-0.011886 0.1865519,-0.0062 0.079582,-0.015503 0.012402,-0.011886 -0.012402,-0.012402 -0.1193725,-0.0093 -0.2051555,-0.0093 L 7.0331624,7.1235962 6.6905477,7.1111938 6.494694,7.1018921 6.4735067,7.0042236 6.4518026,6.9153402 6.4213135,6.8202555 6.33243,6.6672933 6.2590495,6.5877116 h -0.03669 l -0.079582,0.082682 -0.085783,0.1441772 -0.042891,0.1679484 -0.011886,0.1131714 -0.1927531,0.015503 -0.3426147,0.0093 -0.2692342,0.011886 -0.2082561,0.012402 -0.1193725,0.012402 -0.0093,0.011886 0.012402,0.018603 0.079582,0.0093 0.1896525,0.0093 0.2480469,0.011886 0.4066935,0.0093 0.2051554,0.0062 0.0031,0.1038696 -0.024805,0.073381 -0.027388,0.088883 -0.018087,0.079582 -0.0093,0.085783 -0.00568,0.109554 -0.011886,0.011886 -0.00103,0.1353923 -0.0093,0.012919 v 0.567924 l -0.4852417,0.0093 -0.4811076,0.012919 -0.4914428,0.010335 -0.4929932,0.012919 -0.4785238,0.010852 -0.4950602,0.012919 -0.4914429,0.011369 -0.480074,0.010335 -0.4940267,0.013436 -0.4904093,0.011369 -0.47955734,0.010335 -0.0418579,0.00155 -0.0361735,0.00258 -0.0289388,0.014469 -0.0165365,0.013953 -0.0134359,0.022221 -0.008785,0.029972 -0.0118856,0.059945 -0.006201,0.1245402 -0.0315226,0.00413 -0.028422,0.017053 -0.0206706,0.00878 -0.0237712,0.03669 -0.008785,0.021704 -0.0103353,0.045475 -0.010852,0.092501 -0.0103353,0.2459799 -0.006201,0.2909383 0.0155029,0.014469 0.0583944,0.00517 0.0935343,0.010335 0.089917,0.010335 0.10800374,0.010852 0.0935343,0.010335 0.0950846,0.012919 0.0945679,0.011369 0.0914673,0.010852 0.0961182,0.011369 0.1080037,0.012919 0.6304525,0.076998 0.7513753,0.093534 2.9062826,0.3482991 0.6748942,0.08992 0.017053,0.0677 0.022221,0.06356 0.024805,0.04289 0.024805,0.04961 0.016536,0.03617 0.034106,-0.05064 0.025838,-0.05581 0.020671,-0.05219 0.03669,-0.0739 1.8190104,0.219624 0.058394,0.275952 0.014469,0.0155 0.00413,1.176673 0.011369,0.348299 0.011886,0.275952 0.011886,0.221175 0.010335,0.188619 0.012919,0.149345 0.013953,0.132809 0.010852,0.12454 0.010335,0.108003 0.011369,0.118339 0.013436,0.09353 0.012919,0.08216 0.010335,0.0894 0.012919,0.0832 0.012919,0.0832 0.010335,0.06925 0.011886,0.08062 0.010335,0.06873 0.012919,0.06925 0.010335,0.07131 0.012919,0.07286 0.011886,0.06873 0.011885,0.07286 0.011369,0.0677 0.010852,0.06098 0.012919,0.0677 0.00878,0.06925 0.011886,0.07131 -0.00258,0.04806 -0.0093,0.04444 -0.031006,0.06718 -0.054777,0.04858 -2.4685831,0.721403 -0.06873,0.02429 -0.066146,0.06821 -0.037207,0.08372 -0.028939,0.185518 v 0.516248 l 0.01757,0.01964 h 3.1264242 l 0.031006,0.09043 0.030489,0.163297 0.046509,0.209807 0.081649,0.35295 0.015503,0.03721 0.037207,0.03566 0.059945,0.0021 0.05271,0.608748 0.059428,-0.608748 0.059428,-0.0021 0.037724,-0.03566 0.015503,-0.03721 0.081649,-0.35295 0.045992,-0.209807 0.031006,-0.163297 0.031006,-0.09043 h 3.1259081 l 0.01757,-0.01964 V 16.40675 l -0.02842,-0.185518 -0.03772,-0.08372 -0.06615,-0.06821 -0.06821,-0.02429 -2.4691,-0.721403 -0.05426,-0.04858 -0.03152,-0.06718 -0.0088,-0.04444 -0.0026,-0.04806 0.01137,-0.07131 0.0093,-0.06925 0.01292,-0.0677 0.01033,-0.06098 0.01189,-0.0677 0.01189,-0.07286 0.01137,-0.06873 0.01292,-0.07286 0.01034,-0.07131 0.01344,-0.06925 0.01033,-0.06873 0.01137,-0.08062 0.01085,-0.06925 0.01292,-0.0832 0.01292,-0.0832 0.01033,-0.0894 0.01292,-0.08216 0.01292,-0.09353 0.01189,-0.118339 0.01033,-0.108003 0.01034,-0.12454 0.01447,-0.132809 0.01292,-0.149345 0.01034,-0.188619 0.01189,-0.221175 0.01137,-0.275952 0.01189,-0.348299 0.0041,-1.176673 0.01395,-0.0155 0.05891,-0.275952 1.819011,-0.219624 0.03617,0.0739 0.02119,0.05219 0.02584,0.05581 0.03359,0.05064 0.01705,-0.03617 0.0248,-0.04961 0.02481,-0.04289 0.02222,-0.06356 0.01654,-0.0677 0.674895,-0.08992 2.906282,-0.3482991 0.751892,-0.093534 0.630453,-0.076998 0.108003,-0.012919 0.09612,-0.011369 0.09095,-0.010852 0.09509,-0.011369 0.09508,-0.012919 0.09353,-0.010335 0.108003,-0.010852 0.0894,-0.010335 0.09405,-0.010335 0.05839,-0.00517 0.0155,-0.014469 -0.0067,-0.2909383 -0.01034,-0.2459799 -0.01034,-0.092501 -0.01034,-0.045475 -0.0093,-0.021704 -0.02325,-0.03669 -0.02067,-0.00878 -0.02842,-0.017053 -0.03152,-0.00413 -0.0062,-0.1245402 -0.01189,-0.059945 -0.0093,-0.029972 -0.01292,-0.022221 -0.01705,-0.013953 -0.02842,-0.014469 -0.03617,-0.00258 -0.04186,-0.00155 -0.479558,-0.010335 -0.490409,-0.011369 -0.494027,-0.013436 -0.480074,-0.010335 -0.491443,-0.011369 -0.495577,-0.012919 -0.478523,-0.010852 -0.492477,-0.012919 -0.491959,-0.010335 -0.481108,-0.012919 -0.484725,-0.0093 v -0.567924 l -0.0093,-0.012919 -10e-4,-0.1353923 -0.01189,-0.011886 -0.0057,-0.109554 -0.0093,-0.085783 -0.01809,-0.079582 -0.0279,-0.088883 -0.02429,-0.073381 0.0031,-0.1038696 0.205155,-0.0062 0.406694,-0.0093 0.248046,-0.011886 0.189653,-0.0093 0.07958,-0.0093 0.0124,-0.018603 -0.0093,-0.011886 -0.119372,-0.012402 -0.208256,-0.012402 -0.269234,-0.011886 -0.342615,-0.0093 -0.192753,-0.015503 -0.0124,-0.1131714 -0.04289,-0.1679484 -0.08578,-0.1441772 -0.07906,-0.082682 h -0.03721 l -0.07338,0.079582 -0.08837,0.1529622 -0.03101,0.095085 -0.02119,0.088883 -0.02119,0.097668 -0.195853,0.0093 -0.343132,0.012402 -0.269234,0.011886 -0.204639,0.0093 -0.119372,0.0093 -0.0124,0.012402 0.0124,0.011886 0.07958,0.015503 0.186552,0.0062 0.244947,0.011886 0.412894,0.0093 0.213941,0.0093 v 0.1560628 l -0.01499,0.045992 -0.0155,0.042891 -0.0124,0.03669 -0.0088,0.060978 -0.0124,0.079582 v 0.1255737 l -0.0186,0.0093 -0.0088,0.1343588 V 8.479069 L 11.413229,8.475969 10.83497,8.463567 10.354379,8.454267 V 5.1407715 L 10.348722,4.3847453 10.33632,4.1428996 10.312032,3.8984701 10.287227,3.7088175 10.253638,3.5217489 10.201444,3.2923055 10.152869,3.102653 10.085173,2.8918132 10.005591,2.6804565 9.9079224,2.4970052 9.8221395,2.3254395 9.7580607,2.2153687 9.6691772,2.0779093 9.5833944,1.9642212 9.5038127,1.8603516 9.4428345,1.7900716 9.3875407,1.7595825 9.3420654,1.7378784 Z","a":[9.26,8.731]},"A342":{"d":"M 9.314043,0.80666909 9.259383,0.82785643 9.1839354,0.90588784 9.1110716,1.0097575 9.0046182,1.225765 8.9002318,1.4732951 8.798946,1.751831 8.73125,1.9885091 8.663554,2.2515421 8.595858,2.6132771 8.559168,2.8577067 8.528162,3.1651814 8.515243,3.3837727 v 0.168982 3.0194538 L 6.9897541,7.5013508 7.0135253,7.3530394 7.0290282,7.1943928 7.031612,7.040397 V 6.8739989 L 7.0212767,6.6424885 7.0026732,6.4729898 6.9820026,6.4471516 H 6.4223469 l -0.028422,0.020671 -0.012919,0.1457276 -0.010335,0.1565796 -0.00568,0.1741495 0.0031,0.1508952 0.00258,0.1669149 0.015503,0.1379761 0.018087,0.1483113 0.023254,0.1353923 0.026355,0.1405599 -2.2882324,1.418518 0.010852,-0.1198893 0.010335,-0.1121379 0.00775,-0.1483113 0.00517,-0.153479 L 4.1945759,8.5111082 4.1816568,8.3498778 4.168221,8.2170694 4.1501342,8.2015664 H 3.5775593 l -0.018087,0.018087 -0.00775,0.062529 -0.012919,0.1431437 -0.013436,0.153479 v 0.164331 l 0.00258,0.1612305 0.013436,0.1638143 0.023254,0.1901692 0.020671,0.1483114 0.034107,0.1689819 -2.5481649,1.5776816 -0.03669,0.03876 -0.010335,0.04703 -0.00517,0.0987 -0.21600746,0.504879 v 0.221175 l 0.20567216,-0.145728 2.7770915,-1.210262 -0.00258,0.0677 0.015503,0.109555 0.03669,0.125056 0.020671,0.04909 h 0.034107 l 0.03359,-0.109037 0.034107,-0.130225 0.015503,-0.125057 v -0.05736 l 0.263033,-0.0832 0.00258,0.07028 0.018087,0.09612 0.023254,0.09405 0.034107,0.08837 h 0.025838 l 0.03669,-0.114721 0.031006,-0.124541 0.018087,-0.114721 v -0.07028 l 0.736906,-0.247014 -0.00258,0.07286 0.020671,0.101286 0.03359,0.112138 0.026355,0.06459 h 0.025838 l 0.03669,-0.116788 0.028422,-0.114722 0.020671,-0.0987 v -0.09095 L 6.0895507,9.9167072 v 0.07028 l 0.023254,0.1069698 0.036174,0.127124 0.023771,0.04444 0.023254,-0.0026 0.039274,-0.109554 0.028422,-0.119372 0.018087,-0.1069704 0.00258,-0.085783 0.6976318,-0.2392619 0.1224732,0.00517 v 0.1167887 l 0.020671,0.1147217 0.028939,0.1198893 0.025838,0.05426 h 0.028422 l 0.03669,-0.1038685 0.031006,-0.1173055 0.012919,-0.098702 0.010852,-0.09095 h 1.0826212 l 0.010335,0.1353923 0.025838,0.1431437 0.031523,0.129708 0.038757,0.130224 0.026355,0.07028 v 1.528072 l 0.00258,0.252181 0.012919,0.24753 0.023254,0.377238 0.026355,0.283704 0.036174,0.296623 0.065112,0.476456 0.2888712,1.845366 -2.2592936,1.337902 -0.049093,0.04444 -0.047026,0.05994 -0.025838,0.07803 -0.057361,0.559656 2.6391154,-0.752409 0.072864,0.736389 0.03669,0.02119 h 0.066146 l 0.03669,-0.02119 0.072864,-0.736389 2.6391161,0.752409 -0.05736,-0.559656 -0.02584,-0.07803 -0.04702,-0.05994 -0.04961,-0.04444 -2.2592943,-1.337902 0.2888712,-1.845366 0.065113,-0.476456 0.03669,-0.296623 0.02584,-0.283704 0.02377,-0.377238 0.01292,-0.24753 0.0026,-0.252181 v -1.528072 l 0.02584,-0.07028 0.03927,-0.130224 0.03101,-0.129708 0.02636,-0.1431437 0.01034,-0.1353923 h 1.082621 l 0.01033,0.09095 0.01292,0.098702 0.03152,0.1173055 0.03617,0.1038685 h 0.02894 l 0.02584,-0.05426 0.02842,-0.1198893 0.02119,-0.1147217 v -0.116773 l 0.121956,-0.00517 0.697632,0.2392619 0.0026,0.085783 0.0186,0.1069707 0.02842,0.119372 0.03927,0.109554 0.02326,0.0026 0.02325,-0.04444 0.03669,-0.127124 0.02326,-0.1069701 v -0.07028 l 0.736389,0.2449461 v 0.09095 l 0.02119,0.0987 0.02842,0.114722 0.03669,0.116788 h 0.02584 l 0.02584,-0.06459 0.03411,-0.112138 0.02067,-0.101286 -0.0026,-0.07286 0.736389,0.247014 v 0.07028 l 0.0186,0.114721 0.03101,0.124541 0.03669,0.114721 h 0.02584 l 0.03359,-0.08837 0.02377,-0.09405 0.01809,-0.09612 0.0026,-0.07028 0.263033,0.0832 v 0.05736 l 0.0155,0.125057 0.03411,0.130225 0.03359,0.109037 h 0.03411 l 0.02067,-0.04909 0.03617,-0.125056 0.01602,-0.109555 -0.0026,-0.0677 2.777092,1.210262 0.205672,0.145728 v -0.221175 l -0.216008,-0.504879 -0.0052,-0.0987 -0.01085,-0.04703 -0.03617,-0.03876 -2.548165,-1.5776816 0.03359,-0.1689819 0.02119,-0.1483114 0.02325,-0.1901692 0.01292,-0.1638143 0.0026,-0.1612305 v -0.164331 l -0.01292,-0.153479 -0.01292,-0.1431437 -0.0078,-0.062529 -0.01809,-0.018087 h -0.573092 l -0.01809,0.015503 -0.01292,0.1328084 -0.01292,0.1612304 -0.0052,0.1979208 0.0052,0.153479 0.0078,0.1483113 0.01033,0.1121379 0.01034,0.1198893 -2.287716,-1.418518 0.02584,-0.1405599 0.02377,-0.1353923 0.01809,-0.1483113 0.0155,-0.1379761 0.0026,-0.1669149 0.0026,-0.1508952 -0.0052,-0.1741495 -0.01033,-0.1565796 -0.01292,-0.1457276 -0.02894,-0.020671 h -0.559656 l -0.02067,0.025838 -0.01809,0.1694987 -0.01034,0.2315104 V 7.040397 l 0.0026,0.1539958 0.0155,0.1586466 0.02325,0.1483114 -1.524972,-0.9291423 V 3.5527547 3.3837727 L 10.099125,3.1651814 10.067602,2.8577067 10.031429,2.6132771 9.9637327,2.2515421 9.8960366,1.9885091 9.8283405,1.751831 9.7265379,1.4732951 9.6226683,1.225765 9.5156981,1.0097575 9.4428343,0.90588784 9.3673867,0.82785643 Z","a":[9.26,7.937]},"P32T":{"d":"M 7.5157283,3.1978669 H 10.833545 m 9.1744707,2.8906605 -0.1119749,0.037843 -0.062012,0.1033528 -0.077515,0.1912028 -0.036174,0.1498617 -0.020671,0.144694 -0.025838,0.015503 -0.036173,0.08785 -0.031006,0.020671 -0.020671,-0.00517 -0.036173,-0.031006 -0.025838,-0.046509 H 8.4423786 L 8.3700316,3.6313028 8.3080199,3.8741821 8.2666787,4.2147297 8.2103514,4.6074706 8.1638426,5.0565388 8.1173338,6.2394123 7.1148111,6.6579914 H 5.0022786 L 1.2474691,6.96805 1.1441162,7.004224 1.0510982,7.092074 0.9735836,7.2264328 0.9270748,7.3861129 0.9064042,7.4636279 0.808219,7.5824837 v 0.062012 l 0.10335286,0.082682 0.0103353,0.2687174 0.0465088,0.217041 0.08785,0.1596802 0.1033528,0.1085205 0.08785,0.041341 3.6054646,0.3875732 3.3522501,0.020671 0.7022827,5.263244 H 6.5107136 l -0.077515,0.04134 -0.1085205,0.113688 -0.041341,0.103353 -0.036174,0.129191 v 0.351399 l 0.031006,0.159681 0.072347,0.160196 0.08785,0.124024 0.093018,0.07752 h 2.6499674 2.6365315 l 0.09302,-0.07752 0.08785,-0.124024 0.07235,-0.160196 0.03101,-0.159681 v -0.351399 l -0.03617,-0.129191 -0.04134,-0.103353 -0.108521,-0.113688 -0.07751,-0.04134 H 9.4423175 L 10.1446,8.9307209 l 3.35225,-0.020671 3.605465,-0.3875732 0.08785,-0.041341 0.102836,-0.1085205 0.08785,-0.1596802 0.04651,-0.217041 0.01034,-0.2687174 0.103353,-0.082682 v -0.062012 l -0.09819,-0.1188558 -0.02067,-0.077515 -0.04651,-0.1596801 -0.07751,-0.1343588 -0.0925,-0.08785 L 17.102315,6.96805 13.346989,6.6579914 H 11.234456 L 10.23245,6.2394123 10.185941,5.0565388 10.139433,4.6074706 10.082589,4.2147297 10.041247,3.8741821 9.9792357,3.6313028 9.9068887,3.5589558 H 9.6588418 l -0.025838,0.046509 -0.036174,0.031006 -0.020671,0.00517 -0.031006,-0.020671 -0.036174,-0.08785 L 9.4831419,3.5176147 9.4629881,3.3729207 9.4268146,3.223059 9.3493,3.0318562 9.2872882,2.9285034 Z","a":[9.26,7.673]},"B77W":{"d":"M 9.2141029,1.350886 9.1441445,1.3756266 9.0087523,1.5781982 8.89093,1.949235 8.7219481,2.4386108 8.5529662,2.9450398 8.4180907,3.5863443 8.3509113,3.9578979 8.274947,4.404899 V 6.472473 L 8.2408405,6.7086343 8.1142333,6.9112059 7.7850544,7.1980101 7.3463215,7.4935993 7.3804279,7.1897419 V 6.7003661 L 7.3463215,6.4218301 7.211446,6.2616332 H 6.4941771 l -0.1012858,0.03359 -0.084233,0.2361613 v 1.0299112 l 0.050643,0.2273763 v 0.2702678 l -5.2740965,2.7848422 -0.11833907,0.101286 -0.0930176,0.261483 -0.13487548,0.573608 0.0759644,0.0088 0.0930176,0.0083 0.14314365,-0.08423 3.7046834,-1.164787 v 0.315226 l 0.1126546,-0.0041 0.057361,-0.106453 0.049093,-0.257349 1.0386963,-0.327112 V 10.4097 l 0.085783,0.08578 0.091984,-0.09198 0.05116,-0.296623 0.4294312,-0.1183386 V 10.393164 H 6.8843342 V 9.9435789 h 0.179834 v 0.2532141 l 0.061495,0.127124 H 7.2357339 V 9.9394448 h 0.9978719 v 2.7863932 l 0.031523,0.550871 0.043925,0.264583 0.058911,0.448035 0.095601,0.558622 0.095085,0.455269 -2.9682943,2.006079 -0.021704,0.381889 3.519165,-0.896069 v 0.565857 l 0.1290635,0.216202 0.1215672,-0.216202 v -0.565857 l 3.5196818,0.896069 -0.02222,-0.381889 -2.9682941,-2.006079 0.095601,-0.455269 0.095601,-0.558622 0.0584,-0.448035 0.04444,-0.264583 0.03152,-0.550871 V 9.9394448 h 0.997355 v 0.3844722 h 0.110588 l 0.06098,-0.127124 V 9.9435789 h 0.179834 v 0.4495851 h 0.212907 V 9.9885374 l 0.429431,0.1183386 0.05116,0.296623 0.09198,0.09198 0.08578,-0.08578 V 10.16837 l 1.038179,0.327112 0.04909,0.257349 0.05736,0.106453 0.112654,0.0041 v -0.315226 l 3.704684,1.164787 0.14366,0.08423 0.0925,-0.0083 0.07596,-0.0088 -0.134875,-0.573608 -0.09302,-0.261483 L 17.341577,10.843782 12.06748,8.0589395 V 7.7886717 L 12.11812,7.5612954 V 6.5313842 L 12.03337,6.2952229 11.932084,6.2616329 H 11.214815 L 11.07994,6.4218298 11.04635,6.7003658 V 7.1897419 L 11.079944,7.4935993 10.641211,7.1980101 10.312032,6.9112059 10.185425,6.7086343 10.151835,6.472473 V 4.404899 L 10.075871,3.9578979 10.008174,3.5863443 9.873299,2.9450398 9.704317,2.4386108 9.5358519,1.949235 9.4175129,1.5781982 9.2826374,1.3756266 Z","a":[9.26,7.937]},"AN24":{"d":"m 10.447627,5.5590241 h 2.306697 M 5.7413796,5.5590241 H 8.0480772 m 9.2490477,2.3605794 -0.042375,0.011369 -0.052193,0.028939 -0.07028,0.060978 -0.066146,0.076998 -0.076998,0.1105875 -0.090951,0.1545126 -0.076998,0.1627807 -0.1131714,0.2837036 -0.081649,0.2744019 -0.0863,0.3906738 -0.049093,0.3317627 -0.026355,0.37052 -0.013953,0.5844604 V 7.345288 H 7.2403848 L 7.2626057,7.2295327 7.2770751,7.0941405 7.2874104,6.9447956 V 6.4993448 L 7.2729409,6.3019408 7.2507201,6.1221068 7.1907754,5.8905964 7.1453002,5.847705 H 7.0853552 V 5.748486 L 7.0739862,5.66167 7.0584832,5.595007 7.0465972,5.54178 7.0233432,5.483386 6.9969882,5.436361 6.9556472,5.388302 6.9205072,5.366081 6.9034542,5.362461 6.8698642,5.368661 6.8264562,5.3976 6.7835642,5.454444 6.7535922,5.52214 6.7277542,5.606889 6.7122512,5.696806 6.7081212,5.751583 v 0.098702 h -0.062528 l -0.042891,0.038757 -0.023254,0.095085 -0.032556,0.1405598 -0.015503,0.125057 -0.012919,0.1286743 v 0.5648234 l 0.00775,0.160197 0.012919,0.1090372 0.022221,0.1343587 H 6.444051 l -5.74590241,0.9808187 -0.0366903,0.014469 -0.03514,0.031006 -0.0232544,0.037724 -0.0155029,0.059945 -0.005168,0.057361 0.005168,0.071313 0.0103353,0.091467 0.0232544,0.1353923 0.0289388,0.118339 0.0103353,0.020671 0.0191203,0.011886 0.0196371,0.00362 5.96242671,0.2852539 0.011369,0.072864 0.017053,0.1038696 0.034106,0.1601969 0.043925,0.1756999 0.042891,0.1405599 0.041858,0.1167894 0.038757,0.08992 0.01602,0.01447 0.012919,10e-4 0.022738,-0.01654 0.021187,-0.03721 0.032556,-0.08785 0.05116,-0.1581298 0.050126,-0.2077393 0.041341,-0.1958537 0.028422,-0.1684651 0.00775,-0.038757 h 1.2293823 v 2.5636683 l 0.012402,0.298173 0.024805,0.267684 0.033073,0.321427 0.036174,0.278536 0.055294,0.3545 0.1514119,0.789616 0.1271241,0.601514 -2.1399211,0.822172 -0.044442,0.02222 -0.035657,0.03049 -0.026355,0.04651 -0.014986,0.0677 -0.0031,0.179317 0.011369,0.0925 0.01757,0.09922 0.026355,0.08733 0.023254,0.05788 0.023771,0.02481 h 0.028939 l 2.2753132,-0.115755 0.072864,-0.0016 0.055294,0.01395 0.048576,0.04393 0.025838,0.04703 0.00982,0.05219 0.010852,0.03307 0.016536,0.02222 0.021187,0.0067 0.022221,-0.0067 0.016536,-0.02222 0.011369,-0.03307 0.0093,-0.05219 0.026355,-0.04703 0.048576,-0.04393 0.054777,-0.01395 0.073381,0.0016 2.2753127,0.115755 h 0.02894 l 0.02326,-0.02481 0.02377,-0.05788 0.02636,-0.08682 0.01757,-0.09973 0.01137,-0.0925 -0.0031,-0.179317 -0.01499,-0.0677 -0.02636,-0.04651 -0.03566,-0.03049 -0.04444,-0.02222 -2.1399205,-0.822172 0.127124,-0.601514 0.1514119,-0.789616 0.055294,-0.3545 0.036174,-0.278536 0.03307,-0.321427 0.0248,-0.267684 0.0124,-0.298173 V 9.2309609 h 1.229382 l 0.0072,0.038757 0.02894,0.1684651 0.04134,0.1958537 0.04961,0.2077393 0.05168,0.1581298 0.03204,0.08785 0.02119,0.03721 0.02325,0.01654 0.01292,-10e-4 0.0155,-0.01447 0.03927,-0.08992 0.04186,-0.1167892 0.04289,-0.1405599 0.04393,-0.1756999 0.03411,-0.1601969 0.01654,-0.1038696 0.01188,-0.072864 5.962427,-0.2852539 0.01912,-0.00362 0.01964,-0.011886 0.01034,-0.020671 0.02894,-0.118339 0.02325,-0.1353923 0.01034,-0.091467 0.0052,-0.071313 -0.0052,-0.057361 -0.0155,-0.059945 -0.02325,-0.037724 -0.03514,-0.031006 -0.03669,-0.014469 -5.745903,-0.9808187 h -0.117305 l 0.02222,-0.1343587 0.01292,-0.1090372 0.0078,-0.160197 V 6.3784219 l -0.01292,-0.1286743 -0.0155,-0.125057 -0.03256,-0.1405598 -0.02377,-0.095085 -0.04289,-0.038757 h -0.06253 v -0.098702 l -0.0036,-0.054777 -0.0155,-0.089917 -0.02636,-0.084749 -0.02997,-0.067696 -0.04289,-0.056844 -0.04289,-0.028939 -0.03359,-0.0062 -0.01705,0.00362 -0.03514,0.022221 -0.04186,0.048059 -0.02584,0.047025 -0.02325,0.058394 -0.01189,0.053227 -0.0155,0.066663 -0.01189,0.086816 v 0.099219 h -0.05994 l -0.04547,0.042891 -0.05995,0.2315104 -0.0217,0.179834 -0.01447,0.197404 V 6.944799 l 0.01033,0.1493449 0.01447,0.1353922 0.02222,0.1157553 H 10.096024 V 5.2022663 L 10.081555,4.6178059 10.055717,4.2472859 10.006107,3.9155232 9.9203245,3.5248494 9.8386758,3.2504475 9.7249876,2.9667439 9.6485065,2.8039632 9.557556,2.6494506 9.4805581,2.5388631 9.4144123,2.4618652 9.3441323,2.400887 9.2919391,2.3719482 9.2495644,2.3605794 Z","a":[9.26,8.202]},"DH8B":{"d":"m 10.534663,6.0232275 h 2.882722 M 5.0114752,6.0232275 H 7.8941967 M 9.2362395,1.8562174 9.1153709,1.8844365 8.9782632,1.9823079 8.8774941,2.1151163 8.763806,2.2980509 8.6371987,2.5507487 8.5235106,2.8096476 8.4165404,3.1377929 8.3281737,3.51038 8.2522093,3.9144897 8.2206867,4.2679565 8.2144855,4.4700113 V 7.329785 l -0.044442,0.037724 H 6.7370564 V 6.5406859 L 6.7179361,6.1934203 6.6740111,5.9851643 6.5918456,5.8208332 6.4781574,5.7133463 6.452836,5.7066283 6.4027098,5.7453856 6.2952229,5.8776773 6.2383788,6.0544107 6.200655,6.2249429 V 7.37371 l -5.56865224,0.631486 -0.0568441,0.025321 -0.0501261,0.069246 -0.0320394,0.1012858 V 8.952425 l 2.85408934,0.1576131 0.043925,0.107487 0.056844,-0.1012858 1.3068969,0.063562 0.043925,0.1069702 0.056844,-0.1007691 1.319816,0.063045 v 0.624768 l 0.025322,0.2402953 0.050126,0.202055 0.1012858,0.151412 0.1198894,0.05684 0.100769,-0.05064 0.095085,-0.100769 0.063045,-0.126607 0.025321,-0.113688 V 9.268168 l 1.5089518,-0.01912 v 2.0644733 l 0.050126,0.675411 0.050643,0.643888 0.075964,0.549321 0.1700155,1.010274 0.2971395,1.287777 -2.1528402,0.302824 -0.063045,0.05684 -0.050643,0.126607 v 0.618567 l 0.037724,0.202055 0.063045,0.139009 h 2.4127726 l -0.00155,0.2651 0.063045,-0.2651 h 2.4685829 l 0.06304,-0.139009 0.03772,-0.202055 v -0.618567 l -0.05064,-0.126607 -0.06304,-0.05684 -2.1528401,-0.302824 0.2966228,-1.287777 0.1705322,-1.010274 0.075964,-0.549321 0.05064,-0.643888 0.05013,-0.675411 V 9.2490477 l 1.508952,0.01912 v 0.864547 l 0.02532,0.113688 0.06305,0.12609 0.09457,0.101286 0.101285,0.05064 0.11989,-0.05684 0.101286,-0.151412 0.05013,-0.202055 0.02532,-0.2402953 v -0.624768 l 1.319299,-0.063045 0.05685,0.1007691 0.04444,-0.107487 1.306897,-0.063045 0.05684,0.1012858 0.04392,-0.107487 2.853573,-0.1576131 V 8.2010497 L 17.904333,8.0997639 17.854207,8.0305174 17.797363,8.005196 12.228711,7.37371 V 6.2249429 l -0.03772,-0.1705322 -0.05684,-0.1767334 -0.107487,-0.1328084 -0.05064,-0.038241 -0.02481,0.00672 -0.113688,0.1074869 -0.08216,0.1643311 -0.04444,0.208256 -0.0186,0.3472656 V 7.3675088 H 10.259322 L 10.21488,7.329785 V 4.4700113 L 10.208679,4.2679565 10.177156,3.9144897 10.101192,3.51038 10.012825,3.1377929 9.9053384,2.8096476 9.792167,2.5507487 9.6655597,2.2980509 9.5518716,2.1151163 9.4511025,1.9823079 9.3498167,1.88774 Z","a":[9.26,7.937]},"A345":{"d":"m 9.2598568,0.43310442 -0.045992,0.0191203 -0.066663,0.063562 -0.062012,0.0857829 -0.055294,0.0997355 -0.065112,0.14262695 -0.069763,0.17001543 -0.071314,0.1870687 -0.060461,0.1839681 -0.055811,0.1999878 -0.039274,0.1632975 -0.041341,0.1808675 -0.026872,0.1555461 -0.032039,0.2061889 -0.023771,0.2315104 -0.013953,0.2382284 -0.00827,0.2010213 v 3.9134561 l -1.4066325,0.8645467 0.0093,-0.079065 0.0093,-0.116272 0.00982,-0.1488281 V 7.0704253 L 7.1338884,6.9402006 7.1147681,6.7738025 7.0961646,6.6275582 7.0708432,6.6022368 H 6.4233375 l -0.023771,0.020671 -0.010852,0.060461 -0.020671,0.1348755 -0.014469,0.1395263 -0.0062,0.1457276 -0.00155,0.1953369 0.0031,0.1570963 0.014469,0.1519287 0.018603,0.1906861 0.01912,0.1472778 h 0.072864 l 0.01757,0.077515 0.03359,0.076481 -2.1843627,1.3513386 0.014469,-0.109554 0.0062,-0.1395264 0.00775,-0.1348754 V 8.7090849 L 4.3516293,8.5390694 4.321657,8.3406319 4.2963356,8.3153105 H 3.6524472 l -0.027388,0.01602 -0.013953,0.065112 -0.020671,0.1632975 -0.01912,0.1694987 -0.00155,0.2098063 0.0031,0.1948202 0.011369,0.1824178 0.037724,0.3379638 h 0.072864 l 0.023771,0.088883 0.027389,0.072864 -2.5207764,1.5611452 -0.023771,0.02687 -0.012919,0.02842 -0.0093,0.149345 -0.20463863,0.453202 v 0.233577 l 0.19843743,-0.146244 2.7140462,-1.18339 0.00155,0.08113 0.014469,0.08061 0.020671,0.08113 0.033073,0.09043 h 0.042891 l 0.026872,-0.09664 0.025321,-0.104903 0.01602,-0.08888 0.0093,-0.112654 0.2604492,-0.08682 -0.00155,0.08837 0.017053,0.08733 0.01912,0.07131 0.023771,0.06666 0.01912,0.02532 h 0.029972 l 0.027388,-0.09043 0.023771,-0.101286 0.020154,-0.09043 0.00827,-0.127124 0.7121012,-0.240812 v 0.0584 l 0.014469,0.08578 0.022221,0.07442 0.028422,0.08733 0.01912,0.03514 h 0.023771 l 0.022221,-0.06201 0.020671,-0.06666 0.022221,-0.08423 0.017053,-0.08837 0.00982,-0.109554 0.7136515,-0.24753 v 0.07131 l 0.014469,0.08268 0.015503,0.06666 0.01602,0.05684 0.03514,0.06511 h 0.020671 l 0.025321,-0.06976 0.025322,-0.07441 0.01757,-0.06976 0.012402,-0.08113 0.0062,-0.114205 0.6697265,-0.2330607 H 7.1416407 V 9.980828 l 0.01757,0.08733 0.01602,0.06976 0.01757,0.04909 0.031523,0.06046 h 0.01757 l 0.022221,-0.05219 0.020671,-0.05581 0.015503,-0.05995 0.01602,-0.06976 0.014469,-0.087333 V 9.851134 h 1.12913 l 0.011369,0.1142049 0.015503,0.1441771 0.03514,0.380855 v 2.127002 l 0.0093,0.299724 0.020671,0.396875 0.030489,0.366386 0.029972,0.277502 0.028422,0.203088 0.062012,0.434599 0.050643,0.331246 0.1870686,1.21698 -2.0665404,1.224215 -0.060462,0.05581 -0.042891,0.07906 -0.0093,0.06046 -0.049093,0.486792 2.4143229,-0.68678 0.066146,0.668176 0.027388,0.0186 0.042375,0.0015 0.038757,-0.0015 0.026872,-0.0186 0.066663,-0.668176 2.4143232,0.68678 -0.04909,-0.486792 -0.0098,-0.06046 -0.04289,-0.07906 -0.05995,-0.05581 -2.0670568,-1.224215 0.1870686,-1.21698 0.050643,-0.331246 0.062012,-0.434599 0.028422,-0.203088 0.030489,-0.277502 0.029972,-0.366386 0.020671,-0.396875 0.0093,-0.299724 v -2.127002 l 0.03514,-0.380855 0.01602,-0.1441771 0.01085,-0.1142049 h 1.129647 v 0.071314 l 0.01395,0.087333 0.01602,0.06976 0.01602,0.05995 0.02067,0.05581 0.02222,0.05219 h 0.01705 l 0.03204,-0.06046 0.01757,-0.04909 0.0155,-0.06976 0.01757,-0.08733 V 9.8542346 h 0.133325 l 0.66921,0.2330604 0.0062,0.114205 0.01292,0.08113 0.01757,0.06976 0.02532,0.07441 0.02532,0.06976 h 0.02067 l 0.03462,-0.06511 0.01602,-0.05684 0.01602,-0.06666 0.01395,-0.08268 v -0.07131 l 0.714168,0.24753 0.0093,0.109554 0.01757,0.08837 0.02222,0.08423 0.02067,0.06666 0.02222,0.06201 h 0.02377 l 0.01912,-0.03514 0.02842,-0.08733 0.02222,-0.07442 0.01395,-0.08578 v -0.0584 l 0.712618,0.240812 0.0078,0.127124 0.02067,0.09043 0.02377,0.101286 0.02687,0.09043 h 0.02997 l 0.01912,-0.02532 0.02377,-0.06666 0.01912,-0.07131 0.01757,-0.08733 -0.0015,-0.08888 0.259932,0.08733 0.0098,0.112654 0.0155,0.08888 0.02532,0.104903 0.02739,0.09664 h 0.04237 l 0.03359,-0.09043 0.02067,-0.08113 0.01395,-0.08061 0.0021,-0.08113 2.714046,1.18339 0.197921,0.146244 V 12.03499 l -0.204639,-0.453202 -0.0093,-0.149345 -0.01292,-0.02842 -0.02377,-0.02687 -2.520259,-1.5611449 0.02687,-0.072864 0.02377,-0.088883 h 0.07286 l 0.03824,-0.3379638 0.01085,-0.1824178 0.0036,-0.1948202 -0.0021,-0.2098063 -0.0186,-0.1694987 -0.02067,-0.1632975 -0.01447,-0.065112 -0.02687,-0.01602 H 14.22496 l -0.02532,0.025321 -0.03049,0.1984375 -0.01757,0.1700155 v 0.3581177 l 0.0083,0.1348754 0.0062,0.1395264 0.01447,0.109554 -2.184363,-1.3513386 0.03307,-0.076481 0.01757,-0.077515 h 0.07286 l 0.01912,-0.1472778 0.01912,-0.1906861 0.01395,-0.1519287 0.0036,-0.1570963 -0.0016,-0.1953369 -0.0067,-0.1457276 -0.01395,-0.1395263 -0.02067,-0.1348755 -0.01137,-0.060461 -0.02377,-0.020671 h -0.646989 l -0.02532,0.025321 -0.01912,0.1462443 -0.01912,0.1663981 -0.0093,0.1302247 V 7.39547 l 0.0093,0.1488281 0.0098,0.116272 0.0093,0.079065 L 9.9988298,6.8750883 V 2.9616322 L 9.9910783,2.7606109 9.9766089,2.5223825 9.9528377,2.2908721 9.9213151,2.0846832 9.8944434,1.9291371 9.8531022,1.7482696 9.8133114,1.5849721 9.7580176,1.3849843 9.6975562,1.2010162 9.6262427,1.0139475 9.5564795,0.84393205 9.4913672,0.7013051 9.4355567,0.60156959 9.3740617,0.51578671 9.3073991,0.4522247 Z","a":[9.26,8.202]},"A321":{"d":"M 9.2599038,0.45197135 9.1989256,0.46540722 9.1296792,0.5134663 9.0273598,0.61940299 8.8847329,0.83127636 8.7674274,1.0684712 8.6785439,1.2808614 8.6092975,1.4792989 8.5245482,1.8069274 8.4857908,2.0802958 8.4764908,2.26168 v 4.554244 l -0.00982,0.1064535 -0.034623,0.088367 -0.05581,0.081132 -0.067696,0.061495 -0.084749,0.048059 -0.048059,0.025321 -0.8268229,0.4201293 0.011369,-0.063562 0.015503,-0.1560628 0.015503,-0.1850016 0.00775,-0.160197 0.024805,-0.00775 -0.024805,-0.061495 V 6.8526143 L 7.3835325,6.7141214 7.3602781,6.5962992 7.3468423,6.544106 7.327722,6.5306701 H 6.6817666 l -0.01912,0.013436 -0.023254,0.081132 -0.026872,0.1694987 -0.00982,0.1968872 0.013436,0.2408122 0.075448,0.6743774 0.057878,0.00982 v 0.038757 l -4.1093099,2.1259684 -0.057878,0.03462 -0.032556,0.03256 -0.031006,0.05581 -0.00982,0.06201 v 0.645438 h 0.044442 v -0.198436 l 1.9719727,-0.588078 v 0.131258 l 0.01912,0.100252 0.023254,0.06356 h 0.023254 l 0.026872,-0.08113 0.017053,-0.109554 V 10.092727 L 5.937626,9.6994689 v 0.1390096 l 0.023254,0.1095541 0.015503,0.046509 h 0.026872 l 0.028939,-0.096635 0.01757,-0.094051 V 9.6684631 L 6.652828,9.4834615 h 0.3162598 l 0.00362,0.088883 0.027389,0.055811 0.032556,-0.059428 v -0.081132 l 0.2526977,0.00982 -0.00207,0.109554 0.023254,0.1157552 0.022738,0.067179 0.019637,-0.00155 0.038241,-0.09095 0.013436,-0.092501 0.00207,-0.1059367 1.0738363,0.015503 v 4.309815 l 0.00362,0.254248 0.044442,0.586011 0.069246,0.458886 0.083199,0.379305 0.069246,0.293006 0.011369,0.07752 -0.013436,0.05581 -0.024805,0.05168 -0.027389,0.03101 -0.080615,0.05426 -1.7595826,1.154451 -0.033073,0.03462 -0.023254,0.03824 -0.00155,0.04444 v 0.414445 l 2.1197615,-0.504887 v -0.189136 l 0.044442,0.287321 0.092501,0.329696 0.1173055,0.358634 v 0.03462 l 0.095842,3.97e-4 0.08916,-3.97e-4 v -0.03462 l 0.1173055,-0.358634 0.092501,-0.329696 0.044442,-0.287321 v 0.189136 l 2.1197673,0.504879 v -0.414445 l -0.0015,-0.04444 -0.02325,-0.03824 -0.03256,-0.03462 -1.7600992,-1.154451 -0.080615,-0.05426 -0.027388,-0.03101 -0.024805,-0.05168 -0.013436,-0.05581 0.011369,-0.07752 0.069246,-0.293006 0.083199,-0.379305 0.069246,-0.458886 0.044442,-0.586011 0.0036,-0.254248 V 9.5144673 l 1.073837,-0.015503 0.0021,0.1059367 0.01344,0.092501 0.03824,0.09095 0.01964,0.00155 0.02274,-0.067179 0.02325,-0.1157552 -0.0021,-0.109554 0.252698,-0.00982 v 0.081132 l 0.03256,0.059428 0.02739,-0.055811 0.0036,-0.088883 h 0.31626 l 0.603064,0.1850016 v 0.1353922 l 0.01757,0.094051 0.02894,0.096635 h 0.02687 l 0.0155,-0.046509 0.02325,-0.1095541 V 9.6994689 l 1.302763,0.3932581 v 0.136942 l 0.01705,0.109554 0.02687,0.08113 h 0.02324 l 0.02325,-0.06356 0.01912,-0.100252 v -0.131258 l 1.971973,0.588078 v 0.198437 h 0.04444 V 10.26636 l -0.0098,-0.06201 -0.03101,-0.05581 -0.03256,-0.03256 -0.05788,-0.03462 -4.10931,-2.1259687 v -0.038757 l 0.05788,-0.00982 0.07545,-0.6743774 0.01344,-0.2408122 -0.0098,-0.1968872 -0.02687,-0.1694987 -0.02326,-0.081132 -0.01912,-0.013436 h -0.645956 l -0.01912,0.013436 -0.01344,0.052193 -0.02325,0.1178222 -0.0155,0.1384929 v 0.1601969 l -0.02481,0.061495 0.02481,0.00775 0.0078,0.160197 0.0155,0.1850016 0.0155,0.1560628 0.01137,0.063562 -0.826823,-0.4201293 -0.04806,-0.025321 -0.08475,-0.048059 -0.0677,-0.061495 -0.05581,-0.081132 -0.03462,-0.088367 -0.0098,-0.1064535 V 2.26168 L 10.035051,2.0802958 9.996293,1.8069274 9.9115436,1.4792989 9.8422972,1.2808614 9.7534137,1.0684712 9.6361082,0.83127636 9.4934813,0.61940299 9.3911619,0.5134663 9.3219155,0.46540722 9.2609373,0.45197135 Z","a":[9.26,8.202]},"A3ST":{"d":"M 9.260344,0.567994 9.1606718,0.61299012 9.0340646,0.77112 8.8185739,1.2336241 8.6160022,1.7591734 8.4511544,2.2723203 8.4005115,2.3544859 8.3059437,2.5761778 8.2170602,2.8991554 8.1664173,3.1461688 8.1157744,3.4753477 V 3.6908384 7.0916643 L 7.0579578,7.7060971 7.0832793,7.4720029 H 7.191283 L 7.222806,7.2058692 7.254329,6.9144142 7.27965,6.673602 V 6.4265887 L 7.2605294,6.2431373 7.2228057,6.1289324 7.1530425,6.0467669 H 6.450243 L 6.3996,6.0782899 6.367561,6.1924948 6.34224,6.3888653 6.329838,6.6296774 6.348958,6.9459372 6.374279,7.2565125 6.405802,7.4590842 h 0.1074869 l 0.025322,0.5384684 -4.1227457,2.4003694 -0.082166,0.06925 -0.044442,0.101802 -0.0062,0.183452 V 11.39218 H 2.384343 l 0.012402,-0.06976 0.050643,-0.05684 0.01912,-0.01292 1.2040609,-0.413928 0.046509,0.283704 0.059945,-0.326078 0.7270874,-0.258899 0.032039,0.312125 0.074414,-0.361735 0.5286499,-0.170532 0.049609,0.294556 0.067696,-0.347783 0.7338054,-0.2764689 0.060461,0.3193609 0.067179,-0.3689699 0.3121257,-0.124023 h 0.975651 l 0.063562,0.3544999 0.064079,-0.3513993 h 0.5818766 v 2.0009113 l 0.027905,0.37207 0.032039,0.33693 0.067696,0.372587 0.074414,0.344165 0.074414,0.36897 0.1312582,0.666626 0.2552815,1.326534 -1.9187459,1.383378 -0.014469,-0.156063 -0.01757,-0.152445 -0.021187,-0.06046 -0.032039,0.0072 -0.00723,0.283704 -0.0031,0.312125 0.013953,0.560173 2.2768635,-0.812354 0.1632976,0.798401 0.040925,0.0708 0.043824,-0.0708 0.1632975,-0.798401 2.2768637,0.812354 0.01395,-0.560173 -0.0031,-0.312125 -0.0072,-0.283704 -0.03204,-0.0072 -0.02119,0.06046 -0.01757,0.152445 -0.01447,0.156063 -1.9187458,-1.383378 0.2552816,-1.326534 0.1312582,-0.666626 0.07441,-0.36897 0.07441,-0.344165 0.0677,-0.372587 0.03204,-0.33693 0.02842,-0.37207 V 9.8170793 h 0.58136 l 0.06408,0.3513997 0.06356,-0.3545003 h 0.975651 l 0.312126,0.1240234 0.06718,0.3689699 0.06046,-0.3193609 0.734322,0.2764689 0.06718,0.347783 0.04961,-0.294556 0.52865,0.170532 0.07441,0.361735 0.03204,-0.312125 0.727087,0.258899 0.05994,0.326078 0.04651,-0.283704 1.204061,0.413928 0.01912,0.01292 0.05064,0.05684 0.0124,0.06976 h 0.101286 v -0.639754 l -0.0062,-0.183452 -0.04444,-0.101802 -0.08216,-0.06925 -4.122746,-2.4003698 0.02532,-0.5384684 h 0.107487 l 0.03152,-0.2025717 0.02532,-0.3105753 0.01912,-0.3162598 -0.0124,-0.2408121 -0.02532,-0.1963705 -0.03204,-0.1142049 -0.05064,-0.031523 h -0.7028 l -0.06976,0.082165 -0.03772,0.1142049 -0.01912,0.1834514 v 0.2470133 l 0.02532,0.2408122 0.03152,0.291455 0.03152,0.2661337 h 0.108003 l 0.0253,0.2341051 L 10.40504,7.0916643 V 3.6908384 3.4753477 L 10.354397,3.1461688 10.303754,2.8991554 10.214871,2.5761778 10.120303,2.3544859 10.06966,2.2723203 9.9048124,1.7591734 9.7022408,1.2336241 9.4867501,0.77112 9.3601429,0.61299012 Z","a":[9.26,8.202]},"F70":{"d":"M 9.2686332,0.74930083 9.1106159,0.81645804 8.906494,1.0319487 8.7023721,1.3383899 8.5437255,1.7688546 8.4419229,2.2453113 8.4078164,2.5284982 8.3509724,3.1181262 V 7.1773099 L 8.0336791,7.3602445 6.7159301,7.9901802 3.6024251,9.1518664 1.74104,9.814875 1.6258016,9.9383818 1.5022949,10.148188 l -0.090434,0.26355 -0.057878,0.222209 0.020671,0.08268 3.2246093,-0.271818 0.012402,0.09043 0.040824,0.160713 0.041341,0.04134 0.045475,-0.05374 0.024805,-0.28422 1.5151529,-0.102836 0.016536,0.10697 0.033073,0.156579 0.061495,0.0124 0.049609,-0.164848 0.012402,-0.144177 1.8035074,-0.15658 0.00413,0.239262 0.045475,0.151929 0.078031,0.230993 H 8.231083 L 8.173722,10.671144 V 10.461337 L 8.109643,10.397257 H 7.469372 l -0.048059,0.04857 -0.025322,0.09457 -0.017053,0.06201 -0.037207,0.328145 -0.041341,0.309025 0.033073,0.320911 0.074414,0.473873 0.00413,0.45682 0.00775,0.19792 -0.00775,0.197404 0.082166,0.243396 0.033073,0.0615 0.082166,-0.0739 0.078548,0.0041 0.044958,0.06149 0.07028,-0.06149 0.090434,0.0041 0.041341,0.06976 0.069763,-0.0739 v 0.09457 l 0.07028,0.06976 0.061495,0.0083 0.049609,-0.04909 0.057361,-0.181385 0.4325317,0.317294 0.1483114,0.646472 0.094568,0.567924 0.00827,0.321427 0.049609,0.202055 0.1276408,0.156063 v 0.202055 l -2.4871866,1.499133 -0.074414,0.06976 -0.057361,0.115239 -0.045475,0.206189 -0.00827,0.382922 0.2015381,-0.04547 2.4711669,-0.609265 0.012402,0.111104 0.053227,0.148311 0.095579,0.08783 0.084771,-0.08783 0.053743,-0.148311 0.012402,-0.111104 2.4706507,0.609265 0.202055,0.04547 -0.0083,-0.382922 -0.04548,-0.206189 -0.05736,-0.115239 -0.07441,-0.06976 -2.4871867,-1.499133 v -0.202055 l 0.1276408,-0.156063 0.049093,-0.202055 0.00827,-0.321427 0.095085,-0.567924 0.1483114,-0.646472 0.4320145,-0.317294 0.05788,0.181385 0.04961,0.04909 0.06149,-0.0083 0.07028,-0.06976 v -0.09457 l 0.06976,0.0739 0.04134,-0.06976 0.09043,-0.0041 0.07028,0.06149 0.04496,-0.06149 0.07855,-0.0041 0.08216,0.0739 0.03307,-0.0615 0.08217,-0.243396 -0.0083,-0.197404 0.0083,-0.19792 0.0041,-0.45682 0.07441,-0.473873 0.03256,-0.320911 -0.04082,-0.309025 -0.03772,-0.328145 -0.01654,-0.06201 -0.02532,-0.09457 -0.04806,-0.04857 H 10.41072 l -0.06356,0.06408 v 0.209807 l -0.05788,0.05788 h -0.152446 l 0.07855,-0.230993 0.04496,-0.151929 0.0041,-0.239262 1.804024,0.15658 0.0124,0.144177 0.04909,0.164848 0.06201,-0.0124 0.03307,-0.156579 0.01654,-0.10697 1.515153,0.102836 0.02481,0.28422 0.04547,0.05374 0.04082,-0.04134 0.04134,-0.160713 0.0124,-0.09043 3.224609,0.271818 0.02067,-0.08268 -0.05788,-0.222209 -0.09043,-0.26355 L 16.895154,9.9383818 16.779399,9.814875 14.918014,9.1518664 11.805025,7.9901802 10.487276,7.3602445 10.169983,7.1773099 V 3.1181262 L 10.113139,2.5284982 10.079033,2.2453113 9.9772297,1.7688546 9.818583,1.3383899 9.6144611,1.0319487 9.4103392,0.81645804 Z","a":[9.26,8.467]},"B738":{"d":"M 9.2601391,0.36385898 C 9.1070918,0.36529335 8.9583351,0.72716831 8.8610712,1.0489973 8.7123145,1.4666598 8.4413469,2.4229141 8.4205231,3.8882445 V 6.7533689 L 7.6004255,7.4391741 c 0.034188,-0.287757 0.016339,-0.9097883 -0.00855,-1.0541583 -0.00569,-0.042736 -0.034171,-0.097274 -0.085473,-0.099718 h -0.678078 c -0.054133,0.00285 -0.076925,0.054133 -0.082623,0.099718 -0.028491,0.1538498 -0.05983,0.8746665 0.031339,1.4302362 H 6.908098 c 0,0 0.00285,0.037038 0.019944,0.06553 0,0 -0.1225102,0.079774 -0.2535677,0.1538498 -0.9515915,0.5099846 -1.826258,0.8575723 -4.937449,2.3590362 -0.094015,0.04274 -0.1339068,0.07123 -0.1339068,0.142454 v 0.762846 c -0.00152,0.02295 0.020349,0.02812 0.022938,0.0023 0.011661,-0.117437 0.00128,-0.243908 0.1497,-0.277462 l 3.3238091,-0.743707 c 0,0.151797 0.04563,0.408852 0.093037,0.421113 0.04407,-0.0073 0.095486,-0.320732 0.08814,-0.465183 L 6.5244968,9.9569187 c 0.00735,0.1566933 0.041676,0.4268813 0.08814,0.4235613 0.034277,-0.0024 0.095486,-0.306042 0.090589,-0.4578373 l 0.3696984,-0.08814 h 0.1346584 c -0.00735,0.1885223 0.061209,0.4578373 0.090589,0.4578373 0.02938,0 0.095486,-0.271764 0.08814,-0.4578373 h 1.0307493 v 3.3738003 c 0.019585,0.927919 0.1587918,1.595381 0.4504939,2.85231 l -2.6980681,1.486139 c -0.04407,0.02448 -0.071002,0.03917 -0.071002,0.05631 V 18.12211 L 9.17849,17.492886 c 0.0049,0.05142 0.039173,0.168935 0.048967,0.17628 v 0.09793 h 0.061209 v -0.09927 c 0.010041,-0.0093 0.0501,-0.122537 0.062117,-0.171608 l 3.078376,0.630897 V 17.6275 c -3.5e-5,-0.03011 -0.0064,-0.04279 -0.03966,-0.06498 L 9.6588579,16.05695 C 9.9442315,14.790218 10.095423,14.161381 10.096268,13.232805 V 9.8346243 h 1.037752 c 0,0.2548467 0.06739,0.4558127 0.09117,0.4558457 0.03145,1.13e-4 0.088,-0.191678 0.08554,-0.4547607 h 0.137689 l 0.373725,0.0836 c 0,0.1598147 0.06585,0.4579167 0.08851,0.4573207 0.03688,-0.0074 0.08851,-0.253248 0.08605,-0.4179817 l 1.24657,0.2778347 c -0.0073,0.201615 0.05901,0.449945 0.08605,0.457322 0.03443,-0.01721 0.09835,-0.208992 0.09097,-0.417983 l 3.365987,0.759745 c 0.08724,0.02605 0.108184,0.108183 0.118019,0.272918 -7.5e-4,0.01666 0.01345,0.0143 0.01345,-0.0022 v -0.739781 c 0.0012,-0.0709 -0.01654,-0.111081 -0.06617,-0.141806 C 14.55286,9.3146635 12.501776,8.3948688 11.850699,8.0333072 L 11.599635,7.8831784 c 0.01558,-0.021781 0.01352,-0.044524 0.01352,-0.067266 h 0.134386 c 0.09846,-0.7198642 0.0728,-1.1896169 0.03101,-1.4327633 -0.0095,-0.056952 -0.03435,-0.091736 -0.07658,-0.094221 h -0.685753 c -0.0546,-2.263e-4 -0.07848,0.046006 -0.08219,0.094812 -0.04071,0.4563206 -0.04105,0.7139057 -0.01365,1.0455093 L 10.098502,6.7354296 V 3.9098678 c 0,-1.5288612 -0.3092501,-2.4381865 -0.4362051,-2.8646247 C 9.5483629,0.67739921 9.4146301,0.36282461 9.2601391,0.36385898 Z","a":[9.26,8.202]},"C172":{"d":"m 7.8815231,5.9575406 1.2311014,-0.030932 0.2103388,-0.00619 1.1754237,0.049492 -1.1754237,0.030932 H 9.0755059 Z m 9.2064388,5.6983137 -0.029735,0.01461 -0.02119,0.040214 -0.045992,0.1142049 -0.015503,0.107487 -0.00465,0.1121379 -0.2635498,0.00465 -0.083199,0.023771 -0.083716,0.050643 -0.05271,0.081132 -0.1054199,1.262972 -0.076481,0.9131225 -3.0566609,0.01757 -4.189925,0.2284098 -0.076998,0.011369 -0.061495,0.045992 -0.0676961,0.1054199 -0.0614949,0.1514119 -0.0289388,0.1209229 -0.01757,0.1054199 -0.043925,0.010852 -0.01757,0.028422 0.006718,0.045992 0.0222209,0.043925 0.0325562,0.039791 0.0155029,0.1581299 0.0330729,0.188619 0.0392741,0.1777669 0.0552938,0.1912028 0.065629,0.195337 0.03514,0.04186 0.05271,0.03514 0.05271,0.01344 4.1346313,0.544153 H 8.404138 l 0.037724,0.05529 0.074414,0.623218 0.08785,0.766362 0.3358968,2.887679 -2.0158976,0.428397 -0.074414,0.0155 -0.054777,0.03721 -0.043925,0.06821 -0.028939,0.07906 -0.010852,0.09198 v 0.0925 l 0.00672,0.08113 0.028422,0.177767 0.033073,0.188619 0.065629,0.241845 0.028939,0.07028 0.026355,0.03307 0.030489,0.0062 1.9239135,0.276986 0.2392619,-0.634586 0.00672,-0.156063 h 0.050126 l 0.063045,0.783931 0.05271,-0.783931 h 0.050643 l 0.00672,0.156063 0.2392619,0.634586 1.9233965,-0.276986 0.03101,-0.0062 0.02636,-0.03307 0.02842,-0.07028 0.06563,-0.241845 0.03307,-0.188619 0.02842,-0.177767 0.0067,-0.08113 v -0.0925 l -0.01085,-0.09198 -0.02842,-0.07906 -0.04392,-0.06821 -0.05529,-0.03721 -0.07441,-0.0155 -2.0158974,-0.428397 0.3358968,-2.887679 0.08785,-0.766362 0.074931,-0.623218 0.037207,-0.05529 h 3.056661 l 4.134631,-0.544153 0.05271,-0.01344 0.05271,-0.03514 0.03514,-0.04186 0.06615,-0.195337 0.05478,-0.1912028 0.03979,-0.1777669 0.03256,-0.188619 0.0155,-0.1581299 0.03307,-0.039791 0.0217,-0.043925 0.0067,-0.045992 -0.01757,-0.028422 -0.04393,-0.010852 -0.01757,-0.1054199 -0.02842,-0.1209229 -0.06149,-0.1514119 -0.06821,-0.1054199 -0.0615,-0.045992 -0.077,-0.011369 L 13.050366,8.4408283 9.9937051,8.4232583 9.9167072,7.5101358 9.8112873,6.2471638 9.7585773,6.1660318 9.6753782,6.1153889 9.5916624,6.0916177 9.3281126,6.0869669 9.3239785,5.974829 9.3084756,5.867342 9.2624836,5.7531371 9.2380082,5.7128769 Z","a":[9.26,9.525]},"A320":{"d":"M 9.2643526,0.39665685 C 9.0686137,0.40424941 8.9195628,0.66314961 8.8303628,0.84154842 L 8.6926374,1.1359184 C 8.4559151,1.6676829 8.436692,1.883928 8.4078845,2.0502103 c -0.045075,0.255357 -0.089985,0.6321698 -0.083189,0.956747 v 2.7617468 c -0.036457,0.1500962 -0.040747,0.3838144 -0.040747,0.3838144 -0.0086,0.158672 0.00215,0.3194876 -0.1393742,0.3923915 L 7.0510257,7.1088378 C 7.0767517,6.94159 7.0939107,6.8643976 7.0939107,6.4784396 h 0.055755 c 0,-0.1265048 0.010756,-0.1994125 -0.068612,-0.283037 -0.00645,-0.1586707 -0.010756,-0.3280634 -0.081481,-0.4095443 -0.075052,-0.036457 -0.7526182,-0.045024 -0.8298106,0 -0.07504,0.060032 -0.081481,0.2615943 -0.092199,0.3730937 -0.021449,0.2208538 -0.034306,0.4481398 -0.012869,0.6475523 0.012869,0.1350857 0.055755,0.4481399 0.081481,0.5424851 0.00683,0.0256 0.012869,0.031737 0.024018,0.033445 l 0.1003484,0.00595 0.017159,0.1097885 -4.7241306,2.4323975 C 1.2273588,10.133842 1.232504,10.603855 1.232504,10.803696 l -0.012022,0.169821 c -0.00177,0.02059 0.018007,0.0223 0.019728,0.0018 L 1.2454,10.802924 3.5345627,10.135642 v 0.02488 l 0.020589,-0.0059 c 0.024018,0.379955 0.060892,0.379955 0.060892,0.379955 0,0 0.041164,0.0025 0.059184,-0.41512 l 0.026587,-0.0086 v -0.02145 L 5.2782388,9.6279726 c 0,0.03773 0.035166,0.3199165 0.066043,0.3216305 0.02231,0.0018 0.077191,-0.2693121 0.066903,-0.3567966 L 6.2602932,9.3423631 6.507306,9.3389431 c -0.00177,0.037748 0.048036,0.2109911 0.063474,0.2127057 0.020588,0 0.061753,-0.1663911 0.061753,-0.2092752 h 0.2607363 c 0.00342,0.1063466 0.041164,0.3190587 0.065182,0.3190587 0.024018,0.0018 0.070333,-0.2315746 0.066903,-0.3173427 H 8.318743 V 13.39065 c -0.00519,0.231668 0.1064984,1.231411 0.2960582,2.062365 0.012983,0.07531 -0.051933,0.236304 -0.184369,0.334979 l -1.9813828,1.212613 c -0.1194564,0.07531 -0.129838,0.119444 -0.1558046,0.303818 v 0.412882 l 2.5915418,-0.573879 c 0.093477,0.56349 0.2311101,0.984161 0.2804492,0.984161 h 0.1817711 c 0.054527,0 0.2051448,-0.436251 0.2882404,-0.986759 l 2.5915437,0.576477 v -0.363543 c -0.01817,-0.202547 -0.03117,-0.275256 -0.163595,-0.355754 l -1.97352,-1.204964 C 9.9650314,15.709945 9.8897271,15.517792 9.9027104,15.460663 10.092273,14.614135 10.196142,13.549475 10.196142,13.349526 V 9.340173 h 1.293176 c 0,0.1142555 0.04154,0.3168023 0.06492,0.3168023 0.03376,0 0.06751,-0.1999489 0.06751,-0.3168023 h 0.257078 c 0.0078,0.064916 0.04675,0.2103356 0.06492,0.2103356 0.02597,0 0.05741,-0.1415394 0.06779,-0.209055 h 0.24641 l 0.841343,0.2454095 c 0,0.1194559 0.04934,0.360946 0.07012,0.360946 0.02597,0 0.07012,-0.2233191 0.07012,-0.3219935 l 1.57362,0.4596214 v 0.02418 l 0.02394,0.0062 v 0 c 0.0018,0.116648 0.0326,0.415121 0.06004,0.415121 0.02573,0 0.06518,-0.25559 0.06518,-0.377383 l 0.01716,0.0052 v -0.02573 l 2.286589,0.665563 0.0068,0.176683 c -1.76e-4,0.01704 0.02762,0.01704 0.02762,-0.0011 l -0.0081,-0.181995 v -0.154845 c 0,-0.168309 -0.08864,-0.559908 -0.337738,-0.7080216 L 12.23312,7.49065 12.2495,7.3901117 c 0.100095,-0.00886 0.116597,0.00329 0.12429,-0.034103 C 12.45518,6.9413178 12.46646,6.7102861 12.46289,6.538727 12.45519,6.1680339 12.42204,5.7778594 12.307139,5.766544 11.995846,5.742336 11.90307,5.744538 11.531877,5.781919 c -0.04573,0.0043 -0.0909,0.1664114 -0.09859,0.4282069 -0.03878,0.037963 -0.06368,0.066245 -0.06481,0.1149008 v 0.1516312 h 0.05092 c 0,0.2470545 0.0085,0.3455883 0.04187,0.6271928 L 10.3512,6.5339185 C 10.285309,6.4969553 10.246751,6.4085778 10.245144,6.320189 l -0.01607,-0.3326468 c -0.0065,-0.03857 -0.02089,-0.2169437 -0.03375,-0.2330134 V 2.9993976 c 0,-0.3415314 -0.03443,-0.6984453 -0.08366,-0.9507476 C 10.081714,1.8916357 10.065339,1.6654392 9.8101355,1.1040576 L 9.6901349,0.84560282 C 9.5907989,0.66001261 9.4665085,0.40175525 9.2643046,0.39660876 Z","a":[9.26,7.673]},"F28":{"d":"M 9.2635157,0.90506203 9.1133479,0.94009103 8.9573814,1.0648575 8.8263683,1.2769726 8.6204931,1.7074418 8.4832425,2.0879999 8.3522309,2.6058071 8.2711289,3.0736656 8.2399351,3.6912935 8.233696,6.2990513 8.0777293,6.4362959 6.3870536,7.3783332 3.3488694,8.4700542 2.0699449,8.9317158 1.9826038,8.9753893 1.9389333,9.118873 v 0.3493642 l 0.018716,0.1559664 0.04991,0.1497228 0.068625,0.1185424 1.0730492,-0.087347 2.7449669,-0.2245917 2.1398596,-0.1996369 0.1684438,0.2121135 0.00624,0.3431265 -0.1746825,0.0062 V 9.8050526 l -0.062386,-0.043674 -0.074863,-0.049913 -0.4678997,0.00616 -0.087341,0.043674 -0.031194,0.081108 v 1.1978244 l 0.043671,0.386797 0.1372507,0.711205 0.012478,0.212112 0.043671,0.08735 0.1310116,0.0312 h 0.1372507 l 0.099818,-0.02496 0.031194,-0.07487 0.012478,-0.205872 0.6113882,0.44918 0.2682624,1.540906 0.1622053,0.804789 0.087341,0.230831 -0.00624,0.124766 -2.3519736,1.360029 -0.1310116,0.118527 -0.04991,0.193398 0.00624,0.386797 0.04991,0.243309 0.1622053,-0.0063 2.3644505,-0.517808 0.037433,0.180922 0.043671,0.162204 0.046897,0.09545 0.047645,-0.09545 0.043671,-0.162204 0.037433,-0.180922 2.3644499,0.517808 0.162204,0.0063 0.04991,-0.243309 0.0062,-0.386797 -0.04991,-0.193398 -0.131005,-0.118527 -2.3519741,-1.360029 -0.00624,-0.124766 0.087341,-0.230831 0.1622058,-0.804789 0.2682625,-1.540906 0.6113878,-0.44918 0.01248,0.205872 0.03119,0.07487 0.09982,0.02496 h 0.137252 l 0.131006,-0.0312 0.04367,-0.08735 0.01248,-0.212112 0.137244,-0.711205 0.04367,-0.386797 V 9.8424119 l -0.0312,-0.081108 -0.08735,-0.043674 -0.467899,-0.00616 -0.07486,0.049913 -0.06239,0.043674 v 0.1372443 l -0.174682,-0.0062 0.0062,-0.3431262 0.168444,-0.2121135 2.139859,0.1996369 2.744967,0.2245917 1.073049,0.087347 0.06863,-0.1185424 0.04991,-0.1497228 0.01872,-0.1559664 V 9.118873 L 16.5382,8.9753893 16.450853,8.9317158 15.171928,8.4700542 12.133824,7.3783393 10.443148,6.4363019 10.287181,6.2990513 10.280942,3.6912935 10.249748,3.0736656 10.168645,2.6058071 10.037634,2.0879999 9.9003836,1.7074418 9.6945079,1.2769726 9.5634958,1.0648575 9.4075292,0.94008653 Z","a":[9.26,7.673]},"A158":{"d":"M 9.2385517,0.28443908 9.1377826,0.33869933 9.0235777,0.50044657 8.8075702,0.95054829 8.5316181,1.6404286 8.3879576,2.168045 8.2980406,3.0021026 8.2799538,3.2661692 V 5.5874745 L 8.1900368,5.6773915 7.2660622,6.1812367 7.3079201,5.965746 7.3260069,5.3657826 7.3502948,4.3999501 7.3260069,4.2976308 7.2598611,4.2195994 H 6.3963479 l -0.05426,0.030489 -0.059945,0.07183 -0.018087,0.078031 -0.011886,1.1694377 0.024288,0.5400187 0.01757,0.2278931 0.096118,0.3121256 L 0.94241638,9.617202 0.86645198,9.698334 0.79307148,9.797553 0.73054298,9.9556829 0.67886658,10.158255 0.64579368,10.475032 3.361391,9.7376088 3.4146177,9.8786855 3.4781797,9.7035024 5.4129454,9.149531 5.4418842,9.3195465 5.5147479,9.1154246 6.6816018,8.7945139 6.7105406,8.9645294 6.7932229,8.750589 7.6148781,8.5273468 l 0.058394,0.1746663 0.053227,-0.2139404 0.4376994,-0.1069702 0.024288,0.6418213 0.082682,0.4423502 0.043925,1.837614 0.043408,0.666109 0.097152,0.748275 0.3405477,1.988509 0.1069702,0.505396 0.082682,0.228409 -2.3672974,1.754932 -0.082682,0.08268 -0.043925,0.0925 -0.00465,0.607715 2.6153442,-0.908988 0.028939,0.500744 0.058394,0.33538 0.068213,0.155546 0.072347,-0.155546 0.058394,-0.33538 0.028939,-0.500744 2.6153438,0.908988 -0.0052,-0.607715 -0.04341,-0.0925 -0.08268,-0.08268 -2.3672971,-1.754932 0.082682,-0.228409 0.1069702,-0.505396 0.3400309,-1.988509 0.09715,-0.748275 0.04392,-0.666109 0.04341,-1.837614 0.08268,-0.4423502 0.02429,-0.6418213 0.437699,0.1069702 0.05374,0.2139404 0.05788,-0.1746663 0.821656,0.2232422 0.08268,0.2139404 0.02946,-0.1700155 1.166337,0.3209107 0.07286,0.2041219 0.02946,-0.1700155 1.934766,0.5539714 0.06305,0.1751831 0.05323,-0.1410767 2.716113,0.7374232 -0.03359,-0.316777 -0.05116,-0.2025716 -0.06253,-0.1581299 -0.0739,-0.099219 -0.07597,-0.081132 -5.447729,-2.9677775 0.09612,-0.3121256 0.01809,-0.2278931 0.02377,-0.5400187 -0.01189,-1.1694377 -0.01809,-0.078031 -0.05995,-0.07183 -0.05374,-0.030489 h -0.86403 l -0.06615,0.078031 -0.02377,0.1023193 0.02377,0.9658325 0.01809,0.5999634 0.04186,0.2154907 -0.923457,-0.5038452 -0.08992,-0.089917 V 3.2661692 L 10.222471,3.0021026 10.132554,2.168045 9.9883771,1.6404286 9.7124245,0.95054829 9.496417,0.50044657 9.3827289,0.33869933 Z","a":[9.26,6.879]},"B350":{"d":"M 5.7342805,4.3346881 H 7.7642678 m 10.822268,4.3346881 h 2.029988 M 9.287805,2.8819946 9.1916868,2.905249 9.1529295,2.9259195 9.0650796,3.0576944 8.9643105,3.277836 8.8842121,3.5005615 8.8066974,3.7563598 8.728666,4.0772704 8.6744058,4.385262 8.6408161,4.6152221 8.5917235,5.0575723 8.5271279,5.7433186 V 6.5866779 L 7.1401325,6.6512735 7.1375487,6.2218423 7.1323811,5.766573 7.1194619,5.3164713 h 0.243396 V 4.8482828 L 7.3447712,4.8121093 7.3137653,4.7707681 7.2724242,4.7423461 7.2104125,4.7190917 7.1556355,4.7061726 H 7.0703693 L 7.0496988,4.602303 7.0290282,4.4963663 7.0006062,4.4059325 6.8326578,4.0488484 l -0.059428,-0.036173 -0.07028,-0.00775 -0.049093,0.031006 -0.1369425,0.3932576 -0.074931,0.2299602 -0.1658813,0.010335 -0.051676,0.023254 -0.051677,0.065112 -0.03359,0.074931 0.00775,0.4811075 0.2356445,-0.00258 -0.012919,0.4242635 -0.00258,0.4940267 0.00258,0.171049 0.00258,0.098185 -0.6986654,0.3389974 -4.1909586,0.2273763 -0.077515,0.00517 -0.062528,0.00775 -0.05426,0.025838 -0.046509,0.046509 -0.023254,0.049609 -0.015503,0.064596 v 0.7110677 l 5.0394856,0.7839315 h 2.085144 l 0.044442,0.045992 0.050643,0.05581 0.053227,0.074931 0.05116,0.090434 0.028939,0.640271 0.026872,0.3865402 0.050643,0.560172 0.05581,0.50953 0.1999878,1.642794 0.1043864,0.786515 0.058394,0.3545 0.050643,0.205672 -2.4318929,0.874366 -0.045475,0.04547 -0.037207,0.06925 -0.01602,0.06408 v 0.632003 l 2.5709025,-0.229444 0.01602,0.13901 0.031523,0.146244 0.03514,0.0987 0.037207,0.0615 0.03359,0.001 v 0.0016 l 0.00672,-0.001 h 0.00103 l 0.00827,-0.0016 0.037207,-0.0615 0.034623,-0.0987 0.032039,-0.146244 0.01602,-0.13901 2.5709021,0.229444 v -0.632003 l -0.01602,-0.06408 -0.03772,-0.06925 -0.04496,-0.04547 -2.4324092,-0.874366 0.050643,-0.205672 0.058911,-0.3545 0.1038696,-0.786515 0.1999878,-1.642794 0.055811,-0.50953 0.05116,-0.560172 0.026355,-0.3865402 0.02946,-0.640271 0.05064,-0.090434 0.05323,-0.074931 0.05064,-0.05581 0.04444,-0.045992 H 12.33258 L 17.372066,7.9757404 V 7.2646727 l -0.0155,-0.064596 -0.02325,-0.049609 -0.04651,-0.046509 -0.05426,-0.025838 -0.06201,-0.00775 -0.07752,-0.00517 -4.191475,-0.2273763 -0.698149,-0.3389974 0.0026,-0.098185 0.0026,-0.171049 -0.0026,-0.4940267 -0.01292,-0.4242635 0.235128,0.00258 0.0078,-0.4811075 -0.03359,-0.074931 -0.05168,-0.065112 -0.05168,-0.023254 -0.165365,-0.010335 -0.07545,-0.2299602 -0.136942,-0.3932576 -0.04909,-0.031006 -0.06976,0.00775 -0.05943,0.036173 -0.168465,0.3570841 -0.02842,0.090434 -0.02067,0.1059367 -0.02067,0.1038696 h -0.08527 l -0.05426,0.012919 -0.06201,0.023254 -0.04134,0.028422 -0.03152,0.041341 -0.01809,0.036173 v 0.4681885 h 0.243396 l -0.01292,0.4501017 -0.0052,0.4552693 -0.0026,0.4294312 -1.386479,-0.064596 V 5.7433186 L 9.9833698,5.0575723 9.9342772,4.6152221 9.9006875,4.385262 9.8464272,4.0772704 9.7689126,3.7563598 9.6913979,3.5005615 9.6107827,3.277836 9.5100137,3.0576944 9.4221637,2.9259195 9.3834064,2.905249 Z","a":[9.26,7.408]},"PC12":{"d":"M 9.245171,2.0984895 C 9.1056137,2.097774 9.0234037,2.5268618 9.010125,2.54942 8.808202,2.4455449 8.5835447,2.4569685 8.5835447,2.4569685 c -0.3579108,0 -0.4924006,0.131663 -0.4924006,0.131663 l -0.01007,0.098045 0.7499436,-0.020286 0.1571422,0.020679 -0.022595,0.093186 c -0.041015,0.036103 -0.106246,0.28426 -0.106246,0.28426 -0.2124755,-0.023766 -0.3726222,0.2923262 -0.3726222,0.2923262 0.069013,0.073941 0.081621,0.1418995 0.081621,0.1418995 0.017765,0.064715 0.012525,0.1202361 0.012525,0.1202361 C 8.6627667,3.4371739 8.7821194,3.3388919 8.7821194,3.3388919 8.5135573,4.4358041 8.4997219,4.7209534 8.4997219,4.7209534 L 8.3862717,5.6183308 8.3830017,6.9675149 1.8329762,7.2476923 1.7291617,7.3032673 1.5947865,7.5089063 1.2380791,8.2383551 1.2148291,8.4185773 1.2465931,8.64239 1.4713978,8.476654 1.6814992,8.397968 l 0.1135239,0.01205 1.7832097,0.1234229 0.7377374,0.072853 0.02939,0.1258328 0.033483,-0.1143098 1.7448226,0.1963416 0.039214,0.1162851 0.029308,-0.1160877 2.0416371,0.2445083 0.091878,0.070475 0.065821,0.2214224 -0.00491,1.4059114 c 0.1345143,1.173102 0.2428725,1.611991 0.2428725,1.611991 l 0.1064588,1.081332 0.1029222,0.155069 0.2624712,1.032265 -2.1991148,0.276094 -0.1393691,0.25538 -0.1261067,0.366042 0.024806,0.262003 2.4626176,0.129441 c 0.032501,0.277636 0.1143753,0.433786 0.1143753,0.433786 0.096766,-0.200342 0.1022591,-0.427346 0.1022591,-0.427346 l 2.4736948,-0.133012 0.02481,-0.251585 -0.126164,-0.37933 -0.139353,-0.255405 -2.1987873,-0.276069 c 0.1094878,-0.433647 0.2516649,-1.030671 0.2516649,-1.030671 l 0.1122795,-0.157386 0.1028812,-1.080609 c 0.1501672,-0.790636 0.2391317,-1.65308 0.2391317,-1.65308 l -9e-5,-1.3934719 0.05043,-0.2028274 0.109004,-0.060401 2.039132,-0.2397212 0.04396,0.1112809 0.01965,-0.1160876 1.752666,-0.1945373 0.03054,0.1365 0.05182,-0.1406483 0.705171,-0.086845 1.79594,-0.1187808 0.182791,-0.00724 0.200392,0.08718 0.23742,0.1548253 0.0065,-0.4094343 L 16.94152,7.491571 C 16.83078,7.2861358 16.681014,7.2464078 16.592917,7.2447616 L 10.224013,6.9865573 10.083686,6.9553328 10.066412,5.6256591 9.9639645,4.6467439 C 9.8390285,3.867985 9.6844487,3.3574665 9.6844487,3.3574665 9.8201829,3.473665 9.9097691,3.6188318 9.9097691,3.6188318 9.8563105,3.4326639 9.9816476,3.3612397 9.9816476,3.3612397 9.8145669,3.0398977 9.618964,3.0744583 9.618964,3.0744583 9.5598566,2.7789156 9.4923906,2.7553193 9.4923906,2.7553193 l 0.02677,-0.061711 c 0.064347,0.035997 0.097617,-0.011764 0.097617,-0.011764 0.1577644,-0.075268 0.8291734,0.00483 0.8291734,0.00483 l -0.01007,-0.098046 C 10.373828,2.4647319 9.9598467,2.4560475 9.9598467,2.4560475 9.6993156,2.4531822 9.4518341,2.559492 9.4518341,2.559492 9.3751255,2.0638003 9.2456622,2.098487 9.2456622,2.098487 Z","a":[9.26,7.937]},"PA44":{"d":"M 5.2241163,5.8624895 H 7.714142 m 10.723218,5.8624895 h 2.490026 M 9.227475,4.2286934 9.170499,4.2369534 9.122957,4.2643414 9.0475096,4.3671752 8.8924803,4.630725 8.7777586,4.9190795 8.6568358,5.3025186 8.5875894,5.558317 8.4992227,5.9939493 8.456848,6.2988402 8.4237751,6.5773762 8.3881183,7.1344481 7.3623412,7.5277058 7.0770873,7.5344237 7.0341958,7.4853311 7.0409138,7.0068073 7.0310953,6.7380899 7.0047403,6.5608397 6.9752847,6.4331989 6.939628,6.3742878 6.8838174,6.3086587 6.7690957,6.2368285 6.6709105,6.1743 6.634737,6.1319253 6.6151,6.0859333 6.6052815,5.9743122 6.569108,5.8399535 6.5179248,5.7331165 6.4801775,5.6895755 6.444568,5.7350505 6.395475,5.8337525 6.346382,5.9810304 6.326745,6.0859335 l -0.016536,0.045992 -0.026355,0.035657 -0.06873,0.033073 -0.1116211,0.065629 -0.062012,0.042375 -0.055811,0.082166 -0.026355,0.081649 -0.019637,0.1508952 -0.01602,0.2588989 v 0.550354 l -0.00258,0.062528 -0.031006,0.035657 -0.5007446,0.00775 -0.2878377,0.027905 -3.9697835,0.4092773 -0.038757,0.017053 -0.03514,0.027905 -0.024288,0.048576 -0.0093,1.2469522 0.014986,0.039274 0.029972,0.03359 0.03359,0.024288 0.7379395,0.072864 3.6617919,0.3240112 0.070797,-0.00568 0.5053955,0.00568 0.048576,0.1043864 0.057361,0.095085 0.089917,0.09715 0.1136881,0.08578 0.081649,0.02222 0.1085205,-0.0186 0.083716,-0.05013 0.085783,-0.07286 0.067179,-0.08785 0.05426,-0.096635 0.027905,-0.072864 h 1.5564941 l 0.011369,0.1994713 0.016536,0.225826 0.040824,0.415479 0.039274,0.380338 0.050643,0.445968 0.096635,0.822172 0.097152,0.680062 0.2682006,1.763716 -0.044442,0.04496 -1.670699,0.0072 -0.1080038,0.0057 -0.052193,0.04134 -0.044958,0.0615 -0.024288,0.08733 -0.00155,0.205156 0.016536,0.09147 0.032039,0.150895 0.057361,0.222209 0.024288,0.05013 0.039274,0.03927 0.067179,0.0036 1.8410212,0.01085 1.8817493,-0.01085 0.06718,-0.0036 0.03876,-0.03927 0.02429,-0.05013 0.05788,-0.222209 0.03152,-0.150895 0.01705,-0.09147 -0.0021,-0.205156 -0.02429,-0.08733 -0.04444,-0.0615 -0.05219,-0.04134 -0.10852,-0.0057 -1.670183,-0.0072 -0.044958,-0.04496 0.2687174,-1.763716 0.096635,-0.680062 0.097152,-0.822172 0.050126,-0.445968 0.039274,-0.380338 0.041341,-0.415479 0.016537,-0.225826 0.011369,-0.1994713 h 1.5564946 l 0.0279,0.072864 0.05426,0.096635 0.06718,0.08785 0.08578,0.07286 0.08371,0.05013 0.108004,0.0186 0.08217,-0.02222 0.113688,-0.08578 0.0894,-0.09715 0.05788,-0.095085 0.04857,-0.1043864 0.505396,-0.00568 0.0708,0.00568 3.661275,-0.3240112 0.738456,-0.072864 0.03359,-0.024288 0.02997,-0.03359 0.01499,-0.039274 -0.0093,-1.2469522 -0.02429,-0.048576 -0.03566,-0.027905 -0.03824,-0.017053 -3.9703,-0.4092773 -0.287838,-0.027905 -0.500744,-0.00775 -0.03101,-0.035657 -0.0021,-0.062528 v -0.550354 l -0.01654,-0.2588989 -0.01964,-0.1508952 -0.02636,-0.081649 -0.05529,-0.082166 -0.06253,-0.042375 L 12.2369,6.2006555 12.16817,6.1675825 12.14233,6.1319255 12.12579,6.0859335 12.10615,5.9810304 12.05706,5.8337525 12.00797,5.7350505 11.9679,5.6895755 l -0.03899,0.043911 -0.04547,0.1064674 -0.03617,0.1343587 -0.0098,0.1116211 -0.01964,0.045992 -0.03617,0.042375 -0.09819,0.062528 -0.114721,0.07183 -0.05581,0.065629 -0.03617,0.058911 -0.02946,0.1276408 -0.02635,0.1772502 -0.0098,0.2687174 0.0067,0.4785238 -0.04237,0.049093 -0.285254,-0.00672 L 10.064502,7.1344481 10.028328,6.5773762 9.9957721,6.2988402 9.9528807,5.9939493 9.864514,5.558317 9.7957843,5.3025186 9.6743447,4.9190795 9.559623,4.630725 9.4051105,4.3671752 9.3296629,4.2643391 9.2816038,4.2369506 Z","a":[9.26,7.673]},"A21N":{"d":"m 9.2526653,0.39729021 -0.032556,0.001033 v 0 L 9.187036,0.41744392 9.141044,0.45155042 9.102287,0.48772392 9.052678,0.53785002 9.006169,0.59159352 8.963278,0.64998792 8.918836,0.71871762 8.881629,0.78589702 8.805147,0.93575863 8.754504,1.0416953 8.709546,1.1522829 8.654252,1.2959434 8.601025,1.452523 8.559167,1.606002 8.528161,1.7460451 8.496122,1.9403485 8.484237,2.0881431 8.480617,2.3310223 v 4.4772461 l -0.00517,0.063045 -0.01757,0.075964 -0.03669,0.068213 -0.042891,0.058394 -0.059428,0.062012 -0.058911,0.037724 -0.085783,0.042891 -0.825787,0.4237468 0.00258,-0.088367 0.013953,-0.096118 0.011369,-0.1121379 0.00878,-0.1369425 0.00568,-0.118339 V 6.8811322 L 7.3881796,6.765377 7.3752605,6.6713259 7.3520061,6.5710736 7.3406373,6.5292157 7.3163494,6.5090619 H 6.6796958 l -0.025322,0.015503 -0.016536,0.040824 -0.011885,0.065112 -0.018087,0.1012858 -0.00982,0.107487 -0.00207,0.1917195 0.0031,0.1281576 0.00878,0.1214396 0.022221,0.2253092 0.023254,0.1994711 0.042891,0.2682007 -4.1010417,2.1166666 -0.043925,0.03101 -0.031006,0.02946 -0.033073,0.04754 -0.020671,0.05323 v 0.671794 h 0.040824 v -0.192753 l 1.9895427,-0.599447 -0.00207,0.110587 0.00982,0.08475 0.021187,0.05839 0.021704,0.04547 h 0.015503 l 0.013436,-0.03772 0.019637,-0.06718 0.013436,-0.08061 0.0031,-0.05064 v -0.09819 l 1.3043131,-0.3896399 -0.00207,0.1069702 0.011369,0.069763 0.016536,0.066146 0.01757,0.054777 h 0.023254 l 0.01757,-0.045992 0.018604,-0.07183 0.013436,-0.082682 V 9.6685589 l 0.6066813,-0.1839681 0.3281453,0.00517 v 0.06873 l 0.00723,0.045992 0.011369,0.032039 h 0.014469 l 0.014469,-0.032039 0.00723,-0.050643 v -0.066146 l 0.2552815,0.00672 -0.00207,0.1255737 0.016536,0.076481 0.019637,0.071314 0.014469,0.027905 h 0.021704 l 0.010335,-0.031006 0.018604,-0.070797 0.013436,-0.071314 0.00207,-0.1229899 1.0815877,0.014469 v 4.3868124 l 0.00672,0.286804 0.012919,0.179834 0.018604,0.209806 0.021187,0.184485 0.024288,0.176733 0.027388,0.169499 0.060978,0.299207 0.055294,0.237194 0.05271,0.224276 0.00362,0.05064 -0.014469,0.06976 -0.032039,0.05374 -0.040824,0.03772 -1.8339966,1.20406 -0.025838,0.02429 -0.01757,0.02532 -0.00982,0.03411 v 0.441317 L 8.917802,17.306336 v -0.126608 l 0.023254,0.12144 0.029972,0.126607 0.05271,0.199988 0.084233,0.276986 0.067179,0.195337 v 0.04082 l 0.084279,0.0016 0.086253,-0.0016 v -0.04082 l 0.067696,-0.195337 0.083716,-0.276986 0.05271,-0.199988 0.029972,-0.126607 0.023254,-0.12144 v 0.126608 l 2.134236,0.503328 v -0.441317 l -0.0098,-0.03411 -0.01757,-0.02532 -0.02532,-0.02429 -1.8345126,-1.20406 -0.040824,-0.03772 -0.032039,-0.05374 -0.013953,-0.06976 0.0031,-0.05064 0.05271,-0.224276 0.055294,-0.237194 0.060978,-0.299207 0.027388,-0.169499 0.024288,-0.176733 0.021188,-0.184485 0.0186,-0.209806 0.01344,-0.179834 0.0062,-0.286804 V 9.5140464 l 1.081588,-0.014469 0.0021,0.1229899 0.01344,0.071314 0.0186,0.070797 0.01034,0.031006 h 0.0217 l 0.01447,-0.027905 0.02015,-0.071314 0.01654,-0.076481 -0.0026,-0.1255737 0.255281,-0.00672 v 0.066146 l 0.0078,0.050643 0.01395,0.032039 h 0.01447 l 0.01137,-0.032039 0.0078,-0.045992 v -0.06873 l 0.327628,-0.00517 0.606682,0.1839681 v 0.1348755 l 0.01344,0.082682 0.0186,0.07183 0.01757,0.045992 h 0.02325 l 0.01809,-0.054777 0.01654,-0.066146 0.01085,-0.069763 -0.0021,-0.1069702 1.304313,0.38964 v 0.09819 l 0.0031,0.05064 0.01344,0.08061 0.01964,0.06718 0.01344,0.03772 h 0.0155 l 0.02222,-0.04547 0.02067,-0.05839 0.0098,-0.08475 -0.0021,-0.110587 1.989543,0.599447 v 0.192753 h 0.04082 v -0.671794 l -0.02067,-0.05323 -0.03307,-0.04754 -0.03101,-0.02946 -0.04392,-0.03101 -4.101042,-2.1166667 0.04289,-0.2682007 0.02325,-0.1994711 0.02222,-0.2253092 0.0088,-0.1214396 0.0031,-0.1281576 -0.0021,-0.1917195 -0.0098,-0.107487 -0.01757,-0.1012858 -0.0124,-0.065112 -0.01654,-0.040824 -0.02532,-0.015503 h -0.636654 l -0.02429,0.020154 -0.01137,0.041858 -0.02325,0.1002523 -0.01292,0.094051 -0.0021,0.1157552 v 0.2072225 l 0.0052,0.118339 0.0088,0.1369425 0.01137,0.1121379 0.01395,0.096118 0.0026,0.088367 -0.82579,-0.4237468 -0.08578,-0.042891 -0.05839,-0.037724 -0.05994,-0.061495 -0.04289,-0.058911 -0.03669,-0.068213 -0.01757,-0.075964 -0.0052,-0.063045 V 2.3310223 L 10.036597,2.0881431 10.024711,1.9403485 9.9926718,1.7460451 9.961666,1.606002 9.9198081,1.452523 9.8665813,1.2959434 9.8118043,1.1522829 9.7663291,1.0416953 9.7156862,0.93575863 9.639205,0.78589698 9.601998,0.71871761 9.5575563,0.64998796 9.5146648,0.59159359 9.468156,0.5378501 9.4185467,0.48772396 9.3803061,0.45155046 9.3337973,0.41744401 9.3007244,0.39832373 9.2748862,0.39729021 Z","a":[9.26,8.202]},"P68":{"d":"M 5.2668688,6.1053163 H 7.9933035 m 10.452082,6.1053163 h 2.726434 m 9.2263084,2.2767416 -0.1162703,0.018726 -0.095085,0.063562 -0.057878,0.079065 -0.031523,0.1421102 V 2.7590047 L 8.8253009,2.8907796 8.7255654,3.133142 8.6361652,3.448885 8.5359129,3.9858032 8.4620156,4.5284057 8.3622801,5.3707315 8.3359251,6.976835 H 7.2352172 V 6.5551553 L 6.8770995,6.4342325 V 6.3236449 L 6.8249063,6.1500121 6.7613443,5.9867146 6.6300861,5.8446044 6.4874592,5.9918822 6.382556,6.3024576 V 6.4182128 L 5.9980834,6.571175 V 6.9820026 H 1.0381795 L 0.89606932,7.0238606 0.7906494,7.1396158 0.6588745,7.6925536 l -0.005168,0.6371704 0.0738973,0.4320149 0.0997355,0.394808 0.0475423,0.03669 H 2.4386108 l 0.03669,0.05271 h 0.35295 l 0.079065,-0.073897 h 5.4601318 l 0.05271,0.7007324 0.084233,0.6102988 0.1788005,1.447973 0.2475301,2.011764 -0.6898804,0.536918 H 6.6507567 l -0.1054199,0.05788 -0.068213,0.08423 -0.021187,0.110588 v 0.605648 l 0.1054199,0.431498 0.042375,0.01602 h 2.5429972 l 0.081923,0.449557 0.070006,-0.449557 h 2.5429969 l 0.04237,-0.01602 0.10542,-0.431498 v -0.605648 l -0.02119,-0.110588 -0.06873,-0.08423 -0.104903,-0.05788 h -1.590084 l -0.6898805,-0.536918 0.2475301,-2.011764 0.1788005,-1.447973 0.084233,-0.6102988 0.05271,-0.7007324 h 5.460131 l 0.07906,0.073897 h 0.35295 l 0.03669,-0.05271 h 1.563728 l 0.04754,-0.03669 0.09973,-0.394808 0.0739,-0.4320149 -0.0052,-0.6371704 -0.131775,-0.5529378 -0.10542,-0.1157552 -0.14211,-0.041858 H 12.447302 V 6.571175 L 12.062829,6.4182128 V 6.3024576 l -0.10542,-0.3105754 -0.14211,-0.1472778 -0.131258,0.1421102 -0.06356,0.1632975 -0.05271,0.1736328 V 6.4342325 L 11.210168,6.5551553 V 6.976835 H 10.10946 L 10.083105,5.3707315 9.9833698,4.5284057 9.9094725,3.9858032 9.8092202,3.448885 9.71982,3.133142 9.6195677,2.8907796 9.5198322,2.7590047 V 2.5802042 L 9.4883096,2.438094 9.430432,2.3590291 9.3353473,2.2954671 Z","a":[9.26,7.937]},"A124":{"d":"m 9.2603586,1.1910663 -0.089607,0.024889 -0.1543694,0.189248 -0.2390683,0.4332678 -0.1842528,0.3884426 -0.1145391,0.4282727 -0.059767,0.4332243 -0.03983,0.4183261 -0.00995,1.8375769 0.005,0.7071712 -1.0457935,0.7071277 h -0.054773 l 0.049777,-0.074667 V 5.9817705 L 7.2335343,5.8622363 h -0.51788 l -0.064762,0.094602 -0.019893,0.2191315 -0.029883,0.2290782 v 0.3934374 l 0.034834,0.074666 v 0.1593647 l 0.059767,0.069714 h 0.064762 l 0.014898,0.034878 -0.6623025,0.4432145 -0.6125256,0.358559 0.00495,-0.2241266 0.034878,-0.07966 0.00495,-0.5527585 -0.044782,-0.1593644 h -0.582681 l -0.049777,0.054771 -0.00995,0.1941997 -0.024933,0.084655 -0.00995,0.5926322 0.03983,0.07966 -0.00495,0.1195343 0.079661,0.089651 h 0.049821 v 0.089608 L 3.4687269,9.0842274 1.929942,9.935821 l -0.7818801,0.448166 -0.109544,0.06977 -0.0846559,0.0946 -0.0647189,0.104592 -0.0697575,0.134433 -0.0497766,0.104593 -0.0248878,0.144422 -0.0149423,0.1942 v 0.189247 l 0.5428124,-0.149418 1.7628678,-0.51788 0.2689084,-0.08466 0.005,0.03485 0.029883,0.03982 0.064719,0.0747 0.054816,-0.05477 0.044782,-0.04982 -0.00495,-0.10455 0.7121229,-0.219131 v 0.07966 l 0.034834,0.0747 0.044825,0.01 0.054772,-0.07471 0.014942,-0.05477 v -0.08466 l 0.6922295,-0.224127 -0.005,0.05978 0.024889,0.06972 0.049821,0.02489 0.024889,-0.01 0.044825,-0.07471 0.005,-0.11949 0.7469579,-0.2091835 -0.00495,0.094644 0.034834,0.049779 0.044825,-0.00994 0.029884,-0.054769 0.005,-0.1195345 0.7967784,-0.1941991 v 0.059771 l 0.029884,0.069715 0.03983,0.039828 0.024889,-0.00994 0.034878,-0.074704 0.024888,-0.069715 v -0.064728 l 1.0009737,-0.229078 0.00995,0.08965 0.03983,0.064719 0.039874,0.00999 0.034834,-0.029884 0.034878,-0.074709 V 9.2983651 l 0.1892044,-0.03983 -0.00495,1.1254529 0.029884,0.373502 v 2.11148 l 0.03983,0.866535 0.04982,0.398389 0.049777,0.288845 0.059767,0.243976 v 0.174306 l -0.5378077,0.423323 -0.5627487,0.418282 -0.5527586,0.423322 -0.5627485,0.443214 -0.079661,0.124486 -0.029884,0.129481 -0.019937,0.134432 v 0.348612 l 0.049821,0.03982 0.1394273,-0.04978 1.3894108,-0.313734 1.1503423,-0.239068 0.03983,0.149419 0.054771,0.154368 0.034879,0.134476 0.059766,0.0996 0.059767,0.05477 0.049183,0.01333 0.050414,-0.01333 0.059767,-0.05477 0.059767,-0.0996 0.034878,-0.134476 0.054771,-0.154368 0.039829,-0.149419 1.1503428,0.239068 1.38941,0.313734 0.139427,0.04978 0.04981,-0.03982 v -0.348612 l -0.01994,-0.134432 -0.02988,-0.129481 -0.07966,-0.124486 -0.562744,-0.443214 -0.552759,-0.423322 -0.562749,-0.418282 -0.5378159,-0.423321 v -0.174307 l 0.059775,-0.243977 0.04977,-0.288844 0.04981,-0.39839 0.03982,-0.866534 v -2.111482 l 0.02989,-0.3735 -0.005,-1.1254541 0.189247,0.039829 v 0.1045923 l 0.03488,0.074709 0.03484,0.029884 0.03987,-0.00999 0.03982,-0.064719 0.01,-0.089651 1.000968,0.229078 v 0.064763 l 0.02489,0.069715 0.03487,0.074704 0.02489,0.00994 0.03982,-0.039829 0.02989,-0.069715 v -0.059771 l 0.796779,0.1941991 0.005,0.1195345 0.02988,0.054769 0.04483,0.00994 0.03485,-0.049779 -0.005,-0.094645 0.746956,0.2091832 0.005,0.11949 0.04483,0.07471 0.02489,0.01 0.04981,-0.02489 0.02489,-0.06972 -0.005,-0.05978 0.692229,0.224127 v 0.08466 l 0.01495,0.05477 0.05477,0.07471 0.04483,-0.01 0.03484,-0.0747 v -0.07966 l 0.712123,0.219131 -0.005,0.104549 0.04483,0.04982 0.05482,0.05477 0.06471,-0.0747 0.02989,-0.03983 0.005,-0.03484 0.268952,0.08466 1.762869,0.517879 0.542811,0.149419 v -0.189234 l -0.01495,-0.1942 -0.02489,-0.144422 -0.04981,-0.104592 -0.06972,-0.134433 -0.06471,-0.104593 -0.08465,-0.0946 L 17.37271,10.384031 16.590819,9.9358112 15.052034,9.0842176 13.533143,8.227672 V 8.138065 h 0.04982 l 0.07966,-0.089651 -0.005,-0.1195343 0.03982,-0.079661 -0.01,-0.5926321 -0.02494,-0.084655 -0.01,-0.1941997 -0.04977,-0.054771 h -0.582578 l -0.04483,0.1593645 0.005,0.5527584 0.03487,0.079661 0.005,0.2241266 L 12.40767,7.5803124 11.745324,7.137098 11.760274,7.10222 h 0.06476 l 0.05978,-0.069714 V 6.8731515 l 0.03485,-0.074667 V 6.4050486 L 11.889794,6.1759705 11.869904,5.956839 11.805144,5.862237 h -0.51788 l -0.08965,0.1195342 v 0.7021757 l 0.04977,0.074667 h -0.05479 l -1.045803,-0.7071287 0.005,-0.7071712 -0.01,-1.8375769 -0.03979,-0.418327 L 10.042238,2.6551858 9.9276985,2.2269131 9.7434465,1.8384705 9.5043782,1.4052026 9.3500091,1.2159547 Z","a":[9.26,7.673]},"A333":{"d":"m 9.3239785,0.50797932 -0.043925,0.009819 -0.059428,0.0516764 -0.073897,0.0956014 -0.064079,0.11472168 -0.071314,0.14779459 -0.066146,0.16433106 -0.07028,0.1803507 -0.065629,0.1922364 -0.039791,0.1307413 -0.031523,0.1136882 -0.043408,0.1788004 -0.066663,0.3482992 -0.045475,0.315743 -0.017053,0.2030884 -0.012402,0.2392618 -0.00723,0.1090373 v 3.918107 l -1.5818156,0.973584 0.1100708,-0.523999 h 0.1054199 l 0.03514,-0.2682007 0.01912,-0.2671671 0.0062,-0.1632976 V 6.5592894 L 7.2228148,6.3091755 7.2057616,6.147945 7.1804401,6.1252074 H 6.4321654 l -0.024288,0.021704 -0.018087,0.208256 -0.014469,0.3079916 v 0.1829345 l 0.011886,0.2160075 0.025322,0.2604492 0.021704,0.1462443 h 0.1090372 l 0.1271241,0.622701 h 0.040824 l 0.00982,0.049609 -5.3231892,3.290238 -0.024288,0.02067 -0.014469,0.02791 -0.00155,0.125574 -0.2087728,0.471806 v 0.226343 l 0.1896525,-0.136943 2.6592691,-1.16427 0.4402832,-0.151412 0.00465,0.100252 0.023254,0.08992 0.026355,0.08682 0.024288,0.05581 h 0.025321 l 0.020671,-0.06408 0.026355,-0.09457 0.021704,-0.09198 0.012402,-0.09043 v -0.05839 l 0.7084839,-0.241845 v 0.07286 l 0.014469,0.07493 0.024288,0.07597 0.037724,0.106453 h 0.023771 l 0.026872,-0.06873 0.027905,-0.09095 0.015503,-0.09147 0.011886,-0.07545 v -0.06615 l 0.7074504,-0.243396 v 0.0677 l 0.012402,0.08268 0.028939,0.09147 0.037724,0.09198 h 0.022738 l 0.027905,-0.07235 0.025321,-0.09095 0.018087,-0.09043 0.00878,-0.08372 v -0.05891 L 7.0739867,9.9394448 h 0.1152384 l 0.00362,0.097668 0.011886,0.0801 0.017053,0.06408 0.044442,0.146244 h 0.028939 l 0.030489,-0.07752 0.022738,-0.09302 0.01602,-0.05323 0.010852,-0.0677 0.0062,-0.094568 h 1.0423136 l 0.013436,0.1405601 0.027389,0.141593 0.042375,0.166915 0.034107,0.09767 v 1.57458 l 0.00362,0.321428 0.015503,0.329179 0.025321,0.370003 0.014469,0.157096 0.023254,0.230994 0.01912,0.152445 0.025321,0.216525 0.022221,0.167948 0.048059,0.313159 0.05581,0.346232 0.053227,0.361219 0.05426,0.346232 0.088367,0.570507 -2.1802286,1.295529 -0.040308,0.03359 -0.034623,0.04858 -0.023254,0.05529 -0.014469,0.07028 -0.047025,0.499711 2.5295613,-0.722437 0.072864,0.707451 0.027905,0.0186 0.043925,0.0041 0.043408,-0.0041 0.027905,-0.0186 0.072347,-0.707451 2.530078,0.722437 -0.04702,-0.499711 -0.01447,-0.07028 -0.02325,-0.05529 -0.03514,-0.04858 -0.03979,-0.03359 -2.1802287,-1.295529 0.088367,-0.570507 0.05426,-0.346232 0.053227,-0.361219 0.055294,-0.346232 0.048576,-0.313159 0.021704,-0.167948 0.025321,-0.216525 0.01964,-0.152445 0.02274,-0.230994 0.01447,-0.157096 0.02532,-0.370003 0.01602,-0.329179 0.0036,-0.321428 v -1.57458 l 0.03359,-0.09767 0.04237,-0.166915 0.02791,-0.141593 0.01344,-0.1405601 h 1.042314 l 0.0062,0.094568 0.01085,0.0677 0.0155,0.05323 0.02325,0.09302 0.02997,0.07752 h 0.02894 l 0.04496,-0.146244 0.01705,-0.06408 0.01189,-0.0801 0.0036,-0.097668 h 0.114722 l 0.671277,0.2346112 v 0.05891 l 0.0088,0.08372 0.01809,0.09043 0.02532,0.09095 0.02791,0.07235 h 0.02274 l 0.03772,-0.09198 0.02894,-0.09147 0.01189,-0.08268 v -0.0677 l 0.70745,0.243396 v 0.06615 l 0.0124,0.07545 0.0155,0.09147 0.02791,0.09095 0.02635,0.06873 h 0.02429 l 0.03772,-0.106453 0.02377,-0.07597 0.01447,-0.07493 v -0.07286 l 0.709001,0.241845 v 0.05839 l 0.01189,0.09043 0.0217,0.09198 0.02687,0.09457 0.02067,0.06408 h 0.02532 l 0.02377,-0.05581 0.02687,-0.08682 0.02274,-0.08992 0.0052,-0.100252 0.440284,0.151412 2.659269,1.16427 0.189652,0.136943 v -0.226343 l -0.209289,-0.471806 -0.001,-0.125574 -0.01447,-0.02791 -0.02429,-0.02067 -5.323189,-3.290238 0.0093,-0.049609 h 0.04134 l 0.127125,-0.622701 h 0.10852 l 0.0217,-0.1462443 0.02584,-0.2604492 0.01189,-0.2160075 V 6.6631591 l -0.01447,-0.3079916 -0.01809,-0.208256 -0.02429,-0.021704 h -0.748792 l -0.02532,0.022738 -0.01654,0.1612305 -0.01705,0.2501139 v 0.2129069 l 0.0057,0.1632976 0.01964,0.2671671 0.03514,0.2682007 h 0.104903 l 0.110071,0.523999 -1.581816,-0.973584 V 3.1031697 L 10.093957,2.9941324 10.082072,2.7548706 10.065019,2.5517822 10.019027,2.2360392 9.9523639,1.88774 9.9089557,1.7089396 9.8774331,1.5952514 9.8376422,1.4645101 9.7725299,1.2722737 9.70225,1.091923 9.6355874,0.92759194 9.5642739,0.77979735 9.5001951,0.66507567 9.4262978,0.56947427 9.3673867,0.51779784 Z","a":[9.26,8.467]},"GLEX":{"d":"m 9.2730517,0.55239424 c -0.1514874,0 -0.7982853,1.12751206 -0.7982853,2.09807976 V 6.2384321 L 1.227364,11.788781 c -0.092576,0.07153 -0.30048329,0.824528 -0.3366187,0.959387 v 0.29249 l 0.2479003,-0.429428 0.053947,0.0539 c 0.028477,0 0.055941,-0.124026 0.055941,-0.208782 L 3.200902,11.468934 c 0,0.107307 0.012641,0.254599 0.052617,0.254599 0.035768,0 0.05052,-0.195654 0.05052,-0.307165 l 1.6446919,-0.811301 c 0,0.119921 0.015798,0.252808 0.051339,0.252808 0.035541,0 0.058804,-0.17415 0.058804,-0.298062 l 1.5357764,-0.435309 c 0,0.08416 0.00413,0.265235 0.050469,0.265235 0.044239,0 0.052924,-0.214023 0.052924,-0.287222 L 8.4602937,9.9343333 c 0,0.2722717 0.1563183,0.9872117 0.1563183,1.1937887 H 8.4230186 c 0,0 -0.05678,-0.185158 -0.079923,-0.185158 h -0.791103 c -0.023144,0 -0.1619943,0.09255 -0.1619943,1.012003 0,1.060412 0.2885692,1.955547 0.3303293,2.021962 h 0.5764907 c 0.014203,-0.02998 0.020501,-0.04841 0.031547,-0.08206 l 0.4881302,0.246161 c 0.00628,0.103098 0.1199217,0.666972 0.1746249,0.732197 L 6.655706,16.964576 c -0.1041476,0.104146 -0.1367849,0.258823 -0.1367849,0.321942 v 0.650125 L 9.1889116,16.55642 c 0.042081,0.443942 0.071541,0.456581 0.071541,0.456581 0,0 0.029461,-0.01259 0.07154,-0.456581 l 2.6699394,1.380223 v -0.650125 c 0,-0.06311 -0.03259,-0.217796 -0.136733,-0.321942 L 9.5297308,14.873217 c 0.054701,-0.06523 0.168311,-0.6291 0.1746243,-0.732196 l 0.4881299,-0.246162 c 0.01104,0.03366 0.01735,0.05209 0.03156,0.08206 h 0.576542 c 0.04176,-0.06641 0.330329,-0.961551 0.330329,-2.021963 0,-0.919443 -0.138902,-1.012003 -0.162045,-1.012003 h -0.791103 c -0.02315,0 -0.07992,0.185159 -0.07992,0.185159 H 9.9042439 c 0,-0.206578 0.1563181,-0.921517 0.1563181,-1.1937897 l 1.762302,0.1681837 c 0,0.0732 0.0086,0.287222 0.05287,0.287222 0.04635,0 0.05047,-0.181074 0.05047,-0.265235 l 1.535774,0.435309 c 0,0.123908 0.02326,0.298063 0.0588,0.298063 0.03554,0 0.05134,-0.132882 0.05134,-0.252809 l 1.644691,0.811302 c 0,0.111516 0.01475,0.307164 0.05051,0.307164 0.03998,0 0.05261,-0.147297 0.05261,-0.254598 l 1.952369,0.987407 c 0,0.08475 0.02747,0.208782 0.05594,0.208782 l 0.05395,-0.0539 0.2479,0.429427 V 12.748151 C 17.593948,12.613292 17.386046,11.8603 17.293469,11.788764 L 10.046084,6.2384321 V 2.650474 c 0,-0.9705677 -0.6215403,-2.09807976 -0.7730285,-2.09807976 z","a":[9.26,8.202]},"F16":{"d":"m 9.0320067,1.7787028 -0.065112,0.073897 -0.0863,0.2010213 -0.1390096,0.3767212 -0.098702,0.3643188 -0.1049031,0.4506185 -0.058911,0.3860229 -0.021704,0.287321 -0.03669,0.042891 -0.055811,0.559139 -0.070797,0.1173055 -0.049609,0.1638143 -0.024805,0.5431193 -0.030489,0.3276286 -0.05271,0.3736206 -0.098702,0.5002278 -0.095601,0.3767212 -0.096118,0.3302124 -0.1384929,0.37052 -0.096118,0.333313 L 7.546826,8.2444579 7.4817137,8.53798 7.4233194,8.8371865 7.3985147,8.9022988 6.3701537,9.7792479 5.6725219,10.381278 4.9221801,11.001912 4.060734,11.711946 v -0.453719 l -0.05271,-0.148311 -0.0093,-0.108004 -0.1080038,-0.0062 V 10.736295 H 4.0173258 L 3.909322,10.628292 v -0.373621 l -0.068213,-0.0677 -0.069246,0.06925 v 0.270268 l -0.190686,0.190686 h 0.2046387 v 1.785421 l -0.2160075,0.216007 v 0.352434 l 0.1255737,0.217557 h 0.1953369 l 0.1658814,-0.165881 h 3.6566242 v 1.27279 l -1.9047932,1.683102 v 0.660425 l 0.3255615,0.326078 h 1.5332397 v -0.381372 h 0.4816244 v -0.796851 l 0.058394,0.129708 0.015503,0.166915 0.043408,0.262516 0.049609,0.206706 0.064596,0.23151 h 0.3891235 v 0.487826 l 0.2708108,0.0805 0.2542217,-0.0805 V 16.88424 h 0.3891236 l 0.064595,-0.23151 0.049609,-0.206706 0.042891,-0.262516 0.015503,-0.166915 0.058911,-0.129708 v 0.796851 h 0.4816241 v 0.381372 h 1.53324 l 0.325561,-0.326078 v -0.660425 l -1.90531,-1.683102 v -1.27279 h 3.657141 l 0.165882,0.165881 h 0.195337 l 0.125573,-0.217557 v -0.352434 l -0.216007,-0.216007 v -1.785421 h 0.204639 l -0.190686,-0.190686 v -0.270268 l -0.06976,-0.06925 -0.0677,0.0677 v 0.373621 l -0.108003,0.108003 h 0.126607 v 0.259416 l -0.108004,0.0062 -0.0093,0.108004 -0.05271,0.148311 v 0.453719 L 13.141833,11.001912 12.391491,10.381278 11.69386,9.7792479 10.665499,8.9022988 10.640694,8.8371865 10.581783,8.53798 l -0.0646,-0.2935221 -0.0646,-0.287321 -0.09612,-0.333313 -0.13901,-0.37052 -0.0956,-0.3302124 -0.0956,-0.3767212 L 9.9275592,6.0461425 9.8748493,5.6725219 9.8438434,5.3448933 9.8195555,4.801774 9.7699461,4.6379597 9.6991494,4.5206542 9.6433389,3.9615152 9.6061318,3.9186238 9.5844277,3.6313028 9.5260334,3.2452799 9.4211302,2.7946614 9.3224282,2.4303426 9.1834186,2.0536214 9.0966022,1.8526001 Z","a":[8.996,10.848]},"DH8A":{"d":"m 10.534663,6.0232275 h 2.882722 M 5.0114752,6.0232275 H 7.8941967 M 9.2362395,1.8562174 9.1153709,1.8844365 8.9782632,1.9823079 8.8774941,2.1151163 8.763806,2.2980509 8.6371987,2.5507487 8.5235106,2.8096476 8.4165404,3.1377929 8.3281737,3.51038 8.2522093,3.9144897 8.2206867,4.2679565 8.2144855,4.4700113 V 7.329785 l -0.044442,0.037724 H 6.7370564 V 6.5406859 L 6.7179361,6.1934203 6.6740111,5.9851643 6.5918456,5.8208332 6.4781574,5.7133463 6.452836,5.7066283 6.4027098,5.7453856 6.2952229,5.8776773 6.2383788,6.0544107 6.200655,6.2249429 V 7.37371 l -5.56865224,0.631486 -0.0568441,0.025321 -0.0501261,0.069246 -0.0320394,0.1012858 V 8.952425 l 2.85408934,0.1576131 0.043925,0.107487 0.056844,-0.1012858 1.3068969,0.063562 0.043925,0.1069702 0.056844,-0.1007691 1.319816,0.063045 v 0.624768 l 0.025322,0.2402953 0.050126,0.202055 0.1012858,0.151412 0.1198894,0.05684 0.100769,-0.05064 0.095085,-0.100769 0.063045,-0.126607 0.025321,-0.113688 V 9.268168 l 1.5089518,-0.01912 v 2.0644733 l 0.050126,0.675411 0.050643,0.643888 0.075964,0.549321 0.1700155,1.010274 0.2971395,1.287777 -2.1528402,0.302824 -0.063045,0.05684 -0.050643,0.126607 v 0.618567 l 0.037724,0.202055 0.063045,0.139009 h 2.4127726 l -0.00155,0.2651 0.063045,-0.2651 h 2.4685829 l 0.06304,-0.139009 0.03772,-0.202055 v -0.618567 l -0.05064,-0.126607 -0.06304,-0.05684 -2.1528401,-0.302824 0.2966228,-1.287777 0.1705322,-1.010274 0.075964,-0.549321 0.05064,-0.643888 0.05013,-0.675411 V 9.2490477 l 1.508952,0.01912 v 0.864547 l 0.02532,0.113688 0.06305,0.12609 0.09457,0.101286 0.101285,0.05064 0.11989,-0.05684 0.101286,-0.151412 0.05013,-0.202055 0.02532,-0.2402953 v -0.624768 l 1.319299,-0.063045 0.05685,0.1007691 0.04444,-0.107487 1.306897,-0.063045 0.05684,0.1012858 0.04392,-0.107487 2.853573,-0.1576131 V 8.2010497 L 17.904333,8.0997639 17.854207,8.0305174 17.797363,8.005196 12.228711,7.37371 V 6.2249429 l -0.03772,-0.1705322 -0.05684,-0.1767334 -0.107487,-0.1328084 -0.05064,-0.038241 -0.02481,0.00672 -0.113688,0.1074869 -0.08216,0.1643311 -0.04444,0.208256 -0.0186,0.3472656 V 7.3675088 H 10.259322 L 10.21488,7.329785 V 4.4700113 L 10.208679,4.2679565 10.177156,3.9144897 10.101192,3.51038 10.012825,3.1377929 9.9053384,2.8096476 9.792167,2.5507487 9.6655597,2.2980509 9.5518716,2.1151163 9.4511025,1.9823079 9.3498167,1.88774 Z","a":[9.26,7.937]},"B214":{"d":"m 6.9450825,15.027815 -0.010835,0.996798 -0.065008,0.08126 -0.00542,0.362964 0.032504,0.08126 -0.016251,0.926372 0.048756,-0.948042 0.032504,-0.08126 0.016253,-0.406303 -0.027087,-0.04334 z M 7.3334024,4.602303 7.1711384,4.611603 6.9509968,4.642092 6.7215534,4.7521628 6.5262165,4.9418153 6.4373335,5.1252667 6.3794555,5.4125876 6.3303625,5.8409852 6.2998735,6.3515484 6.2792035,6.742739 6.2301105,6.828005 6.1572465,6.755141 V 5.8730264 L 6.1055704,5.82135 6.0585448,5.8683755 v 3.1558797 l 0.058911,0.058911 0.034107,-0.058911 V 8.7751748 l 0.062528,-0.062529 H 6.336564 L 6.4983112,9.0366576 6.6419717,9.3177773 6.794934,9.5932127 6.9298094,9.7704629 v 0.2997231 l -0.030489,0.03669 0.011885,0.351917 0.055294,0.01809 0.127124,2.755387 h -1.1467 v 0.524516 h 1.170988 l 0.062528,1.353406 0.03669,0.02429 0.013953,1.026294 -0.069246,0.06873 H 6.93291 v 0.04547 h 0.2289266 l 0.091984,0.0646 0.021187,0.08268 h 0.039791 l 0.021704,-0.05839 0.014986,-0.195854 0.027905,-1.04283 0.03669,-0.02739 0.077515,-1.320849 h 1.192176 V 13.241569 H 7.5251219 l 0.1627808,-2.779675 0.076481,0.0062 0.024805,-0.397909 -0.095085,-0.03979 -0.0093,-0.1803504 L 7.7400959,9.776664 7.8775552,9.5689248 8.0522215,9.2723021 8.1865803,8.9937661 8.3090534,8.7095457 h 0.091467 l 0.055294,0.054777 v 0.2599324 l 0.060978,0.052193 0.045992,-0.039791 0.024288,-3.1315918 -0.051676,-0.03359 -0.052193,0.03359 v 0.856279 L 8.4341104,6.8135375 8.3824339,6.7215534 8.3700316,6.1221068 8.3364419,5.7123127 8.2780475,5.3516112 8.1741779,5.0002115 8.0093301,4.8167602 7.8072753,4.6818847 7.5716307,4.6147053 Z m -1.1606527,3.5098632 0.019637,0.078031 0.05271,0.2304769 0.067696,0.2103231 -0.093534,0.011885 -0.046509,-0.026872 z m 2.2877156,0.05271 0.0031,0.4382161 -0.039791,0.03514 -0.095601,-0.00672 0.067179,-0.2061889 z m 6.0232374,8.3266676 -0.049442,-0.043626 0.040717,-0.05235 0.055259,0.040717 0.8812366,-0.072709 0.049442,-0.034901 0.1745025,-0.011634 0.075618,-0.072709 -0.072709,-0.052351 -0.023268,-0.4391641 -0.055259,-0.0349 -0.4537059,-5.9621616 0.040717,-0.046534 0.087251,-0.00582 0.055259,0.034901 0.3490048,-0.00291 0.4682476,5.9767033 -0.2792036,0.02036 0.081435,0.2210364 0.00582,0.2355778 -0.046534,0.034901 0.066892,0.066892 0.2035861,-0.02036 0.049442,0.0349 0.8405193,-0.072709 0.037809,-0.043626 0.046534,0.046534 -0.043626,0.046534 -0.040717,-0.026175 -0.8463362,0.081434 -0.049442,0.040717 -0.1803191,0.026175 -0.037809,0.078526 0.081435,0.055259 0.014541,0.3635465 0.043626,0.058167 0.407172,6.0261461 -0.040717,0.06398 -0.069801,0.0058 -0.069801,-0.05235 L 7.509418,14.855935 7.474517,14.806495 7.0731575,8.7920046 7.343636,8.7803708 7.2592932,8.626227 l -0.00873,-0.2413947 0.0349,-0.052351 -0.09016,-0.066892 -0.2152194,0.014541 -0.055259,-0.043626 -0.8550611,0.063984 z","a":[9.26,6.35]},"AJ27":{"d":"M 9.2601099,0.51369358 9.1816169,0.53624465 8.9929979,0.72021274 8.8090298,1.009084 8.672604,1.2922708 8.5573656,1.6705423 8.473133,2.0534647 8.4152554,2.4942646 8.3889004,3.166575 v 4.2255818 l -0.057361,0.2046387 -5.8637247,3.0447755 -0.1415934,0.141593 -0.1105875,0.194304 -0.031523,0.189135 -0.047026,0.141594 -0.05271,0.12609 -0.00517,0.319877 0.05271,-0.151928 0.1312582,-0.141594 0.1209228,-0.06821 0.083716,-0.02636 4.0736531,-1.223181 1.8531168,0.0155 -0.010852,1.160136 H 8.1372362 l -0.041858,-0.06821 H 7.3496874 l -0.094568,0.110588 -0.041858,0.120406 v 0.541052 l 0.057878,0.492993 0.073381,0.115755 0.084233,0.08372 0.015503,0.162781 0.05271,0.126091 0.1049032,0.12609 0.1519287,0.409277 0.1524455,-0.425297 0.1100708,-0.07855 0.00517,0.120923 0.1943034,0.09974 0.2992065,0.08888 0.00517,0.304891 0.057878,0.346232 0.057878,0.272852 0.057878,0.278536 0.047026,0.230993 0.057878,0.236162 0.052193,0.204638 0.1157552,0.388607 -2.4303425,1.711007 v 0.645955 l 2.6298136,-0.824239 0.03669,0.393774 0.057878,0.115239 0.057361,-0.115239 0.037207,-0.393774 2.6298142,0.824239 v -0.645955 l -2.4303432,-1.711007 0.1152385,-0.388607 0.05271,-0.204638 0.057361,-0.236162 0.047542,-0.230993 0.057878,-0.278536 0.057361,-0.272852 0.057878,-0.346232 0.0052,-0.304891 0.299207,-0.08888 0.194303,-0.09974 0.0052,-0.120923 0.110588,0.07855 0.151928,0.425297 0.152446,-0.409277 0.104903,-0.12609 0.05219,-0.126091 0.01602,-0.162781 0.08372,-0.08372 0.0739,-0.115755 0.05736,-0.492993 v -0.541052 l -0.04186,-0.120406 -0.09457,-0.110588 h -0.745174 l -0.04186,0.06821 h -0.247084 l -0.01034,-1.160136 1.853117,-0.0155 4.073136,1.223181 0.08423,0.02636 0.120923,0.06821 0.131258,0.141594 0.05219,0.151928 -0.0052,-0.319877 -0.05271,-0.12609 -0.04703,-0.141594 -0.03152,-0.189135 -0.11007,-0.194304 -0.142067,-0.141595 -5.863207,-3.0447755 -0.05788,-0.2046387 V 3.166575 L 10.105591,2.4942646 10.04823,2.0534647 9.9639985,1.6705423 9.8482429,1.2922708 9.7118171,1.009084 9.5283658,0.72021274 9.33923,0.53624465 Z","a":[9.26,8.731]},"A748":{"d":"m 6.106416,6.1724037 0.7512465,-0.040608 0.015227,-0.035532 0.2487234,-0.00507 0.015229,0.030456 0.7309427,0.05076 -0.7157146,0.025381 -0.035532,0.035532 -0.2690275,0.00508 -0.035532,-0.040608 z m 10.644457,6.1724037 0.751246,-0.040608 0.01523,-0.035532 0.248723,-0.00507 0.01523,0.030456 0.730943,0.05076 -0.715714,0.025381 -0.03553,0.035532 -0.269028,0.00508 -0.03553,-0.040608 z M 9.2604165,3.4220133 9.1844521,3.438033 9.0485431,3.5501708 8.9410562,3.6617919 8.7968789,3.9253417 8.6811237,4.2328165 8.6371987,4.3847452 8.5695026,4.6958373 8.5136921,5.0157144 8.4775186,5.2591104 8.4454792,5.650301 v 2.0804931 l -1.1456665,0.08785 V 7.1840575 l 0.01602,-0.1038696 0.00775,-0.1317749 -0.00413,-0.1400432 -0.027905,-0.1116211 -0.00413,-0.135909 -0.031523,-0.135909 -0.012402,-0.067696 -0.035657,-0.051676 H 7.147884 L 7.131864,6.1055709 7.096207,5.9458907 7.048148,5.8420211 7.000089,5.8099821 6.944278,5.8502901 6.900353,5.9340061 6.860562,6.0616469 6.840408,6.2332127 6.836278,6.3055597 6.796487,6.2972897 6.772716,6.3334637 6.736543,6.4089117 6.688484,6.572726 6.680734,6.7887335 6.668849,7.0083583 6.684869,7.223849 6.692619,7.4233201 6.688489,7.870838 0.68678827,8.3658982 l -0.0759644,0.011886 -0.0475423,0.036174 -0.0599447,0.099735 -0.0201538,0.1157552 0.0320394,0.6268351 3.53001703,0.2557983 0.01602,0.027905 0.031523,0.011886 0.059945,-0.00413 0.043925,-0.032039 0.036174,-0.011886 1.2376505,0.099735 0.020154,0.024288 0.048059,0.01602 0.051676,-0.012402 0.036174,-0.031523 1.5012004,0.1033528 v 0.056327 l 0.040308,0.00362 h 0.08785 l 0.043925,-0.051677 0.8381918,0.07183 0.036174,0.020154 h 0.075964 l 0.1953369,0.2036054 -0.00362,1.745113 0.023771,0.602547 0.035657,0.583427 0.036174,0.24753 0.036174,0.251664 0.023771,0.155547 -2.4039876,0.515214 -0.07183,0.03204 -0.051677,0.06356 v 0.15968 0.299723 l 0.00775,0.111621 0.01602,0.05994 0.048059,0.03204 H 6.20944 l 2.7951782,0.251664 0.043925,0.123506 0.064079,0.124024 0.063562,0.139526 0.088167,0.10387 0.079781,-0.10387 0.064079,-0.139526 0.063562,-0.124024 0.043925,-0.123506 2.7956948,-0.251664 h 0.0677 l 0.04806,-0.03204 0.01602,-0.05994 0.0078,-0.111621 V 14.36347 14.20379 l -0.05168,-0.06356 -0.07183,-0.03204 -2.4039878,-0.515214 0.023771,-0.155547 0.036174,-0.251664 0.035657,-0.24753 0.03617,-0.583427 0.02377,-0.602547 -0.0041,-1.745113 0.195854,-0.2036054 h 0.07596 l 0.03566,-0.020154 0.838708,-0.07183 0.04393,0.051677 h 0.08785 l 0.03979,-0.00362 v -0.055811 l 1.501717,-0.1038696 0.03566,0.031523 0.05219,0.012402 0.04806,-0.01602 0.01964,-0.024288 1.238168,-0.099735 0.03566,0.011886 0.04392,0.032039 0.05995,0.00413 0.03204,-0.011886 0.01602,-0.027905 3.530017,-0.2557983 0.03204,-0.6268351 -0.02015,-0.1157552 -0.05994,-0.099735 -0.04806,-0.036174 -0.07545,-0.011886 -6.002217,-0.4950602 -0.0036,-0.4475179 0.0078,-0.1994711 0.01602,-0.2154907 -0.01189,-0.2196248 -0.0083,-0.2160075 -0.04754,-0.1638143 -0.03617,-0.075448 -0.02377,-0.036174 -0.04031,0.00827 -0.0036,-0.072347 -0.02015,-0.1715658 -0.03979,-0.1276408 -0.04392,-0.083716 -0.05581,-0.040308 -0.04806,0.032039 -0.04806,0.1038696 -0.03617,0.1596802 -0.0155,0.1999878 h -0.05995 l -0.03617,0.051676 -0.01189,0.067696 -0.03204,0.135909 -0.0041,0.135909 -0.02791,0.1116211 -0.0036,0.1400432 0.0078,0.1317749 0.01602,0.1038696 v 0.6345866 l -1.146183,-0.08785 V 5.650301 L 10.042798,5.2591104 10.007141,5.0157144 9.9513304,4.6958373 9.8831175,4.3847452 9.8391925,4.2328165 9.7234373,3.9253417 9.5797768,3.6617919 9.4717731,3.5501708 9.3363809,3.438033 Z","a":[9.26,8.731]},"C441":{"d":"m 9.2604827,2.8506183 -0.044463,0.0054 -0.1283042,0.06692 L 8.9594113,3.095872 8.8422753,3.291138 8.7586013,3.497533 8.6860573,3.787647 8.6470093,4.094469 8.5745013,4.585382 8.5075353,5.109773 8.4796623,5.544895 8.4294493,6.38731 8.3904013,7.251974 8.3346003,7.291004 H 7.0515205 L 6.9343438,7.235254 6.9232148,6.41518 6.9064618,5.918679 6.8506698,5.494723 6.7558268,5.143231 6.6721528,5.009344 6.5996448,4.948034 6.5773138,4.942634 6.4880528,4.992804 6.3820833,5.137865 6.3262913,5.3108 l -0.03346,0.178513 -0.044626,0.234277 -0.033506,0.317988 -0.022295,0.937209 -0.00561,0.212018 -0.1004257,0.06131 -2.4657744,0.106004 -2.0306096,0.07806 -0.3793688,0.03341 -0.050213,0.401706 -0.011129,0.74753 0.4462924,0.07254 0.513215,0.0614 3.8214035,0.446287 0.2454401,0.0054 0.039084,0.03903 0.2063951,0.02228 0.1450553,0.0054 0.1673492,-0.01114 0.1673492,-0.01675 0.072544,-0.05017 1.2440351,0.01114 0.1450552,0.133887 0.016708,0.764274 0.044626,0.390495 0.050213,0.580183 0.044626,0.223148 0.050213,0.200853 0.3068208,1.723787 -2.6945052,0.317988 -0.1003849,0.0335 -0.044626,0.0614 v 0.150604 l 0.00552,0.424001 0.039048,0.156218 1.2496586,0.100381 1.439262,0.106014 0.1004265,0.0054 0.011166,0.02789 0.2845259,0.01114 v 0.708483 l 0.095854,0.320043 0.093423,-0.320043 v -0.708423 l 0.284526,-0.01114 0.01117,-0.02789 0.100386,-0.0054 1.4393024,-0.106014 1.249618,-0.100381 0.03908,-0.156218 0.0055,-0.423965 v -0.15064 l -0.04463,-0.0614 -0.100386,-0.0335 -2.6945044,-0.317988 0.306821,-1.723787 0.05021,-0.200853 0.04463,-0.223148 0.05021,-0.580183 0.04463,-0.390495 0.01671,-0.764274 0.145056,-0.133887 1.244033,-0.01114 0.07254,0.05017 0.167349,0.01675 0.167349,0.01114 0.145056,-0.0054 0.206394,-0.02228 0.03905,-0.03903 0.245481,-0.0054 3.821403,-0.446287 0.513216,-0.0614 L 17.37156,8.618885 17.36043,7.87131 17.31022,7.469649 16.930852,7.436239 14.900201,7.358179 12.434426,7.252175 12.334041,7.190865 12.328441,6.978847 12.306111,6.041638 12.272651,5.72365 12.228021,5.489373 12.194561,5.31086 l -0.0558,-0.17298 -0.10597,-0.145016 -0.08926,-0.05017 -0.02233,0.0054 -0.07251,0.06131 -0.08367,0.133887 -0.09484,0.351447 -0.0558,0.424001 -0.01675,0.496501 -0.01117,0.820074 -0.117136,0.05578 H 10.186259 L 10.130469,7.252004 10.091419,6.38734 10.041209,5.544925 10.013329,5.109803 9.9463586,4.585412 9.8738486,4.094499 9.8347986,3.787677 9.7622586,3.497563 9.6785886,3.291168 9.5614526,3.095902 9.4331476,2.9229683 9.3048037,2.8560473 Z","a":[9.26,8.202]},"SR22":{"d":"M 9.75064,15.276764 9.3186323,14.796247 M 8.7105344,15.276764 9.1425421,14.796247 M 7.7794703,4.4705654 H 10.6741 M 9.2300785,4.0810057 9.1126219,4.1516845 9.0289061,4.3428873 8.9870482,4.5041178 8.9513914,4.701005 8.7663898,4.7728352 8.6346149,4.8203775 8.5514159,4.8865233 8.48527,5.0296671 8.4077554,5.3402424 8.3240396,6.3794555 V 7.3535562 L 8.2702961,7.5085855 4.3997314,7.652246 4.3516723,7.5923013 1.072286,7.7416462 0.94722899,7.8010741 0.81545409,8.0046792 0.72605386,8.2434243 0.67799478,8.428426 0.61856688,8.4646 l -0.0361735,0.1669148 0.0480591,0.065629 -0.0180868,0.1674316 0.0480591,0.053743 0.57309162,-0.018087 0.5973796,0.07183 6.3437987,0.692981 0.083716,0.047542 -0.1131714,0.1198893 -0.1617472,-0.0062 -0.00568,0.1136882 0.1793172,0.00568 0.1612305,-0.1788005 0.059428,0.035657 0.078031,0.4361486 0.1493449,0.656808 0.2744018,1.266589 0.1912028,0.997355 0.018087,0.268718 -2.538863,0.316776 -0.07183,0.03566 -0.065629,0.14366 -0.041858,0.256832 -0.00568,0.292489 2.771407,0.125574 0.0062,0.196887 0.023771,0.53175 0.06873,0.268718 0.059428,-0.268718 0.024288,-0.53175 0.00568,-0.196887 2.7719237,-0.125574 -0.0062,-0.292489 -0.04186,-0.256832 -0.06563,-0.14366 -0.07183,-0.03566 -2.5383466,-0.316776 0.01757,-0.268718 0.1912028,-0.997355 0.2749187,-1.266589 0.1493451,-0.656808 0.07751,-0.4361486 0.05995,-0.035657 0.16123,0.1788005 0.179318,-0.00568 -0.0062,-0.1136882 -0.16123,0.0062 -0.113688,-0.1198893 0.08372,-0.047542 6.343798,-0.692981 0.59738,-0.07183 0.573608,0.018087 0.04754,-0.053743 -0.01757,-0.1674316 0.04754,-0.065629 L 17.842838,8.4645995 17.782894,8.428426 17.735351,8.2434243 17.645434,8.0046792 17.514176,7.8010741 17.388602,7.7416462 14.109216,7.5923013 14.061674,7.652246 10.190592,7.5085855 10.136849,7.3535562 V 6.3794555 L 10.053133,5.3402424 9.9756183,5.0296671 9.9099892,4.8865233 9.8262734,4.8203775 9.6950153,4.7728352 9.5094969,4.701005 9.4738402,4.5041178 9.4319823,4.3428873 9.3482664,4.1516845 Z","a":[9.26,7.673]},"SW3":{"d":"m 9.2604371,1.8288587 c -0.057435,0 -0.2600945,0.1945417 -0.4804209,0.8634905 C 8.3699731,3.9373128 8.3175086,4.7139445 8.3175086,6.4965976 v 0.5723336 l -1.306887,0.079737 c 0.01771,-0.1948192 0.031039,-0.4162266 0.031039,-0.7084563 0,-0.7571408 -0.1151543,-1.4036125 -0.1948529,-1.6117156 0.1505423,0.053132 0.7970215,0.048751 1.0626843,0.048751 0.1416874,0 0.1461152,-0.1904118 0,-0.1904121 L 6.8069883,4.7178224 C 6.7627101,4.5894182 6.6908833,4.3987225 6.6315962,4.3987225 c -0.054861,0 -0.1212855,0.186268 -0.1655629,0.3190999 L 5.3192701,4.6823944 c -0.1461152,0 -0.1505692,0.1815301 -0.00888,0.1815301 0.1771085,0 0.9741025,0.022156 1.120217,-0.04426 -0.066417,0.2346694 -0.2257897,0.8634203 -0.2257897,1.624989 0,0.2479522 -0.013281,0.55786 0,0.7571077 L 1.3697193,7.5028467 c -0.079699,0.0089 -0.1815536,0.09742 -0.172698,0.185971 l 0.070855,1.000661 6.8541344,1.1291 c 0.05313,0.2036753 0.1992434,0.9430703 0.1992434,1.1910233 0,1.018376 0.2135213,2.144325 0.3099191,2.31129 l -1.8286231,1.594003 c -0.1461145,0.128404 -0.2363183,0.434941 -0.2363183,0.704514 v 0.406821 l 2.4410761,-0.708406 v 0.0974 c 0,0.03116 0.046465,0.05963 0.1429588,0.05963 0.00878,0.53728 0.078975,1.21712 0.1096765,1.217121 0.030701,-1e-6 0.1008497,-0.679841 0.1096267,-1.217121 0.09649,0 0.1439565,-0.02847 0.1439565,-0.05963 v -0.0974 l 2.4410756,0.708406 v -0.406821 c 0,-0.269573 -0.0902,-0.57611 -0.236318,-0.704514 L 9.8896604,13.320892 c 0.096398,-0.166965 0.3099186,-1.292914 0.3099186,-2.31129 0,-0.247953 0.146111,-0.987348 0.199244,-1.1910233 l 6.854134,-1.1291 0.07085,-1.000661 c 0.0089,-0.08855 -0.093,-0.177115 -0.172703,-0.185971 L 12.316061,7.2017609 c 0.01328,-0.1992477 0,-0.5091548 0,-0.7571077 0,-0.761568 -0.159424,-1.3903194 -0.22584,-1.6249888 0.146115,0.066416 0.943109,0.04426 1.120218,0.04426 0.141688,0 0.137283,-0.1815302 -0.0088,-0.1815302 l -1.146814,0.035428 c -0.04428,-0.1328322 -0.110703,-0.3191002 -0.165563,-0.3191002 -0.05929,0 -0.131065,0.1906958 -0.175342,0.3191 l -1.102504,-0.030987 c -0.146114,3e-7 -0.141687,0.1904122 0,0.1904122 0.265663,0 0.912093,0.00438 1.062635,-0.048751 -0.0797,0.2081031 -0.194803,0.8545753 -0.194803,1.6117161 0,0.2922297 0.01328,0.5136364 0.03098,0.7084562 L 10.203316,7.0689308 V 6.4965972 c 0,-1.7826531 -0.05241,-2.5592848 -0.4624573,-3.8042484 C 9.5205331,2.0234 9.3178718,1.8288583 9.2604371,1.8288587 Z","a":[9.26,8.202]},"AT25":{"d":"m 10.44994,6.5162386 h 2.390705 m 5.6336877,6.5162386 h 2.390705 M 9.2404854,0.9094692 9.169466,0.92294106 8.9953164,1.0588501 8.8971312,1.1952759 8.7684569,1.3993978 8.6320311,1.7094563 8.5338459,1.9972941 8.4583983,2.3600626 8.4279092,2.7006103 8.3901854,3.0638956 8.3555622,7.1111937 8.277014,7.2228148 8.2325723,7.3685423 8.176245,7.6031533 8.1653929,7.7597329 H 7.0584838 L 7.1142943,7.4465738 7.1029255,7.077604 7.0693358,6.7866657 7.0135253,6.5298339 6.9127562,6.3396646 l -0.083716,-0.060461 -0.095601,0.065629 -0.095085,0.1705323 -0.090434,0.2811198 -0.029972,0.2557983 -0.00517,0.396875 -0.014986,0.3059245 -5.170227,0.3663859 -0.1002523,0.025321 -0.075448,0.050126 -0.03514,0.090434 -0.00982,0.044958 -0.085266,0.014986 L 0.970996,8.4077544 0.9461913,8.763805 0.881079,8.814448 0.8004638,8.874393 l 0.005168,0.080615 0.03514,0.085266 0.1855184,0.00465 5.3660807,0.3865397 h 1.7967895 l 0.014986,0.2961059 0.045475,0.3865394 0.1152384,0.361735 v 2.318722 l 0.025322,0.447001 0.055294,0.39119 0.1100708,0.77308 0.3012736,1.852083 -1.6562297,0.31626 -0.1054199,0.04547 -0.100769,0.100252 v 0.602548 l 0.045475,0.05013 2.047937,0.11007 v 0.191203 L 9.238266,17.8043 9.3865034,17.673853 V 17.48265 L 11.43444,17.37258 11.4794,17.32245 v -0.602548 l -0.100252,-0.100252 -0.10542,-0.04547 -1.656229,-0.31626 0.3007569,-1.852083 0.1105871,-0.77308 0.05529,-0.39119 0.02532,-0.447001 v -2.318722 l 0.115239,-0.361735 0.04496,-0.3865394 0.0155,-0.2961059 h 1.79679 l 5.365564,-0.3865397 0.186035,-0.00465 0.03514,-0.085266 0.0052,-0.080615 -0.08062,-0.059945 -0.06511,-0.050643 -0.02532,-0.3560506 -0.05013,-0.060461 -0.08527,-0.014986 -0.0098,-0.044958 -0.03514,-0.090434 -0.07545,-0.050126 -0.100252,-0.025321 -5.170227,-0.3663859 -0.01499,-0.3059245 -0.0052,-0.396875 -0.02997,-0.2557983 -0.09043,-0.2811198 -0.0956,-0.1705323 -0.09508,-0.065629 -0.08423,0.060461 -0.100252,0.1901693 -0.05633,0.2568318 -0.03359,0.2909383 -0.01085,0.3689698 0.05581,0.3131591 H 10.308931 L 10.297562,7.6031533 10.241752,7.3685423 10.19731,7.2228148 10.118762,7.1111937 10.084139,3.0638956 10.046415,2.7006103 10.015926,2.3600626 9.9404783,1.9972941 9.8417764,1.7094563 9.7058673,1.3993978 9.577193,1.1952759 9.4790078,1.0588501 9.3048582,0.92294106 Z","a":[9.26,8.467]},"F100":{"d":"m 9.2672207,1.4582685 c -0.4316516,-0.01811 -0.6791716,1.545495 -0.6791716,1.545495 v 4.632321 l -1.618202,0.775738 -3.305318,1.2141992 c -0.20237,0.101183 -0.20237,0.202367 -0.20237,0.202367 l -0.13491,0.5396443 2.39467,-0.202367 0.03373,0.337278 0.06746,-0.337278 1.146744,-0.06745 0.101183,0.472188 0.101183,-0.505916 1.281655,-0.1011833 c 0,0.2698223 0.134911,0.5396443 0.134911,0.5396443 v 0.910649 H 8.4876011 V 11.244959 C 8.3864181,11.07632 8.0828681,11.07632 8.0828681,11.07632 c -0.269821,0 -0.269821,0.101184 -0.269821,0.101184 v 0.775738 c 0,0.640827 0.101183,1.247927 0.101183,1.247927 0.101183,0.06746 0.269822,0.06746 0.269822,0.06746 0.168638,0 0.202366,-0.06746 0.202366,-0.06746 l 0.337278,0.303549 c 0.202366,1.113017 0.43846,1.720116 0.43846,1.720116 l -1.855026,1.146743 c -0.202366,0.168639 -0.202366,0.43846 -0.202366,0.43846 v 0.236095 l 2.057392,-0.472188 c 0,0.236093 0.1011836,0.371005 0.1011836,0.371005 0.06745,-0.06746 0.134911,-0.371005 0.134911,-0.371005 l 2.0236653,0.472188 V 16.77631 c 0,-0.269822 -0.202367,-0.404733 -0.202367,-0.404733 L 9.3645227,15.224834 c 0.269822,-0.573372 0.438461,-1.720116 0.438461,-1.720116 l 0.3710053,-0.303549 c 0.06746,0.06746 0.202366,0.06746 0.202366,0.06746 0.168639,0 0.236095,-0.06746 0.236095,-0.06746 0.06745,-0.438461 0.101183,-1.281655 0.101183,-1.281655 0.03373,-0.337277 0,-0.809466 0,-0.809466 -0.134911,-0.03373 -0.269822,-0.03373 -0.269822,-0.03373 -0.236094,0 -0.371005,0.101184 -0.371005,0.101184 -0.03373,0.06745 -0.03373,0.236094 -0.03373,0.236094 h -0.06746 V 10.30058 c 0.06746,-0.06746 0.06746,-0.3372773 0.06746,-0.3372773 l 1.34911,0.1011833 c 0,0.202366 0.101183,0.505916 0.101183,0.505916 0.03373,-0.101183 0.06746,-0.472188 0.06746,-0.472188 l 1.146743,0.06745 c 0,0.101183 0.06746,0.337278 0.06746,0.337278 0.03373,-0.134911 0.03373,-0.337278 0.03373,-0.337278 l 2.39467,0.202367 -0.06746,-0.3710063 C 15.064512,9.6597477 14.86215,9.6260197 14.86215,9.6260197 L 11.590559,8.4118205 9.9716257,7.6023545 v -4.586974 c -0.269822,-1.618932 -0.704395,-1.557114 -0.704395,-1.557114 z","a":[9.26,8.731]},"AT75":{"d":"M 9.2071898,1.2004435 9.1415607,1.2149129 8.9653441,1.3435872 8.7296995,1.6629476 8.5121418,2.1404378 8.395353,2.6504842 8.359696,3.0954182 8.350916,7.2558877 8.287871,7.3726765 l -0.1519287,0.396875 -0.025838,0.044442 -0.034623,0.00723 H 7.0336791 l 0.021704,-0.2284098 0.0062,-0.2816366 -0.015503,-0.2501139 -0.037207,-0.2134237 -0.083199,-0.1390096 -0.0093,-0.1116211 -0.037207,-0.1638143 -0.040308,-0.0894 -0.05271,-0.037207 -0.055294,-0.015503 -0.05271,0.021704 -0.040308,0.040308 -0.040308,0.0863 -0.03359,0.151412 -0.0062,0.096118 -0.062012,0.135909 -0.043408,0.1731161 -0.015503,0.2754354 -0.0031,0.2408121 0.021704,0.1545126 0.031006,0.1669148 -5.2064005,0.3834392 -0.052193,0.024805 -0.049609,0.055811 -0.024805,0.076998 -0.015503,0.074414 -0.058394,0.012402 -0.031006,0.049609 -0.027905,0.1080038 -0.0062,0.1948201 0.015503,0.340031 5.2802977,0.2594156 h 1.9011759 l 0.05271,0.1302246 0.083716,0.1390096 v 2.1797126 l 0.0062,0.379822 0.018087,0.398941 0.034107,0.473357 0.065112,0.52865 0.1607137,0.95188 0.2475301,1.406632 -1.6014526,0.281637 -0.074414,0.04909 -0.071313,0.10232 -0.039791,0.154513 -0.021704,0.201021 0.0031,0.253215 1.8794718,0.10542 0.096118,-0.120406 0.015503,0.123506 0.039791,0.132809 0.055811,0.07441 0.071314,0.03669 0.080098,-0.04599 0.055294,-0.0739 0.040308,-0.133325 0.015503,-0.123507 0.095601,0.120406 1.8799878,-0.104903 0.0031,-0.253731 -0.0217,-0.201022 -0.04031,-0.154512 -0.0708,-0.101803 -0.07441,-0.04961 -1.6014528,-0.28112 0.2475301,-1.406632 0.1607147,-0.952397 0.0646,-0.52865 0.03411,-0.472839 0.0186,-0.398942 0.0062,-0.380339 V 9.6733112 l 0.08372,-0.1390096 0.05219,-0.1297079 h 1.901693 l 5.280298,-0.2599324 0.0155,-0.3400309 -0.0062,-0.1948202 -0.02791,-0.1080037 -0.03101,-0.049609 -0.05891,-0.012402 -0.0155,-0.073897 -0.02429,-0.077515 -0.04961,-0.055294 -0.05271,-0.024805 -5.2064,-0.3834392 0.03101,-0.1669148 0.0217,-0.1545126 -0.0031,-0.2413289 -0.0155,-0.2749186 -0.04289,-0.1731161 -0.06201,-0.1364257 -0.0062,-0.095601 -0.03411,-0.151412 -0.04031,-0.086816 -0.03979,-0.040308 -0.05271,-0.021187 -0.05581,0.014986 -0.05271,0.037207 -0.03979,0.089917 -0.03721,0.1638143 -0.0093,0.1111044 -0.08372,0.1390096 -0.03669,0.2134236 -0.0155,0.2506307 0.0062,0.2811198 0.02119,0.2289266 h -1.041797 l -0.03462,-0.00775 -0.02532,-0.044442 -0.152446,-0.396875 -0.06253,-0.116272 -0.0093,-4.1604695 -0.03566,-0.444934 L 9.9606321,2.131136 9.7425576,1.6536458 9.5069131,1.3342855 9.3306964,1.2061279 9.2728188,1.2035441 Z m 10.495696,6.509431 0.01195,0.143348 1.048751,-0.064551 -1.060704,-0.078797 m 11.916362,6.6049678 1.014787,0.071631 V 6.4975641 Z","a":[9.26,7.673]},"DHC5":{"d":"m 5.2827211,5.4105759 h 2.537117 M 10.697843,5.4105759 H 13.23496 M 9.2553722,2.5211278 9.1069375,2.5553995 9.0056517,2.6411824 8.9276203,2.8122314 8.9043659,3.0618286 8.8030801,3.2096232 8.6780231,3.4902262 8.5689858,3.9108723 8.4754515,4.4720784 8.4134398,5.0327677 8.3979369,5.3056192 V 6.8094034 H 6.9406615 L 6.9174071,6.6223347 6.8941527,6.5443033 V 5.8353026 L 6.6057982,4.9547362 H 6.496761 l -0.2645834,0.857312 v 0.7555095 l -0.1012858,0.225826 -5.0797932,0.4051432 -0.15606281,0.062528 -0.1245402,0.1638143 -0.007751,0.2490804 0.054777,0.2335774 0.17880046,0.350883 5.2591104,0.6697265 0.1477946,0.015503 0.023254,0.3038574 0.054777,0.1328084 0.1322917,-0.00775 0.07028,-0.1560629 0.062528,-0.3193603 h 1.6278076 v 3.2954058 l 0.047026,0.615467 0.062528,0.529683 0.085266,0.607715 0.1870687,1.012858 -2.1812621,0.249597 -0.1167888,0.06201 -0.047025,0.747758 0.078031,0.272851 0.1090373,0.06253 2.688478,0.218074 2.6331612,-0.218074 0.109554,-0.06253 0.07751,-0.272851 -0.04651,-0.747758 -0.116789,-0.06201 -2.1817791,-0.249597 0.1870687,-1.012858 0.085782,-0.607715 0.06253,-0.529683 0.04651,-0.615467 V 8.8971312 h 1.628324 l 0.06253,0.3193603 0.06976,0.1560629 0.132808,0.00775 0.05426,-0.1328084 0.02326,-0.3038574 0.148311,-0.015503 5.258594,-0.6697265 0.179317,-0.350883 0.05426,-0.2335774 -0.0078,-0.2490804 -0.12454,-0.1638143 -0.155546,-0.062528 -5.079794,-0.4051432 -0.101285,-0.225826 V 5.8120482 l -0.265101,-0.857312 h -0.109037 l -0.287838,0.8805664 v 0.7090007 l -0.02377,0.078031 -0.02325,0.1870687 H 10.120312 V 5.3056192 L 10.104809,5.0327677 10.042281,4.4720784 9.9487466,3.9108723 9.8397093,3.4902262 9.7151691,3.2096232 9.6138833,3.0618286 9.5906289,2.8122314 9.5125975,2.6411824 9.4113117,2.5553995 Z","a":[9.26,7.673]},"CT4":{"d":"m 7.267131,3.1660925 h 3.973951 M 9.2541065,2.8029683 9.114689,2.8773433 9.040792,3.0561438 8.966378,3.3331294 8.948291,3.5429357 l -0.1850017,0.030489 -0.1850016,0.037207 -0.073897,0.092501 -0.049093,0.3756876 -0.043408,0.5115967 -0.042891,0.4743896 -0.024805,0.4066936 -0.042891,0.517281 -0.1111043,0.061495 -1.7068725,0.7704956 -0.5172811,0.018087 -4.2591715,0.331246 -0.1147216,0.035657 -0.1002523,0.107487 -0.0863,0.1720825 -0.042891,0.2790527 -0.021187,1.0386963 0.1074869,0.07183 1.9983276,0.3436483 0.035657,0.071314 0.372587,0.07183 0.064596,-0.064595 4.3403035,0.7162354 0.079065,0.515731 0.5586222,3.552755 v 0.172082 l -2.7936279,0.229443 -0.1503784,0.05684 -0.107487,0.143661 -0.085783,0.221692 -0.021704,1.131714 0.057361,0.05736 3.4793741,-0.01395 3.4380326,0.01395 0.05736,-0.05736 -0.0217,-1.131714 -0.08578,-0.221692 -0.107487,-0.143661 -0.150378,-0.05684 -2.793628,-0.229443 v -0.172082 l 0.558622,-3.552755 0.07906,-0.515731 4.340304,-0.7162354 0.06459,0.064595 0.372587,-0.07183 0.03566,-0.071314 1.998328,-0.3436483 0.107487,-0.07183 L 17.14779,7.7643838 17.104899,7.4853311 17.018599,7.3132486 16.918347,7.2057616 16.803625,7.1701049 12.544454,6.8388589 12.027173,6.8207722 10.3203,6.0502766 10.209196,5.9887816 10.166304,5.4715006 10.1415,5.064807 10.098608,4.5904174 10.0552,4.0788207 10.006107,3.7031331 9.9322101,3.6106323 9.7472085,3.5734252 9.5622069,3.5429361 9.5441201,3.3331298 9.4702228,3.0561442 9.3963255,2.8773437 Z","a":[9.26,7.408]},"A109":{"d":"m 8.5648283,15.238123 -0.027614,2.172272 m 9.0246572,3.7575321 -0.1442538,0.037422 -0.1331339,0.07251 -0.1844848,0.199471 -0.092501,0.1550293 -0.095085,0.2351278 -0.098185,0.333313 -0.065629,0.3570841 -0.053743,0.3632853 -0.020671,0.5808431 -0.0031,0.6728272 v 2.0691243 l 0.038757,0.4495849 0.2645833,2.4649659 0.042375,0.467672 0.1596108,2.081218 -1.3771075,0.08402 -0.075964,0.104903 v 0.223759 l 0.03359,0.06718 1.4660604,0.193786 0.092501,0.875916 0.00878,0.307474 -0.1348755,0.173116 v 0.07545 l 0.1136882,0.126607 0.1307413,0.534851 h 0.1472779 l 0.092501,-0.353983 0.054777,-0.210323 -0.00413,-0.13901 -0.021187,-0.172599 -0.016536,-0.185519 -0.00413,-0.172599 0.088297,-0.837983 0.7684974,-0.04155 0.570508,-0.08475 0.116789,-0.02015 0.03721,-0.04858 V 14.53658 l -0.03101,-0.077 -0.07183,-0.03152 -1.3239027,-0.129232 0.3513523,-3.450395 v -10e-4 L 9.6970823,10.46086 9.8200723,9.5053628 9.8857013,8.55555 9.9027545,7.869287 9.9285928,7.2600218 V 6.3071084 L 9.9198078,6.0554442 9.8888019,5.6492675 9.8598631,5.4777017 9.8397093,5.3288736 9.765812,4.874121 9.6882974,4.5511433 9.6112995,4.3392699 9.5022622,4.1217122 9.3823729,3.9387776 9.29659,3.8504109 9.1672841,3.780887 Z m 4.4945967,3.2585269 -0.088883,0.00207 -0.166397,0.1643322 v 0.090951 l 0.028936,0.037209 4.2054281,4.2322996 h 0.037206 L 8.722758,7.9988129 A 0.37373784,0.37373784 0 0 0 8.63698,8.2370344 0.37373784,0.37373784 0 0 0 8.721729,8.4731957 l -0.00672,-0.00672 -0.2392619,0.2402954 -0.060979,0.00207 -0.2542451,0.2490832 -0.6056478,0.2790527 -3.5243345,3.515029 0.00207,0.08888 0.1643322,0.166397 H 4.287894 L 4.3251034,12.97835 8.557403,8.7729214 V 8.7357148 L 8.7708293,8.5238441 A 0.37373784,0.37373784 0 0 0 9.0106079,8.6111774 0.37373784,0.37373784 0 0 0 9.249353,8.524361 h 5.168e-4 l 0.2387478,0.2371922 0.00207,0.060979 0.2490833,0.2542452 0.2790531,0.605648 3.515032,3.5243376 0.08888,-0.0021 0.166425,-0.164304 2e-6,-0.09095 -0.02894,-0.03721 L 9.5547529,8.6799015 H 9.5175464 L 9.3051563,8.4669946 A 0.37373784,0.37373784 0 0 0 9.3842208,8.2370345 0.37373784,0.37373784 0 0 0 9.2793176,7.977102 l 0.2330607,-0.2340942 0.060978,-0.00207 0.2542448,-0.249083 0.6056479,-0.2790529 3.524335,-3.5150292 -0.0021,-0.088885 -0.164304,-0.1664253 -0.09095,-1.4e-6 -0.03721,0.028935 -4.2322992,4.2054281 v 0.037206 L 9.2173306,7.9259038 a 0.37373784,0.37373784 0 0 0 -0.2067305,-0.06249 0.37373784,0.37373784 0 0 0 -0.2356445,0.084233 l 0.00517,-0.00465 L 8.5398258,7.7037357 8.5377589,7.6427569 8.2886756,7.3885117 8.0096229,6.782864 Z","a":[9.26,5.027]},"A319":{"d":"M 9.2895867,0.41982862 9.2290527,0.44046712 9.07454,0.57493996 8.9060703,0.76837976 8.6939263,1.1302906 l -0.156033,0.3868799 -0.09361,0.4118948 -0.09983,0.5428666 -0.012484,0.358456 -0.031187,0.018704 -0.012491,0.037453 -0.00621,1.7347866 -0.00626,1.5724883 L 8.0705801,6.4184943 6.6977504,7.1423626 6.7601728,6.9426572 6.7975822,6.7429521 6.8413008,6.4746514 6.847519,5.9878959 6.7913619,5.5698279 6.7289394,5.376388 H 5.8615691 l -0.037453,0.2184089 -0.037405,0.6551805 0.01244,0.5616162 0.049937,0.3494724 0.037453,0.09361 0.1934309,0.2059243 -3.0826471,1.609942 -2.24646484,1.1731747 -0.14354804,0.124799 -0.08108,0.143547 -0.0374534,0.112314 v 0.542869 l 1.87829218,-0.605289 0.717603,-0.19966 v 0.149767 l 0.056157,0.09356 0.049937,-0.0187 0.031189,-0.07486 v -0.193486 l 1.7106927,-0.5323191 0.00626,0.193442 0.031187,0.04994 h 0.049891 l 0.049937,-0.06864 0.037453,-0.112315 v -0.118581 l 0.9476208,-0.2976012 0.6143183,-0.00626 -0.00621,0.1497671 0.037405,0.068641 h 0.056157 l 0.056203,-0.04367 V 9.4137507 l 1.4357587,-0.00623 -0.00626,1.7909493 -0.025108,1.010919 0.024463,0.991384 0.017186,0.537661 c 0.049932,0.48914 0.1336599,0.984248 0.220987,1.477358 l -0.05307,0.157553 -0.120099,0.15396 -0.3182386,0.212188 -1.8408353,1.18561 -0.1247986,0.124792 -0.074907,0.18722 v 0.455521 l 0.9485422,-0.205924 1.1356707,-0.274566 0.79251,-0.174736 0.01875,0.274566 0.037408,0.205924 0.1560331,0.586584 0.1302813,-0.0012 0.1411531,0.0012 0.1560331,-0.586584 0.037408,-0.205924 0.018751,-0.274566 0.7924667,0.174736 1.135717,0.274566 0.948543,0.205924 v -0.455508 l -0.07492,-0.187221 -0.124798,-0.124799 -1.840836,-1.185609 -0.318284,-0.212188 -0.08108,-0.174737 -0.037451,-0.149767 c 0.093639,-0.504627 0.178056,-1.005497 0.218419,-1.516332 l 0.05616,-0.511725 0.03119,-0.936011 0.03119,-1.010919 -0.0062,-1.7909485 1.422768,0.00627 v 0.1871754 l 0.05616,0.043721 h 0.05616 l 0.03745,-0.068642 -0.0063,-0.1497677 0.649008,0.00623 0.917308,0.2933172 v 0.1185345 l 0.03741,0.112315 0.04994,0.06864 h 0.04994 l 0.03119,-0.04989 0.0062,-0.193441 1.741006,0.53665 v 0.193439 l 0.03123,0.07486 0.04989,0.01875 0.05616,-0.09361 v -0.149776 l 0.717639,0.199706 1.878289,0.605289 v -0.542913 l -0.03746,-0.112314 -0.08112,-0.143503 -0.143494,-0.124845 -2.246472,-1.173127 -3.082648,-1.6099886 0.193421,-0.2059243 0.03745,-0.093611 0.04989,-0.3494265 0.01248,-0.5616162 -0.03745,-0.655227 -0.03741,-0.2184085 h -0.867415 l -0.06238,0.19344 -0.05616,0.418114 0.0062,0.4867094 0.04367,0.2683468 0.03745,0.199659 0.06242,0.1997055 L 10.450148,6.4478443 10.312865,6.2232162 10.306665,4.6506818 10.300465,2.915895 10.287985,2.878488 10.256745,2.859739 10.244305,2.454148 10.144475,1.911236 10.050862,1.4993873 9.8948747,1.1125075 9.6826817,0.75055046 9.5142084,0.55711071 9.351957,0.43231217 Z","a":[9.26,7.673]},"E190":{"d":"M 9.2634963,0.91701053 C 8.600838,1.257304 8.5890979,2.6679718 8.5890979,2.6679718 V 6.9432872 L 8.3044894,7.4258843 7.5558452,7.8156743 C 7.6734009,7.6424344 7.6795879,7.0794044 7.6795879,7.0794044 7.7105239,6.6524915 7.6115293,6.5225616 7.6115293,6.5225616 H 6.763891 C 6.6525225,6.6277431 6.6587095,7.1289015 6.6587095,7.1289015 6.6525195,7.6548086 6.7886394,7.7971128 6.7886394,7.7971128 l 0.074245,0.00619 0.061872,0.3155437 -3.8917126,1.9736985 c -0.1299301,0.08662 -0.1484916,0.197986 -0.1484916,0.197986 l -0.2412984,0.872388 v 0.167052 h 0.074245 l 0.2474861,-0.414538 1.9056399,-0.501159 v 0.235112 l 0.04331,0.105181 0.049497,-0.117556 v -0.247485 l 1.2745514,-0.340294 v 0.19799 l 0.04331,0.105181 0.04331,-0.06806 V 10.024484 L 6.8938209,9.8698055 h 0.5320943 v 0.2165495 l 0.049497,0.06806 0.049497,-0.04331 V 9.8636185 h 1.0580013 v 3.4833605 c 0.029337,1.224798 0.2784215,2.159314 0.2784215,2.159314 l -1.707651,1.194118 c -0.1794273,0.12993 -0.1670529,0.365042 -0.1670529,0.365042 l -0.00619,0.395977 2.072693,-0.550656 c 0.1113685,0.705334 0.2041756,0.699147 0.2041756,0.699147 0.08662,0.0062 0.2289243,-0.711522 0.2289243,-0.711522 l 2.066508,0.569218 -0.0062,-0.34648 c -0.01856,-0.327919 -0.099,-0.371229 -0.099,-0.371229 L 9.6656606,15.500106 C 9.9812052,14.021378 9.9564562,13.359355 9.9564562,13.359355 V 9.8512442 h 1.0208778 l 0.04331,0.2907958 0.08662,-0.2907958 h 0.532094 l 0.538282,0.1794268 0.05569,0.296983 0.08044,-0.253672 1.25599,0.358853 0.02475,0.303171 0.08044,-0.266048 1.874703,0.501159 0.204176,0.266047 0.05569,0.099 0.06806,-10e-7 V 11.101049 L 15.642444,10.259597 C 15.599131,10.135853 15.450639,10.05542 15.450639,10.05542 l -3.860778,-1.9365758 0.05569,-0.309357 h 0.07425 C 11.855909,7.7847386 11.886844,7.1536501 11.886844,7.1536501 11.874471,6.497813 11.763101,6.4978129 11.763101,6.4978129 H 10.915463 C 10.785533,6.7267372 10.810282,7.0732172 10.810282,7.0732172 10.822662,7.5681886 10.958773,7.8033 10.958773,7.8033 L 10.272,7.4568201 9.9564562,6.9432873 V 2.6617847 C 9.9378952,1.2078066 9.2634963,0.91701053 9.2634963,0.91701053 Z","a":[9.26,8.467]},"A318":{"d":"M 9.2604132,1.634002 9.1570603,1.6908461 8.9663743,1.8768813 8.7653529,2.1605849 8.5844854,2.552809 8.4248052,3.0530369 8.3369553,3.9149998 v 2.6675374 l -0.051676,0.066663 v 0.098185 L 8.1457525,6.9282525 6.8920823,7.578342 6.954094,7.3199599 6.9850998,6.9949151 6.9902675,6.7008762 6.9799322,6.396502 6.9437587,6.1076308 6.9179205,5.9629368 H 6.0513067 l -0.036174,0.144694 -0.025838,0.350883 -0.010335,0.3922241 0.00517,0.3612182 0.031006,0.3147095 0.041341,0.2475301 0.077515,0.1648478 -4.6901557,2.4561805 -0.1808675,0.108521 -0.1493449,0.144177 -0.08785,0.186035 v 0.598413 l 0.046509,-0.10852 2.3838338,-0.706934 v 0.129191 l 0.061495,0.103353 0.082682,-0.09302 v -0.18035 l 1.609721,-0.495575 v 0.155029 l 0.072347,0.09767 0.077515,-0.0925 V 10.044341 L 6.2419927,9.7658052 h 0.567924 l 0.015503,0.175183 0.066663,0.06718 0.077515,-0.09767 0.010335,-0.149861 h 1.3363525 v 1.9657708 l 0.051677,0.75861 0.046509,0.505396 0.082682,0.464571 0.07183,0.340547 -0.041341,0.185519 -0.07183,0.180867 -1.9967773,1.300179 -0.144694,0.124024 -0.056844,0.113171 -0.010335,0.160197 v 0.340548 l 2.6572021,-0.603581 0.041341,0.330212 0.072347,0.345716 0.082682,0.33538 0.097668,0.01499 0.059012,0.12236 0.065012,-0.12236 0.097668,-0.01499 0.082682,-0.33538 0.072347,-0.345716 0.041341,-0.330212 2.657202,0.603581 v -0.340548 l -0.01033,-0.160197 -0.05684,-0.113171 -0.144694,-0.124024 -1.996777,-1.300179 -0.07183,-0.180867 -0.04134,-0.185519 0.07235,-0.340547 0.08217,-0.464571 0.04651,-0.505396 0.05168,-0.75861 V 9.7606372 h 1.336353 l 0.01033,0.149861 0.07751,0.09767 0.06718,-0.06718 0.0155,-0.175183 h 0.567407 l 0.882117,0.2785358 v 0.196371 l 0.07751,0.0925 0.07235,-0.09767 v -0.155027 l 1.609721,0.495577 v 0.18035 l 0.08268,0.09302 0.06201,-0.103353 v -0.129191 l 2.383317,0.706934 0.04651,0.10852 v -0.598415 l -0.08734,-0.186035 -0.149862,-0.144177 -0.180351,-0.108521 -4.690153,-2.4561805 0.077,-0.1648478 0.04134,-0.2475301 0.03101,-0.3147095 0.0052,-0.3612182 -0.01033,-0.3922241 -0.02584,-0.350883 -0.03617,-0.144694 H 11.60295 L 11.57711,6.1076308 11.54094,6.396502 11.5306,6.7008762 11.5358,6.9949151 11.56681,7.3199599 11.62882,7.578342 10.375074,6.9282525 10.235548,6.747385 v -0.098185 l -0.05168,-0.066663 V 3.9149998 L 10.096538,3.0530369 9.9363406,2.552809 9.7559901,2.1605849 9.5544521,1.8768813 9.363766,1.6908461 Z","a":[9.26,7.937]},"AN26":{"d":"m 10.437007,4.6121632 h 2.107282 M 5.9030115,4.6121632 H 8.010293 M 9.2288175,1.5288837 9.1787677,1.5409912 8.9891152,1.7053222 8.774658,2.1419881 8.5937905,2.6613362 8.4780353,3.1718994 8.3793333,3.9547973 V 6.154663 H 7.3080809 L 7.3576903,5.8745767 7.3659585,5.404838 7.3246174,5.1247517 7.2915445,4.9273477 7.176306,4.7459635 7.0858723,4.7376952 V 4.6059203 4.4658772 L 7.0362629,4.350122 6.9623656,4.3010294 6.8631468,4.3666585 6.805786,4.4658772 v 0.271818 L 6.731372,4.7542312 6.657475,4.8777379 6.607866,5.0260492 6.542237,5.2813308 6.533967,5.8332351 6.550503,6.1298578 H 6.467821 l -5.65185125,0.9808187 -0.10748698,0.098702 -0.0573608,0.1400432 0.007751,0.1400431 0.0413411,0.1317749 0.0909505,0.1235067 0.0573608,0.033073 5.76760653,0.2309936 0.033073,0.2552816 0.082166,0.3787882 0.1235067,0.2392619 0.1979208,-0.2392619 0.1152384,-0.37052 0.041341,-0.1565796 H 8.371064 v 3.8560958 l 0.024805,0.601514 0.057878,0.502294 0.1069702,0.131775 -2.2164021,0.791166 -0.098702,0.0987 -0.057878,0.148312 v 0.255281 l 0.065629,0.107487 0.1074869,0.08217 h 2.5538493 l 0.066146,0.148311 0.1483114,0.140043 0.098702,0.01654 0.099219,-0.01654 0.1483114,-0.140043 0.065629,-0.148311 h 2.5543669 l 0.10697,-0.08217 0.06615,-0.107487 V 14.24564 l -0.05788,-0.148312 -0.0987,-0.0987 -2.2164026,-0.791166 0.1069706,-0.131775 0.05788,-0.502294 0.0248,-0.601514 V 8.1157835 h 1.161687 l 0.04082,0.1565796 0.115755,0.37052 0.197404,0.2392619 0.123507,-0.2392619 0.08268,-0.3787882 0.03307,-0.2552816 5.76709,-0.2309936 0.05788,-0.033073 0.09043,-0.1235067 0.04134,-0.1317749 0.0083,-0.1400431 -0.05788,-0.1400432 -0.10697,-0.098702 -5.652368,-0.9808187 h -0.08217 l 0.01654,-0.2966227 -0.0083,-0.5519043 -0.06563,-0.2552816 -0.04961,-0.1483113 -0.07441,-0.1235067 -0.0739,-0.016536 v -0.271818 l -0.05788,-0.099219 -0.0987,-0.065629 -0.07441,0.049093 -0.04909,0.1157552 v 0.1400431 0.1317749 l -0.09095,0.00827 -0.115239,0.1813842 -0.03307,0.197404 -0.04082,0.2800863 0.0083,0.4697387 0.04909,0.2800863 H 10.076904 V 3.9547973 L 9.9776854,3.1718994 9.8624469,2.6613362 9.6810627,2.1419881 9.4671222,1.7053222 9.2774697,1.5409912 Z","a":[9.26,7.937]},"TWEN":{"d":"m 9.2604562,4.1242617 c -0.0517,0 -0.16683,0.27345 -0.1869,0.46537 l -1.11516,0.0238 1.11016,0.14176 c -0.37005,0.14551 -0.41772,0.18814 -0.43654,0.56195 l -0.14051,2.05976 c -0.22077,-0.0439 -0.47791,-0.10912 -0.62593,-0.10912 h -4.9005 c -0.16321,0 -0.24838,0.10797 -0.26257,0.21441 l -0.12417,1.23118 2.38424,0.41865 h 3.5764 c 0,0.80894 0.49318,3.6722103 0.55704,4.0447503 h -1.88044 c -0.22353,0 -0.0958,1.00761 0,1.00406 h 2.00819 l 0.026,0.21574 h 0.0213 l 0.026,-0.21574 h 2.0081498 c 0.0958,0.004 0.22352,-1.00406 0,-1.00406 H 9.4248162 c 0.0639,-0.37254 0.55699,-3.2358103 0.55699,-4.0447503 h 3.5764098 l 2.38428,-0.41865 -0.12421,-1.23118 c -0.0142,-0.10644 -0.0993,-0.21441 -0.26253,-0.21441 h -4.90049 c -0.14803,0 -0.40521,0.0652 -0.62599,0.10912 l -0.1404598,-2.05976 c -0.0188,-0.37381 -0.0665,-0.41644 -0.43654,-0.56195 l 1.1101598,-0.14176 -1.1151998,-0.0238 c -0.0201,-0.19192 -0.13523,-0.46537 -0.18691,-0.46537 z","a":[9.26,8.202]},"SONX":{"d":"m 9.2604762,3.9687497 c 5.95e-5,0 -0.148122,0.06498 -0.1533195,0.3170437 0,0.016889 -0.037681,0.055188 -0.084116,0.084116 -0.026941,0.015932 -0.2218366,0.041897 -0.245224,0.030199 -0.024685,-0.014294 -0.02729,-0.027263 -0.051975,-0.022072 C 8.5179591,4.4079214 8.4556097,4.4923686 8.3646611,4.893842 L 8.2620126,5.3745617 c -0.015592,0.07016 -0.033797,0.181889 -0.036392,0.311817 V 6.5153551 L 7.7318835,6.8297358 h -0.077967 c 0,-0.3715897 -0.087016,-0.5027787 -0.1376875,-0.5352604 -0.053604,0.03095 -0.1637243,0.1766637 -0.1637243,0.5352604 H 1.4902282 c -0.077958,0 -0.3378051,0.215722 -0.3378051,0.6678667 V 9.6128043 H 8.3295746 L 8.9583859,13.739256 7.206977,14.643539 c -0.5428158,0.140623 -0.2962009,0.691218 -0.1974565,1.101786 h 1.9176983 l 0.1533194,-0.387169 0.054589,0.462523 h 0.093502 c 0,0 -0.028552,0.205277 -0.0026,0.244255 h 0.036348 0.036392 c 0.025992,-0.03898 -0.0026,-0.244255 -0.0026,-0.244255 h 0.093551 l 0.054544,-0.462523 0.1533195,0.387169 H 11.51529 c 0.09874,-0.410568 0.345359,-0.961163 -0.197457,-1.101786 L 9.5664241,13.739256 10.195235,9.6128043 h 7.177154 V 7.4976025 c 0,-0.4521447 -0.259849,-0.6678667 -0.337805,-0.6678667 h -5.862278 c 0,-0.3585967 -0.110117,-0.5043117 -0.163724,-0.5352604 -0.05067,0.03248 -0.137687,0.1636707 -0.137687,0.5352604 h -0.07797 L 10.299188,6.5153551 V 5.6864267 c -0.0026,-0.129927 -0.0208,-0.241705 -0.03639,-0.311865 L 10.160198,4.893842 C 10.06925,4.4923686 10.006852,4.4079198 9.7989703,4.3780362 c -0.024685,-0.00519 -0.02729,0.00779 -0.051975,0.022072 C 9.723608,4.4117971 9.5287166,4.385841 9.5017714,4.3699093 9.4553368,4.3409816 9.4176556,4.3026918 9.4176556,4.2857934 9.4124643,4.0337323 9.2604762,3.9687497 9.2604167,3.9687497 c -1.98e-5,0 5.95e-5,0 5.95e-5,0 z","a":[9.26,7.937]},"A19N":{"d":"M 9.2889726,0.612133 9.2297686,0.6323192 9.0786437,0.7638434 8.9138677,0.95304157 8.7063755,1.3070169 8.553764,1.6854134 8.4622068,2.0882765 8.3645661,2.6192392 8.3523529,2.9698351 8.3218437,2.9881286 8.3096304,3.0247605 8.3035557,4.7215073 8.2974011,6.259515 8.0966934,6.4792626 6.7539668,7.1872579 6.8150203,6.9919321 6.8516056,6.7966057 6.8943644,6.5341881 6.9004447,6.058106 6.8455191,5.6492053 6.7844655,5.460007 H 5.9361146 l -0.036632,0.2136194 -0.036585,0.6408144 0.012165,0.5493013 c 0.00561,0.2790867 0.085909,0.441303 0.2746715,0.6347766 l -3.015052,1.5746392 -2.19720544,1.1474451 -0.14040054,0.122063 -0.0793016,0.1404 -0.0366318,0.10985 V 11.12388 L 2.5182477,10.531864 3.2201153,10.336582 v 0.146484 l 0.054925,0.09151 0.048843,-0.0183 0.030504,-0.07322 v -0.189242 l 1.6731815,-0.5206438 0.00613,0.1891967 0.030504,0.04885 h 0.048798 l 0.048844,-0.06713 0.036632,-0.1098497 v -0.115979 l 0.9268416,-0.291075 0.6008481,-0.0062 -0.00608,0.146485 0.036586,0.06713 h 0.054925 l 0.054971,-0.04271 v -0.183115 l 1.404275,-0.0061 -0.00615,1.7516728 -0.024554,0.988752 0.023931,0.969647 0.016809,0.525871 0.0315,0.04046 0.00512,0.423409 0.012213,0.0488 0.036632,0.02442 0.1307132,0.907873 -0.051906,0.154098 -0.1174787,0.15065 -0.3112595,0.207536 -1.8004705,1.159612 -0.122062,0.122062 -0.073264,0.183115 v 0.445533 l 0.9277432,-0.201409 1.1107682,-0.268545 0.775132,-0.170905 0.018336,0.268546 0.036584,0.201408 0.1526116,0.573723 0.1274233,-0.0012 0.1380579,0.0012 0.1526116,-0.573723 0.036584,-0.201408 0.018336,-0.268546 0.7750862,0.170905 1.110813,0.268545 0.927744,0.201409 v -0.445533 l -0.07326,-0.183115 -0.122061,-0.122062 -1.800471,-1.159612 -0.311305,-0.207536 -0.079298,-0.170905 -0.036632,-0.146483 0.128146,-0.945992 0.03663,-0.02442 0.01221,-0.04885 -0.0061,-0.43945 0.04271,-0.02438 0.05493,-0.500504 0.0305,-0.915487 0.03051,-0.988751 -0.0061,-1.7516728 1.391569,0.0062 v 0.18307 l 0.05493,0.04275 h 0.05493 l 0.03663,-0.06713 -0.0062,-0.146483 0.634776,0.0061 0.897194,0.286884 v 0.115933 l 0.03658,0.1098517 0.04885,0.06713 h 0.04885 l 0.0305,-0.0488 0.0061,-0.1891967 1.70283,0.5248798 v 0.189198 l 0.03055,0.07322 0.0488,0.01834 0.05493,-0.09156 v -0.146484 l 0.701912,0.195326 1.837103,0.592017 v -0.531009 l -0.03663,-0.10985 -0.07935,-0.140355 L 17.583355,10.249355 15.38615,9.1019546 12.371098,7.5272698 C 12.587063,7.3568235 12.609281,7.147899 12.645744,6.8925386 l 0.01221,-0.5493014 -0.03663,-0.6408594 -0.03658,-0.2136195 h -0.848396 l -0.06101,0.1891984 -0.05493,0.4089457 0.0061,0.4760371 0.04271,0.2624627 0.03663,0.1952807 0.06105,0.1953263 -1.342772,-0.7079953 -0.134273,-0.2197028 -0.0061,-1.5380524 -0.0061,-1.6967468 -0.01221,-0.036587 -0.03055,-0.018334 -0.01221,-0.3966832 -0.09764,-0.5310079 -0.09156,-0.402818 L 9.880983,1.2896233 9.6734461,0.93560307 9.5086684,0.7464048 9.349975,0.6243428 Z","a":[9.26,7.937]},"B752":{"d":"M 9.3114097,0.68084135 9.1999551,0.72863768 9.0661131,0.8629964 8.9643105,1.0076904 8.8728433,1.2056111 8.7767251,1.4521077 8.7017943,1.7311605 8.6320311,2.0954793 8.5999917,2.4489461 V 7.3256509 L 7.3995482,8.0005451 7.4207355,7.8186441 V 7.2610554 L 7.4047158,7.0362629 7.3029133,6.95048 h -0.567924 l -0.058911,0.026872 -0.080615,0.2087727 -0.048059,0.3054078 v 0.5038452 l 0.053743,0.444934 -4.0514322,2.2024495 -0.069763,0.05374 -0.032039,0.06925 -0.01602,0.150378 v 0.514181 h 0.053227 l 0.058911,-0.0801 0.1126546,-0.04289 2.100647,-0.514697 -0.010335,0.166398 0.026355,0.04806 h 0.064596 l 0.037207,-0.04806 0.016536,-0.19327 1.1518676,-0.283704 v 0.13901 l 0.037724,0.08578 h 0.037207 l 0.037724,-0.06408 0.026872,-0.09095 0.00517,-0.112655 0.444934,-0.112655 h 0.5730917 v 0.149862 l 0.026872,0.08578 h 0.042891 l 0.032039,-0.06408 v -0.176733 h 1.3239502 v 3.72432 l 0.021187,0.455269 0.026872,0.428915 0.053743,0.482141 0.01602,0.155546 -1.2056112,0.83044 -0.7984009,0.6165 -0.085783,0.07493 v 0.637687 l 0.072347,-0.01964 2.3120035,-0.559139 0.026872,0.267684 0.058911,0.252181 0.069763,0.230477 h 0.048059 l 0.063658,0.04425 0.06605,-0.04425 h 0.048576 l 0.069763,-0.230477 0.058911,-0.252181 0.026872,-0.267684 2.3120031,0.559139 0.07235,0.01964 v -0.637687 l -0.08578,-0.07493 -0.798401,-0.6165 -1.2056114,-0.83044 0.01602,-0.155546 0.053743,-0.482141 0.026872,-0.428915 0.021187,-0.455269 v -3.72432 h 1.3234332 v 0.176733 l 0.03256,0.06408 h 0.04289 l 0.02636,-0.08578 v -0.149862 h 0.573608 l 0.444934,0.112655 0.0052,0.112655 0.02687,0.09095 0.03772,0.06408 h 0.03721 l 0.03772,-0.08578 v -0.13901 l 1.151868,0.283704 0.01602,0.19327 0.03772,0.04806 h 0.06408 l 0.02687,-0.04806 -0.01033,-0.166398 2.100647,0.514697 0.112137,0.04289 0.05891,0.0801 h 0.05374 v -0.514181 l -0.01602,-0.150378 -0.03204,-0.06925 -0.06976,-0.05374 -4.051432,-2.2024495 0.05374,-0.444934 V 7.4915323 L 12.03079,7.1861245 11.950175,6.9773518 11.891264,6.95048 H 11.32334 l -0.101803,0.085783 -0.01602,0.2247925 v 0.5575887 l 0.02119,0.181901 -1.200444,-0.6748942 V 2.4489461 L 9.9942218,2.0954793 9.9244586,1.7311605 9.8495278,1.4521077 9.7528929,1.2056111 9.6619424,1.0076904 9.5601398,0.8629964 9.4262978,0.72863768 Z","a":[9.26,8.467]},"A400":{"d":"M 3.1856274,5.595028 3.3341192,5.55453 3.6536015,5.53653 H 4.0000821 4.378061 4.7515403 L 5.0035262,5.559028 5.1970155,5.572527 5.2368655,5.601681 5.0485237,5.626523 4.7110426,5.649023 4.3735613,5.680521 3.9730837,5.676021 3.7075984,5.662522 3.4241143,5.635524 3.2171257,5.617524 Z m 10.924938,4.995975 0.148491,-0.040498 0.319482,-0.018 h 0.346481 0.377979 0.373479 l 0.251986,0.022498 0.193489,0.013499 0.03985,0.029154 -0.188341,0.024842 -0.337481,0.0225 -0.337482,0.031498 -0.400477,-0.0045 -0.265486,-0.013499 -0.283483,-0.026998 -0.206989,-0.018 z m 13.257013,5.595028 0.148491,-0.040498 0.319483,-0.018 h 0.34648 0.377979 0.37348 l 0.251985,0.022498 0.19349,0.013499 0.03985,0.029154 -0.188342,0.024842 -0.337481,0.0225 -0.337481,0.031498 -0.400478,-0.0045 -0.265485,-0.013499 -0.283484,-0.026998 -0.206989,-0.018 z m 5.5072315,4.995975 0.1484918,-0.040498 0.3194823,-0.018 H 6.3216862 6.6996651 7.0731444 L 7.3251303,4.959975 7.5186196,4.973474 7.5584696,5.002628 7.3701278,5.02747 7.0326467,5.04997 6.6951654,5.081468 6.2946878,5.076968 6.0292025,5.063469 5.7457184,5.036471 5.5387298,5.018471 Z M 9.2604165,0.45578612 9.1498289,0.51107991 8.9844644,0.66920979 8.8521727,0.85266112 8.7054116,1.1063924 8.5436644,1.4376383 8.3927692,1.7611328 8.2532429,2.1321696 8.187097,2.5548828 8.1540241,3.2240926 V 5.1428384 L 8.0620401,5.2606607 7.9369831,5.4740844 7.8305296,5.7055948 7.8010741,5.8637247 6.8450601,6.2053059 6.8414427,6.1463947 6.8083698,6.1133218 6.8305907,5.9262531 6.8414427,5.6647704 6.8305907,5.4187906 6.8119872,5.2751301 6.7566934,5.2089843 6.7458413,5.1505899 V 5.0694579 L 6.7308552,4.8674031 6.7200031,4.7201252 6.6833129,4.6431274 6.6244017,4.5878336 H 6.5029621 l -0.084233,0.062528 -0.040308,0.076998 0.00362,0.4154785 -0.03669,0.073897 -0.062528,0.1503785 -0.025838,0.1472778 -0.00723,0.2020548 0.010852,0.1508952 0.029456,0.1581299 0.00723,0.1689819 L 6.2678344,6.3670531 4.4886148,6.9664997 4.4705281,6.9261921 4.4741454,6.7825316 4.503601,6.7530761 4.5180704,6.5179483 4.514453,6.253365 4.5072183,6.0327066 4.4922322,5.9148843 4.4591593,5.7975788 4.4116169,5.7422851 V 5.3857177 l -0.025838,-0.088367 -0.058911,-0.058911 -0.066146,-0.025838 -0.1028361,0.011369 -0.084749,0.076998 -0.018087,0.1105876 v 0.3271118 l -0.040824,0.091984 -0.047542,0.1870686 -0.025838,0.2537313 0.00362,0.2428792 0.014986,0.2754354 0.03669,0.066146 0.021704,0.051677 -0.00362,0.1214396 -0.021704,0.084233 -2.8199829,0.966866 -0.08785,0.048059 -0.077515,0.066146 -0.0366902,0.080615 V 9.1389769 L 3.6612752,8.9405394 3.6871134,9.0800658 3.7057169,8.92607 4.8968586,8.837703 l 0.010852,0.1173055 0.051676,-0.1286743 1.010791,-0.080615 0.025838,0.1984375 0.043925,-0.2056722 1.4118001,-0.1028361 0.021704,0.2165243 0.044442,-0.2278931 0.2092896,-0.00723 0.011369,0.4707723 0.021704,0.095085 0.073897,0.084749 0.3198771,0.2795695 -0.00775,1.7828376 0.025838,0.521932 0.033073,0.434082 0.055294,0.363802 0.058911,0.375171 0.1689819,0.9741 0.2020549,1.010791 0.00362,0.04754 -0.00362,0.04444 -0.080615,0.07338 -2.4670328,1.819527 -0.1875854,0.15813 -0.1359091,0.147278 -0.1250569,0.161747 -0.069763,0.217041 -0.029456,0.191203 v 0.238745 l 3.5000447,-1.301213 0.029456,0.135909 0.05116,0.143144 0.08523,0.220658 0.084268,-0.220658 0.05116,-0.143144 0.029456,-0.135909 3.5000453,1.301213 v -0.238745 l -0.02946,-0.191203 -0.06976,-0.217041 -0.125057,-0.161747 -0.136426,-0.147278 -0.187068,-0.15813 -2.4670336,-1.819527 -0.080615,-0.07338 -0.00362,-0.04444 0.00362,-0.04754 0.2020546,-1.010791 0.168982,-0.9741 0.05891,-0.375171 0.05529,-0.363802 0.03307,-0.434082 0.02584,-0.521932 -0.0078,-1.7828376 0.319877,-0.2795695 0.07338,-0.084749 0.02222,-0.095085 0.01085,-0.4707723 0.209807,0.00723 0.04392,0.2278931 0.02222,-0.2165243 1.4118,0.1028361 0.04392,0.2056722 0.02584,-0.1984375 1.010791,0.080615 0.05168,0.1286743 0.01085,-0.1173055 1.191142,0.088367 0.0186,0.1539958 0.02532,-0.1395264 2.691309,0.1984375 V 8.274947 l -0.03669,-0.080615 -0.07751,-0.066146 -0.08837,-0.048059 -2.819466,-0.966866 -0.02222,-0.084233 -0.0036,-0.1214396 0.02222,-0.051677 0.03669,-0.066146 0.01499,-0.2754354 0.0036,-0.2428792 -0.02584,-0.2537313 -0.04806,-0.1870686 -0.04031,-0.091984 v -0.327111 l -0.01809,-0.1105876 -0.08475,-0.076998 -0.102836,-0.011369 -0.06615,0.025838 -0.05891,0.058911 -0.02584,0.088367 v 0.3565674 l -0.04754,0.055294 -0.03307,0.1173055 -0.01499,0.1178223 -0.0072,0.2206584 -0.0036,0.2645833 0.01447,0.2351278 0.02946,0.029456 0.0036,0.1436605 -0.01809,0.040308 L 12.25296,6.3670539 12.2235,6.1944546 12.2307,6.0254727 12.26015,5.8673428 12.271,5.7164476 12.2638,5.5143928 12.23796,5.367115 12.17543,5.2167365 12.13874,5.1428395 12.14234,4.727361 12.10203,4.650363 12.01728,4.587835 h -0.120923 l -0.05891,0.055294 -0.03669,0.076998 -0.01137,0.1472779 -0.01447,0.2020548 v 0.081132 l -0.01137,0.058394 -0.05478,0.066146 -0.0186,0.1436605 -0.01085,0.2459798 0.01085,0.2614827 0.02222,0.1870687 -0.03307,0.033073 -0.0036,0.058911 L 10.719759,5.8637247 10.690303,5.7055948 10.58385,5.4740844 10.458793,5.2606607 10.366809,5.1428384 V 3.2240926 L 10.333736,2.5548828 10.26759,2.1321696 10.128064,1.7611328 9.9771686,1.4376383 9.8154214,1.1063924 9.6686603,0.85266112 9.5358519,0.66920979 9.3704873,0.51107991 Z","a":[9.26,7.144]},"PA31":{"d":"M 5.2670722,4.4725801 H 8.2411466 m 10.386885,4.5611617 h 2.974074 M 9.3162269,2.4962806 9.204089,2.5464067 9.1064206,2.6595781 8.9544919,2.9169267 8.8118649,3.2579912 8.6278968,3.8884437 8.4883705,4.6113969 8.3855344,5.4196163 8.3493609,5.9394812 V 6.2789954 L 7.3969642,6.7363318 7.4181516,6.1467037 7.3923133,5.6371741 7.353556,5.117826 7.3230669,4.9891516 7.0398801,4.8811479 7.0140419,4.6697913 6.9907875,4.407275 6.8776161,4.1860999 6.7541094,4.0780962 6.6119992,4.2005693 6.5174314,4.4119259 6.4605873,4.8651282 6.1789507,4.9948361 6.0900673,5.7451778 6.0265053,6.8639726 1.2774412,7.15026 1.1187946,7.220023 l -0.036174,0.1235067 -0.00517,0.4940266 0.056844,0.3451986 0.087333,0.2056722 0.09095,0.038241 4.7562987,0.8810831 0.057361,0.7797978 0.5374349,0.192753 0.4439005,-0.158647 0.056844,-0.08113 0.037207,-0.4015259 0.021187,-0.1198893 0.8862507,0.1741496 0.1503785,0.1886193 0.091984,1.1110433 0.1136882,1.128096 0.2397786,1.652096 -3.0850829,0.403076 -0.081649,0.03256 -0.069246,0.113688 0.00413,0.362252 0.053227,0.211357 0.081132,0.150895 3.376538,0.390157 0.085783,0.191203 0.056844,0.525032 0.056844,-0.525032 0.085266,-0.191203 3.3770552,-0.272335 0.08113,-0.150895 0.05271,-0.211357 0.0041,-0.362251 -0.06873,-0.113688 -0.08165,-0.03256 -3.0308225,-0.520898 0.2888713,-1.647445 0.1462442,-1.118794 0.07338,-1.0495493 0.211356,-0.236161 0.829924,-0.1503784 0.04496,0.1054199 0.0041,0.5007448 0.05684,0.08113 0.500744,0.130225 0.504362,-0.121957 0.09457,-0.883667 4.868953,-0.7823811 0.07235,-0.00517 0.08733,-0.2056722 0.05684,-0.3446818 -0.0052,-0.4945434 -0.03617,-0.1235067 -0.09767,-0.045992 -4.786788,-0.4273641 -0.0155,-1.1529012 -0.05116,-0.695048 -0.319361,-0.1850016 -0.05633,-0.4532023 -0.06718,-0.2160075 -0.123507,-0.093403 -0.123507,0.088236 -0.10803,0.2134635 -0.05165,0.2702279 -0.02532,0.2113566 -0.283187,0.1080037 -0.03101,0.1286743 -0.06201,0.5146973 -0.02532,0.5095296 -0.02067,0.6175333 -0.967899,-0.5302001 V 5.9498165 L 10.150285,5.4299516 10.077938,4.6217322 9.9699336,3.9065304 9.789583,3.2528236 9.6815793,2.9081418 9.537402,2.6657793 9.4242306,2.537105 Z","a":[9.26,7.673]},"C560":{"d":"m 9.2604595,1.7110993 c -0.483383,0 -0.955145,1.4794607 -0.955145,3.116973 V 7.799758 l -7.38377,0.4932304 c -0.0464,0.00276 -0.134003,0.058993 -0.132388,0.1655695 v 0.1728684 c -0.08509,0.05145 -0.08421,0.08964 0,0.235498 l 0.002,0.334958 6.466304,1.0873627 c -0.0268,0.256142 0.03398,1.392428 0.309245,1.77332 h 0.384095 l 0.166418,0.713707 0.483301,0.435353 c 0.05403,0.447377 0.350426,1.632917 0.420756,1.798694 l -3.044245,0.542536 c -0.09042,0.01507 -0.155725,0.09047 -0.155725,0.190944 l 0.005,0.607797 3.345681,0.27131 c 0.02518,0.205952 0.0845,0.186786 0.0845,0.186786 0,0 0.06718,0.01917 0.09236,-0.186786 l 3.3456815,-0.27131 0.005,-0.607797 c 0,-0.100471 -0.0653,-0.175873 -0.155725,-0.190944 L 9.4995575,15.010319 c 0.07033,-0.165777 0.366726,-1.351317 0.420756,-1.798694 l 0.4833015,-0.435353 0.166419,-0.713707 h 0.384095 c 0.275266,-0.380892 0.336132,-1.517178 0.309329,-1.77332 l 6.466219,-1.0873627 0.002,-0.334958 c 0.08421,-0.145861 0.08509,-0.184047 0,-0.235498 V 8.4585579 C 17.733277,8.351981 17.645687,8.2957518 17.599289,8.2929884 L 10.21569,7.799758 V 4.8280723 c 0,-1.6375123 -0.4718465,-3.116973 -0.9552305,-3.116973 z","a":[9.26,8.996]},"DA42":{"d":"m 9.2604151,3.8368011 c -0.33135,0 -0.707481,2.001544 -0.707481,3.0448481 l -0.940334,0.196993 c 0.08508,-0.143286 0.06271,-0.326885 -0.03132,-0.326885 0.09851,-0.1970191 -0.08512,-0.7611931 -0.317959,-0.7611931 0,-0.21493 -0.107406,-0.438727 -0.168752,-0.474014 -0.06099,0.03522 -0.184681,0.255788 -0.184681,0.47109 -0.202637,-0.0063 -0.366833,0.408367 -0.363667,0.6901681 0,0.205812 0.08511,0.45596 0.08511,0.642766 l -2.925575,0.145667 -2.647015,0.08865 c -0.10467697,0 -0.16459697,0.01581 -0.16459697,0.721871 -0.09182,0.177308 -0.246988,0.6934 -0.123505,0.6934 0.07916,0 0.26909497,-0.288102 0.26909497,-0.288102 l 2.048572,0.123505 3.543025,0.117118 c 0.01266,0.104485 0.08542,0.509796 0.126584,0.509796 h 0.541422 c 0.05699,0 0.107663,-0.326149 0.12666,-0.446466 l 1.108162,0.08865 c 0.01418,0.480798 0.642793,1.5831138 0.592133,4.3947118 l -1.678133,0.430614 c -0.03707,0.0072 -0.375111,0.651923 -0.169137,0.651923 0.05373,0 0.123162,-0.04472 0.181372,-0.04248 0.335828,0.01567 1.016447,0.0828 1.155256,0.0828 v 0.0918 h 0.631312 0.658222 v -0.0918 c 0.1388079,0 0.8194279,-0.06713 1.1552559,-0.0828 0.05821,-0.0022 0.127639,0.04248 0.181371,0.04248 0.205975,0 -0.13214,-0.644752 -0.169213,-0.651923 L 9.3945411,13.469375 c -0.05066,-2.811598 0.577876,-3.9139138 0.592056,-4.3947118 l 1.1081619,-0.08865 c 0.019,0.120317 0.06967,0.446466 0.12666,0.446466 h 0.541423 c 0.04116,0 0.113996,-0.405311 0.126661,-0.509796 l 3.543024,-0.117118 2.048496,-0.123505 c 0,0 0.190017,0.288102 0.269172,0.288102 0.123482,0 -0.03169,-0.516092 -0.123505,-0.6934 0,-0.706066 -0.06,-0.721871 -0.164674,-0.721871 l -2.646938,-0.08865 -2.925575,-0.145667 c 0,-0.186806 0.08503,-0.436954 0.08503,-0.642766 0.0032,-0.2818011 -0.16103,-0.6965011 -0.363668,-0.6901681 0,-0.215302 -0.123608,-0.435874 -0.184604,-0.47109 -0.06134,0.03529 -0.168829,0.259084 -0.168829,0.474014 -0.23284,0 -0.416391,0.564174 -0.317881,0.7611931 -0.09403,0 -0.116396,0.183599 -0.03132,0.326885 L 9.9678971,6.8816492 c 0,-1.0433041 -0.376131,-3.0448481 -0.707482,-3.0448481 z","a":[9.26,7.937]},"SW4":{"d":"m 10.04408,5.9857252 h 2.210189 m 5.9265168,5.9903744 h 2.21019 M 9.0950118,1.5685377 8.9898113,1.7019566 8.9395059,1.8060913 8.8118651,2.0608561 8.6986937,2.3114868 8.627897,2.5476481 8.547282,2.8592569 8.486304,3.1662149 8.443413,3.5393188 8.41034,3.9449788 8.391737,4.4317708 8.354013,5.5505655 v 1.99316 L 8.330242,7.6000525 8.264096,7.6661985 8.164877,7.7230425 8.042403,7.7468138 7.33857,7.7798867 7.3525227,7.4445067 7.33857,7.0099079 7.2961953,6.4760904 7.248653,6.1975544 7.2207478,6.055961 7.1639037,5.8719929 7.0977578,5.7019774 l -0.042375,-0.052193 -0.023771,0.00465 -0.066146,0.070797 -0.070797,0.1700155 -0.051677,0.2030884 -0.03824,0.1276408 -0.047026,0.2645833 -0.042375,0.306958 -0.033073,0.7792806 -0.0093,0.2309936 -3.7827148,0.2459798 -0.1178223,0.033073 -0.085266,0.056327 -0.056844,0.080615 -0.018604,0.1131714 0.018604,0.1178222 0.00982,0.5953125 5.5438475,0.8547282 0.056327,0.028422 0.042892,0.066146 v 3.6121823 l 0.00465,0.387573 0.042375,0.235645 0.061495,0.345198 0.1085205,0.443901 -1.4355713,1.189591 -0.094568,0.118339 -0.066146,0.179318 -0.018604,0.344681 -0.0093,0.326079 0.1462443,0.0047 0.061495,-0.04237 1.7187581,-0.533818 0.066146,0.250114 v 0.420646 l 0.075448,0.03772 v 0.245463 l 0.1603603,0.03108 0.1558995,-0.03108 v -0.245463 l 0.075448,-0.03772 v -0.420646 l 0.066146,-0.250114 1.7187584,0.533818 0.0615,0.04237 0.146244,-0.0047 -0.0093,-0.326079 -0.0186,-0.344681 -0.06615,-0.179318 -0.09457,-0.118339 -1.4355713,-1.189591 0.1085206,-0.443901 0.061495,-0.345198 0.042375,-0.235645 0.00465,-0.387573 V 9.9993895 l 0.042891,-0.066146 0.056328,-0.028422 5.543847,-0.8547282 0.0098,-0.5953125 0.0186,-0.1178222 -0.0186,-0.1131714 -0.05684,-0.080615 -0.08527,-0.056327 -0.117823,-0.033073 -3.782714,-0.2459798 -0.0093,-0.2309936 -0.03307,-0.7792806 -0.04237,-0.306958 -0.04703,-0.2645833 -0.03824,-0.1276408 -0.05168,-0.2030884 -0.0708,-0.1700155 -0.06615,-0.070797 -0.02377,-0.00465 -0.04238,0.052193 -0.06614,0.1700155 -0.05685,0.1839681 -0.0279,0.1415934 -0.04754,0.278536 -0.04238,0.5338175 -0.01395,0.4345988 0.01395,0.33538 -0.703833,-0.033073 -0.122473,-0.023771 -0.099219,-0.056844 -0.066146,-0.066146 -0.023771,-0.056327 v -1.99316 L 9.8128376,4.4317708 9.794234,3.9449788 9.7611611,3.5393188 9.7182697,3.1662149 9.6572915,2.8592569 9.5766763,2.5476481 9.5058795,2.3114868 9.3927082,2.0608561 9.2650674,1.8060913 9.2092568,1.7042887 v -5.168e-4 z","a":[9.26,8.467]},"A338":{"d":"m 9.3811121,1.4739255 -0.087106,0.046395 -0.1286743,0.1700155 -0.1028361,0.2284098 -0.125057,0.3116089 -0.099736,0.3276286 -0.086816,0.344165 -0.054777,0.3307291 -0.05116,0.3343466 -0.028939,0.4211629 v 2.5383463 l -0.00982,0.073897 -0.05116,0.057878 L 8.419641,6.8161213 7.3401203,7.4910155 7.3690591,7.3334024 7.39128,7.0409138 7.4072997,6.7489419 V 6.4435342 L 7.3334024,6.3887572 H 6.4626545 l -0.044958,0.057878 -0.01912,0.2537313 -0.022738,0.2185913 v 0.1963704 l 0.025838,0.2470134 0.041858,0.289388 0.048059,0.1028361 h 0.1348755 l 0.019637,0.060978 0.05116,0.073897 -4.9940103,3.1750002 -0.1607137,0.151412 -0.1539958,0.195853 -0.164331,0.237712 -0.1508952,0.241329 -0.15399579,0.276469 v 0.173116 l 0.12815759,-0.131775 0.199471,-0.157096 0.2377116,-0.170533 0.2216919,-0.121956 0.2666503,-0.122473 2.1693766,-0.86093 0.4630209,-0.157613 0.01912,0.121957 0.048059,0.131775 0.025838,0.04857 0.05116,-0.0646 0.016536,-0.176733 0.012402,-0.121957 0.7487915,-0.273368 0.00672,0.08372 0.041858,0.131775 0.041858,0.09974 0.044958,-0.09664 0.022221,-0.163814 0.00982,-0.118856 0.7167521,-0.2444295 0.012402,0.1224735 0.038757,0.134875 0.025838,0.06408 0.041858,-0.105937 0.028939,-0.125573 0.01602,-0.1379765 0.5684408,-0.1958537 0.164331,-0.01602 0.022221,0.1219564 0.041858,0.1576131 0.022738,0.05426 0.05426,-0.083199 0.025838,-0.144694 0.01602,-0.1224732 1.0671183,-0.1059366 0.0093,0.2604492 0.041858,0.1865518 v 1.584399 l 0.025838,0.584461 0.041858,0.591695 0.03824,0.459404 0.032556,0.28267 0.028939,0.340547 0.07028,0.488859 0.045475,0.253732 0.048059,0.289388 0.025838,0.224792 -1.896525,1.266073 -0.083199,0.08682 -0.073897,0.102836 -0.048576,0.157613 -0.044959,0.179834 -0.0031,0.183452 2.3492106,-0.761711 0.1059367,0.51418 H 9.3789314 9.485209 l 0.1059367,-0.51418 2.3492103,0.761711 -0.0031,-0.183452 -0.04496,-0.179834 -0.04858,-0.157613 -0.0739,-0.102836 -0.0832,-0.08682 -1.8960083,-1.266073 0.025321,-0.224792 0.048576,-0.289388 0.044958,-0.253732 0.07028,-0.488859 0.028939,-0.340547 0.03256,-0.28267 0.03824,-0.459404 0.04186,-0.591695 0.02584,-0.584461 v -1.584399 l 0.04186,-0.1865518 0.0093,-0.2604492 1.067118,0.1059366 0.01602,0.1224732 0.02584,0.144694 0.05426,0.083199 0.02274,-0.05426 0.04186,-0.1576131 0.02222,-0.1219564 0.164331,0.01602 0.56844,0.1958537 0.01602,0.1379765 0.02894,0.125573 0.04186,0.105937 0.02584,-0.06408 0.03876,-0.134875 0.0124,-0.1224735 0.716752,0.2444295 0.0098,0.118856 0.02222,0.163814 0.04496,0.09664 0.04186,-0.09974 0.04186,-0.131775 0.0062,-0.08372 0.748791,0.273368 0.01292,0.121957 0.01602,0.176733 0.05168,0.0646 0.02584,-0.04857 0.04806,-0.131775 0.01912,-0.121957 0.463021,0.157613 2.169376,0.86093 0.266651,0.122473 0.221692,0.121956 0.237711,0.170533 0.199471,0.157096 0.128158,0.131775 v -0.173116 l -0.153996,-0.276469 -0.150895,-0.241329 -0.164331,-0.237712 -0.153996,-0.195853 -0.160714,-0.151412 -4.99401,-3.1750002 0.05116,-0.073897 0.01964,-0.060978 h 0.134875 l 0.04806,-0.1028361 0.04186,-0.289388 0.02584,-0.2470134 V 6.9189574 l -0.02274,-0.2185913 -0.01912,-0.2537313 -0.04496,-0.057878 h -0.870748 l -0.07441,0.054777 v 0.3054077 l 0.01654,0.2919719 0.02222,0.2924886 0.02894,0.1576131 -1.080037,-0.6748942 -0.134876,-0.1576131 -0.05116,-0.057878 -0.0098,-0.073897 V 3.988387 L 10.111527,3.5672241 10.060368,3.2328775 10.005591,2.9021484 9.9187742,2.5579834 9.8190387,2.2303548 9.6939818,1.9187459 9.5911457,1.6903361 9.4624713,1.5203206 Z","a":[9.26,7.937]},"BE36":{"d":"M 7.5089036,2.7975683 H 11.110701 M 9.308191,2.5129663 9.2376789,2.5590169 9.1596475,2.7398844 9.0573281,3.1207397 8.9255532,3.1352091 8.8030801,3.1987711 8.7105793,3.3207275 8.6371987,3.4917765 8.5689858,3.7749633 8.5250609,4.0534993 8.4614989,4.5470092 8.3782998,5.6115437 7.147884,6.1438109 3.3382975,6.3293293 V 6.1877359 L 2.962093,6.1923859 2.957443,6.3391469 1.4583097,6.3928899 1.3068977,6.4073589 1.135848,6.4905598 1.0231933,6.6223347 0.98443602,6.8667642 0.9746175,8.2191364 2.5517822,8.5271279 V 8.654252 l 0.6397542,0.1167887 0.00517,-0.1219564 5.2498087,0.9766846 v 0.1514119 l -0.3513997,0.00982 -0.029456,-0.058394 -0.053743,-0.034107 -0.058394,0.038757 -0.00982,0.08785 -0.00517,0.1173055 0.049093,0.034106 0.043925,-0.019637 0.029455,-0.048576 0.034107,-0.019637 0.3612182,0.00517 0.083199,0.9033037 0.092501,0.776697 0.2738851,2.324406 -2.3786662,0.283187 -0.1173055,0.03927 -0.078031,0.07803 -0.038757,0.112138 -0.014986,0.937928 0.039274,0.107487 0.1121379,0.08785 1.4898315,0.205156 0.00465,0.107487 1.157552,0.01447 0.1219564,-0.195337 0.024288,0.698666 0.085781,0.129381 0.078033,-0.129381 0.024288,-0.698666 0.1219563,0.195337 1.1575519,-0.01447 0.0047,-0.107487 1.489831,-0.205156 0.112138,-0.08785 0.03927,-0.107487 -0.01447,-0.937928 -0.03927,-0.112138 -0.07803,-0.07803 -0.117305,-0.03927 -2.378666,-0.283187 0.2738851,-2.324406 0.092501,-0.776697 0.0832,-0.9033037 0.361218,-0.00517 0.03411,0.019637 0.02946,0.048576 0.04392,0.019637 0.04909,-0.034106 -0.0052,-0.1173055 -0.0098,-0.08785 -0.05839,-0.038757 -0.05374,0.034107 -0.02946,0.058394 -0.3514,-0.00982 V 9.6257689 l 5.249809,-0.9766846 0.0052,0.1219564 0.639754,-0.1167887 V 8.5271279 l 1.577164,-0.3079915 -0.0098,-1.3523722 -0.03876,-0.2444295 -0.112655,-0.1317749 -0.170532,-0.083199 -0.151412,-0.014469 -1.49965,-0.053743 -0.0047,-0.146761 -0.376204,-0.00465 V 6.3293293 L 11.472168,6.1438109 10.241235,5.6115437 10.158036,4.5470092 10.094474,4.0534993 10.050549,3.7749633 9.9823362,3.4917765 9.9089557,3.3207275 9.8164549,3.1987711 9.6944985,3.1352091 9.5622069,3.1207397 9.4598875,2.7398844 9.3818561,2.5590169 Z","a":[9.26,6.879]},"B38M":{"d":"M 9.2604063,0.66204342 9.1990401,0.6794847 9.1215255,0.74563053 9.0223067,0.94820214 8.9375574,1.1797125 8.8347213,1.4887376 8.7313684,1.8349697 8.624915,2.2762864 8.5804732,2.5191656 8.5215621,2.8690151 8.4776371,3.1816575 8.4517989,3.6307257 8.4373295,3.8808396 V 6.9499028 L 8.293669,7.1297368 8.1536259,7.2625453 7.9810266,7.3839849 7.5800175,7.6707891 7.6311772,7.4098231 7.6720016,7.1519577 7.6900883,6.8982264 V 6.7473312 L 7.6642501,6.5633631 7.6239425,6.4088506 7.5650313,6.3427048 H 6.714954 L 6.681881,6.3938648 6.641573,6.5153045 6.612117,6.6589649 6.597131,6.7437139 v 0.3751709 l 0.014986,0.2320272 0.025838,0.1725992 0.029456,0.2211752 0.021704,0.1395263 0.033073,0.091984 0.066662,0.011369 0.021704,-0.081132 0.022221,0.022221 0.014986,0.076998 0.029456,0.07028 -4.8648192,2.6158603 -0.018603,0.07028 -0.5519043,0.717269 0.00362,0.10697 -0.025838,0.05529 0.037207,0.01085 v 0.04392 h 0.03669 l 0.029456,-0.03307 0.4635376,-0.283187 0.048059,0.02946 3.2271931,-1.030428 0.040308,0.415995 0.1214396,-0.463537 0.982369,-0.261483 0.062528,0.404626 L 6.57543,10.026197 7.0239814,9.8897714 7.3774482,9.8933914 7.4435942,10.287166 7.5505644,9.889774 8.437332,9.871171 V 13.1981 l 0.029456,0.470773 0.018087,0.279569 0.014986,0.213424 0.018087,0.169498 0.058911,0.426848 0.062529,0.367936 0.1436604,0.588594 -2.6344644,1.828829 v 0.320394 h 0.054777 l 2.8189493,-0.740006 0.040308,0.213423 0.1069702,0.31316 0.066146,0.0036 h 0.049609 l 0.066663,-0.0036 0.1064535,-0.31316 0.040308,-0.213423 2.81895,0.740006 h 0.05529 v -0.320394 l -2.6349821,-1.828829 0.1436605,-0.588594 0.062528,-0.367936 0.058911,-0.426848 0.0186,-0.169498 0.01447,-0.213424 0.0186,-0.279569 0.02946,-0.470773 V 9.8711715 l 0.886768,0.018603 0.106454,0.3973925 0.06615,-0.3937751 0.353466,-0.00362 0.449069,0.1364261 0.106453,0.448551 0.06253,-0.404626 0.982368,0.261483 0.12144,0.463537 0.04082,-0.415995 3.227194,1.030428 0.04754,-0.02946 0.463538,0.283187 0.02946,0.03307 h 0.03721 v -0.04392 l 0.03669,-0.01085 -0.02584,-0.05529 0.0036,-0.10697 -0.551905,-0.717269 -0.0186,-0.07028 -4.864303,-2.6158608 0.02946,-0.07028 0.01447,-0.076998 0.02222,-0.022221 0.02222,0.081132 0.06615,-0.011369 0.03307,-0.091984 0.02222,-0.1395263 0.02946,-0.2211752 0.02532,-0.1725992 0.01499,-0.2320272 V 6.7437139 l -0.01499,-0.084749 -0.02894,-0.1436604 -0.04082,-0.1214397 -0.03307,-0.05116 H 10.95604 l -0.05891,0.066146 -0.04031,0.1545125 -0.02584,0.1839681 v 0.1508952 l 0.0186,0.2537313 0.04031,0.2578654 0.05168,0.260966 L 10.540561,7.3839849 10.367445,7.2625453 10.227401,7.1297368 10.084257,6.9499028 V 3.8808396 L 10.069271,3.6307257 10.043433,3.1816575 9.999508,2.8690151 9.9405969,2.5191656 9.8961552,2.2762864 9.7897017,1.8349697 9.6868656,1.4887376 9.5835128,1.1797125 9.4987634,0.94820214 9.3995447,0.74563053 9.3225468,0.6794847 Z","a":[9.26,7.937]},"A346":{"d":"m 9.2609331,0.39327714 -0.045475,0.0108521 -0.058911,0.0573608 -0.057361,0.0785482 -0.064596,0.11833903 -0.057361,0.12143961 -0.055294,0.13797607 -0.064596,0.17156575 -0.056844,0.1720825 -0.046509,0.1607137 -0.041341,0.1700155 -0.057361,0.2971394 -0.032039,0.2165243 -0.019637,0.2056722 -0.00878,0.1968872 v 5.0606729 l -1.2867432,0.7890991 0.012402,-0.116272 0.00879,-0.146761 0.0093,-0.1379761 V 7.7173778 L 7.3241005,7.5654491 7.289994,7.3344554 7.2631223,7.3236034 h -0.572575 l -0.023254,0.010852 -0.012402,0.048576 -0.01447,0.1002523 -0.01602,0.1374593 -0.012402,0.1343588 -0.00207,0.1948201 0.00568,0.1808675 0.012402,0.1684652 0.032039,0.243396 h 0.068213 l 0.01602,0.083716 0.028422,0.060978 -1.9843749,1.2257649 0.012402,-0.1002522 0.0093,-0.1235067 0.00723,-0.1483114 V 9.3586212 L 4.8136593,9.2046255 4.797123,9.0754344 4.7774859,8.9343577 4.7702511,8.8893992 4.7490639,8.8806142 H 4.1604692 l -0.016536,0.012402 -0.01757,0.085783 -0.01447,0.1255737 -0.014469,0.1503784 -0.00672,0.2036051 0.00878,0.243396 0.013953,0.1793172 0.025321,0.2144574 h 0.069763 l 0.019637,0.08785 0.021704,0.05891 -2.2871989,1.417484 -0.01602,0.01602 -0.014469,0.02481 -0.00155,0.04134 -0.00568,0.09302 -0.1875854,0.414962 v 0.205672 l 0.1808675,-0.12299 2.4639321,-1.077453 v 0.08216 l 0.010852,0.07545 0.028422,0.08217 0.026872,0.06615 h 0.019637 l 0.028422,-0.05529 0.032556,-0.121957 0.01757,-0.0894 0.00723,-0.10387 0.2258259,-0.07131 0.00362,0.08423 0.01757,0.077 0.021704,0.07648 0.032039,0.06821 h 0.021704 l 0.029972,-0.06615 0.025321,-0.100252 0.019637,-0.09663 0.00517,-0.10542 0.6480225,-0.222208 0.00155,0.06976 0.016536,0.07906 0.021187,0.07493 0.032556,0.08216 h 0.024805 l 0.028422,-0.06253 0.025321,-0.08372 0.01602,-0.08061 0.010852,-0.077 v -0.06821 l 0.6495727,-0.220142 0.00362,0.06976 0.013952,0.06976 0.021704,0.08785 0.03204,0.08216 h 0.021704 l 0.028422,-0.06046 0.019637,-0.07338 0.018087,-0.07338 0.01602,-0.09508 0.00207,-0.07131 0.6133992,-0.212906 0.109554,-0.0021 v 0.111104 l 0.021187,0.112654 0.034106,0.10387 0.021187,0.04289 h 0.018087 l 0.030489,-0.06821 0.018087,-0.077 0.021187,-0.08372 0.012402,-0.07906 v -0.06253 H 8.531778 l 0.010852,0.16123 0.014469,0.180351 0.026872,0.254248 v 2.277897 l 0.00517,0.257865 0.010852,0.254248 0.030489,0.406177 0.023254,0.234094 0.053744,0.40256 0.060461,0.384989 0.068213,0.434599 0.1307414,0.837675 -1.8737874,1.11466 -0.051676,0.04289 -0.03204,0.05581 -0.020154,0.06976 -0.042891,0.44545 2.1869466,-0.619083 0.060978,0.604614 0.01757,0.01447 0.046509,0.0036 0.050643,-0.0036 0.018087,-0.01447 0.060462,-0.604614 2.1869464,0.619083 -0.04289,-0.44545 -0.01964,-0.06976 -0.03256,-0.05581 -0.05168,-0.04289 -1.8737873,-1.11466 0.1307413,-0.837675 0.068213,-0.434599 0.060978,-0.384989 0.053227,-0.40256 0.023254,-0.234094 0.030489,-0.406177 0.010852,-0.254248 0.00517,-0.257865 v -2.277897 l 0.026872,-0.254248 0.014469,-0.180351 0.010852,-0.16123 h 1.023711 v 0.06253 l 0.0124,0.07906 0.0217,0.08372 0.01757,0.077 0.03049,0.06821 h 0.01809 l 0.02119,-0.04289 0.03411,-0.10387 0.0217,-0.112654 v -0.111104 l 0.109037,0.0021 0.613916,0.212906 0.0015,0.07131 0.01602,0.09508 0.01809,0.07338 0.01964,0.07338 0.02842,0.06046 h 0.0217 l 0.03204,-0.08216 0.0217,-0.08785 0.01395,-0.06976 0.0036,-0.06976 0.649573,0.220142 v 0.06821 l 0.01085,0.077 0.01602,0.08061 0.02532,0.08372 0.02842,0.06253 h 0.02532 l 0.03204,-0.08216 0.0217,-0.07493 0.01602,-0.07906 0.0015,-0.06976 0.648023,0.222208 0.0052,0.10542 0.01964,0.09663 0.02532,0.100252 0.03049,0.06615 h 0.02119 l 0.03204,-0.06821 0.0217,-0.07648 0.01809,-0.077 0.0036,-0.08423 0.225309,0.07131 0.0072,0.10387 0.01757,0.0894 0.03256,0.121957 0.02842,0.05529 h 0.01964 l 0.02687,-0.06615 0.02894,-0.08217 0.01033,-0.07545 v -0.08216 l 2.464449,1.077453 0.180351,0.123507 v -0.206189 l -0.187586,-0.414962 -0.0057,-0.09302 -0.0016,-0.04134 -0.01447,-0.02481 -0.01602,-0.01602 -2.286682,-1.417484 0.02119,-0.05891 0.01964,-0.08785 h 0.06976 l 0.02532,-0.2144574 0.01395,-0.1793172 0.0093,-0.2428792 -0.0072,-0.2041219 -0.01447,-0.1503784 -0.01447,-0.125057 -0.01757,-0.0863 -0.01602,-0.012402 h -0.589112 l -0.02119,0.00878 -0.0072,0.044958 -0.01964,0.1415934 -0.01602,0.1286744 -0.0036,0.1539957 v 0.1824178 l 0.0072,0.1483114 0.0088,0.1235067 0.0124,0.1002522 -1.984375,-1.2257649 0.02842,-0.060978 0.01602,-0.083716 h 0.06821 l 0.03204,-0.243396 0.01292,-0.1684652 0.0052,-0.1808675 -0.0016,-0.1948201 -0.01292,-0.1343588 -0.01602,-0.1374593 -0.01395,-0.1002523 -0.01292,-0.048576 -0.02325,-0.010852 h -0.572575 l -0.02687,0.010852 -0.03411,0.2309937 -0.01395,0.1519287 v 0.2397846 l 0.0088,0.1379761 0.0088,0.146761 0.0124,0.116272 L 9.9265255,7.5690664 V 2.5083935 L 9.9172238,2.3115063 9.8975867,2.1058341 9.8655473,1.8893098 9.8081865,1.5921704 9.7673621,1.4221549 9.7208533,1.2614412 9.6634925,1.0893587 9.598897,0.91779292 9.5436032,0.77981685 9.4862423,0.65837724 9.4216468,0.54003821 9.364286,0.46149003 9.3053748,0.40412919 Z","a":[9.26,8.731]},"DH8D":{"d":"m 9.2085072,1.5995163 c -0.2360846,0 -0.6164201,1.033863 -0.6164201,1.723693 v 4.649786 l -0.091321,0.03805 c -0.4604281,0 -1.0920529,0.06088 -1.0920529,0.06088 v -1.054002 c 0,-0.213084 -0.095127,-0.528904 -0.186448,-0.528904 -0.079906,0 -0.2016684,0.30821 -0.2016684,0.532709 v 1.073027 l -4.0143407,0.31582 c -0.125567,0.0076 -0.1407873,0.04566 -0.1445924,0.08752 l -0.038051,0.422362 c -0.0038,0.06088 0,0.06849 0.034246,0.0723 l 1.8682855,0.136982 0.034246,0.125567 0.045661,-0.117957 1.1529339,0.0723 0.030441,0.186448 0.068491,-0.178838 0.9588757,0.04566 v 0.6012 c 0,0.133177 0.1027367,0.5593437 0.178838,0.5593437 0.076529,0 0.2321088,-0.414746 0.2321088,-0.5555387 v -0.468023 h 1.1148833 c 0.041856,0.0038 0.049466,0.04186 0.049466,0.0723 v 2.6787637 c 0,0.563149 0.4185569,3.546318 0.4185569,3.546318 -0.304405,0.01522 -1.5905161,0.213084 -1.5905161,0.213084 v 0.673497 h 1.7617422 c 0.011416,0.194057 0.053271,0.39192 0.053271,0.39192 0,0 0.053271,-0.213083 0.068491,-0.39192 h 1.7274981 v -0.677302 c 0,0 -1.2823058,-0.186447 -1.5752955,-0.224498 0,0 0.3767012,-2.964145 0.3767012,-3.534904 V 9.4836163 c 0.00381,-0.04947 0.038051,-0.07991 0.079906,-0.07991 h 1.1453233 v 0.445192 c 0,0.1712277 0.09893,0.5707587 0.171228,0.5707587 0.07991,0 0.232109,-0.395726 0.232109,-0.5517337 v -0.563149 l 0.958876,-0.04947 0.06849,0.140787 0.04186,-0.152202 1.179569,-0.07991 0.03805,0.102736 0.03805,-0.114151 1.84926,-0.140788 c 0.04947,-0.0076 0.06469,-0.04185 0.06469,-0.09132 l -0.01142,-0.331041 c -0.0076,-0.110347 -0.0761,-0.167422 -0.159812,-0.178838 l -4.071416,-0.3006 v -1.088247 c 0,-0.224499 -0.121763,-0.536514 -0.205474,-0.536514 -0.07991,0 -0.213083,0.312015 -0.213083,0.536514 v 1.038782 c -0.403337,-0.02664 -1.1567392,-0.05327 -1.1567392,-0.05327 l -0.076101,-0.06849 v -4.607931 c 0,-0.696326 -0.3614813,-1.731303 -0.5973949,-1.731303 z","a":[9.26,8.467]},"C206":{"d":"M 7.6017364,2.8989743 H 10.837448 m 9.2195921,2.5729695 v 0 l -0.053936,0.057875 -0.1364258,0.2802935 -0.040729,0.2261356 0.039738,0.013435 0.00186,0.061188 -0.371016,0.015426 -0.058394,0.031006 -0.065629,0.058911 -0.041858,0.096635 -0.027388,0.1240235 -0.078579,1.378056 V 5.3614049 L 8.3453521,5.744844 5.2027841,5.738154 1.1048431,5.9898183 1.0216441,6.0001533 0.9632498,6.0657823 0.907956,6.2109931 0.818039,6.5732449 0.7420746,7.7163275 5.3650482,8.3684841 H 8.0439544 L 8.310088,8.2925201 H 8.39277 l 0.5007446,4.6333089 -2.4995889,0.365869 -0.0863,0.03824 -0.069246,0.06201 -0.034623,0.07235 v 1.032495 l 0.048576,0.05529 0.082682,0.05839 0.2315104,0.04134 2.3233724,0.469738 0.1136881,-0.455786 0.048576,-0.296622 0.1798924,1.368027 0.0449,-0.0012 h 0.037724 l 0.1312581,-1.366841 0.048059,0.296622 0.1142049,0.455786 2.323372,-0.469738 0.231511,-0.04134 0.08268,-0.05839 0.04806,-0.05529 v -1.032495 l -0.03411,-0.07235 -0.06925,-0.06201 -0.0863,-0.03824 -2.4995894,-0.365869 0.5007444,-4.6333089 h 0.08268 l 0.266134,0.075964 h 2.678906 L 17.756022,7.7163247 17.680057,6.5732421 17.59014,6.2109903 17.534847,6.0657795 17.475936,6.0001504 17.393253,5.9898152 13.295312,5.7381509 H 10.119279 L 10.070703,5.3547118 V 4.909261 L 9.9983559,3.5248494 9.9704507,3.4008259 9.9291095,3.304191 9.8634805,3.2452799 9.8050861,3.214274 H 9.4355996 V 3.141927 L 9.487276,3.1279744 9.414929,2.9036987 9.2820158,2.6288777 Z","a":[9.26,6.879]},"A339":{"d":"M 9.3461063,0.90113532 9.2604165,0.94826252 9.1451781,1.0955403 9.0366576,1.3125814 8.945707,1.532723 8.8542397,1.8060913 8.7529539,2.1595581 8.6759561,2.5445475 8.6129108,2.9610595 8.5850055,3.293339 V 6.7473916 L 8.5638182,6.8698648 8.4625324,6.9783853 8.3400593,7.0905231 7.2760415,7.7695515 7.3003295,7.619173 7.3287515,7.3948973 7.3458047,7.02076 V 6.7303384 L 7.3178994,6.6703938 7.1044758,6.6424885 H 6.6249185 l -0.2273763,0.027905 -0.052193,0.03514 -0.014469,0.1539958 -0.010335,0.2800863 0.00362,0.2030883 0.01757,0.3110921 0.034623,0.2206584 0.042375,0.1436605 h 0.1364258 l 0.083716,0.1467611 -5.0358682,3.2127238 -0.199471,0.189136 -0.1855184,0.217041 -0.1576131,0.244946 -0.16433108,0.276469 -0.0806152,0.164331 -0.0242879,0.136942 0.0206706,0.06253 0.1157552,-0.136426 0.14314376,-0.129191 0.1788004,-0.122473 0.181901,-0.122473 0.223759,-0.115755 0.1788004,-0.08733 2.7192139,-1.050065 v 0.181901 l 0.063045,0.126091 0.03514,-0.0067 0.048576,-0.153996 v -0.199471 l 0.7596436,-0.273368 0.00723,0.129708 0.05581,0.136425 h 0.038241 l 0.038757,-0.118855 v -0.206706 l 0.7627441,-0.251664 0.013953,0.167948 0.045992,0.125574 0.034623,-0.0067 0.027905,-0.126091 0.031523,-0.112137 -0.0031,-0.108521 0.3638021,-0.125574 0.3953247,-0.077 v 0.167949 l 0.05271,0.160714 h 0.045475 l 0.041858,-0.09767 0.00723,-0.2594156 1.1125936,-0.1085205 0.013953,0.2837031 0.024805,0.189136 v 2.446362 l 0.049093,0.573609 0.034623,0.455269 0.045475,0.486275 0.042375,0.45527 0.080098,0.517798 0.1054199,0.699699 -1.907377,1.270723 -0.098185,0.09095 -0.076998,0.118856 -0.045475,0.150379 -0.03514,0.157613 -0.00672,0.195853 2.3585123,-0.745174 0.1018026,0.535368 0.128571,0.01194 0.1282609,-0.01194 0.1018025,-0.535368 2.358512,0.745174 -0.0067,-0.195853 -0.03514,-0.157613 -0.04547,-0.150379 -0.077,-0.118856 -0.09818,-0.09095 -1.907377,-1.270723 0.1054199,-0.699699 0.080099,-0.517798 0.042375,-0.45527 0.045475,-0.486275 0.03462,-0.455269 0.04909,-0.573609 v -2.446362 l 0.0248,-0.189136 0.01395,-0.2837031 1.112594,0.1085205 0.0072,0.2594156 0.04186,0.09767 h 0.04547 l 0.05271,-0.160714 v -0.167949 l 0.395325,0.077 0.363802,0.125574 -0.0031,0.108521 0.03152,0.112137 0.02791,0.126091 0.03514,0.0067 0.04547,-0.125574 0.01395,-0.167948 0.762744,0.251664 v 0.206706 l 0.03876,0.118855 h 0.03824 l 0.05581,-0.136425 0.0072,-0.129708 0.759644,0.273368 v 0.199471 l 0.04857,0.153996 0.03514,0.0067 0.06305,-0.126091 v -0.181901 l 2.719213,1.050065 0.178801,0.08733 0.223759,0.115755 0.181901,0.122473 0.1788,0.122473 0.143144,0.129191 0.115755,0.136426 0.02119,-0.06253 -0.02481,-0.136942 -0.08062,-0.164331 -0.164331,-0.276469 -0.157613,-0.244946 -0.185519,-0.217041 -0.199471,-0.189136 -5.035868,-3.2127238 0.08372,-0.1467611 h 0.136426 l 0.04237,-0.1436605 0.03462,-0.2206584 0.01757,-0.3110921 0.0036,-0.2030883 -0.01034,-0.2800863 -0.01395,-0.1539958 -0.05271,-0.03514 -0.227376,-0.027905 h -0.479558 l -0.213423,0.027905 -0.02791,0.059945 V 7.02076 l 0.01705,0.3741373 0.02842,0.2242757 0.02429,0.1503785 L 10.35389,7.0905231 10.231417,6.9783853 10.130131,6.8698648 10.108944,6.7473916 V 3.293339 L 10.081038,2.9610595 10.017993,2.5445475 9.9409951,2.1595581 9.8397093,1.8060913 9.7487588,1.532723 9.6572915,1.3125814 9.5492878,1.0955403 9.4335325,0.94826252 Z","a":[9.26,8.467]},"HAWK":{"d":"m 9.2506951,1.8218253 v 0.032791 h -0.017994 v 0.071937 h 0.016939 v 0.2835326 h -0.016939 v 0.3988236 c -0.1440301,0 -0.5691416,0.929219 -0.5691416,2.0682549 v 2.8521836 h -0.034998 v -0.09644 H 8.3307193 c -0.051073,0.020521 -0.2573189,0.1005788 -0.2573189,0.2680077 0,0.4559466 0.068252,0.8336309 0.068252,0.8336309 L 7.9651178,8.6746018 7.4995226,8.9834641 3.8980457,10.807918 c -0.4100071,0.236718 -0.4885738,0.763976 -0.4902318,0.950958 v 0.375075 l 5.0835195,-0.585323 c 0.020968,0.05369 0.067013,0.161899 0.096935,0.171107 0,0.534018 0.089764,2.092331 0.089764,2.092331 C 8.429438,14.08598 8.3673004,14.230985 8.2706242,14.8893 l -1.4892786,1.068022 c -0.081864,0.04967 -0.2393918,0.267021 -0.2393918,0.704362 0,0.02322 0.015805,0.04212 0.046053,0.03683 l 0.2058749,-0.02013 2.2128507,-0.575127 c 0.016955,0.06358 0.022583,0.08479 0.043783,0.08479 h 0.163937 v 0.03533 h -0.018386 v 0.05227 h 0.062297 0.066413 v -0.05227 h -0.018354 v -0.03533 h 0.1639044 c 0.021192,0 0.02686,-0.0212 0.043815,-0.08479 l 2.2128512,0.575127 0.205874,0.02013 c 0.03025,0.0053 0.04601,-0.01362 0.04601,-0.03683 0,-0.437341 -0.157527,-0.654696 -0.239391,-0.704362 l -1.489244,-1.068025 c -0.09668,-0.658315 -0.158846,-0.80332 -0.4074408,-1.077233 0,0 0.089797,-1.558313 0.089797,-2.092331 0.029924,-0.0092 0.075937,-0.117415 0.0969,-0.171107 l 5.083521,0.585323 v -0.375075 c -0.0017,-0.186982 -0.08022,-0.71424 -0.490232,-0.950959 L 11.021344,8.9834312 10.555717,8.6746018 10.379214,8.5345466 c 0,0 0.06822,-0.3776867 0.06822,-0.8336309 0,-0.1674289 -0.206211,-0.2474969 -0.257286,-0.2680077 H 9.8922717 v 0.09644 H 9.8573076 V 4.6771648 c 0,-1.1390359 -0.4251447,-2.0682549 -0.5691745,-2.0682549 V 2.2100864 H 9.2711941 V 1.9265537 h 0.016939 v -0.071937 h -0.017994 v -0.032791 z","a":[9.26,9.79]},"BL8":{"d":"m 7.667773,5.1780131 h 3.247299 m 9.2914224,4.665865 -0.094051,0.1080037 -0.05271,0.1142049 -0.044442,0.2005046 -0.00155,0.1705322 -0.020154,0.1767334 -0.4449341,0.2361613 -0.057878,0.047542 -0.00672,0.057878 -0.012919,1.4283366 0.047542,0.071314 -0.022735,0.347265 L 7.7581826,7.6114216 7.7307941,7.4786131 7.6966877,7.3220336 7.652246,7.2062784 7.5845498,7.103959 7.553544,7.0734699 7.5163369,7.103959 7.4687946,7.1618366 7.4310708,7.257438 7.4041991,7.3799112 7.3530394,7.6217569 1.5177368,7.5700804 1.0051066,7.5726643 0.9441284,7.6165892 0.89968667,7.7256265 0.86919758,7.8858234 0.848527,8.0625568 0.8123535,8.3204222 0.74775796,8.3984536 v 0.057878 l 0.0645955,0.021704 0.006718,0.2211752 0.001034,0.2227254 0.0139526,0.4805908 0.0392741,0.4940267 0.23667804,0.1653643 0.3322795,0.217041 7.0398802,0.05013 0.1064535,0.111621 0.018603,0.19172 0.03359,0.515214 0.3808553,3.046842 -0.2449463,0.05529 -1.578715,0.412378 -0.234611,0.0646 -0.1431437,0.08165 -0.088367,0.09612 -0.064596,0.112138 -0.044442,0.187069 0.023771,0.173633 0.074931,0.166915 0.1121379,0.112137 0.1493449,0.0832 0.3152262,0.05426 1.4314371,0.144177 0.4268474,-0.542603 0.022738,0.835608 0.064596,-0.840775 0.3844727,0.54777 1.4805291,-0.122473 0.336931,-0.05426 0.132808,-0.08837 0.112138,-0.112655 0.07493,-0.166398 0.02377,-0.173633 -0.04444,-0.187585 -0.06459,-0.112138 -0.142627,-0.112138 -0.143144,-0.08165 -0.234611,-0.0646 -1.545125,-0.428915 -0.1638143,-0.03411 0.3405477,-3.01532 0.023771,-0.534334 0.013436,-0.163298 0.1260905,-0.132808 7.0517661,0.04082 0.40876,-0.248563 0.112138,-0.08165 0.112138,-0.6299354 0.05478,-0.4831746 0.01705,-0.2242757 V 8.5529662 l 0.0646,0.037207 v -0.057878 l -0.0646,-0.078031 -0.0072,-0.2552816 -0.02015,-0.1772502 -0.03049,-0.1596801 -0.04444,-0.1090373 -0.06098,-0.044442 -0.486792,-0.00982 -5.867859,-0.040824 -0.03049,-0.2418457 -0.02739,-0.1224732 -0.03721,-0.095601 -0.04754,-0.057878 -0.03772,-0.030489 -0.03049,0.030489 -0.06821,0.1023194 -0.04392,0.1157552 -0.03411,0.1565795 -0.02739,0.1328085 H 9.9585651 V 7.321 l 0.047542,-0.07183 0.02015,-1.4903483 -0.0067,-0.057878 L 9.9616657,5.6528848 9.5125975,5.4317097 9.5089801,5.244641 9.4888263,5.0679076 9.4443846,4.8839395 9.3627358,4.7340779 Z","a":[9.26,7.673]},"B789":{"d":"m 9.2469069,0.64642786 c -0.2141371,0 -0.8588093,0.99604494 -0.8588093,2.69738694 V 6.2339525 L 6.7477024,7.3813835 C 6.8606893,6.9930674 6.882213,6.6182353 6.882213,6.3939433 6.882213,6.1097383 6.859173,5.9315298 6.837665,5.8178478 6.823835,5.7594698 6.794498,5.642625 6.723902,5.642625 H 5.8559928 c -0.1090734,0 -0.1167572,0.1291391 -0.1275106,0.1767626 -0.013829,0.1106098 -0.044548,0.2580103 -0.044548,0.5776075 0,0.3328504 0.071738,0.7942662 0.1474759,1.0569638 h 0.1925823 c 0.01458,0.043005 0.1061008,0.293421 0.1309825,0.3375655 L 1.0735184,11.370425 c -0.078658,0.05378 -0.17377009,0.11661 -0.22553811,0.206275 l -0.4912001,0.782566 v 0.304218 l 0.5482077,-0.467148 C 0.97127119,12.141196 1.1024174,12.04787 1.1842855,12.00854 l 2.3340618,-1.008104 c 0,0.182999 0.070737,0.281342 0.090747,0.281342 0.022418,0 0.087415,-0.132006 0.087415,-0.359209 l 1.122876,-0.485599 c 0,0.15651 0.060209,0.28092 0.087499,0.28092 0.029697,0 0.091505,-0.132438 0.091505,-0.360383 L 5.9390685,9.9473678 h 0.6212314 c 0,0.1870122 0.069842,0.3290792 0.092316,0.3290792 0.029697,0 0.087779,-0.141523 0.087779,-0.3275952 h 1.6466952 v 3.3149752 c 0,0.571342 0.1616072,1.410718 0.2094943,1.641375 0.046691,0.205526 -0.016285,0.288464 -0.063896,0.333002 l -2.0379648,1.81223 c -0.034475,0.0323 -0.081851,0.08446 -0.093687,0.139745 L 6.2936009,17.62412 8.9752522,16.646985 c 0.087488,0.360664 0.188465,0.805134 0.1964744,0.805134 4.33e-4,0 3.384e-4,6.15e-4 3.928e-4,6.45e-4 h 0.0595 0.015211 0.074731 c 5.73e-5,0 -4.3e-5,-6.45e-4 3.913e-4,-6.45e-4 0.00802,0 0.1089865,-0.44447 0.1964747,-0.805134 l 2.6816716,0.977135 -0.107437,-0.433939 c -0.01184,-0.05529 -0.05921,-0.107437 -0.09368,-0.139747 l -2.0379684,-1.81223 c -0.047609,-0.04454 -0.1105865,-0.127476 -0.063895,-0.333002 0.047887,-0.230657 0.2094934,-1.070033 0.2094934,-1.641375 V 9.9488518 h 1.646694 c 0,0.1860732 0.05809,0.3275952 0.08778,0.3275952 0.02248,0 0.09229,-0.142067 0.09229,-0.3290792 h 0.621259 l 0.940681,0.4101392 c 0,0.227945 0.06178,0.360383 0.09148,0.360383 0.02729,0 0.08749,-0.124408 0.08749,-0.28092 l 1.122875,0.485599 c 0,0.227202 0.06503,0.359209 0.08744,0.359209 0.02001,0 0.09075,-0.09834 0.09075,-0.281342 l 2.334036,1.008104 c 0.08187,0.03933 0.213041,0.132651 0.279326,0.187796 l 0.54821,0.467148 V 12.359266 L 17.645694,11.5767 c -0.05176,-0.08966 -0.146882,-0.152499 -0.225539,-0.206275 l -5.08143,-3.5789006 c 0.02488,-0.044144 0.11637,-0.29456 0.130955,-0.3375655 h 0.192582 c 0.07573,-0.2626976 0.147475,-0.7241134 0.147475,-1.0569638 0,-0.3195972 -0.03072,-0.4669975 -0.04455,-0.5776075 -0.01077,-0.047625 -0.01844,-0.1767626 -0.127511,-0.1767626 h -0.867909 c -0.0706,0 -0.09991,0.1168459 -0.113736,0.1752228 -0.02151,0.1136826 -0.04455,0.2918905 -0.04455,0.5760955 0,0.224292 0.0215,0.5991241 0.134483,0.9874402 l -1.64036,-1.147431 V 3.3438148 c 0,-1.701342 -0.6445595,-2.69738694 -0.8586971,-2.69738694 z","a":[9.26,7.937]},"DH8C":{"d":"m 10.534663,6.0232275 h 2.882722 M 5.0114752,6.0232275 H 7.8941967 M 9.2362395,1.8562174 9.1153709,1.8844365 8.9782632,1.9823079 8.8774941,2.1151163 8.763806,2.2980509 8.6371987,2.5507487 8.5235106,2.8096476 8.4165404,3.1377929 8.3281737,3.51038 8.2522093,3.9144897 8.2206867,4.2679565 8.2144855,4.4700113 V 7.329785 l -0.044442,0.037724 H 6.7370564 V 6.5406859 L 6.7179361,6.1934203 6.6740111,5.9851643 6.5918456,5.8208332 6.4781574,5.7133463 6.452836,5.7066283 6.4027098,5.7453856 6.2952229,5.8776773 6.2383788,6.0544107 6.200655,6.2249429 V 7.37371 l -5.56865224,0.631486 -0.0568441,0.025321 -0.0501261,0.069246 -0.0320394,0.1012858 V 8.952425 l 2.85408934,0.1576131 0.043925,0.107487 0.056844,-0.1012858 1.3068969,0.063562 0.043925,0.1069702 0.056844,-0.1007691 1.319816,0.063045 v 0.624768 l 0.025322,0.2402953 0.050126,0.202055 0.1012858,0.151412 0.1198894,0.05684 0.100769,-0.05064 0.095085,-0.100769 0.063045,-0.126607 0.025321,-0.113688 V 9.268168 l 1.5089518,-0.01912 v 2.0644733 l 0.050126,0.675411 0.050643,0.643888 0.075964,0.549321 0.1700155,1.010274 0.2971395,1.287777 -2.1528402,0.302824 -0.063045,0.05684 -0.050643,0.126607 v 0.618567 l 0.037724,0.202055 0.063045,0.139009 h 2.4127726 l -0.00155,0.2651 0.063045,-0.2651 h 2.4685829 l 0.06304,-0.139009 0.03772,-0.202055 v -0.618567 l -0.05064,-0.126607 -0.06304,-0.05684 -2.1528401,-0.302824 0.2966228,-1.287777 0.1705322,-1.010274 0.075964,-0.549321 0.05064,-0.643888 0.05013,-0.675411 V 9.2490477 l 1.508952,0.01912 v 0.864547 l 0.02532,0.113688 0.06305,0.12609 0.09457,0.101286 0.101285,0.05064 0.11989,-0.05684 0.101286,-0.151412 0.05013,-0.202055 0.02532,-0.2402953 v -0.624768 l 1.319299,-0.063045 0.05685,0.1007691 0.04444,-0.107487 1.306897,-0.063045 0.05684,0.1012858 0.04392,-0.107487 2.853573,-0.1576131 V 8.2010497 L 17.904333,8.0997639 17.854207,8.0305174 17.797363,8.005196 12.228711,7.37371 V 6.2249429 l -0.03772,-0.1705322 -0.05684,-0.1767334 -0.107487,-0.1328084 -0.05064,-0.038241 -0.02481,0.00672 -0.113688,0.1074869 -0.08216,0.1643311 -0.04444,0.208256 -0.0186,0.3472656 V 7.3675088 H 10.259322 L 10.21488,7.329785 V 4.4700113 L 10.208679,4.2679565 10.177156,3.9144897 10.101192,3.51038 10.012825,3.1377929 9.9053384,2.8096476 9.792167,2.5507487 9.6655597,2.2980509 9.5518716,2.1151163 9.4511025,1.9823079 9.3498167,1.88774 Z","a":[9.26,7.937]},"A20N":{"d":"m 9.2878472,0.3959157 -0.082682,0.004651 -0.076481,0.0413411 -0.054777,0.0434082 -0.065112,0.0707967 -0.055294,0.0764811 -0.049093,0.0728638 -0.078548,0.14159342 -0.076481,0.15709638 -0.082682,0.1865519 -0.084233,0.2046387 -0.065112,0.171049 -0.039274,0.1255737 -0.031523,0.1281576 -0.043408,0.2315104 -0.023254,0.1240234 -0.021704,0.1984375 -0.01602,0.1689819 -0.00982,0.151412 -0.00775,0.1477946 -0.00362,0.1591634 v 0.6800618 l -0.00207,0.6015137 0.00207,0.5364014 v 0.550354 0.4010091 l -0.011886,0.041341 -0.01757,0.1534791 -0.013953,0.2397786 -0.00982,0.1395264 -0.00982,0.05116 -0.025321,0.060978 -0.031523,0.047026 -0.039274,0.035657 L 7.052836,7.1040343 7.070923,6.9820779 7.082292,6.8425515 7.088492,6.7087095 7.092112,6.562982 V 6.4787485 L 7.0822971,6.1976287 7.0688612,6.0265797 7.0569756,5.9304616 7.0373386,5.8612152 7.0135674,5.8121225 6.9918633,5.784734 6.871974,5.7692311 l -0.1493449,-0.00982 -0.1514119,-0.0062 -0.168982,0.00413 -0.1136881,0.00775 -0.079065,0.00207 -0.027388,0.00775 -0.03359,0.037207 -0.027388,0.055294 -0.019637,0.060978 -0.013436,0.1136882 -0.011886,0.118339 -0.011885,0.1136882 -0.00775,0.1374593 -0.00413,0.1514119 0.00413,0.1694987 0.00568,0.076481 0.015503,0.1374593 0.027905,0.2103231 0.037207,0.2025716 0.013953,0.025321 0.1100708,0.011886 0.013436,0.1043864 -1.273824,0.6562906 -3.4416504,1.7714681 -0.06873,0.054777 -0.069246,0.072863 -0.060461,0.08268 -0.05116,0.09818 -0.037724,0.112138 -0.029456,0.112138 -0.013436,0.117822 -0.01602,0.410828 0.021704,-0.01189 0.011886,-0.180868 2.2820312,-0.658357 0.019637,0.08837 0.01757,0.159164 0.025838,0.121956 0.019637,0.02739 0.025322,-0.06305 0.01602,-0.113688 0.015503,-0.139526 0.00413,-0.102319 0.029456,-0.03566 1.5683797,-0.4501018 0.00413,0.078548 0.015503,0.098702 0.021704,0.094051 0.025838,0.047542 0.031523,-0.063045 0.019637,-0.094568 0.013436,-0.1023193 0.00982,-0.1018026 0.8433594,-0.2459798 h 0.2475301 l 0.00207,0.041341 0.03359,0.1240235 0.027389,0.044958 0.039274,-0.1038696 0.027389,-0.1085206 0.2537312,0.0062 -0.00207,0.074414 0.021704,0.1064534 0.031523,0.1178223 0.015503,0.015503 0.035657,-0.080615 0.021704,-0.1002523 0.00982,-0.1395264 1.2970784,0.00207 -0.00568,4.0374802 0.011886,0.190686 0.01757,0.200504 0.025322,0.251664 0.029455,0.241846 0.067179,0.428398 0.058911,0.330212 0.047026,0.240296 0.043408,0.206188 -0.011886,0.05891 -0.025322,0.07286 -0.027905,0.05684 -0.066663,0.07855 -0.056844,0.05529 -1.9833415,1.212846 -0.060978,0.03927 -0.045475,0.05116 -0.023771,0.06253 -0.0093,0.08268 -0.01602,0.116272 -0.00207,0.159163 v 0.194304 l 0.013953,0.0062 2.5848552,-0.574125 0.025321,0.192753 0.035657,0.149345 0.056844,0.245463 0.05116,0.180867 0.066663,0.159164 0.039791,0.05529 h 0.098185 0.098185 l 0.039274,-0.05529 0.067179,-0.159164 0.05116,-0.180867 0.056844,-0.245463 0.03514,-0.149345 0.025838,-0.192753 2.5848548,0.574125 0.01395,-0.0062 v -0.194304 l -0.0021,-0.159163 -0.01602,-0.116272 -0.0098,-0.08268 -0.02326,-0.06253 -0.04547,-0.05116 -0.06098,-0.03927 -1.983342,-1.212846 -0.05684,-0.05529 -0.067179,-0.07855 -0.027389,-0.05684 -0.025321,-0.07286 -0.011886,-0.05891 0.043408,-0.206705 0.047026,-0.239779 0.058911,-0.330212 0.06666,-0.428398 0.02945,-0.241846 0.02584,-0.251664 0.01757,-0.200504 0.01188,-0.190686 -0.0062,-4.0374802 1.297595,-0.00207 0.0098,0.1395264 0.0217,0.1002523 0.03514,0.080615 0.01602,-0.015503 0.03152,-0.1178223 0.02119,-0.1064534 -0.0016,-0.074414 0.253215,-0.0062 0.02791,0.1085206 0.03927,0.1038696 0.02739,-0.044958 0.03359,-0.1240235 0.0016,-0.041341 h 0.248046 l 0.84336,0.2459798 0.0098,0.1018026 0.01344,0.1023193 0.01964,0.094568 0.03152,0.063045 0.02584,-0.047542 0.02119,-0.094051 0.01602,-0.098702 0.0036,-0.078548 1.568896,0.4501018 0.02946,0.03566 0.0036,0.102319 0.01602,0.139526 0.0155,0.113688 0.02584,0.06305 0.01964,-0.02739 0.02532,-0.121956 0.01809,-0.159164 0.01964,-0.08837 2.282031,0.658357 0.01189,0.180868 0.0217,0.01189 -0.01602,-0.410828 -0.01395,-0.117822 -0.02946,-0.112138 -0.03721,-0.112138 -0.05116,-0.09818 -0.06098,-0.08268 -0.06873,-0.072863 -0.06873,-0.054777 -3.442167,-1.7714681 -1.273824,-0.6562906 0.01395,-0.1043864 0.110071,-0.011886 0.01395,-0.025321 0.03721,-0.2025716 0.02739,-0.2103231 0.01602,-0.1374593 0.0057,-0.076481 0.0041,-0.1694987 -0.0041,-0.1514119 -0.0078,-0.1374593 -0.01189,-0.1136882 -0.01188,-0.118339 -0.01344,-0.1136882 -0.01964,-0.060978 -0.02791,-0.055294 -0.03307,-0.037207 -0.02791,-0.00775 -0.07855,-0.00207 -0.113688,-0.00775 -0.169499,-0.00413 -0.150895,0.0062 -0.149861,0.00982 -0.11989,0.015503 -0.02119,0.027388 -0.02377,0.049093 -0.01964,0.069246 -0.01189,0.096118 -0.01395,0.171049 -0.0098,0.2811198 v 0.084233 l 0.0041,0.1457275 0.0057,0.133842 0.01189,0.1395264 0.01757,0.1219564 -1.108459,-0.5643067 -0.03927,-0.035657 -0.03152,-0.047026 -0.02532,-0.060978 -0.0098,-0.05116 -0.0098,-0.1395264 -0.01386,-0.239779 -0.01757,-0.1534791 -0.01189,-0.041341 V 5.3697723 4.8194183 l 0.0021,-0.5364014 -0.0021,-0.6015137 V 3.0014414 l -0.0036,-0.1591634 -0.0083,-0.1477946 -0.0098,-0.151412 -0.0155,-0.1689819 L 10.141036,2.175652 10.117254,2.0516286 10.074362,1.8201182 10.04284,1.6919606 10.003566,1.5663869 9.9384535,1.3953379 9.8542209,1.1906992 9.7715386,1.0041473 9.6950575,0.84705095 9.6159925,0.70545753 9.5668999,0.63259376 9.5121229,0.55611264 9.4470106,0.48531593 9.3922336,0.44190772 9.3152357,0.40056658 Z","a":[9.26,7.937]},"A169":{"d":"m 9.0630866,3.6047915 0.1294725,0.034072 0.1056225,0.061329 0.1158441,0.1158438 0.098808,0.1396942 0.095401,0.1771732 0.1022154,0.2487237 0.088586,0.3032387 0.1124368,0.4088611 0.051108,0.2180593 0.030664,0.3441245 0.010221,0.2827956 v 2.5315315 h 0.177173 l 0.06814,0.00341 0.06814,0.027257 0.05452,0.064736 0.03748,0.1362871 -0.01363,0.1908016 -0.04429,0.248724 -0.06814,0.2180592 -0.09199,0.194209 -0.0954,0.1396941 H 9.8842151 l -0.061329,0.2555381 -0.071551,0.2725738 -0.085179,0.245317 -0.1022154,0.224873 -0.1158439,0.153323 -0.00341,0.39864 -0.013629,0.347532 -0.017036,0.320274 -0.02385,0.344125 -0.027257,0.364567 -0.037479,0.391826 -0.044293,0.391825 -0.0477,0.340718 -0.010221,0.115843 -0.020442,0.115844 -0.017037,0.06474 v 0.02726 H 10.3987 l 0.07155,0.0477 0.06474,0.08177 0.05111,0.09881 0.02385,0.129472 v 0.10903 l -0.01363,0.06133 -0.03748,0.03067 H 9.1618944 l -0.00682,0.09881 0.057922,0.02044 0.064736,0.02385 0.030665,0.04429 v 0.149916 h 0.3781965 v 0.09199 H 9.3015873 v 0.238503 l -0.052155,0.02883 -0.075032,0.02728 -0.088675,0.01364 -0.1023167,-0.02046 -0.064801,-0.03411 -0.075032,-0.05457 -0.054569,-0.08185 -0.034106,-0.122781 0.00341,-0.09208 0.047748,-0.0955 0.06139,-0.06821 0.051158,-0.03752 0.040927,-0.02387 v -0.11255 H 7.5816689 l -0.040927,-0.01705 -0.023873,-0.02387 -0.00682,-0.143244 0.017052,-0.109138 0.037516,-0.09549 0.051158,-0.07162 0.098906,-0.08868 H 8.9322503 L 8.9288403,14.003763 8.8879133,13.785488 8.8503973,13.509233 8.8231133,13.24662 8.7924183,12.939669 8.7412603,12.411033 8.7003333,11.66071 8.6832803,11.207106 8.6696383,10.842176 8.5775533,10.726217 8.4957003,10.5591 8.4309003,10.391982 8.3456356,10.136179 8.2603717,9.7848911 8.2364984,9.692806 H 8.0420966 L 7.953422,9.5904893 7.8647474,9.4233718 7.7897153,9.2221491 7.7487885,9.0141051 7.7317361,8.8265242 l -0.00682,-0.1944018 0.027284,-0.075032 0.047748,-0.054569 0.06139,-0.027284 0.071622,-0.017052 H 8.1205397 V 5.8081804 L 8.1614665,5.3034178 8.2160355,5.0169309 8.3217627,4.692928 8.4513639,4.2802503 8.5673231,4.0142268 8.6866925,3.8334672 8.7924197,3.720919 8.9083786,3.6424761 9.0141061,3.6083705 Z m 9.502568,15.010764 v -1.131385 m 0,2.26277 v -1.131385 M 7.312215 2.0985799 L 7.2755248 2.1068481 L 7.2140298 2.1621419 L 7.1447834 2.2334554 L 7.0838052 2.337325 L 7.0610676 2.4432617 L 7.2347004 3.0225545 L 7.2548542 3.0530436 L 8.709029 7.3587238 L 8.7539875 7.336503 L 8.8335692 7.5385578 L 9.0764484 7.8543008 L 9.0764484 7.454842 L 8.9989338 7.2631224 L 9.033557 7.246586 L 8.3338581 5.1784952 L 8.09718 4.4787963 L 7.9137287 3.9325764 L 7.7385456 3.4018595 L 7.573181 2.9310872 L 7.4998005 2.778125 L 7.4672443 2.6758056 L 7.4321044 2.5802042 L 7.4098835 2.4659993 L 7.3954141 2.3698811 L 7.3876626 2.2618774 L 7.3793944 2.1905639 L 7.3545897 2.1316528 L 7.312215 2.0985799 z M 9.0764484 7.8543008 L 9.4562702 7.7307941 L 9.6149168 7.5979857 L 9.6412718 7.625891 L 11.392069 6.3215778 L 11.984281 5.8802611 L 12.447302 5.5366129 L 12.897404 5.2064005 L 13.294279 4.9035766 L 13.417269 4.7862711 L 13.504085 4.7237426 L 13.5847 4.6612141 L 13.686503 4.60437 L 13.772802 4.5614786 L 13.873055 4.5201375 L 13.938684 4.4901651 L 13.98726 4.448824 L 14.005346 4.3981811 L 13.986226 4.3656249 L 13.914913 4.3242838 L 13.825512 4.2803588 L 13.70769 4.2545206 L 13.599686 4.2658894 L 13.102559 4.6095377 L 13.079822 4.6384765 L 9.4340493 7.3520059 L 9.4691893 7.3881794 L 9.3017576 7.5261555 L 9.0764484 7.8543008 z M 9.0764484 7.8543008 L 9.3110594 8.1777953 L 9.4867593 8.2873493 L 9.4681558 8.320939 L 11.249959 9.5828774 L 11.852506 10.010242 L 12.322245 10.344071 L 12.775964 10.67015 L 13.186275 10.95437 L 13.33562 11.034985 L 13.42192 11.09803 L 13.506669 11.155391 L 13.591935 11.234456 L 13.659631 11.303703 L 13.729911 11.386385 L 13.778487 11.439612 L 13.832747 11.472685 L 13.887007 11.474235 L 13.911812 11.445813 L 13.928865 11.365198 L 13.942818 11.267012 L 13.931449 11.146606 L 13.887007 11.047904 L 13.406417 10.681002 L 13.371793 10.668082 L 9.6645262 8.0398192 L 9.6412718 8.0842609 L 9.4583372 7.9674722 L 9.0764484 7.8543008 z M 9.0764484 7.8543008 L 8.8413206 8.1777953 L 8.7911945 8.3788166 L 8.7534707 8.3715819 L 8.103898 10.455692 L 7.8842731 11.161076 L 7.7116739 11.710913 L 7.5416584 12.24318 L 7.3985147 12.721187 L 7.3680256 12.888102 L 7.3344359 12.989905 L 7.3060139 13.08809 L 7.2569213 13.19351 L 7.2119628 13.279293 L 7.1551187 13.371793 L 7.1199787 13.434322 L 7.1049925 13.496334 L 7.1204955 13.54801 L 7.1551187 13.562996 L 7.2367674 13.554728 L 7.3349527 13.537675 L 7.4455402 13.489099 L 7.5261555 13.416752 L 7.7261433 12.846244 L 7.7276935 12.809554 L 9.0821328 8.4713174 L 9.0325234 8.4630492 L 9.0867837 8.2527261 L 9.0764484 7.8543008 z M 9.0764484 7.8543008 L 8.6961099 7.7307941 L 8.4899209 7.7452635 L 8.4847533 7.7075397 L 6.3019408 7.7338947 L 5.5634846 7.7426797 L 4.9867756 7.7483641 L 4.4281534 7.7509479 L 3.9289591 7.7628335 L 3.7610107 7.7850544 L 3.6540405 7.7845376 L 3.5517211 7.788155 L 3.4364827 7.7742023 L 3.3408813 7.7581826 L 3.2354614 7.7323444 L 3.1651814 7.7183918 L 3.1011026 7.7230427 L 3.0571777 7.7540485 L 3.0535603 7.7912556 L 3.08715 7.8667031 L 3.133142 7.9545531 L 3.2132405 8.0449868 L 3.3072916 8.0987303 L 3.9119059 8.1131997 L 3.9470458 8.1028644 L 8.4914712 8.0506712 L 8.4842365 8.0010619 L 8.7007607 7.987626 L 9.0764484 7.8543008 z ","a":[8.996,6.35]},"SF34":{"d":"M 9.2603956,1.0381971 C 8.2429566,1.4583347 8.2986376,3.8526052 8.2986376,3.8526052 V 7.4009861 L 6.8256296,7.5730908 V 7.2339443 6.9808502 l 0.07593,-0.1974146 -0.101238,-0.09617 c -0.03543,-0.6732317 -0.08099,-0.7592825 -0.08099,-0.7592825 0.18729,0.020242 0.313837,0.015216 0.313837,0.015216 0.759283,-0.015216 0.754221,-0.080985 0.754221,-0.080985 -0.13667,-0.086057 -0.754221,-0.050614 -0.754221,-0.050614 l -0.34421,0.010145 C 6.5725356,5.4674128 6.4864836,5.4674128 6.4864836,5.4674128 6.3649986,5.497784 6.2688226,5.8268062 6.2688226,5.8268062 l -0.329023,-0.00507 c -0.759282,0.00507 -0.75422,0.060742 -0.75422,0.060742 0.01013,0.080985 0.749158,0.065799 0.749158,0.065799 0.121485,0.020242 0.308775,-0.00507 0.308775,-0.00507 -0.151856,0.5365576 -0.121485,1.2857157 -0.121485,1.2857157 V 7.6591831 L 0.65013091,8.3071003 c -0.2379085,0.075928 -0.2328467,0.3897649 -0.2328467,0.3897649 l -0.035433,0.07593 0.035433,0.05061 v 0.3796407 l 5.82116639,0.344209 c 0.0051,0.2277837 0.227785,0.2227217 0.227785,0.2227217 0.202476,0.02025 0.227785,-0.2024747 0.227785,-0.2024747 l 1.589432,0.09618 v 3.8369091 c 0,0.830164 0.141733,1.250285 0.141733,1.250285 l -2.541066,0.425199 c -0.222723,0.05569 -0.232847,0.273341 -0.232847,0.273341 l 0.0051,0.496063 c 0,0.06074 0.101238,0.0658 0.101238,0.0658 l 2.890336,0.394827 0.237908,0.207537 c 0.151857,0.799777 0.323961,0.799778 0.323961,0.799778 l 0.02025,0.111356 0.02025,-0.106299 c 0.192352,-0.01522 0.334085,-0.820024 0.334085,-0.820024 l 0.232845,-0.217694 2.9308314,-0.425198 c 0.08606,-0.02024 0.08099,-0.06074 0.08099,-0.06074 v -0.399894 c -0.01014,-0.313838 -0.217658,-0.349271 -0.217658,-0.349271 l -2.561306,-0.415064 c 0.156919,-0.77953 0.141734,-1.235099 0.141734,-1.235099 V 9.6383386 l 1.55906,-0.09111 c 0.02531,0.2125987 0.232847,0.2024747 0.232847,0.2024747 0.227784,0.0051 0.232847,-0.2379077 0.232847,-0.2379077 l 5.846476,-0.354332 V 8.8081942 l 0.0658,-0.0658 -0.06074,-0.07087 C 18.037699,8.2564437 17.850413,8.2513823 17.850413,8.2513823 L 12.358269,7.6237091 V 7.2136958 6.9302304 c 0.0405,-0.045557 0.0405,-0.111356 0.0405,-0.111356 0.0051,-0.1316138 -0.0658,-0.1670434 -0.0658,-0.1670434 0,-0.4150746 -0.09617,-0.7390339 -0.09617,-0.7390339 0.126541,0.035428 0.298652,0.00507 0.298652,0.00507 0.784591,0.060742 0.764344,-0.070871 0.764344,-0.070871 -0.0051,-0.075928 -0.769407,-0.0405 -0.769407,-0.0405 -0.126541,-0.00507 -0.323961,0.00507 -0.323961,0.00507 -0.121484,-0.3644548 -0.21766,-0.3644548 -0.21766,-0.3644548 -0.09112,0.00507 -0.207538,0.3695177 -0.207538,0.3695177 -1.113615,-0.0405 -1.078181,0.055686 -1.078181,0.055686 0,0.070871 0.739036,0.070871 0.739036,0.070871 C 11.604063,5.95333 11.745797,5.92797 11.745797,5.92797 11.604063,6.4746538 11.619249,7.2187506 11.619249,7.2187506 V 7.5477764 L 10.206967,7.3857975 v -3.528134 c 0,-2.495759 -0.9465724,-2.8194694 -0.9465724,-2.8194694 z","a":[9.26,8.467]},"ASK21":{"d":"m 9.2606891,5.0357991 -0.034623,0.01602 -0.034107,0.066146 -0.063562,0.1720825 -0.042375,0.1503785 -0.050126,0.190686 -0.034623,0.1906861 -0.039791,0.2273763 -0.039791,0.3674194 -0.012919,0.2490804 -0.00827,0.2428792 v 0.1932699 0.2196248 l 0.00827,0.1850016 v 0.1483114 l -0.00827,0.018603 h -4.972304 l -1.219047,0.020671 -1.0102742,0.00879 -0.94619548,0.011885 -0.05271,0.0031 -0.0325562,0.023254 -0.0377238,0.07028 -0.0237712,0.084749 -0.005684,0.099735 0.0118856,0.2103231 0.0103353,0.022738 3.35225008,0.4749064 4.6891194,0.4475179 0.093534,0.018604 0.1059366,0.031523 0.062529,0.024805 0.045992,0.050126 0.014469,0.06873 0.160197,3.3832564 -1.361674,0.220658 -0.031006,0.0021 -0.022738,0.02532 -0.01912,0.07493 -0.00827,0.07493 v 0.249589 l 1.4619283,0.104387 0.066663,-0.110588 0.028699,0.24598 0.028145,-0.24598 0.066663,0.110588 1.4614095,-0.104387 v -0.249597 l -0.0083,-0.07493 -0.0186,-0.07493 -0.02325,-0.02532 -0.03101,-0.0021 -1.361674,-0.220658 0.160197,-3.3832567 0.014469,-0.06873 0.045992,-0.050126 0.062529,-0.024805 0.1059367,-0.031523 0.094051,-0.018604 4.6886023,-0.4475179 3.35225,-0.4749064 0.01034,-0.022738 0.01188,-0.2103231 -0.0057,-0.099735 -0.02325,-0.084749 -0.03824,-0.07028 -0.03204,-0.023254 -0.05271,-0.0031 -0.946195,-0.011885 -1.010791,-0.00879 -1.21853,-0.020671 H 9.6203571 l -0.00775,-0.018603 V 7.5064493 l 0.00775,-0.1850016 V 7.1018229 6.908553 L 9.6126056,6.6656738 9.5991697,6.4165934 9.5593789,6.049174 9.519588,5.8217977 9.4854816,5.6311116 9.4353554,5.4404256 9.3929808,5.2900472 9.3294187,5.1179647 9.2947955,5.0518188 Z","a":[9.26,8.202]}},"designators":{"B190":"B190D","A388":"A388","AS50":"AS50","R44":"R44","A139":"A139","B06":"B06","A148":"A148","P28A":"P28A","C208":"C208","C402":"C402","A225":"A225","AN12":"AN12","E290":"E290","A343":"A343","E295":"E290","A337":"A337","RV9":"RV9","B762":"B772","A332":"A332","B772":"B772","AS65":"AS65","H25A":"H25A","A306":"A306","A35K":"A35K","B190C":"B190D","A310":"A310","C182":"C182","B412":"B412","A30B":"A306","C210":"C210","AS55":"AS55","PC21":"PC21","EC45":"EC45","A359":"A359","AN28":"AN28","A119":"A119","AC90":"AC90","A140":"A140","A342":"A342","P32T":"P32T","B77W":"B77W","AN24":"AN24","DH8B":"DH8B","A345":"A345","A321":"A321","A3ST":"A3ST","F70":"F70","B738":"B738","C72R":"C172","A320":"A320","F28":"F28","A158":"A158","C172":"C172","B350":"B350","PC12":"PC12","PA44":"PA44","A21N":"A21N","P68":"P68","A124":"A124","A333":"A333","GLEX":"GLEX","F16":"F16","DH8A":"DH8A","B214":"B214","AJ27":"AJ27","A748":"A748","C441":"C441","SR22":"SR22","SW3":"SW3","AT25":"AT25","F100":"F100","AT75":"AT75","DHC5":"DHC5","CT4":"CT4","A109":"A109","A319":"A319","E190":"E190","A318":"A318","AN26":"AN26","E195":"E190","TWEN":"TWEN","SONX":"SONX","A19N":"A19N","B752":"B752","A400":"A400","EC35":"EC45","PA31":"PA31","C560":"C560","DA42":"DA42","SW4":"SW4","A338":"A338","BE36":"BE36","B38M":"B38M","A346":"A346","DH8D":"DH8D","C206":"C206","A339":"A339","HAWK":"HAWK","BL8":"BL8","B789":"B789","DH8C":"DH8C","B190D":"B190D","A20N":"A20N","A169":"A169","SF34":"SF34","ASK21":"ASK21"},"categories":{"A1":"C172","A2":"DH8B","A3":"B738","A4":"B752","A5":"B77W","A6":"F16","A7":"B06"}};

    // resolvedDesignator -> Path2D, built lazily the first time each type is actually seen
    // on the scope so we're not constructing ~100 Path2D objects up front for nothing.
    const pwSilhouettePathCache = new Map();

    function resolvePwSilhouetteShape(ac) {
      const type = String(ac.t || '').trim().toUpperCase();
      const category = String(ac.category || '').trim().toUpperCase();
      let key = (type && PW_SILHOUETTES.designators[type]) || null;
      if (!key && category) key = PW_SILHOUETTES.categories[category] || null;
      if (!key) return null;
      const shape = PW_SILHOUETTES.shapes[key];
      if (!shape) return null;
      let path = pwSilhouettePathCache.get(key);
      if (!path) {
        try {
          path = new Path2D(shape.d);
        } catch (e) {
          path = null;
        }
        pwSilhouettePathCache.set(key, path);
      }
      if (!path) return null;
      return { path, anchor: shape.a };
    }

    // Pixels per silhouette-viewbox-unit. The viewBox is ~18.5 units square; this scale
    // makes a mid-size airliner come out at roughly the same on-scope footprint as the old
    // hand-drawn vector aircraft did, so zoom levels and label spacing didn't need retuning.
    const PW_SILHOUETTE_SCALE = 1.25;

    function drawVectorAircraftSilhouette(ctx, ac, pt, heading, colorHex) {
      const category = String(ac.category || '').trim().toUpperCase();
      const type = String(ac.t || '').trim().toUpperCase();
      const typeLower = type.toLowerCase();

      // A few broad type/category hints keep the shapes believable without requiring
      // another network request or an aircraft-type database.
      const isHelicopter =
        category === 'A7' || /^(R22|R44|EC20|EC30|EC35|EC45|EC55|EC75|H125|H130|H135|H145|H155|H160|AS3|AS32|B06|B407|B412|S76|S92|AW13|AW16|AW17)/.test(type);
      const isLight =
        category === 'A1' || category === 'A2' ||
        /^(C1[0-9]|C2[0-9]|C3[0-9]|C4[0-9]|C5[0-9]|C6[0-9]|C7[0-9]|C8[0-9]|C9[0-9]|P28|PA1|PA2|PA3|PA4|DA4|DA5|SR2|TB[0-9]|BE[0-9]|SF2|G[A-Z0-9])/.test(type);
      // (A5 is "Heavy" = airliners, so it is not a military hint - only A6 "High Performance".)
      const isMilitary =
        category === 'A6' ||
        /^(F[0-9]|E[0-9]|T[0-9]|A10|B1|B2|B52|C130|C17|C5M|KC|P8|RC|U2|SR71|MIR|RAF|EUFI|F35|F22|F18|GRIP)/.test(type);

      ctx.save();
      ctx.translate(pt.x, pt.y);
      // Every shape below (including the helicopter, as of this fix - see its coordinates)
      // is drawn nose-up in its own local coordinates, i.e. already pointing along track 0 /
      // north at zero rotation. Canvas rotate() is clockwise for a positive angle, same
      // direction compass headings increase in, so the aircraft's own track in degrees is
      // the rotation to apply directly - no offset needed. (A previous version of this code
      // assumed the shapes were drawn nose-right and applied an extra -90 degrees to
      // compensate, which was wrong for these nose-up shapes and rotated every aircraft 90
      // degrees off from its real track.)
      ctx.rotate(heading * Math.PI / 180);

      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.fillStyle = colorHex;
      ctx.strokeStyle = '#050505';
      ctx.lineWidth = 1.05;
      ctx.shadowBlur = 0;

      ctx.beginPath();

      if (isHelicopter) {
        // Compact top-down helicopter: rotor bar + body + tail boom. Nose-up (tail extends
        // down/+Y) to match the other three shapes below, per the rotation comment above -
        // this used to be drawn nose-right (tail extending in -X) instead, which needed the
        // old rotation formula's extra -90 degrees to look right and was the other half of
        // that bug; these coordinates are that same shape rotated 90 degrees to match.
        ctx.ellipse(0, 0, 2.9, 5.4, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(1.7, 1);
        ctx.lineTo(1.7, 7.5);
        ctx.lineTo(2.2, 9);
        ctx.lineTo(0.9, 7.2);
        ctx.lineTo(0.9, 1);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(-4.6, 5.5);
        ctx.lineTo(-4.6, -5.5);
        ctx.moveTo(4.6, 5.5);
        ctx.lineTo(4.6, -5.5);
        ctx.stroke();
      } else if (isLight) {
        // Small GA aircraft, deliberately narrow and slightly chunky like the reference.
        ctx.moveTo(0, -9);
        ctx.lineTo(1.5, -3.5);
        ctx.lineTo(6.8, 1.8);
        ctx.lineTo(6.3, 3.0);
        ctx.lineTo(1.2, 1.5);
        ctx.lineTo(1.0, 6.5);
        ctx.lineTo(3.0, 9.0);
        ctx.lineTo(2.0, 9.7);
        ctx.lineTo(0, 7.0);
        ctx.lineTo(-2.0, 9.7);
        ctx.lineTo(-3.0, 9.0);
        ctx.lineTo(-1.0, 6.5);
        ctx.lineTo(-1.2, 1.5);
        ctx.lineTo(-6.3, 3.0);
        ctx.lineTo(-6.8, 1.8);
        ctx.lineTo(-1.5, -3.5);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      } else if (isMilitary) {
        // Fast-jet / military silhouette with swept wings.
        ctx.moveTo(0, -11);
        ctx.lineTo(1.6, -4.2);
        ctx.lineTo(7.2, 2.4);
        ctx.lineTo(6.2, 3.3);
        ctx.lineTo(1.6, 1.5);
        ctx.lineTo(1.0, 5.0);
        ctx.lineTo(3.5, 8.5);
        ctx.lineTo(2.4, 9.2);
        ctx.lineTo(0, 6.8);
        ctx.lineTo(-2.4, 9.2);
        ctx.lineTo(-3.5, 8.5);
        ctx.lineTo(-1.0, 5.0);
        ctx.lineTo(-1.6, 1.5);
        ctx.lineTo(-6.2, 3.3);
        ctx.lineTo(-7.2, 2.4);
        ctx.lineTo(-1.6, -4.2);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      } else {
        // Main airliner silhouette: wide swept wings, twin tail fins and a recognisable nose.
        ctx.moveTo(0, -12);
        ctx.bezierCurveTo(1.5, -10, 2.0, -6, 2.2, -2.5);
        ctx.lineTo(11.0, 4.2);
        ctx.lineTo(10.2, 5.5);
        ctx.lineTo(2.1, 3.0);
        ctx.lineTo(2.0, 8.0);
        ctx.lineTo(5.2, 10.7);
        ctx.lineTo(4.1, 11.8);
        ctx.lineTo(0, 9.4);
        ctx.lineTo(-4.1, 11.8);
        ctx.lineTo(-5.2, 10.7);
        ctx.lineTo(-2.0, 8.0);
        ctx.lineTo(-2.1, 3.0);
        ctx.lineTo(-10.2, 5.5);
        ctx.lineTo(-11.0, 4.2);
        ctx.lineTo(-2.2, -2.5);
        ctx.bezierCurveTo(-2.0, -6, -1.5, -10, 0, -12);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        // Small fuselage highlight makes the shape readable at low radar zoom.
        ctx.beginPath();
        ctx.moveTo(0, -9);
        ctx.lineTo(0, 7);
        ctx.strokeStyle = 'rgba(0,0,0,0.45)';
        ctx.lineWidth = 0.65;
        ctx.stroke();
      }

      ctx.restore();
      return true;
    }

    // Real pw-silhouettes artwork first (specific type, falling back to the ADS-B category's
    // generic shape - see resolvePwSilhouetteShape), then the hand-drawn vector shapes for
    // anything neither covers. Wrapped in try/catch so a bad/missing path never breaks the
    // whole scope render - worst case it just falls through to the vector silhouette.
    function drawPwSilhouette(ctx, ac, pt, heading, colorHex) {
      try {
        const resolved = resolvePwSilhouetteShape(ac);
        if (resolved) {
          const s = PW_SILHOUETTE_SCALE;
          ctx.save();
          ctx.translate(pt.x, pt.y);
          ctx.rotate(heading * Math.PI / 180);
          ctx.scale(s, s);
          ctx.translate(-resolved.anchor[0], -resolved.anchor[1]);
          ctx.lineJoin = 'round';
          ctx.lineCap = 'round';
          ctx.fillStyle = colorHex;
          ctx.strokeStyle = '#050505';
          ctx.lineWidth = 0.9 / s;
          ctx.shadowBlur = 0;
          ctx.fill(resolved.path);
          ctx.stroke(resolved.path);
          ctx.restore();
          return true;
        }
      } catch (e) {
        // fall through to the vector silhouette below
      }
      return drawVectorAircraftSilhouette(ctx, ac, pt, heading, colorHex);
    }

    let scrollState = 'PAUSED_TOP';
    let scrollTimer = 120;
    let internalScrollPos = 0;

    // Array of randomized bonus phrases to prepend or add to speech alerts
    const randomAddonPhrases = [
      "hold on to your hats boys! it could be a fast one.",
      "dont get too excited now, but there is a",
      "heads up troops, things are getting spicy!",
      "brace yourselves, there is a",
      "buckle up, we've got a",
      "hold my beer, im tracking a",
      "look alive team, incoming",
      "eyes up, we've got a",
      "stand by everyone, we've got a",
      "is it a bird? is it a plane? no well kind of, its a"
    ];

    function initKioskAudio() {
      try {
        // Reuse the context if a gesture handler already made one (see unlockAudioFromGesture).
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended') {
          audioCtx.resume();
        }
      } catch (e) {}
    }

    // Audio + speech unlock, for a tap handler that can't call startFeed() straight away.
    function unlockAudioFromGesture() {
      initKioskAudio();
      if ('speechSynthesis' in window) {
        try {
          const warmup = new SpeechSynthesisUtterance('');
          warmup.volume = 0;
          window.speechSynthesis.speak(warmup);
        } catch (e) {}
      }
    }

    // Runs on the first user gesture (tap/click on the start overlay). Browsers require a
    // real user gesture before AudioContext or SpeechSynthesis will produce sound, so nothing
    // in announceMilitaryAircraft() can reliably fire until this has run at least once.
    let startRequested = false;
    async function startFeed() {
      if (feedStarted || startRequested) return;
      startRequested = true;

      // Make sure any postcode-based station override (see resolveStationCoords
      // above) has finished before the map/radar are built around userConfig.
      await stationReadyPromise;

      if (needsPostcodePrompt) {
        // First-ever visit, no URL postcode and no saved cookie - ask before doing anything
        // else. handlePostcodeSubmit() calls startFeed() again once a postcode is saved, and
        // by then needsPostcodePrompt is false so this branch is skipped the second time.
        startRequested = false;
        const overlay = document.getElementById('start-overlay');
        if (overlay) overlay.classList.add('hidden');
        // forcedReconsent (set in resolveStationCoords) prefills the postcode they already had,
        // so re-confirming is one tap, not real re-entry.
        showPostcodeOverlay(forcedReconsent ? getCookie(POSTCODE_COOKIE) : '');
        return;
      }

      feedStarted = true;
      const statusBar = document.getElementById('status-bar');
      if (statusBar) statusBar.textContent = formatStationLabel(userConfig.lat, userConfig.lon);
      pruneOldDailyLogs();

      initKioskAudio();
      if ('speechSynthesis' in window) {
        // Nudge speechSynthesis awake with a silent utterance, inside the gesture handler.
        const warmup = new SpeechSynthesisUtterance('');
        warmup.volume = 0;
        window.speechSynthesis.speak(warmup);

        // Chrome has a known bug where speechSynthesis silently stops firing speak() after
        // sitting idle for a while (no error, no event - it just never says anything). On a
        // kiosk that only speaks occasionally (a military pass every so often, an emergency
        // maybe once a day) that idle gap is exactly when it bites. The standard workaround is
        // a periodic pause/resume "nudge" so the engine never sits idle long enough to trip it.
        setInterval(() => {
          if (!window.speechSynthesis.speaking) {
            window.speechSynthesis.pause();
            window.speechSynthesis.resume();
          }
        }, 10000);
      }

      const overlay = document.getElementById('start-overlay');
      if (overlay) overlay.classList.add('hidden');

      canvas = document.getElementById('radarCanvas');
      ctx = canvas.getContext('2d');

      // Attached before initMap()/resizeCanvas() below, not after, so nothing is missed if the
      // container's real final size only settles a moment after this point - see the follow-up
      // corrections just below too.
      watchScreenSize();
      initMap();
      resizeCanvas();
      buildAltitudeLegend();

      // Kiosk mode (--kiosk) launches already fullscreen - there's no windowed-to-fullscreen
      // transition to fire a corrective resize event the way there is when testing normally in a
      // browser window and toggling fullscreen by hand. If the container's real final size
      // hasn't actually settled yet at the moment initMap()/resizeCanvas() just ran above (a real
      // race on some kiosk setups, where Chromium is still finishing sizing itself to the
      // display right as this script starts), the radar circle gets fitted to the wrong - too
      // small - container size, which makes the circle itself look too big relative to it, and
      // with no resize event ever coming along afterwards on a kiosk to fix it, it stays wrong
      // for the rest of the session. These two follow-up corrections catch that without needing
      // any real resize event at all: one after the next paint (layout is reliably settled by
      // then) and one a bit later as a second safety net for anything slower still.
      requestAnimationFrame(resizeCanvas);
      setTimeout(resizeCanvas, 500);

      applyNightMode();
      setInterval(applyNightMode, 60000);
      setInterval(cycleBurnInShift, BURN_IN_SHIFT_INTERVAL_MS);

      requestAnimationFrame(drawRadarScope);
      fetchLiveFlights();

      // Test-squawk via URL, e.g. radar.html?testsquawk=7700 - handy from mobile where
      // there's no keyboard for the shortcut below.
      const testParam = new URLSearchParams(window.location.search).get('testsquawk');
      if (testParam) triggerTestSquawk(testParam);
      const testRare = new URLSearchParams(window.location.search).get('testrare');
      if (testRare) triggerTestRare(testRare);
    }

    // ---------------------------------------------------------------------
    // Screen-burn mitigation: every 24/7 static-content kiosk display (OLED especially, but
    // plasma/LCD too over long enough time) risks burn-in from the scope rings, sidebar labels
    // and scrollboard text always sitting in the same pixels. Nudging the whole visible UI
    // (everything inside #burn-in-shield - i.e. not the full-screen overlays, which are
    // siblings of it) by a couple of px every so often is the standard mitigation, and at that
    // magnitude it's imperceptible during normal viewing.
    // ---------------------------------------------------------------------
    const BURN_IN_SHIFT_INTERVAL_MS = 90000;
    const BURN_IN_OFFSETS = [[0, 0], [2, 0], [2, 2], [0, 2], [-2, 2], [-2, 0], [-2, -2], [0, -2], [2, -2]];
    let burnInOffsetIdx = 0;

    function cycleBurnInShift() {
      const shieldEl = document.getElementById('burn-in-shield');
      if (!shieldEl) return;
      burnInOffsetIdx = (burnInOffsetIdx + 1) % BURN_IN_OFFSETS.length;
      const [dx, dy] = BURN_IN_OFFSETS[burnInOffsetIdx];
      // left/top (on a position:relative wrapper), not transform - see the #burn-in-shield CSS.
      shieldEl.style.left = `${dx}px`;
      shieldEl.style.top = `${dy}px`;
    }

    // ---------------------------------------------------------------------
    // Night mode: dims the whole page (brightness/saturation, see body.night-mode CSS) during
    // configured local hours, easier on the eyes - and on a kiosk display's longevity - than
    // running full brightness overnight. Purely based on the viewing device's own clock.
    // ---------------------------------------------------------------------
    const NIGHT_MODE_START_HOUR = 21; // 9pm
    const NIGHT_MODE_END_HOUR = 6;    // 6am

    function applyNightMode() {
      const hour = new Date().getHours();
      const isNight = hour >= NIGHT_MODE_START_HOUR || hour < NIGHT_MODE_END_HOUR;
      document.body.classList.toggle('night-mode', isNight);
    }

    // Keyboard shortcut for testing the alert-lock path at a desktop: 5/6/7 -> 7500/7600/7700, 9 -> 7777 (QRA),
// 0 -> injects a fake military contact to test the separate proximity-chirp path (see triggerTestMilitary()).
    // Also tracks the last few letters typed so "ufo" (typed in order, not necessarily fast)
    // triggers the UFO easter egg - see triggerUfoSighting().
    let ufoTypedBuffer = '';
    document.addEventListener('keydown', (e) => {
      // These are debug shortcuts for a desktop keyboard - never fire them while typing into a
      // field, or entering a postcode with a 5, 6, 7, 9 or 0 in it sets off fake alerts.
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (!feedStarted || settingsOpen) return;
      if (e.key === '5') triggerTestSquawk('7500');
      else if (e.key === '6') triggerTestSquawk('7600');
      else if (e.key === '7') triggerTestSquawk('7700');
      else if (e.key === '9') triggerTestSquawk('7777');
      else if (e.key === '0') triggerTestMilitary();
      else if (e.key === '8') triggerTestRare('A388');

      if (/^[a-zA-Z]$/.test(e.key)) {
        ufoTypedBuffer = (ufoTypedBuffer + e.key.toLowerCase()).slice(-3);
        if (ufoTypedBuffer === 'ufo') {
          triggerUfoSighting();
          ufoTypedBuffer = '';
        }
      } else if (e.key.length === 1) {
        ufoTypedBuffer = ''; // any other single-character keystroke breaks the sequence
      }
    });


    const aircraftModelNames = {
      'C17': 'Boeing C-17 Globemaster',
      'C130': 'Lockheed C-130 Hercules',
      'F16': 'Lockheed Martin F-16 Fighting Falcon',
      'F15': 'McDonnell Douglas F-15 Eagle',
      'F18': 'Boeing F/A-18 Hornet',
      'F35': 'Lockheed Martin F-35 Lightning II',
      'EF20': 'Eurofighter Typhoon',
      'EUFI': 'Eurofighter Typhoon',
      'TYPH': 'Eurofighter Typhoon',
      'A400': 'Airbus A400M Atlas',
      'K35R': 'Boeing KC-135 Stratotanker',
      'KC135': 'Boeing KC-135 Stratotanker',
      'P8': 'Boeing P-8 Poseidon',
      'E3TF': 'Boeing E-3 Sentry AWACS',
      'CH47': 'Boeing CH-47 Chinook',
      'AH64': 'Boeing AH-64 Apache',
      'UH60': 'Sikorsky UH-60 Black Hawk',
      'V22': 'Bell Boeing V-22 Osprey',
      'HAWK': 'BAE Systems Hawk',
      'TOR': 'Panavia Tornado',
      'RC135': 'Boeing RC-135 Rivet Joint'
    };

    function playAlertTone() {
      if (!audioAlertsEnabled) return;
      try {
        if (!audioCtx) initKioskAudio();
        if (audioCtx && audioCtx.state === 'suspended') {
          audioCtx.resume();
        }
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        
        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, audioCtx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(440, audioCtx.currentTime + 0.15);
        
        gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.3);
        
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        
        osc.start();
        osc.stop(audioCtx.currentTime + 0.3);
      } catch (e) {}
    }

    // Wailing two-tone siren (European emergency-vehicle style: sweeps between a low and
    // high pitch a few times) - distinct from the short single-beep playAlertTone(), reserved
    // for an actual emergency-squawk lock so it doesn't get confused with a routine proximity
    // ping. Returns its total duration in ms so callers can time a follow-up speech announcement.
    function playEmergencySiren() {
      if (!audioAlertsEnabled) return 0;
      try {
        if (!audioCtx) initKioskAudio();
        if (audioCtx && audioCtx.state === 'suspended') {
          audioCtx.resume();
        }
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.connect(gain);
        gain.connect(audioCtx.destination);

        const now = audioCtx.currentTime;
        const lowFreq = 600;
        const highFreq = 1300;
        const sweepSeconds = 0.4;
        const cycles = 4;
        const totalSeconds = cycles * sweepSeconds * 2;

        gain.gain.setValueAtTime(0.16, now);
        osc.frequency.setValueAtTime(lowFreq, now);
        for (let i = 0; i < cycles; i++) {
          const upEnd = now + (i * 2 + 1) * sweepSeconds;
          const downEnd = now + (i * 2 + 2) * sweepSeconds;
          osc.frequency.linearRampToValueAtTime(highFreq, upEnd);
          osc.frequency.linearRampToValueAtTime(lowFreq, downEnd);
        }
        gain.gain.setValueAtTime(0.16, now + totalSeconds - 0.15);
        gain.gain.linearRampToValueAtTime(0, now + totalSeconds);

        osc.start(now);
        osc.stop(now + totalSeconds + 0.05);
        return totalSeconds * 1000;
      } catch (e) {
        return 0;
      }
    }

    // Spoken emergency callout - separate from announceMilitaryAircraft() (that one is for
    // routine military-proximity pings, not squawk emergencies).
    const DIGIT_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

    // TTS engines read a bare "7700" as "seven thousand seven hundred" - squawks are read
    // digit-by-digit in real life ("seven seven zero zero"), so spell each digit out as a
    // word rather than relying on spacing/punctuation to coax the engine into it.
    function squawkToSpokenDigits(squawk) {
      return String(squawk || '').split('').map(ch => DIGIT_WORDS[ch] !== undefined ? DIGIT_WORDS[ch] : ch).join(' ');
    }

    function announceEmergencySquawk(ac) {
      if (!audioAlertsEnabled) return;
      if (!('speechSynthesis' in window)) return;
      const callsign = ac.flight ? ac.flight.trim() : ac.hex;
      const squawk = ac.squawk || '';
      const spokenSquawk = squawkToSpokenDigits(squawk);
      const meaning = SQUAWK_MEANINGS[squawk] || 'an unrecognized alert code';
      const isQra = squawk === QRA_SQUAWK;
      // 7777 isn't a distress squawk, so it gets its own opener/verb rather than being
      // announced as an "emergency" like the three real ICAO codes.
      const speechText = isQra
        ? `Alert, alert. The callsign ${callsign} is squawking ${spokenSquawk} - that means ${meaning}.`
        : `Emergency, emergency. A plane has squawked ${spokenSquawk} with the callsign ${callsign} - that means ${meaning}.`;
      const utterance = new SpeechSynthesisUtterance(speechText);
      utterance.rate = 1.0;
      utterance.pitch = 1.0;
      // See the keep-alive nudge in startFeed() - this cancel() clears any stuck queue from
      // the same idle bug, so a speak() call right after doesn't join a queue that's silently
      // stopped draining.
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utterance);
    }

    function triggerRedPulse() {
      const overlay = document.getElementById('screen-pulse-overlay');
      if (!overlay) return;
      overlay.classList.remove('screen-pulse-active');
      void overlay.offsetWidth; 
      overlay.classList.add('screen-pulse-active');
    }

    function getCardinalFromDeg(deg) {
      const val = Math.floor((deg + 22.5) / 45);
      const arr = ["North", "Northeast", "East", "Southeast", "South", "Southwest", "West", "Northwest"];
      return arr[(val % 8)];
    }

    // name + coordinates (used for the ETA calc - see getDestinationCoords) for the fixed set
    // of airports the heuristic route guess in resolveFlightRoute() can return, plus a few
    // other common ones seen in hexdb responses.
    const airportDatabase = {
      'EGLL': { name: 'London Heathrow, UK', lat: 51.4700, lon: -0.4543 },
      'EGKK': { name: 'London Gatwick, UK', lat: 51.1481, lon: -0.1903 },
      'EGGW': { name: 'London Luton, UK', lat: 51.8747, lon: -0.3683 },
      'EGSS': { name: 'London Stansted, UK', lat: 51.8860, lon: 0.2389 },
      'EGCC': { name: 'Manchester Airport, UK', lat: 53.3537, lon: -2.2750 },
      'EGBB': { name: 'Birmingham Airport, UK', lat: 52.4539, lon: -1.7480 },
      'EGNX': { name: 'East Midlands Airport, UK', lat: 52.8311, lon: -1.3281 },
      'EGPH': { name: 'Edinburgh Airport, UK', lat: 55.9500, lon: -3.3725 },
      'EGPF': { name: 'Glasgow Airport, UK', lat: 55.8642, lon: -4.4328 },
      'EGNT': { name: 'Newcastle Airport, UK', lat: 55.0375, lon: -1.6917 },
      'EGVN': { name: 'RAF Brize Norton, UK', lat: 51.7500, lon: -1.5836 },
      'EGUN': { name: 'RAF Mildenhall, UK', lat: 52.3617, lon: 0.4864 },
      'EGVA': { name: 'RAF Fairford, UK', lat: 51.6822, lon: -1.7900 },
      'EGXC': { name: 'RAF Coningsby, UK', lat: 53.0929, lon: -0.1650 },
      'EGUL': { name: 'RAF Lakenheath, UK', lat: 52.4093, lon: 0.5610 },
      'ETAR': { name: 'Ramstein Air Base, Germany', lat: 49.4369, lon: 7.6003 },
      'EHAM': { name: 'Amsterdam Schiphol, Netherlands', lat: 52.3086, lon: 4.7639 },
      'LFPG': { name: 'Paris Charles de Gaulle, France', lat: 49.0097, lon: 2.5479 },
      'EDDF': { name: 'Frankfurt Airport, Germany', lat: 50.0379, lon: 8.5622 },
      'EIDW': { name: 'Dublin Airport, Ireland', lat: 53.4213, lon: -6.2701 },
      'LEMD': { name: 'Madrid Barajas, Spain', lat: 40.4983, lon: -3.5676 },
      'LIRF': { name: 'Rome Fiumicino, Italy', lat: 41.8003, lon: 12.2389 },
      'KJFK': { name: 'New York JFK, USA', lat: 40.6413, lon: -73.7781 },
      'KLAX': { name: 'Los Angeles International, USA', lat: 33.9416, lon: -118.4085 },
      'OMDB': { name: 'Dubai International, UAE', lat: 25.2532, lon: 55.3657 }
    };

    function airportName(code) {
      const entry = airportDatabase[(code || '').toUpperCase()];
      return entry ? entry.name : '';
    }

    // Best-effort destination coordinates for the ETA calc: prefer real lat/lon that came back
    // from adsbdb with the route itself (see queryAdsbdb), then fall back to our small local
    // airport table for hexdb/heuristic routes. Returns null if neither has it (ETA is then
    // just hidden rather than showing a wrong number).
    function getDestinationCoords(route) {
      if (route.toLat !== undefined && route.toLon !== undefined) {
        return { lat: route.toLat, lon: route.toLon };
      }
      const entry = airportDatabase[(route.toCode || '').toUpperCase()];
      return entry ? { lat: entry.lat, lon: entry.lon } : null;
    }


    // ---------------------------------------------------------------------
    // Route resolution uses API data only. No callsign/heading heuristics are used because
    // they can turn an unknown route into a convincing but completely false destination.
    // Cache entries are keyed by aircraft hex + callsign and expire so a reused callsign cannot
    // keep an old route forever.
    const ROUTE_CACHE_TTL_MS = 5 * 60 * 1000;
    const ROUTE_MAX_STALE_MS = 15 * 60 * 1000;
    const routeCache = {};
    let adsbdbBackoffUntil = 0;
    let hexdbBackoffUntil = 0;
    let openSkyBackoffUntil = 0;

    function routeCacheKey(ac) {
      const hex = (ac && ac.hex || '').trim().toUpperCase();
      const callsign = (ac && ac.flight || '').trim().toUpperCase();
      return `${hex}|${callsign}`;
    }

    function validAirportCode(code) {
      return typeof code === 'string' && /^[A-Z0-9]{3,4}$/.test(code.trim().toUpperCase());
    }

    function normaliseRoute(route, source) {
      if (!route || !validAirportCode(route.fromCode) || !validAirportCode(route.toCode)) return null;
      const fromCode = route.fromCode.trim().toUpperCase();
      const toCode = route.toCode.trim().toUpperCase();
      if (fromCode === toCode) return null;
      const clean = {
        fromCode, toCode,
        fromName: typeof route.fromName === 'string' ? route.fromName.trim() : '',
        toName: typeof route.toName === 'string' ? route.toName.trim() : '',
        source
      };
      if (Number.isFinite(route.toLat) && Number.isFinite(route.toLon) && route.toLat >= -90 && route.toLat <= 90 && route.toLon >= -180 && route.toLon <= 180) {
        clean.toLat = route.toLat; clean.toLon = route.toLon;
      }
      if (Number.isFinite(route.fromLat) && Number.isFinite(route.fromLon) && route.fromLat >= -90 && route.fromLat <= 90 && route.fromLon >= -180 && route.fromLon <= 180) {
        clean.fromLat = route.fromLat; clean.fromLon = route.fromLon;
      }
      return clean;
    }

    // Conservative sanity check. We reject only strong contradictions because aircraft can turn
    // and ADS-B track can be temporarily stale.
    function routePassesPositionCheck(route, ac) {
      if (!route || !ac || !Number.isFinite(ac.lat) || !Number.isFinite(ac.lon)) return false;
      const hasDestinationCoords = Number.isFinite(route.toLat) && Number.isFinite(route.toLon);
      const hasOriginCoords = Number.isFinite(route.fromLat) && Number.isFinite(route.fromLon);
      if (!hasDestinationCoords && !hasOriginCoords) return true;

      const speed = Number(ac.gs);
      const track = Number(ac.track);
      if (hasDestinationCoords && Number.isFinite(speed) && speed >= 80 && Number.isFinite(track)) {
        const destBearing = calcBearing(ac.lat, ac.lon, route.toLat, route.toLon);
        const diff = Math.abs(((destBearing - track + 540) % 360) - 180);
        const destDistance = calcDistanceNM(ac.lat, ac.lon, route.toLat, route.toLon);
        if (destDistance > 80 && diff > 125) return false;
      }
      if (hasOriginCoords) {
        const originDistance = calcDistanceNM(ac.lat, ac.lon, route.fromLat, route.fromLon);
        if (originDistance > 5000) return false;
      }
      return true;
    }

    // ADSB.lol's routeset endpoint is especially useful for callsigns such as
    // SHT4YL (British Airways Shuttle) and TOM5MH (TUI), where the transponder
    // callsign does not necessarily contain the commercial flight number.
    // It accepts the live aircraft position as well as the callsign and returns
    // a current route candidate when its route database can resolve it.
    async function queryAdsbLolRoute(ac) {
      const callsign = (ac && ac.flight || '').trim().toUpperCase();
      if (!callsign || !Number.isFinite(ac.lat) || !Number.isFinite(ac.lon)) return null;
      const routesetBody = JSON.stringify({ planes: [{ callsign, lat: Number(ac.lat), lng: Number(ac.lon) }] });
      // Primary -> backup -> (no third-party fallback exists for this POST
      // endpoint) order, matching the point-lookup endpoints array below.
      // Only moves on to the next proxy on a network-level failure or 5xx -
      // a 429 or a normal "no route found" response is a real answer from a
      // reachable proxy, not a reason to retry against a different one.
      const proxyBases = [WORKER_URL, WORKER_URL_BACKUP].filter(Boolean);
      let res = null;
      for (let i = 0; i < proxyBases.length; i++) {
        try {
          // api.adsb.lol doesn't send Access-Control-Allow-Origin for browser requests
          // from arbitrary origins either, so this goes through the same Wispbyte proxy
          // as the point lookups above (see server.js) rather than hitting adsb.lol
          // directly. Note: adsb.lol is known to 403 datacenter/cloud IPs, which is what
          // this proxy's own outbound requests look like to it - if that happens here,
          // this call fails gracefully (falls through to queryAdsbdb/queryHexdb below)
          // rather than breaking anything.
          const attempt = await fetchWithTimeout(`${proxyBases[i]}${ROUTESET_PATH}`, {
            method: 'POST',
            headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
            cache: 'no-store',
            body: routesetBody
          });
          if (attempt.status >= 500 && i < proxyBases.length - 1) continue; // try the next proxy
          res = attempt;
          break;
        } catch (fetchErr) {
          if (i === proxyBases.length - 1) {
            // Out of proxies to try - both backup and primary are unreachable
            // right now. Return null (not throw) so the caller's fallback
            // chain (adsbdb -> hexdb) still runs instead of the whole route
            // lookup aborting here.
            console.warn('[ROUTE] Both ADSB.lol proxies unreachable, falling back:', fetchErr);
            return null;
          }
          // otherwise fall through to the next proxyBases entry
        }
      }

      // Defensive - every exit path above either sets res or returns early,
      // but if that ever changes, fail closed (fall through) rather than
      // crash on res.status below.
      if (!res) return null;

      try {
        if (res.status === 429) return undefined;
        if (!res.ok) return null;
        let data;
        try {
          data = await res.json();
        } catch (parseErr) {
          // Belt-and-braces: the proxy already turns an empty/malformed
          // upstream body into a non-ok status, but if that ever slips
          // through, fall back the same way a non-ok response would rather
          // than throwing out of this whole try block.
          console.warn('[ROUTE] ADSB.lol routeset returned unparseable JSON, falling back:', parseErr);
          return null;
        }
        const row = Array.isArray(data) ? data.find(r => String(r && r.callsign || '').toUpperCase() === callsign) || data[0] : null;
        if (!row) return null;

        // A false 'plausible' flag means the route database could not reconcile
        // the route with the supplied live position. Do not display it as verified.
        if (row.plausible === false || row.plausible === 0 || row.plausible === '0') return null;

        const airports = Array.isArray(row._airports) ? row._airports : [];
        const routeIata = String(row._airport_codes_iata || '').toUpperCase().split('-').filter(Boolean);
        const routeIcao = String(row.airport_codes || '').toUpperCase().split('-').filter(Boolean);
        if (routeIata.length < 2 && routeIcao.length < 2) return null;

        // routeset can return a multi-leg chain (e.g. DEN-SAN-SFO). For the
        // current flight, use the first and last airport in that chain.
        const fromCode = routeIata.length >= 2 ? routeIata[0] : routeIcao[0];
        const toCode = routeIata.length >= 2 ? routeIata[routeIata.length - 1] : routeIcao[routeIcao.length - 1];
        if (!validAirportCode(fromCode) || !validAirportCode(toCode) || fromCode === toCode) return null;

        const airportForCode = (code) => {
          const found = airports.find(a => String(a && (a.iata || '')).toUpperCase() === code || String(a && (a.icao || '')).toUpperCase() === code);
          if (found) return found;
          const db = airportDatabase[String(code).toUpperCase()];
          return db ? { name: db.name, lat: db.lat, lon: db.lon, iata: code } : null;
        };
        const from = airportForCode(fromCode);
        const to = airportForCode(toCode);

        return normaliseRoute({
          fromCode,
          toCode,
          fromName: from ? (from.name || from.location || '') : '',
          toName: to ? (to.name || to.location || '') : '',
          fromLat: from && Number(from.lat),
          fromLon: from && Number(from.lon),
          toLat: to && Number(to.lat),
          toLon: to && Number(to.lon)
        }, 'adsb.lol');
      } catch (err) {
        console.warn('[ROUTE] ADSB.lOL routeset lookup failed:', err);
        return null;
      }
    }

    // A regular fetch() never times out on its own - if a server accepts the
    // TCP connection but never responds (as opposed to a fast connection
    // refused / DNS failure, which reject almost immediately), the await
    // just hangs indefinitely. That happened for real: a routeset POST to a
    // downed proxy once sat pending for ~11 minutes, blocking the poll loop
    // that was awaiting it and stalling everything downstream, including the
    // scrollboard lock-on, even though aircraft data itself was already in
    // and rendering fine. Every route-lookup fetch below goes through this
    // wrapper so a hung request is aborted and treated as a normal failure
    // (falls through to the next provider) instead of blocking forever.
    async function fetchWithTimeout(url, options, timeoutMs = 8000) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await fetch(url, { ...options, signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
    }

    async function queryAdsbdb(callsign) {
      if (Date.now() < adsbdbBackoffUntil) return undefined;
      try {
        const res = await fetchWithTimeout(`https://api.adsbdb.com/v0/callsign/${encodeURIComponent(callsign)}`, { headers: { 'Accept': 'application/json' } });
        if (res.status === 429) { adsbdbBackoffUntil = Date.now() + 30000; return undefined; }
        if (!res.ok) return null;
        const data = await res.json();
        const route = data && data.response && data.response.flightroute;
        if (!route || !route.origin || !route.destination) return null;
        return normaliseRoute({
          fromCode: route.origin.iata_code || route.origin.icao_code,
          toCode: route.destination.iata_code || route.destination.icao_code,
          fromName: route.origin.name ? `${route.origin.name}${route.origin.municipality ? `, ${route.origin.municipality}` : ''}` : '',
          toName: route.destination.name ? `${route.destination.name}${route.destination.municipality ? `, ${route.destination.municipality}` : ''}` : '',
          fromLat: Number(route.origin.latitude), fromLon: Number(route.origin.longitude),
          toLat: Number(route.destination.latitude), toLon: Number(route.destination.longitude)
        }, 'adsbdb');
      } catch (err) { console.warn('[ROUTE] ADSBDB lookup failed:', err); return null; }
    }

    async function queryHexdb(callsign) {
      if (Date.now() < hexdbBackoffUntil) return undefined;
      try {
        const res = await fetchWithTimeout(`https://hexdb.io/api/v1/route/icao/${encodeURIComponent(callsign)}`, { headers: { 'Accept': 'application/json' } });
        if (res.status === 429) { hexdbBackoffUntil = Date.now() + 30000; return undefined; }
        if (!res.ok) return null;
        const data = await res.json();
        if (!data || !(data.orig_iata || data.orig_icao) || !(data.dest_iata || data.dest_icao)) return null;
        const fromIcao = validAirportCode(data.orig_icao) ? data.orig_icao.toUpperCase() : null;
        const toIcao = validAirportCode(data.dest_icao) ? data.dest_icao.toUpperCase() : null;
        const from = fromIcao && airportDatabase[fromIcao];
        const to = toIcao && airportDatabase[toIcao];
        return normaliseRoute({
          fromCode: data.orig_iata || data.orig_icao, toCode: data.dest_iata || data.dest_icao,
          fromName: from ? from.name : '', toName: to ? to.name : '',
          fromLat: from ? from.lat : undefined, fromLon: from ? from.lon : undefined,
          toLat: to ? to.lat : undefined, toLon: to ? to.lon : undefined
        }, 'hexdb');
      } catch (err) { console.warn('[ROUTE] HexDB lookup failed:', err); return null; }
    }

    // ADSBDB/adsb.lol/HexDB are all callsign -> scheduled-route lookup tables built for airline
    // flight numbers. GA aircraft (Cessnas, Pipers, etc.) broadcast their registration as the
    // callsign and don't have a "scheduled route" for any of those tables to find, so all three
    // legitimately come back empty. OpenSky's flight-track API sidesteps that: it looks up the
    // aircraft by ICAO24 hex and returns the nearest airport to where its actual track began/
    // ended, so it works for any aircraft with recent ADS-B history, GA or airline. It's an
    // estimate rather than a verified schedule, so it's tagged and coloured differently below.
    // It only sees flights OpenSky's own network already tracked, so very fresh departures (or
    // aircraft only ever seen by this radar's own receiver) can still come back empty.
    async function queryOpenSky(ac) {
      const hex = (ac && ac.hex || '').trim().toLowerCase();
      if (!/^[0-9a-f]{6}$/.test(hex)) return null;
      if (Date.now() < openSkyBackoffUntil) return undefined;
      try {
        const end = Math.floor(Date.now() / 1000);
        const begin = end - 48 * 60 * 60; // last 48h; OpenSky caps a single query span at 30 days
        const res = await fetchWithTimeout(
          `https://opensky-network.org/api/flights/aircraft?icao24=${encodeURIComponent(hex)}&begin=${begin}&end=${end}`,
          { headers: { 'Accept': 'application/json' } }
        );
        if (res.status === 429) { openSkyBackoffUntil = Date.now() + 60000; return undefined; }
        if (!res.ok) return null;
        const flights = await res.json();
        if (!Array.isArray(flights) || !flights.length) return null;
        // Flights come back oldest-first; take the most recent one that has at least a
        // departure airport (the arrival airport can legitimately be missing mid-flight).
        const flight = [...flights].reverse().find(f => f && f.estDepartureAirport);
        if (!flight) return null;
        const fromIcao = validAirportCode(flight.estDepartureAirport) ? flight.estDepartureAirport.toUpperCase() : null;
        const toIcao = validAirportCode(flight.estArrivalAirport) ? flight.estArrivalAirport.toUpperCase() : null;
        if (!fromIcao || !toIcao) return null; // normaliseRoute needs both ends; still airborne with no arrival yet just means "try again later"
        const from = airportDatabase[fromIcao];
        const to = airportDatabase[toIcao];
        return normaliseRoute({
          fromCode: fromIcao, toCode: toIcao,
          fromName: from ? from.name : '', toName: to ? to.name : '',
          fromLat: from ? from.lat : undefined, fromLon: from ? from.lon : undefined,
          toLat: to ? to.lat : undefined, toLon: to ? to.lon : undefined
        }, 'opensky');
      } catch (err) { console.warn('[ROUTE] OpenSky lookup failed:', err); return null; }
    }

    async function fetchRoutesForAircraft(acList) {
      const ac = acList && acList[0];
      if (!ac) return;
      const callsign = (ac.flight || '').trim().toUpperCase();
      if (!callsign || !/^[A-Z0-9]{3,8}$/.test(callsign)) return;

      const key = routeCacheKey(ac);
      const now = Date.now();
      const cached = routeCache[key];
      if (cached && now - cached.checkedAt < ROUTE_CACHE_TTL_MS) return;

      // Try ADSBDB first. It's the most reliable general-purpose route DB and
      // doesn't have adsb.lol's datacenter-IP 403 problem. The live
      // position-aware routeset (adsb.lol) runs next since it's the fix for
      // non-standard airline callsigns such as SHT4YL and TOM5MH that ADSBDB
      // can't resolve, then HexDB as the last resort.
      let result = await queryAdsbdb(callsign);
      if (result === undefined) {
        // Keep going to the other providers if adsbdb is temporarily rate-limited.
        result = null;
      }
      if (result && !routePassesPositionCheck(result, ac)) {
        console.warn('[ROUTE] rejected ADSBDB route after validation', callsign, result);
        result = null;
      }

      if (!result) {
        result = await queryAdsbLolRoute(ac);
        if (result === undefined) result = null;
        if (result && !routePassesPositionCheck(result, ac)) {
          console.warn('[ROUTE] rejected ADSB.lol route after validation', callsign, result);
          result = null;
        }
      }
      if (!result) {
        result = await queryHexdb(callsign);
        if (result === undefined) result = null;
        if (result && !routePassesPositionCheck(result, ac)) {
          console.warn('[ROUTE] rejected HexDB route after validation', callsign, result);
          result = null;
        }
      }

      // Last resort: none of the callsign->schedule lookups had anything, most often because
      // this is a GA aircraft flying under its registration rather than an airline flight
      // number. Fall back to OpenSky's track-derived estimate.
      if (!result) {
        result = await queryOpenSky(ac);
        if (result === undefined) result = null;
        if (result && !routePassesPositionCheck(result, ac)) {
          console.warn('[ROUTE] rejected OpenSky route after validation', callsign, result);
          result = null;
        }
      }

      if (result) {
        routeCache[key] = { route: result, checkedAt: now };
        console.log('[ROUTE] refreshed', key, result);
      } else if (cached && now - cached.checkedAt < ROUTE_MAX_STALE_MS) {
        cached.checkedAt = now;
        cached.refreshFailed = true;
      } else {
        routeCache[key] = { route: null, checkedAt: now };
      }
    }

    function resolveFlightRoute(flightStr, ac) {
      const entry = routeCache[routeCacheKey(ac || { flight: flightStr })];
      return entry && entry.route ? entry.route : null;
    }

    // Local house-lights hook (lights/hue-bridge.js). Only active when this page is being viewed
    // on the Pi itself (kiosk at localhost) - people on the public site never call it, and the
    // bridge only listens on 127.0.0.1 so nothing here can reach it from the internet. A no-cors
    // POST needs no CORS setup; we don't read the reply, and a missing bridge is silently ignored.
    const LIGHT_BRIDGE_URL = ['localhost', '127.0.0.1'].includes(location.hostname)
      ? 'http://127.0.0.1:10005/flash' : null;
    function pingLightBridge(distNM) {
      if (!LIGHT_BRIDGE_URL) return;
      fetch(`${LIGHT_BRIDGE_URL}?dist=${distNM.toFixed(1)}`, { method: 'POST', mode: 'no-cors', keepalive: true })
        .catch(() => {});
    }

    function announceMilitaryAircraft(ac) {
      if (!audioAlertsEnabled) return;

      const dist = calcDistanceNM(userConfig.lat, userConfig.lon, ac.lat, ac.lon);
      let triggeredPulse = false;

      if (dist <= 5.0 && !hexIsCoolingDown(pulsed5Hexes, ac.hex)) {
        pulsed5Hexes.set(ac.hex, Date.now());
        pulsed35Hexes.set(ac.hex, Date.now());
        triggeredPulse = true;
        playAlertTone();
        triggerRedPulse();
        pingLightBridge(dist);

        setTimeout(() => {
          if (!audioAlertsEnabled) return;
          const callsign = ac.flight ? ac.flight.trim() : 'Unknown callsign';
          const bearing = calcBearing(userConfig.lat, userConfig.lon, ac.lat, ac.lon);
          const posCardinal = getCardinalFromDeg(bearing);
          const trackCardinal = getCardinalFromDeg(ac.track !== undefined ? ac.track : 0);
          const altText = spokenAlt(ac.alt_baro);
          
          const speedKts = ac.gs !== undefined ? Math.round(ac.gs) : 0;
          const speedMph = Math.round(speedKts * 1.15078);
          
          // Randomly select one of the phrases from the array to add on top
          const randomPhrase = randomAddonPhrases[Math.floor(Math.random() * randomAddonPhrases.length)];

          const speechText = `${randomPhrase} Proximity alert. Military aircraft callsign ${callsign} is heading in from the ${posCardinal} and moving ${trackCardinal} at ${altText} altitude, travelling at ${spokenSpeed(speedKts)}, ${spokenDist(dist)} away.`;
          
          if ('speechSynthesis' in window) {
            const utterance = new SpeechSynthesisUtterance(speechText);
            utterance.rate = 1.0;
            utterance.pitch = 1.0;
            window.speechSynthesis.cancel(); // clear any stuck queue - see startFeed() keep-alive nudge
            window.speechSynthesis.speak(utterance);
          }
        }, 350);
      }

      if (!triggeredPulse && dist <= 35.0 && !hexIsCoolingDown(pulsed35Hexes, ac.hex)) {
        pulsed35Hexes.set(ac.hex, Date.now());
        playAlertTone();
        triggerRedPulse();
        pingLightBridge(dist);
      }
    }

    function calcDistanceNM(lat1, lon1, lat2, lon2) {
      const R = 3440.065;
      const dLat = (lat2 - lat1) * Math.PI / 180;
      const dLon = (lon2 - lon1) * Math.PI / 180;
      const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                Math.sin(dLon / 2) * Math.sin(dLon / 2);
      return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    function calcBearing(lat1, lon1, lat2, lon2) {
      const dLon = (lon2 - lon1) * Math.PI / 180;
      const y = Math.sin(dLon) * Math.cos(lat2 * Math.PI / 180);
      const x = Math.cos(lat1 * Math.PI / 180) * Math.sin(lat2 * Math.PI / 180) -
                Math.sin(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.cos(dLon);
      let brng = Math.atan2(y, x) * 180 / Math.PI;
      return Math.round((brng + 360) % 360);
    }

    // Altitude-banded colour for the scope silhouette/label of routine traffic (military,
    // QRA, and emergency squawks still win out over this - see silColor in drawRadarScope).
    // Bands roughly follow common ATC/flight-level intuition: ground/low circuit traffic,
    // low-level GA, mid-level regional/climb-descent, upper airways, and cruise-altitude
    // long-haul. Order matters - checked low to high. Kept in sync with the on-screen legend
    // built in buildAltitudeLegend().
    const ALTITUDE_BANDS = [
      { maxFt: 3000, color: '#ff4d94', label: '< 3,000 ft' },
      { maxFt: 10000, color: '#ff9900', label: '3,000–10,000 ft' },
      { maxFt: 24000, color: '#ffe600', label: '10,000–24,000 ft' },
      { maxFt: 34000, color: '#00ff66', label: '24,000–34,000 ft' },
      { maxFt: Infinity, color: '#00bfff', label: '34,000+ ft' }
    ];

    function altitudeColor(altBaro) {
      if (altBaro === undefined || altBaro === null || altBaro === 'ground') return '#7a8a94'; // unknown/on-ground - neutral grey
      const alt = Number(altBaro);
      if (Number.isNaN(alt)) return '#7a8a94';
      for (const band of ALTITUDE_BANDS) {
        if (alt < band.maxFt) return band.color;
      }
      return ALTITUDE_BANDS[ALTITUDE_BANDS.length - 1].color;
    }

    // One-time legend build for the altitude colour key (see #altitude-legend in the HTML).
    function buildAltitudeLegend() {
      const el = document.getElementById('altitude-legend');
      if (!el) return;
      el.innerHTML = ALTITUDE_BANDS.map((b, i) =>
        `<div class="legend-row"><span class="legend-dot" style="background:${b.color};"></span>${altitudeBandLabel(i)}</div>`
      ).join('');
    }

    const EMERGENCY_SQUAWKS = ['7500', '7600', '7700'];
    const QRA_SQUAWK = '7777';
    const ALERT_SQUAWKS = [...EMERGENCY_SQUAWKS, QRA_SQUAWK];
    const EMERGENCY_LOCK_RADIUS_NM = 250;

    // What each code actually means, used in both the scrollboard label and the spoken
    // callout. 7500/7600/7700 are the standard ICAO distress codes; 7777 isn't a distress
    // squawk - it's the UK/NATO convention for a Quick Reaction Alert fighter intercept -
    // so it gets its own wording rather than being lumped in as an "emergency".
    const SQUAWK_MEANINGS = {
      '7500': 'a hijacking or unlawful interference',
      '7600': 'a radio failure',
      '7700': 'a general emergency',
      '7777': 'a Quick Reaction Alert fighter intercept'
    };

    function isEmergencySquawk(ac) {
      return EMERGENCY_SQUAWKS.includes(ac.squawk);
    }

    // True distress codes OR a QRA intercept - both take scrollboard/canvas priority over
    // routine traffic, just with different wording once locked (see updateNearestScrollboard).
    function isAlertSquawk(ac) {
      return ALERT_SQUAWKS.includes(ac.squawk);
    }

    // ---------------------------------------------------------------------
    // Test-squawk injector: for exercising the emergency-lock path (scrollboard override,
    // red pulse, tone, speech) without waiting for a real 7500/7600/7700/7777. Trigger via:
    //   - browser console: triggerTestSquawk('7700')
    //   - URL param on load: radar.html?testsquawk=7700
    //   - keyboard: press 5 / 6 / 7 / 9 once the feed has started (9 = 7777 QRA)
    // The fake aircraft is merged into liveAircraft on every poll for TEST_AIRCRAFT_TTL_MS,
    // then expires on its own - no cleanup step needed.
    // ---------------------------------------------------------------------
    const TEST_AIRCRAFT_TTL_MS = 90000;

    function buildTestAircraft(squawk) {
      const bearingRad = Math.random() * 2 * Math.PI;
      const distNM = 3 + Math.random() * 8; // a few NM out, well inside the 35 NM scope
      const dLat = (distNM / 60) * Math.cos(bearingRad);
      const dLon = (distNM / 60) * Math.sin(bearingRad) / Math.cos(userConfig.lat * Math.PI / 180);
      return {
        // Random suffix so announcedEmergencyHexes/pulsed sets don't swallow repeat tests.
        hex: 'TEST' + Math.floor(Math.random() * 9000 + 1000),
        flight: 'TESTSQK ',
        lat: userConfig.lat + dLat,
        lon: userConfig.lon + dLon,
        alt_baro: 12000,
        gs: 280,
        track: Math.floor(Math.random() * 360),
        squawk: squawk,
        t: 'B738',
        category: 'A3'
      };
    }

    // Same TTL/merge pattern as buildTestAircraft() above, but exercises the military
    // proximity-chirp path (announceMilitaryAircraft -> playAlertTone + triggerRedPulse)
    // specifically, since that path previously had no manual trigger at all - unlike the
    // squawk-emergency siren path, there was no way to confirm the chirp/flash actually fires
    // without waiting for real qualifying traffic to pass within 35 NM.
    function buildTestMilitaryAircraft() {
      const bearingRad = Math.random() * 2 * Math.PI;
      const distNM = 3 + Math.random() * 8;
      const dLat = (distNM / 60) * Math.cos(bearingRad);
      const dLon = (distNM / 60) * Math.sin(bearingRad) / Math.cos(userConfig.lat * Math.PI / 180);
      return {
        hex: 'TESTMIL' + Math.floor(Math.random() * 900 + 100),
        flight: 'TESTMIL ',
        lat: userConfig.lat + dLat,
        lon: userConfig.lon + dLon,
        alt_baro: 8000,
        gs: 350,
        track: Math.floor(Math.random() * 360),
        squawk: '1200',
        t: 'F35',
        category: 'A5'
      };
    }

    function triggerTestMilitary() {
      testAircraft = buildTestMilitaryAircraft();
      testAircraftExpiryAt = Date.now() + TEST_AIRCRAFT_TTL_MS;
      console.log(`[TEST] Injecting fake military aircraft (${testAircraft.hex}) for ${TEST_AIRCRAFT_TTL_MS / 1000}s`);
      liveAircraft = liveAircraft.filter(a => !a.hex || !a.hex.startsWith('TEST')).concat([testAircraft]);
      recomputeAircraftPixelCache();
      updateUIState(true);
    }
    window.triggerTestMilitary = triggerTestMilitary;

    function triggerTestSquawk(squawk) {
      squawk = String(squawk || '7700');
      if (!ALERT_SQUAWKS.includes(squawk)) {
        console.warn(`[TEST] "${squawk}" isn't 7500/7600/7700/7777 - defaulting to 7700`);
        squawk = '7700';
      }
      testAircraft = buildTestAircraft(squawk);
      testAircraftExpiryAt = Date.now() + TEST_AIRCRAFT_TTL_MS;
      console.log(`[TEST] Injecting fake squawk ${squawk} aircraft (${testAircraft.hex}) for ${TEST_AIRCRAFT_TTL_MS / 1000}s`);

      // Apply immediately rather than waiting for the next 12s poll.
      liveAircraft = liveAircraft.filter(a => !a.hex || !a.hex.startsWith('TEST')).concat([testAircraft]);
      recomputeAircraftPixelCache(); // liveAircraft changed outside the normal poll cycle
      updateUIState(true);
    }
    window.triggerTestSquawk = triggerTestSquawk;

    // ---------------------------------------------------------------------
    // UFO easter egg: typing "ufo" on the keyboard (once the feed has started) spawns a fake
    // unidentified contact a few NM out, same TTL/merge pattern as the test-squawk injector
    // above. Type "UFO" (ac.t) runs through the exact same drawPwSilhouette() lookup as any
    // real aircraft - pw-silhouettes has no "UFO" artwork and category "A0" (no info) has no
    // generic either, so nothing is drawn but the label, same as any other uncovered type.
    // The rest is deliberately unremarkable: placeholder altitude/speed, and the
    // REGISTRATION_OVERRIDES 'UFO1' badge (see fetchAircraftPhoto) instead of a real airline
    // logo. Most sightings squawk a normal 1200; some fraction squawk 7700 instead so it
    // occasionally takes over the scrollboard/siren like a real emergency.
    // ---------------------------------------------------------------------
    const UFO_AIRCRAFT_TTL_MS = 90000;
    const UFO_SQUAWK_7700_CHANCE = 0.3;
    let ufoAircraft = null;
    let ufoAircraftExpiryAt = 0;

    function buildUfoAircraft() {
      const bearingRad = Math.random() * 2 * Math.PI;
      const distNM = 3 + Math.random() * 8;
      const dLat = (distNM / 60) * Math.cos(bearingRad);
      const dLon = (distNM / 60) * Math.sin(bearingRad) / Math.cos(userConfig.lat * Math.PI / 180);
      return {
        hex: 'UFO' + Math.floor(Math.random() * 9000 + 1000),
        flight: 'UFO154 ',
        r: 'UFO1', // drives the REGISTRATION_OVERRIDES logo/route badge
        lat: userConfig.lat + dLat,
        lon: userConfig.lon + dLon,
        alt_baro: 55000 + Math.floor(Math.random() * 15000), // placeholder: implausibly high
        gs: 900 + Math.floor(Math.random() * 500), // placeholder: implausibly fast
        track: Math.floor(Math.random() * 360),
        squawk: Math.random() < UFO_SQUAWK_7700_CHANCE ? '7700' : '1200',
        t: 'UFO',
        category: 'A0'
      };
    }

    function triggerUfoSighting() {
      ufoAircraft = buildUfoAircraft();
      ufoAircraftExpiryAt = Date.now() + UFO_AIRCRAFT_TTL_MS;
      console.log(`[UFO] Unidentified contact ${ufoAircraft.hex} inbound${ufoAircraft.squawk === '7700' ? ' - squawking 7700' : ''}, for ${UFO_AIRCRAFT_TTL_MS / 1000}s`);

      liveAircraft = liveAircraft.filter(a => !a.hex || !a.hex.startsWith('UFO')).concat([ufoAircraft]);
      recomputeAircraftPixelCache(); // liveAircraft changed outside the normal poll cycle
      updateUIState(true);
    }
    window.triggerUfoSighting = triggerUfoSighting;

    // The only place a route (From/To) is ever displayed is the scrollboard, locked onto
    // whichever aircraft is selected below. Route lookups should only ever target that one
    // aircraft - never the whole liveAircraft list, or we flood adsbdb/hexdb with lookups
    // nobody sees.
    function findNearestAircraft(acList) {
      const validAc = (acList || []).filter(a => a.lat && a.lon);
      if (validAc.length === 0) return null;
      return [...validAc].sort((a, b) =>
        calcDistanceNM(userConfig.lat, userConfig.lon, a.lat, a.lon) -
        calcDistanceNM(userConfig.lat, userConfig.lon, b.lat, b.lon)
      )[0];
    }

    // Squawking 7500 (hijack), 7600 (radio failure), 7700 (general emergency), or 7777 (QRA
    // intercept) takes priority for the scrollboard lock over plain proximity: if any such
    // aircraft is within EMERGENCY_LOCK_RADIUS_NM, it's shown instead of whichever aircraft
    // is nearest. With multiple simultaneous alerts, the closest one wins. Falls back to
    // nearest-aircraft when there's no alert in range.
    function findScrollboardTarget(acList) {
      const validAc = (acList || []).filter(a => a.lat && a.lon);
      if (validAc.length === 0) return null;

      const emergencyAc = validAc.filter(a =>
        isAlertSquawk(a) &&
        calcDistanceNM(userConfig.lat, userConfig.lon, a.lat, a.lon) <= EMERGENCY_LOCK_RADIUS_NM
      );

      if (emergencyAc.length > 0) {
        return [...emergencyAc].sort((a, b) =>
          calcDistanceNM(userConfig.lat, userConfig.lon, a.lat, a.lon) -
          calcDistanceNM(userConfig.lat, userConfig.lon, b.lat, b.lon)
        )[0];
      }

      return findNearestAircraft(validAc);
    }

    // Shared photo lookup with a simple cache, used by both the scrollboard and the
    // sidebar cards so a photo already fetched this session isn't re-requested every poll.
    async function resolveAircraftPhoto(ac) {
      const cacheKey = (ac.r && ac.r.trim()) || (ac.t && ac.t.trim()) || ac.hex;
      if (cacheKey && photoCache[cacheKey] !== undefined) {
        return photoCache[cacheKey];
      }

      let photoUrl = null;

      if (ac.r && ac.r.trim() !== '') {
        try {
          const res = await fetch(`https://api.planespotters.net/pub/photos/reg/${encodeURIComponent(ac.r.trim())}`);
          if (res.ok) {
            const data = await res.json();
            if (data.photos && data.photos.length > 0) {
              photoUrl = data.photos[0].thumbnail_large.src;
            }
          }
        } catch (err) {}
      }

      if (!photoUrl && ac.t && ac.t.trim() !== '') {
        try {
          const res = await fetch(`https://api.planespotters.net/pub/photos/icaotype/${encodeURIComponent(ac.t.trim())}`);
          if (res.ok) {
            const data = await res.json();
            if (data.photos && data.photos.length > 0) {
              photoUrl = data.photos[0].thumbnail_large.src;
            }
          }
        } catch (err) {}
      }

      if (cacheKey) photoCache[cacheKey] = photoUrl;
      return photoUrl;
    }

    // ---------------------------------------------------------------------
    // Airline logo lookup: derived from the callsign's 3-letter ICAO airline prefix
    // (e.g. "RYR123" -> "RYR" -> Ryanair). Logos are pulled from the Jxck-S/airline-logos
    // GitHub repo (raw file hosting - each source folder keys its images by ICAO code,
    // e.g. custom_logos/RYR.png). The repo doesn't publish a single pre-merged folder -
    // that only exists as the local output of its combine.sh script - so this mirrors that
    // script's own precedence order (custom_logos, then flightaware_logos, then
    // radarbox_logos) by trying each source in turn and keeping the first that loads.
    // Falls back to airhex's free small-logo endpoint for anything none of the three have.
    // Cached per ICAO code so a repeat lock on the same airline doesn't re-probe every poll.
    // ---------------------------------------------------------------------
    const airlineLogoCache = {}; // icaoCode -> url string, or null for known-empty (no source has it)

    function extractAirlineIcaoCode(flightStr) {
      if (!flightStr) return null;
      const cs = flightStr.trim().toUpperCase();
      // Standard ICAO callsigns are a 3-letter airline code followed by a flight number,
      // e.g. RYR123, BAW45A. Bare registrations (G-VBZZ) and tactical callsigns
      // ("LEADER 4") won't match this and correctly resolve to null.
      const match = cs.match(/^([A-Z]{3})\d/);
      return match ? match[1] : null;
    }

    const AIRLINE_LOGOS_REPO_BASE = 'https://raw.githubusercontent.com/Jxck-S/airline-logos/main';
    const airlineLogoRepoFolders = ['custom_logos', 'flightaware_logos', 'radarbox_logos'];

    function airhexLogoUrl(icaoCode) {
      return `https://content.airhex.com/content/logos/airlines_${icaoCode}_50_50_s.png?proportions=keep`;
    }

    // Resolves via <img> load/error rather than fetch(), since raw.githubusercontent.com
    // doesn't need to be readable by JS - just displayable - and this sidesteps any CORS
    // fuss entirely.
    function probeImageUrl(url) {
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(url);
        img.onerror = () => resolve(null);
        img.src = url;
      });
    }

    async function resolveAirlineLogoUrl(icaoCode) {
      for (const folder of airlineLogoRepoFolders) {
        const url = `${AIRLINE_LOGOS_REPO_BASE}/${folder}/${icaoCode}.png`;
        const ok = await probeImageUrl(url);
        if (ok) return ok;
      }
      // None of the three repo sources have this ICAO code - fall back to airhex.
      const airhexUrl = airhexLogoUrl(icaoCode);
      const ok = await probeImageUrl(airhexUrl);
      return ok || null;
    }

    function initMap() {
      map = L.map('map', {
        zoomControl: true,
        attributionControl: false,
        dragging: true,
        scrollWheelZoom: true,
        doubleClickZoom: true,
        boxZoom: true,
        keyboard: true,
        touchZoom: true,
        tap: true
      }).setView([userConfig.lat, userConfig.lon], 10);

      // The scope overlay (rings/crosshair/aircraft blips) is drawn from cached pixel
      // points that are normally only refreshed on poll/resize (see
      // recomputeMapProjectionCache below) - now that the map can be panned/zoomed by the
      // user, those caches also need refreshing as the map moves, or the canvas overlay
      // would drift away from / desync with the underlying map tiles.
      map.on('move zoom', () => {
        recomputeMapProjectionCache();
        recomputeAircraftPixelCache();
      });

      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors'
      }).addTo(map);

      const radiusMeters = userConfig.radiusNM * 1852;
      radarCircle = L.circle([userConfig.lat, userConfig.lon], {
        color: currentTheme().accent,
        weight: 2,
        opacity: 0.8,
        fillColor: currentTheme().accent,
        fillOpacity: 0.05,
        radius: radiusMeters
      }).addTo(map);

      map.fitBounds(radarCircle.getBounds(), { padding: [0, 0] });
      recomputeMapProjectionCache();

      refreshWeatherOverlay();
      setInterval(refreshWeatherOverlay, WEATHER_REFRESH_MS);
    }

    // ---------------------------------------------------------------------
    // Weather systems overlay: RainViewer's free public Weather Maps API (no key required -
    // https://www.rainviewer.com/api.html). Fetches the latest available radar frame (data
    // refreshes there every ~10 minutes) and lays it into the Leaflet map as a translucent
    // tile layer, underneath the canvas scope so blips/labels/sweep always stay legible on
    // top of it. The map div itself already renders at opacity 0.7 (see #map CSS), so this
    // layer's own low opacity keeps precipitation as a soft backdrop rather than a solid overlay.
    // ---------------------------------------------------------------------
    const WEATHER_REFRESH_MS = 10 * 60 * 1000;
    let weatherLayer = null;

    async function refreshWeatherOverlay() {
      if (!map) return;
      try {
        const res = await fetch('https://api.rainviewer.com/public/weather-maps.json');
        if (!res.ok) return;
        const data = await res.json();
        const frames = data && data.radar && data.radar.past;
        if (!frames || !frames.length) return;
        const latest = frames[frames.length - 1];
        const tileUrl = `${data.host}${latest.path}/256/{z}/{x}/{y}/2/1_1.png`;

        const newLayer = L.tileLayer(tileUrl, {
          opacity: 0.35,
          // RainViewer has progressively cut back the max zoom its free public radar tiles
          // support (down to zoom 7 as of Jan 2026) - anything requested above that returns
          // a "Zoom Level Not Supported" placeholder instead of real data. Capping
          // maxNativeZoom at their limit tells Leaflet to fetch the zoom-7 tile and upscale
          // ("overzoom") it to cover our actual (higher) map zoom, rather than requesting a
          // zoom level that no longer exists - blockier, but it actually shows precipitation.
          maxNativeZoom: 7,
          zIndex: 5,
          pane: 'tilePane'
        });
        newLayer.addTo(map);
        const oldLayer = weatherLayer;
        weatherLayer = newLayer;
        // Swap after the new tiles are in so there's no flash of no-weather between frames.
        // 'load' only fires if Leaflet actually had to fetch tiles for the current view - if
        // everything's already cached (the common case on a dashboard that rarely pans/zooms),
        // it never fires and oldLayer would leak forever, stacking translucent radar frames on
        // top of each other into visible banding over time. A fallback timer guarantees cleanup
        // either way; a flag stops the timer removing oldLayer twice if 'load' also fires.
        let swapped = false;
        const doSwap = () => {
          if (swapped) return;
          swapped = true;
          if (oldLayer) map.removeLayer(oldLayer);
        };
        newLayer.once('load', doSwap);
        setTimeout(doSwap, 3000);
      } catch (err) {
        console.debug('[weather] failed to refresh radar overlay -', err);
      }
    }

    // ---------------------------------------------------------------------
    // Screen profile: the scope is drawn in CSS-pixel coordinates (the same units Leaflet
    // reports), but the canvas backing store is sized to real device pixels so it stays sharp
    // on high-density screens (an iPhone is 3x - previously everything was drawn at 1x and
    // upscaled by the browser, i.e. soft). Two guard-rails keep that from costing too much on
    // weak hardware like a Pi driving a big display:
    //   - density is capped at MAX_CANVAS_DPR, and
    //   - it is also lowered (never below 1x) if the backing store would exceed
    //     MAX_BACKING_PIXELS, since the whole canvas is repainted 30x a second.
    // uiScale grows the drawn glyphs (aircraft icons, callsign labels, ring labels) on large
    // scopes, where they'd otherwise look tiny; it stays at 1 for anything <= 800px so phone
    // and small-window rendering is unchanged.
    const MAX_CANVAS_DPR = 2;
    const MAX_BACKING_PIXELS = 6e6;
    const UI_SCALE_REFERENCE_PX = 800;
    const MAX_UI_SCALE = 2;
    let viewW = 0;      // scope size in CSS px
    let viewH = 0;
    let canvasDpr = 1;  // backing-store pixels per CSS px
    let uiScale = 1;    // multiplier for drawn glyph sizes

    function computeScreenProfile(cssW, cssH) {
      const budgetDpr = Math.sqrt(MAX_BACKING_PIXELS / Math.max(1, cssW * cssH));
      const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, MAX_CANVAS_DPR, budgetDpr));
      const scale = Math.max(1, Math.min(MAX_UI_SCALE, Math.min(cssW, cssH) / UI_SCALE_REFERENCE_PX));
      return { dpr, scale };
    }

    function resizeCanvas() {
      if (!canvas) return;
      const container = document.getElementById('radarContainer');
      const rect = container.getBoundingClientRect();
      const cssW = Math.round(rect.width);
      const cssH = Math.round(rect.height);
      if (cssW === 0 || cssH === 0) return; // hidden / mid-layout - the observer will fire again

      const profile = computeScreenProfile(cssW, cssH);
      // Resize events (and the ResizeObserver) can fire without anything that matters having
      // changed - skip the canvas reset + map re-fit + full cache rebuild in that case.
      if (cssW === viewW && cssH === viewH && profile.dpr === canvasDpr) return;

      viewW = cssW;
      viewH = cssH;
      canvasDpr = profile.dpr;
      uiScale = profile.scale;

      canvas.width = Math.round(cssW * canvasDpr);
      canvas.height = Math.round(cssH * canvasDpr);
      // Setting canvas.width above reset the context, so the density transform has to be
      // re-applied every time. After this, all drawing code keeps using CSS-pixel coordinates.
      ctx.setTransform(canvasDpr, 0, 0, canvasDpr, 0, 0);

      if (map && radarCircle) {
        map.invalidateSize();
        map.fitBounds(radarCircle.getBounds(), { padding: [0, 0] });
      }

      // The map's pixel<->latlng projection just changed (container size and/or the fitBounds
      // above may shift it) - every cached screen point (scope centre/radius, each aircraft,
      // each trail) is now stale and must be recomputed, or blips will drift from where the
      // map itself is drawn until the next 12s poll happens to refresh them.
      recomputeMapProjectionCache();
      recomputeAircraftPixelCache();
    }

    // Re-fit whenever the scope's container changes size for ANY reason - window resize,
    // phone/tablet rotation, iPad split-view, the mobile browser toolbar collapsing, or a CSS
    // media query swapping layouts. window 'resize' alone misses several of those (notably
    // some iOS rotation and toolbar cases), so the ResizeObserver is the primary trigger and
    // 'resize'/'orientationchange' are belt-and-braces. Callbacks are coalesced to one per
    // animation frame, and resizeCanvas() itself no-ops if nothing meaningful changed.
    function watchScreenSize() {
      let pending = false;
      const schedule = () => {
        if (pending) return;
        pending = true;
        requestAnimationFrame(() => {
          pending = false;
          resizeCanvas();
        });
      };

      const container = document.getElementById('radarContainer');
      if (typeof ResizeObserver !== 'undefined' && container) {
        new ResizeObserver(schedule).observe(container);
      }
      window.addEventListener('resize', schedule);
      // iOS can report the pre-rotation size for a moment after the event fires.
      window.addEventListener('orientationchange', () => setTimeout(schedule, 300));
    }

    // ---------------------------------------------------------------------
    // Screen-point caching: map.latLngToContainerPoint() is a real (if small) chunk of work -
    // reading the map's current projection/zoom/pixel-origin and doing the lat/lon -> pixel
    // maths. The scope's lat/lon, radius, every aircraft, and every trail point only actually
    // change when a new poll lands (every 12s) or the container is resized - never on a normal
    // animation frame, since the map itself never pans or zooms (dragging/zoom are disabled).
    // Recomputing all of that 60 times a second in drawRadarScope() was pure waste, and on
    // slower hardware (e.g. a Raspberry Pi) that waste was enough to drag the actual frame
    // rate down - which, since the old code advanced the sweep by a fixed amount per rendered
    // frame, made the whole sweep visibly crawl. These caches (populated by
    // recomputeMapProjectionCache/recomputeAircraftPixelCache, called only on poll/resize) let
    // the render loop just read a pre-computed {x,y} instead of re-deriving it every frame.
    // ---------------------------------------------------------------------
    let cachedCenterPt = null;
    let cachedMaxRadiusPx = 0;

    // Offscreen layer for the range rings, crosshair and N/S/E/W labels. These only
    // ever change when centerPt/maxRadiusPx change (i.e. on resize - the map never
    // pans or zooms), yet drawRadarScope was re-stroking 4 arcs + 4 shadowed
    // fillText calls for them on *every* rendered frame, with shadowBlur turned on
    // for all of it. shadowBlur is one of the most expensive canvas 2D operations,
    // especially on a software-rendering path (e.g. Chromium on a Pi without GPU
    // compositing) - paying that cost 30x/sec for pixels that are visually static
    // was the single biggest remaining per-frame cost. Render it once here into an
    // offscreen canvas instead, and just blit it (cheap) every frame.
    let staticScopeCanvas = null;
    let staticScopeCtx = null;

    function renderStaticScopeLayer() {
      if (!canvas || !cachedCenterPt) return;
      if (!staticScopeCanvas) staticScopeCanvas = document.createElement('canvas');
      if (staticScopeCanvas.width !== canvas.width || staticScopeCanvas.height !== canvas.height) {
        staticScopeCanvas.width = canvas.width;
        staticScopeCanvas.height = canvas.height;
      }
      if (!staticScopeCtx) staticScopeCtx = staticScopeCanvas.getContext('2d');

      const sctx = staticScopeCtx;
      const centerPt = cachedCenterPt;
      const maxRadiusPx = cachedMaxRadiusPx;
      const s = uiScale;

      // Same density transform as the main canvas, so this layer is also drawn in CSS px.
      sctx.setTransform(canvasDpr, 0, 0, canvasDpr, 0, 0);
      sctx.clearRect(0, 0, viewW, viewH);

      // shadowBlur is specified in device pixels and ignores the transform, so it has to be
      // multiplied by the density to look the same width at 2x as at 1x.
      sctx.shadowColor = currentTheme().accent;
      sctx.shadowBlur = 8 * canvasDpr;

      sctx.strokeStyle = accentRgba(0.35);
      sctx.lineWidth = 1;
      [0.25, 0.5, 0.75, 1.0].forEach((factor) => {
        const r = maxRadiusPx * factor;
        sctx.beginPath();
        sctx.arc(centerPt.x, centerPt.y, r, 0, 2 * Math.PI);
        sctx.stroke();

        sctx.fillStyle = accentRgba(0.8);
        sctx.font = `${9 * s}px system-ui`;
        sctx.fillText(fmtDist(userConfig.radiusNM * factor, 0), centerPt.x + 4 * s, centerPt.y - r + 10 * s);
      });

      sctx.beginPath();
      sctx.moveTo(centerPt.x - maxRadiusPx, centerPt.y);
      sctx.lineTo(centerPt.x + maxRadiusPx, centerPt.y);
      sctx.moveTo(centerPt.x, centerPt.y - maxRadiusPx);
      sctx.lineTo(centerPt.x, centerPt.y + maxRadiusPx);
      sctx.strokeStyle = accentRgba(0.25);
      sctx.stroke();

      sctx.fillStyle = currentTheme().accent;
      sctx.font = `bold ${11 * s}px system-ui`;
      sctx.fillText('N', centerPt.x - 4 * s, centerPt.y - maxRadiusPx - 5 * s);
      sctx.fillText('S', centerPt.x - 4 * s, centerPt.y + maxRadiusPx + 15 * s);
      sctx.fillText('E', centerPt.x + maxRadiusPx + 5 * s, centerPt.y + 4 * s);
      sctx.fillText('W', centerPt.x - maxRadiusPx - 18 * s, centerPt.y + 4 * s);

      sctx.shadowBlur = 0;
    }

    function recomputeMapProjectionCache() {
      if (!map) return;
      cachedCenterPt = map.latLngToContainerPoint([userConfig.lat, userConfig.lon]);
      const edgeLat = userConfig.lat + (userConfig.radiusNM / 60);
      const edgePt = map.latLngToContainerPoint([edgeLat, userConfig.lon]);
      cachedMaxRadiusPx = Math.abs(edgePt.y - cachedCenterPt.y);
      renderStaticScopeLayer();
    }

    // Recomputes the cached pixel point for every current aircraft and every trail point.
    // Call this whenever liveAircraft/aircraftTrails changes (each poll, and each
    // test-squawk/UFO injection) or whenever the projection itself changes (resize).
    function recomputeAircraftPixelCache() {
      if (!map) return;
      liveAircraft.forEach(ac => {
        if (ac.lat && ac.lon) {
          ac.__pt = map.latLngToContainerPoint([ac.lat, ac.lon]);
        }
      });
      Object.keys(aircraftTrails).forEach(hex => {
        const trail = aircraftTrails[hex];
        trail.__pts = trail.map(p => map.latLngToContainerPoint([p.lat, p.lon]));
      });
    }

    function scheduleAircraftPoll(delay = AIRCRAFT_POLL_MS) {
      clearTimeout(aircraftPollTimer);
      aircraftPollTimer = setTimeout(fetchLiveFlights, Math.max(0, delay));
    }

    async function fetchLiveFlights() {
      if (isFetching) {
        scheduleAircraftPoll(AIRCRAFT_POLL_MS);
        return;
      }

      const now = Date.now();
      if (now < pollBackoffUntil) {
        scheduleAircraftPoll(pollBackoffUntil - now);
        return;
      }

      isFetching = true;
      let nextPollDelay = AIRCRAFT_POLL_MS;

      // Single call to our own backend (server.js), same origin, no CORS involved.
      // The backend does its own upstream fetch + short-lived caching against
      // adsb.fi server-side (see handlePointLookup in cors-proxy/server.js), so
      // the three-way client fallback chain this used to be (Wispbyte primary ->
      // Wispbyte backup -> allorigins.win third-party proxy) is gone: that
      // existed to route around CORS and around each individual proxy's own
      // uptime, both of which are no longer client-side problems now that the
      // backend is self-hosted and does the resilience work itself.
      const url = `${WORKER_URL}/v2/point/${userConfig.lat}/${userConfig.lon}/${userConfig.radiusNM}`;
      let success = false;
      let sawRateLimit = false;

      try {
        try {
          const response = await fetch(url, {
            headers: { 'Accept': 'application/json' },
            cache: 'no-store'
          });
          if (response.status === 429) {
            sawRateLimit = true;
          } else if (response.ok) {
              const data = await response.json();
              const aircrafts = data.ac || data.aircraft;
              if (aircrafts) {
                // Some feeds inject a synthetic "ground station" placeholder - hex all zeros,
                // type "TWR" - representing the receiver's own site rather than an aircraft.
                // Drop these before anything else, or they can end up "nearest" (distance ~0)
                // and lock the scrollboard onto a fake target.
                liveAircraft = aircrafts.filter(ac => !/^0+$/.test(ac.hex || '') && (ac.t || '').toUpperCase() !== 'TWR');

                // Keep the injected test-squawk aircraft (see triggerTestSquawk) alive across
                // polls until it expires, so a real fetch cycle doesn't wipe it out mid-test.
                if (testAircraft) {
                  if (Date.now() < testAircraftExpiryAt) {
                    liveAircraft = liveAircraft.concat([testAircraft]);
                  } else {
                    testAircraft = null;
                  }
                }

                // Same for the UFO easter egg (see triggerUfoSighting).
                if (ufoAircraft) {
                  if (Date.now() < ufoAircraftExpiryAt) {
                    liveAircraft = liveAircraft.concat([ufoAircraft]);
                  } else {
                    ufoAircraft = null;
                  }
                }

                const receivedAt = Date.now();
                liveAircraft.forEach(ac => {
                  if (!ac.hex || !ac.lat || !ac.lon) return;
                  ac.__receivedAt = receivedAt;
                  if (!aircraftFirstSeenAt[ac.hex]) aircraftFirstSeenAt[ac.hex] = receivedAt;
                  if (!aircraftTrails[ac.hex]) aircraftTrails[ac.hex] = [];
                  const t = aircraftTrails[ac.hex];
                  t.__lastSeenAt = receivedAt;
                  const last = t[t.length - 1];
                  if (!last || Math.abs(last.lat - ac.lat) > 0.0005 || Math.abs(last.lon - ac.lon) > 0.0005) {
                    t.push({ lat: ac.lat, lon: ac.lon });
                    if (t.length > 20) t.shift();
                  }
                });

                // Drop trails for aircraft we've stopped receiving. aircraftTrails is keyed by
                // hex and the render loop walks every key each frame, so without this an
                // aircraft that left the scope hours ago still has its 20-point trail drawn
                // forever. Over a long session hundreds of these ghost trails accumulate and
                // their translucent blue strokes overlap into dense banding across the scope
                // (and the per-frame loop grows without bound). TRAIL_RETENTION_MS is well past
                // the point an aircraft could still be in range, so live traffic that briefly
                // drops out of a poll keeps its trail.
                Object.keys(aircraftTrails).forEach(hex => {
                  const lastSeen = aircraftTrails[hex].__lastSeenAt || 0;
                  if (receivedAt - lastSeen > TRAIL_RETENTION_MS) {
                    delete aircraftTrails[hex];
                    delete aircraftLastSweepHit[hex];
                    delete aircraftFirstSeenAt[hex];
                  }
                });

                // Refresh the cached screen points for the new aircraft list/trails now, once,
                // rather than letting the render loop re-derive them on every frame - see
                // recomputeAircraftPixelCache() above.
                recomputeAircraftPixelCache();

                // Route lookups only matter for whichever aircraft the scrollboard is locked
                // onto (an in-range emergency squawk, or otherwise the nearest aircraft) -
                // resolving the whole liveAircraft list every poll needlessly floods adsbdb/hexdb.
                // fetchRoutesForAircraft() has its own 5-minute cache, so this does NOT hit the
                // route APIs once per aircraft refresh.
                //
                // Deliberately NOT awaited: this is supplementary data (route origin/destination
                // for the sidebar), not core to rendering aircraft positions or the lock-on itself
                // - resolveFlightRoute() just reads whatever's in routeCache synchronously, so if
                // this hasn't finished yet the sidebar simply shows no route for one poll cycle (1s)
                // until the next updateUIState() picks up the now-cached result. Awaiting this here
                // previously meant a single slow/hung route provider blocked updateUIState(true) -
                // and therefore lock-on - for as long as that request took (observed once: ~11
                // minutes against a downed proxy, now bounded anyway by fetchWithTimeout above).
                const scrollboardTarget = findScrollboardTarget(liveAircraft);
                if (scrollboardTarget) {
                  fetchRoutesForAircraft([scrollboardTarget]).catch((err) => {
                    console.warn('[ROUTE] Background route fetch failed:', err);
                  });
                }

                updateUIState(true);
                success = true;
              }
            }
          } catch (err) {
            // A request blocked by the browser, or a genuine network/backend error
            // (Pi's own network hiccuping, backend briefly restarting, etc) - treat
            // it like a rate limit so we back off instead of retrying every second.
            sawRateLimit = true;
          }

        if (success) {
          consecutive429s = 0;
          pollBackoffUntil = 0;
          nextPollDelay = AIRCRAFT_POLL_MS;
        } else if (sawRateLimit) {
          consecutive429s++;
          // 15s, 30s, 60s, 120s, ... capped at 5 minutes.
          // This prevents a 1-second poll loop from hammering the provider after a 429.
          const backoffMs = Math.min(300000, 15000 * Math.pow(2, consecutive429s - 1));
          pollBackoffUntil = Date.now() + backoffMs;
          nextPollDelay = backoffMs;
        } else {
          // A transient network/API error should not blank the map. Keep the last successful
          // aircraft state visible and try again on the normal 1-second cadence.
          updateUIState(false);
          nextPollDelay = AIRCRAFT_POLL_MS;
        }
      } finally {
        isFetching = false;
        scheduleAircraftPoll(nextPollDelay);
      }
    }

    function updateUIState(isConnected) {
      if (isConnected) {
        renderFlightBoard(liveAircraft);
        updateNearestScrollboard(liveAircraft);
        checkRareAircraft(liveAircraft);
        checkLinkedAircraft();
        refreshAircraftDetail();
        recordDailyLogEntries(liveAircraft);
      }
    }

    // --- Daily sightings log (for the "📰 Today" AI summary panel) --------------------------
    // A compact, privacy-conscious log kept in localStorage: one entry per distinct aircraft
    // (by hex) per local calendar day, for military traffic and anything squawking an alert
    // code - the same definition of "notable" this app already uses for audio/Hue alerts. No
    // position, speed, or altitude is stored; just enough (type/operator/category/squawk) for
    // a later AI recap of the day. Cleared automatically once the calendar day rolls over.
    const DAILY_LOG_PREFIX = 'radarDailyLog:';
    const DAILY_LOG_MAX_ENTRIES = 200;

    function todayLocalKey() {
      const d = new Date();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      return `${d.getFullYear()}-${mm}-${dd}`;
    }

    function loadDailyLog() {
      try {
        const raw = localStorage.getItem(DAILY_LOG_PREFIX + todayLocalKey());
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
      } catch { return []; }
    }

    function saveDailyLog(log) {
      try {
        localStorage.setItem(DAILY_LOG_PREFIX + todayLocalKey(), JSON.stringify(log));
      } catch { /* storage full/unavailable - the log just doesn't persist, nothing else breaks */ }
    }

    // Drop any log (and cached summary) from a previous day - keeps localStorage from growing
    // forever on a kiosk that's never manually cleared, and stops the "Today" panel drifting
    // across midnight without a page reload.
    function pruneOldDailyLogs() {
      try {
        const today = todayLocalKey();
        const staleKeys = [];
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (!key) continue;
          if ((key.startsWith(DAILY_LOG_PREFIX) && key !== DAILY_LOG_PREFIX + today) ||
              (key.startsWith(DAILY_SUMMARY_CACHE_PREFIX) && key !== DAILY_SUMMARY_CACHE_PREFIX + today)) {
            staleKeys.push(key);
          }
        }
        staleKeys.forEach((k) => localStorage.removeItem(k));
      } catch { /* ignore */ }
    }

    function recordDailyLogEntries(acList) {
      if (!Array.isArray(acList) || !acList.length) return;
      const log = loadDailyLog();
      if (log.length >= DAILY_LOG_MAX_ENTRIES) return;
      const seenToday = new Set(log.map((e) => e.hex));
      let changed = false;
      for (const ac of acList) {
        if (log.length >= DAILY_LOG_MAX_ENTRIES) break;
        const alert = isAlertSquawk(ac);
        const mil = isMilitary(ac);
        if (!alert && !mil) continue;
        if (!ac.hex || seenToday.has(ac.hex)) continue;
        seenToday.add(ac.hex);
        log.push({
          hex: ac.hex,
          t: (ac.t || '').trim() || null,
          desc: (ac.desc || '').trim() || null,
          category: mil ? 'military_other' : null,
          operator: (ac.ownOp || '').trim() || null,
          squawk: alert ? String(ac.squawk || '') : null,
          emergency: alert,
        });
        changed = true;
      }
      if (changed) saveDailyLog(log);
    }

    function isMilitary(ac) {
      const type = (ac.t || '').toUpperCase();
      const flight = (ac.flight || '').toUpperCase();
      const reg = (ac.r || '').toUpperCase();
      const cat = (ac.category || '').toUpperCase();

      // ADS-B emitter categories B0-B7 and C0-C3 cover non-aircraft: surface vehicles and
      // fixed "point obstacle" beacons (commonly mounted on masts/towers, including at
      // airports, for obstruction marking). These sometimes carry a government/military
      // database flag - which previously tripped the dbFlags check below and got a fixed
      // ground beacon rendered as a "military transponder". Exclude them outright first,
      // since they're never aircraft regardless of any other flag.
      if (/^[BC][0-7]$/.test(cat)) return false;

      if (reg.startsWith('G-')) return false;

      const civilExclusions = [
        'MM16', 'B407', 'R22', 'R44', 'AS35', 'EC35', 'EC45', 'H125', 'H135', 
        'B206', 'C172', 'PA28', 'SR20', 'SR22', 'C152', 'DA40', 'DA42', 'AS50'
      ];
      if (civilExclusions.some(ex => type.includes(ex))) return false;

      const milTypes = [
        'F16', 'F15', 'F18', 'F35', 'F22', 'EF20', 'EUFI', 'TYPH', 'TOR', 
        'HAWK', 'A10', 'C130', 'C17', 'A400', 'K35R', 'E3TF', 'V22', 'CH47', 
        'AH64', 'UH60', 'NH90', 'P8', 'RC135', 'KC135'
      ];
      if (milTypes.some(s => {
        if (s === 'C17') return type === 'C17' || type === 'C-17';
        return type.includes(s);
      })) return true;

      const milPrefixes = ['RRR', 'ASCOT', 'SHF', 'VORTEX', 'RCH', 'DUKE', 'BOOM', 'REACH', 'CNV', 'GUN', 'VIPER'];
      if (milPrefixes.some(prefix => flight.startsWith(prefix))) return true;

      const dbFlags = ac.dbFlags !== undefined ? ac.dbFlags : (ac.db_flags !== undefined ? ac.db_flags : 0);
      if (dbFlags & 1) {
        if (reg.startsWith('G-') || reg.startsWith('N')) return false;
        // TEMP DEBUG: dbFlags bit is the only evidence and reg isn't G-/N-, so it's
        // sailing through the override. Log the raw fields so a reported false
        // positive can be traced to this branch vs. the A6/A7 branch below.
        console.warn('[MIL classify] dbFlags bit fired', {
          flight: ac.flight, hex: ac.hex, type, reg, cat, dbFlags
        });
        return true;
      }

      // ADS-B emitter categories: A5 = Heavy (>300,000 lb), A6 = High Performance (>5g and
      // >400 kt), A7 = rotorcraft. A6/A7 are a reasonable "no other evidence" military hint
      // (fast jets / helicopters). A5 is deliberately NOT here: it is every widebody airliner
      // (777, 787, A330, A350, A380...), and treating it as military filled the MIL panel with
      // airline flights and fired false alerts. Genuinely military heavies (C-17, KC-135, E-3,
      // A400M, tankers...) are still caught above by type, callsign prefix or the dbFlags bit.
      if (cat === 'A7' || cat === 'A6') {
        // TEMP DEBUG: same as above - trace which category hint fired.
        console.warn('[MIL classify] category hint fired', {
          flight: ac.flight, hex: ac.hex, type, reg, cat, dbFlags
        });
        return true;
      }

      return false;
    }

    function renderFlightBoard(acList) {
      const gridEl = document.getElementById('aircraft-grid');
      if (!gridEl) return;

      const currentScroll = gridEl.scrollTop;
      gridEl.innerHTML = '';

      const militaryList = acList.filter(ac => isMilitary(ac));

      if (!militaryList || militaryList.length === 0) {
        gridEl.innerHTML = `<div style="color:var(--text-dim); font-size:0.75rem; padding: 0.5rem; text-align:center;">No active military transponders within ${fmtDist(userConfig.radiusNM, 0)}.</div>`;
        internalScrollPos = 0;
        return;
      }

      militaryList.forEach((ac, index) => {
        if (!ac.lat || !ac.lon) return;

        announceMilitaryAircraft(ac);

        const dist = calcDistanceNM(userConfig.lat, userConfig.lon, ac.lat, ac.lon);
        const cardId = `mil-card-${ac.hex}-${index}`;
        const card = document.createElement('div');
        card.className = 'ac-card';
        card.style.cursor = 'pointer';
        card.title = 'Tap for aircraft details';
        card.addEventListener('click', () => {
          // Prefer the live snapshot (matches what scope-click selection uses) in case this
          // card's own `ac` object has since been superseded by a later poll.
          const live = liveAircraft.find((a) => a.hex === ac.hex) || ac;
          selectAircraft(live);
        });
        card.innerHTML = `
          <div class="ac-thumb" id="${cardId}-thumb">
            <span style="font-size:0.55rem; color:var(--accent-military); font-weight:bold; text-align:center;">MIL</span>
          </div>
          <div style="flex: 1; min-width: 0;">
            <div style="font-weight:bold; font-size:0.78rem; color:var(--accent-military); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-shadow: 0 0 5px rgba(255,176,0,0.4);">${ac.flight ? ac.flight.trim() : ac.hex}</div>
            <div style="font-size:0.65rem; color:var(--text-dim);">[${ac.t || 'MIL'}] • ${fmtSpeed(ac.gs || 0)}</div>
          </div>
          <div style="text-align:right; flex-shrink: 0;">
            <div style="font-weight:bold; color:var(--accent-green); font-size:0.78rem; text-shadow: 0 0 5px rgba(var(--accent-rgb),0.4);">${fmtDist(dist)}</div>
            <div style="font-size:0.65rem; color:var(--text-dim);">${fmtAltOrGround(ac.alt_baro, true)}</div>
          </div>
        `;
        gridEl.appendChild(card);
        fetchCardPhoto(ac, `${cardId}-thumb`);
      });

      gridEl.scrollTop = Math.min(currentScroll, gridEl.scrollHeight - gridEl.clientHeight);
      internalScrollPos = gridEl.scrollTop;
    }

    async function fetchCardPhoto(ac, thumbId) {
      const thumbEl = document.getElementById(thumbId);
      if (!thumbEl) return;

      const photoUrl = await resolveAircraftPhoto(ac);

      // The card (and its id) may have been re-rendered away while the fetch was in flight
      // (e.g. next poll cycle) - re-grab it rather than trust the closed-over reference.
      const liveEl = document.getElementById(thumbId);
      if (!liveEl) return;

      if (photoUrl) {
        liveEl.innerHTML = `<img src="${photoUrl}" alt="Military Aircraft Photo">`;
      } else {
        liveEl.innerHTML = `<span style="font-size:0.55rem; color:var(--accent-military); font-weight:bold; text-align:center;">MIL</span>`;
      }
    }

    function processAutoScroll() {
      const grid = document.getElementById('aircraft-grid');
      if (!grid) return;

      const maxScroll = grid.scrollHeight - grid.clientHeight;

      if (maxScroll <= 0) {
        internalScrollPos = 0;
        grid.scrollTop = 0;
        return;
      }

      if (scrollState === 'PAUSED_TOP') {
        scrollTimer--;
        if (scrollTimer <= 0) {
          scrollState = 'SCROLLING';
        }
        return;
      }

      if (scrollState === 'PAUSED_BOTTOM') {
        scrollTimer--;
        if (scrollTimer <= 0) {
          internalScrollPos = 0;
          grid.scrollTop = 0;
          scrollState = 'PAUSED_TOP';
          scrollTimer = 120;
        }
        return;
      }

      internalScrollPos += 0.35;
      grid.scrollTop = internalScrollPos;

      if (grid.scrollTop >= maxScroll - 1 || internalScrollPos >= maxScroll) {
        scrollState = 'PAUSED_BOTTOM';
        scrollTimer = 120;
        internalScrollPos = maxScroll;
        grid.scrollTop = maxScroll;
      }
    }

    // Manual overrides for specific airframes, keyed by registration (ac.r), trimmed +
    // uppercased - e.g. police/agency aircraft with no real airline code, or the UFO easter
    // egg below. `logo` replaces the normal ICAO-callsign-prefix airline lookup with a plain
    // text/colour badge (shown regardless of civil/military classification); `route` replaces
    // the resolved/estimated From-To with fixed text instead of airport codes.
    const REGISTRATION_OVERRIDES = {
      'UKP154': {
        logo: { text: 'POLICE', bg: '#ffffff', textColor: '#0a3fd9' },
        route: { from: 'Fighting crime', to: 'Finding criminals' }
      },
      'UFO1': {
        logo: { text: 'UFO', bg: '#000000', textColor: '#00ff66' }
      }
    };

    async function fetchAircraftPhoto(ac, isMil) {
      const logoBox = document.getElementById('sb-logo-box');

      // Build the two-slot layout up front (airline badge + aircraft photo) so both can
      // populate independently and asynchronously without clobbering each other.
      logoBox.innerHTML = `
        <div class="photo-row">
          <div class="airline-logo-thumb" id="sb-airline-logo" style="display:none;"></div>
          <div class="aircraft-photo-thumb" id="sb-aircraft-photo">
            <span class="logo-fallback" id="sb-logo-text">${isMil ? 'MILITARY' : '--'}</span>
          </div>
        </div>
      `;

      const regOverride = REGISTRATION_OVERRIDES[(ac.r || '').trim().toUpperCase()];

      if (regOverride && regOverride.logo) {
        const overrideEl = document.getElementById('sb-airline-logo');
        if (overrideEl) {
          overrideEl.style.background = regOverride.logo.bg;
          overrideEl.innerHTML = `<span style="font-weight:800; font-size:0.7rem; letter-spacing:0.04em; text-transform:uppercase; color:${regOverride.logo.textColor};">${regOverride.logo.text}</span>`;
          overrideEl.style.display = 'flex';
        }
      }
      // Airline logo - civil flights only, derived from the callsign's ICAO airline prefix.
      // Skipped entirely when a registration override above already set the badge.
      else if (!isMil) {
        const callsign = ac.flight ? ac.flight.trim() : '';
        const icaoCode = extractAirlineIcaoCode(callsign);
        if (icaoCode) {
          if (airlineLogoCache[icaoCode] === undefined) {
            // Not resolved yet this session - probe the repo sources (then airhex) in the
            // background and populate once we know. Mark as "in flight" so a rapid string
            // of polls for the same airline doesn't kick off duplicate probes.
            airlineLogoCache[icaoCode] = null;
            resolveAirlineLogoUrl(icaoCode).then((url) => {
              airlineLogoCache[icaoCode] = url;
              // Only touch the DOM if the scrollboard is still locked on this same airline -
              // otherwise this stale resolution would clobber whatever's shown now.
              const stillRelevant = lockedAircraft && !isMilitary(lockedAircraft) &&
                extractAirlineIcaoCode(lockedAircraft.flight ? lockedAircraft.flight.trim() : '') === icaoCode;
              if (url && stillRelevant) {
                const liveLogoEl = document.getElementById('sb-airline-logo');
                if (liveLogoEl) {
                  liveLogoEl.innerHTML = `<img src="${url}" alt="${icaoCode} logo">`;
                  liveLogoEl.style.display = 'flex';
                }
              }
            });
          } else if (airlineLogoCache[icaoCode]) {
            const logoEl = document.getElementById('sb-airline-logo');
            if (logoEl) {
              logoEl.innerHTML = `<img src="${airlineLogoCache[icaoCode]}" alt="${icaoCode} logo">`;
              logoEl.style.display = 'flex';
            }
          }
        }
      }

      const photoUrl = await resolveAircraftPhoto(ac);
      const photoEl = document.getElementById('sb-aircraft-photo');
      if (!photoEl) return; // scrollboard may have re-rendered away while the fetch was in flight

      if (photoUrl) {
        photoEl.innerHTML = `<img src="${photoUrl}" alt="Aircraft Photo">`;
      } else if (isMil) {
        photoEl.innerHTML = `<span class="logo-fallback" style="color: var(--accent-military);">MIL AC</span>`;
      } else {
        photoEl.innerHTML = `<span class="logo-fallback">${ac.t || 'CIVIL'}</span>`;
      }
    }

    function updateNearestScrollboard(acList) {
      if (!acList || acList.length === 0) return;
      lockedAircraft = findScrollboardTarget(acList);
      if (!lockedAircraft) return;

      const dist = calcDistanceNM(userConfig.lat, userConfig.lon, lockedAircraft.lat, lockedAircraft.lon);
      const bearing = calcBearing(userConfig.lat, userConfig.lon, lockedAircraft.lat, lockedAircraft.lon);
      const flightStr = lockedAircraft.flight ? lockedAircraft.flight.trim() : `ICAO: ${lockedAircraft.hex}`;
      const isAlertLock = isAlertSquawk(lockedAircraft);
      const isQraLock = lockedAircraft.squawk === QRA_SQUAWK;

      // Sound/flash once per aircraft the first time it takes an alert lock, not on
      // every 12s poll while it's still squawking - otherwise this fires continuously for
      // as long as the emergency/QRA lasts.
      if (isAlertLock && !announcedEmergencyHexes.has(lockedAircraft.hex)) {
        announcedEmergencyHexes.add(lockedAircraft.hex);
        const emergencyAc = lockedAircraft;
        const sirenMs = playEmergencySiren();
        triggerRedPulse();
        pingLightBridge(dist);
        // Let the siren play out before the spoken callout so they don't talk over each other.
        setTimeout(() => announceEmergencySquawk(emergencyAc), Math.max(300, sirenMs));
      }

      fetchAircraftPhoto(lockedAircraft, isMilitary(lockedAircraft));

      const speedKts = lockedAircraft.gs !== undefined ? Math.round(lockedAircraft.gs) : 0;
      const speedSecond = settings.speed === 'kts' ? SPEED_UNITS.mph : SPEED_UNITS.kts;

      document.getElementById('sb-distance').innerText = fmtDist(dist);
      document.getElementById('sb-alt').innerText = `Alt: ${fmtAltOrGround(lockedAircraft.alt_baro, true)}`;
      document.getElementById('sb-speed').innerText = `Spd: ${fmtSpeed(speedKts)} (${Math.round(speedKts * speedSecond.perKt)} ${speedSecond.label})`;

      const airlineEl = document.getElementById('sb-airline');
      const planeLabel = lockedAircraft.flight ? lockedAircraft.flight.trim() : lockedAircraft.hex;
      if (isQraLock) {
        // 7777 isn't a distress code - label it ALERT (amber, matching the app's existing
        // military color) rather than EMERGENCY (red).
        airlineEl.innerText = `⚠ ALERT-${planeLabel}-${lockedAircraft.squawk}`;
        airlineEl.style.color = 'var(--accent-military)';
        airlineEl.style.textShadow = '0 0 10px rgba(255,176,0,0.5)';
      } else if (isAlertLock) {
        airlineEl.innerText = `⚠ EMERGENCY-${planeLabel}-${lockedAircraft.squawk}`;
        airlineEl.style.color = 'var(--accent-red)';
        airlineEl.style.textShadow = '0 0 10px rgba(255,51,51,0.6)';
      } else {
        airlineEl.innerText = flightStr;
        airlineEl.style.color = 'var(--accent-green)';
        airlineEl.style.textShadow = '0 0 8px rgba(var(--accent-rgb),0.4)';
      }

      document.getElementById('sb-type').innerText = `Type: ${lockedAircraft.t || 'Aircraft'}`;

      const heading = lockedAircraft.track !== undefined ? Math.round(lockedAircraft.track) : '--';
      document.getElementById('sb-heading').innerText = `Hdng: ${heading}°`;
      document.getElementById('sb-bearing').innerText = `Bearing: ${bearing}°`;

      const vertRate = lockedAircraft.baro_rate !== undefined ? lockedAircraft.baro_rate : 0;
      const rateEl = document.getElementById('sb-rate');
      if (vertRate > 30) {
        rateEl.innerHTML = `<span style="color: var(--accent-green); text-shadow: 0 0 6px rgba(var(--accent-rgb),0.4);">▲ +${fmtVRate(vertRate, true)}</span>`;
      } else if (vertRate < -30) {
        rateEl.innerHTML = `<span style="color: var(--accent-red); text-shadow: 0 0 6px rgba(255,51,51,0.4);">▼ -${fmtVRate(vertRate, true)}</span>`;
      } else {
        rateEl.innerHTML = `<span style="color: var(--text-dim);">— Level Flight</span>`;
      }

      const routeContainer = document.getElementById('sb-route-container');
      const tagEl = document.getElementById('sb-route-tag');
      const routeOverride = REGISTRATION_OVERRIDES[(lockedAircraft.r || '').trim().toUpperCase()];

      if (routeOverride && routeOverride.route) {
        // Fixed flavour text instead of a real route - not "estimated" (that styling/tag means
        // "we tried to resolve a real route and couldn't"), just its own permanent from/to.
        routeContainer.classList.remove('route-estimated');
        document.getElementById('sb-from').innerHTML = `<b>${routeOverride.route.from}</b>`;
        document.getElementById('sb-to').innerHTML = `<b>${routeOverride.route.to}</b>`;
        tagEl.style.display = 'none';
      } else {
        // Only display routes returned by an API and accepted by validation. Never invent a
        // destination from callsign prefixes or heading.
        const route = resolveFlightRoute(flightStr, lockedAircraft);
        routeContainer.classList.remove('route-estimated');

        if (!route) {
          document.getElementById('sb-from').innerHTML = '<b>UNKNOWN</b> — <span style="color:var(--text-dim);">No verified route</span>';
          document.getElementById('sb-to').innerHTML = '<b>UNKNOWN</b> — <span style="color:var(--text-dim);">No verified destination</span>';
          tagEl.style.display = 'inline-block';
          tagEl.className = 'route-source-tag estimated';
          tagEl.innerText = 'NO DATA';
          tagEl.title = 'No route from the available route APIs';
          document.getElementById('sb-eta').innerText = 'ETA: --';
        } else {
          document.getElementById('sb-from').innerHTML =
            `<b>${route.fromCode}</b> — <span style="color:var(--text-dim);">${route.fromName || airportName(route.fromCode) || 'Aerodrome'}</span>`;
          document.getElementById('sb-to').innerHTML =
            `<b>${route.toCode}</b> — <span style="color:var(--text-dim);">${route.toName || airportName(route.toCode) || 'Aerodrome'}</span>`;
          tagEl.style.display = 'inline-block';
          if (route.source === 'opensky') {
            // Track-derived estimate, not a verified schedule - styled like the
            // amber "estimated" tag rather than the green confirmed one.
            tagEl.className = 'route-source-tag estimated';
            tagEl.innerText = 'TRACK EST';
            tagEl.title = 'Estimated from OpenSky ADS-B track history, not a verified schedule';
          } else {
            tagEl.className = 'route-source-tag confirmed';
            tagEl.innerText = route.source === 'hexdb' ? 'HEXDB' : 'CONFIRMED';
            tagEl.title = `Verified route data from ${route.source}`;
          }
          document.getElementById('sb-eta').innerText = `ETA: ${computeEtaText(lockedAircraft, route)}`;
        }      }
    }

    let sweepAngle = 0;
    // One full sweep rotation takes ~7s of real time. Previously this was advanced by a fixed
    // 0.015rad on every executed animation frame, which meant the sweep's actual on-screen
    // speed was tied to whatever frame rate the device happened to achieve - on a Raspberry
    // Pi (or any device that can't sustain 60fps), fewer executed frames per second meant a
    // visibly slower sweep, independent of anything actually being "wrong". Advancing by
    // elapsed wall-clock time instead (see drawRadarScope) keeps the sweep's real-world speed
    // constant no matter how many frames the device manages to render.
    const SWEEP_RATE_RAD_PER_SEC = 0.9;
    // One full sweep rotation (2π at the rate above, ~7s) - fade every non-locked blip out
    // over roughly that long, down to a dim floor rather than to nothing, so the scope still
    // reads at a glance between sweep passes.
    const SWEEP_FADE_MS = 7000;
    const SWEEP_FADE_MIN_ALPHA = 0.35;

    // Soft render-rate cap: redrawing the full canvas (rings, sweep, every aircraft
    // silhouette + label) at an uncapped 60fps is more work than a Raspberry Pi's GPU/canvas
    // path can comfortably sustain. 30fps is still smooth for a slow-moving radar sweep and
    // roughly halves the per-second drawing cost; because the sweep/fade maths above are now
    // time-based rather than frame-count-based, capping the render rate changes nothing about
    // how fast anything visually moves - only how often the canvas is repainted.
    const MIN_FRAME_INTERVAL_MS = 1000 / 30;
    let lastRenderTimestamp = null;

    function drawRadarScope(timestamp) {
      requestAnimationFrame(drawRadarScope);

      if (lastRenderTimestamp === null) lastRenderTimestamp = timestamp;
      const elapsedMs = timestamp - lastRenderTimestamp;
      if (elapsedMs < MIN_FRAME_INTERVAL_MS) return;
      // Clamp so returning from a backgrounded/minimised tab (which can pause rAF for a long
      // time) doesn't spin the sweep angle through several full rotations to "catch up".
      const dtMs = Math.min(200, elapsedMs);
      lastRenderTimestamp = timestamp;

      if (!ctx || !canvas || !map || !cachedCenterPt) return;
      ctx.clearRect(0, 0, viewW, viewH);

      processAutoScroll();

      // Cached once per poll/resize rather than re-derived from the map every frame - see
      // recomputeMapProjectionCache().
      const centerPt = cachedCenterPt;
      const maxRadiusPx = cachedMaxRadiusPx;

      // Range rings, crosshair and N/S/E/W labels are static (they only change on
      // resize - see recomputeMapProjectionCache/renderStaticScopeLayer), so they're
      // pre-rendered once onto an offscreen canvas and just blitted here instead of
      // being re-stroked with shadowBlur on every frame.
      if (staticScopeCanvas) ctx.drawImage(staticScopeCanvas, 0, 0, viewW, viewH);

      sweepAngle += SWEEP_RATE_RAD_PER_SEC * (dtMs / 1000);
      if (sweepAngle > 2 * Math.PI) sweepAngle -= 2 * Math.PI; // keep it bounded, doesn't affect the maths below either way

      // shadowBlur is one of the more expensive canvas operations, especially on a Pi's
      // software/GPU-lite rendering path, and it was previously left "on" (inherited from
      // the scope rings above) for every subsequent stroke/fill this frame - including the
      // 15-segment sweep trail and, worse, every aircraft's silhouette + label, every frame.
      // Turn it off before that bulk per-aircraft work; it gets switched back on only for the
      // few individual draws below that actually want a glow (the sweep beam itself, and the
      // locked-aircraft pulse ring).
      ctx.shadowBlur = 0;

      // Sweep trail: drawn as one multi-segment path instead of 15 separate stroke() calls -
      // same look (each segment still gets its own fading alpha via a per-segment gradient
      // isn't worth the complexity here, so we approximate with one mid-alpha stroke per
      // segment) but far fewer draw-call round trips into the canvas backend.
      for (let i = 0; i < 15; i++) {
        const trailAngle = sweepAngle - (i * 0.012);
        const trailX = centerPt.x + Math.cos(trailAngle) * maxRadiusPx;
        const trailY = centerPt.y + Math.sin(trailAngle) * maxRadiusPx;

        ctx.beginPath();
        ctx.moveTo(centerPt.x, centerPt.y);
        ctx.lineTo(trailX, trailY);
        ctx.strokeStyle = accentRgba(0.12 * (1 - i / 15));
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      const sweepX = centerPt.x + Math.cos(sweepAngle) * maxRadiusPx;
      const sweepY = centerPt.y + Math.sin(sweepAngle) * maxRadiusPx;
      ctx.shadowColor = currentTheme().accent;
      ctx.shadowBlur = 6 * canvasDpr;
      ctx.beginPath();
      ctx.moveTo(centerPt.x, centerPt.y);
      ctx.lineTo(sweepX, sweepY);
      ctx.strokeStyle = accentRgba(0.9);
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.shadowBlur = 0;

      Object.keys(aircraftTrails).forEach(hex => {
        const trail = aircraftTrails[hex];
        const pts = trail.__pts;
        if (pts && pts.length > 1) {
          ctx.beginPath();
          for (let i = 0; i < pts.length; i++) {
            if (i === 0) ctx.moveTo(pts[i].x, pts[i].y);
            else ctx.lineTo(pts[i].x, pts[i].y);
          }
          ctx.strokeStyle = 'rgba(0, 191, 255, 0.3)';
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      });

      if (liveAircraft && liveAircraft.length > 0) {
        // Label boxes placed so far this frame, so overlapping callsigns can be nudged
        // apart instead of stacking illegibly on top of each other - see the collision
        // step just before each label is drawn, below.
        const placedLabelBoxes = [];
        liveAircraft.forEach(ac => {
          if (!ac.lat || !ac.lon || !ac.__pt) return;

          // Cached once per poll/resize instead of re-derived from the map every frame -
          // see recomputeAircraftPixelCache().
          const pt = ac.__pt;
          const isMil = isMilitary(ac);
          const isEmg = ac.squawk === '7500' || ac.squawk === '7600' || ac.squawk === '7700';
          const isQra = ac.squawk === QRA_SQUAWK;
          const isLocked = lockedAircraft && lockedAircraft.hex === ac.hex;
          const isSelected = !!selectedHex && ac.hex === selectedHex;

          // CRT-style sweep fade: everything except the locked aircraft brightens when the
          // sweep beam passes its bearing, then dims until the next pass comes back around
          // (one full rotation later) rather than staying uniformly lit the whole time.
          const blipAngle = Math.atan2(pt.y - centerPt.y, pt.x - centerPt.x);
          const angDiff = Math.abs(((sweepAngle - blipAngle + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI);
          if (ac.hex && angDiff < 0.02) aircraftLastSweepHit[ac.hex] = Date.now();
          let fadeAlpha = 1;
          if (!isLocked && !isSelected && ac.hex) {
            if (aircraftLastSweepHit[ac.hex] === undefined) aircraftLastSweepHit[ac.hex] = Date.now();
            const elapsed = Date.now() - aircraftLastSweepHit[ac.hex];
            const t = Math.min(1, elapsed / SWEEP_FADE_MS);
            fadeAlpha = 1 - t * (1 - SWEEP_FADE_MIN_ALPHA);
          }

          ctx.save();
          ctx.globalAlpha = fadeAlpha;

          if (isLocked) {
            const pulseRadius = (12 + Math.sin(Date.now() / 150) * 3) * uiScale;
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, pulseRadius, 0, 2 * Math.PI);
            ctx.strokeStyle = '#ff3333';
            ctx.lineWidth = 2;
            ctx.shadowColor = '#ff3333';
            ctx.shadowBlur = 10 * canvasDpr;
            ctx.stroke();
            ctx.shadowBlur = 0;
          }

          if (isSelected) {
            // Dashed white reticle marking the aircraft whose details are open; distinct from the
            // solid red pulse ring used for the scrollboard lock.
            ctx.save();
            ctx.setLineDash([4 * uiScale, 3 * uiScale]);
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, 17 * uiScale, 0, 2 * Math.PI);
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
            ctx.lineWidth = 1.5;
            ctx.stroke();
            ctx.restore();
          }

          if (ac.track !== undefined) {
            const trackRad = (ac.track - 90) * (Math.PI / 180);
            const lineLen = 16 * uiScale;
            const endX = pt.x + Math.cos(trackRad) * lineLen;
            const endY = pt.y + Math.sin(trackRad) * lineLen;
            ctx.beginPath();
            ctx.moveTo(pt.x, pt.y);
            ctx.lineTo(endX, endY);
            ctx.strokeStyle = isMil ? '#ffb000' : '#00bfff';
            ctx.lineWidth = 1.2;
            ctx.stroke();
          }

          const heading = ac.track !== undefined ? ac.track : 0;
          // Altitude-banded colour for routine traffic; emergency/military/QRA still win out
          // over altitude so those states are never ambiguous with a colour band - see
          // altitudeColor() and ALTITUDE_BANDS above.
          const silColor = isEmg ? '#ff3333' : (isQra || isMil ? '#ffb000' : altitudeColor(ac.alt_baro));

          // Silhouette is always drawn at full brightness - only the label fades with the
          // sweep, so the aircraft shape itself stays clearly visible between sweep passes.
          ctx.globalAlpha = 1;

          // Local spritesheet lookup - specific type designator first, falling back to the
          // aircraft's ADS-B category's generic silhouette. Draws nothing (beyond the label)
          // if neither is covered - see drawPwSilhouette/resolvePwSpriteKey above.
          ctx.save();
          ctx.translate(pt.x, pt.y);
          ctx.scale(uiScale, uiScale);
          ctx.translate(-pt.x, -pt.y);
          drawPwSilhouette(ctx, ac, pt, heading, silColor);
          ctx.restore();

          ctx.globalAlpha = fadeAlpha;
          const s = uiScale;
          ctx.font = `bold ${9 * s}px system-ui`;
          const label = ac.flight ? ac.flight.trim() : ac.hex;
          const altText = ac.alt_baro ? ` FL${Math.round(ac.alt_baro / 100)}` : '';
          const labelText = `${label}${altText}`;

          const labelMetrics = ctx.measureText(labelText);
          const labelPadX = 2 * s;
          const labelPadY = 1 * s;
          const labelBoxW = labelMetrics.width + labelPadX * 2;
          const labelBoxH = 9 * s + labelPadY * 2;
          let labelBoxX = pt.x + 7 * s - labelPadX;
          let labelBoxY = pt.y + (3 - 7) * s - labelPadY;

          // Nudge this label down, a row at a time, until it clears every box already
          // placed this frame - so two aircraft close together on screen get readable,
          // stacked labels instead of one illegible overlapping blob. Capped at 24 tries
          // (a tall stack of coincident blips) so this can never hang the render loop.
          const labelBoxGap = 2 * s;
          for (let attempt = 0; attempt < 24; attempt++) {
            const collidesWith = placedLabelBoxes.find(box =>
              labelBoxX < box.x + box.w &&
              labelBoxX + labelBoxW > box.x &&
              labelBoxY < box.y + box.h &&
              labelBoxY + labelBoxH > box.y
            );
            if (!collidesWith) break;
            labelBoxY = collidesWith.y + collidesWith.h + labelBoxGap;
          }
          placedLabelBoxes.push({ x: labelBoxX, y: labelBoxY, w: labelBoxW, h: labelBoxH });
          ac.__labelBox = { x: labelBoxX, y: labelBoxY, w: labelBoxW, h: labelBoxH }; // for tap hit-testing, see findAircraftAtPoint()

          // Faded white backing box behind the callsign/altitude label so it stays readable
          // against the scope regardless of what colour/brightness is under it (trails, sweep
          // glow, other blips).
          ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
          ctx.fillRect(labelBoxX, labelBoxY, labelBoxW, labelBoxH);

          ctx.fillStyle = isEmg ? '#ff3333' : (isQra || isMil ? '#ffb000' : '#8b4513');
          ctx.fillText(labelText, labelBoxX + labelPadX, labelBoxY + labelBoxH - labelPadY - 2 * s);

          ctx.restore(); // matches the fadeAlpha save() above
        });
      }
    }

    // ---------------------------------------------------------------------
    // Aircraft detail panel: tap/click an aircraft (or its callsign label) on the scope.
    // ---------------------------------------------------------------------
    // Live numbers (distance, altitude, speed, heading, vertical rate, squawk) come straight from
    // the ADS-B record and refresh every poll. The route reuses the same verified route lookups
    // as the scrollboard. The "aircraft profile" block (type, operator, specs, summary) is
    // fetched once per aircraft from our own backend - POST /api/aircraft-info, which asks Gemini
    // for a JSON profile (see cors-proxy/server.js) - and is cached for the page's lifetime. The
    // Gemini API key never reaches the browser.
    //
    // Everything shown in the panel is written with textContent, never innerHTML: callsigns are
    // broadcast over radio and the profile is model output, so neither is trusted as markup.
    const AIRCRAFT_INFO_PATH_CLIENT = '/api/aircraft-info';
    const AIRCRAFT_INFO_TIMEOUT_MS = 25000;
    // A wall board shouldn't be left with a panel covering the scope, so it closes itself after
    // a couple of minutes without interaction, or once the aircraft has been gone a minute.
    const AIRCRAFT_DETAIL_IDLE_MS = 120000;
    const AIRCRAFT_DETAIL_LOST_MS = 60000;
    const SQUAWK_SHORT_LABELS = { '7500': 'HIJACK', '7600': 'RADIO FAILURE', '7700': 'EMERGENCY', '7777': 'QRA / INTERCEPT' };
    const AIRCRAFT_CATEGORY_LABELS = {
      airliner: 'Airliner', regional_airliner: 'Regional airliner', cargo: 'Cargo', business_jet: 'Business jet',
      general_aviation: 'General aviation', helicopter: 'Helicopter', military_fighter: 'Military fighter',
      military_transport: 'Military transport', military_tanker: 'Military tanker',
      military_surveillance: 'Military surveillance', military_trainer: 'Military trainer',
      military_helicopter: 'Military helicopter', military_other: 'Military', glider_or_balloon: 'Glider / balloon',
      unmanned: 'Unmanned', other: 'Other'
    };
    let aircraftDetailIdleTimer = null;
    // hex -> { status: 'loading' | 'ok' | 'error' | 'unavailable', info, message, retryable, model }
    const aircraftProfileState = {};

    // ---------------------------------------------------------------------
    // UK squawk decoder
    // ---------------------------------------------------------------------
    // Special-purpose Mode A codes from the UK AIP (ENR 1.6). The distress codes and 7777 keep
    // their own wording in SQUAWK_SHORT_LABELS / SQUAWK_MEANINGS; these are the everyday
    // conspicuity and special-activity codes that make a squawk worth reading. kind 'notable'
    // codes also get a tag under the callsign; 'info' codes only show in the Squawk stat.
    const UK_SQUAWK_CODES = {
      '7000': { short: 'VFR', long: 'VFR conspicuity code - no air traffic service requested', kind: 'info' },
      '7001': { short: 'MIL LOW-LEVEL', long: 'Military fixed-wing low-level conspicuity or climb-out', kind: 'notable' },
      '7002': { short: 'DANGER AREA', long: 'Working in or near a danger area', kind: 'info' },
      '7003': { short: 'RED ARROWS', long: 'Red Arrows transit or display', kind: 'notable' },
      '7004': { short: 'AEROBATICS', long: 'Aerobatics or a flying display in progress', kind: 'notable' },
      '7005': { short: 'HIGH-ENERGY', long: 'High-energy manoeuvres', kind: 'notable' },
      '7006': { short: 'TRA OPS', long: 'Autonomous operations inside a temporary reserved area', kind: 'notable' },
      '7007': { short: 'OPEN SKIES', long: 'Open Skies treaty observation aircraft', kind: 'notable' },
      '7010': { short: 'CIRCUIT', long: 'Flying in the aerodrome circuit (traffic pattern)', kind: 'info' },
      '7400': { short: 'DRONE LINK LOST', long: 'Unmanned aircraft has lost its control link', kind: 'notable' }
    };
    const ALERT_SQUAWK_LONG = {
      '7500': 'Hijacking or unlawful interference',
      '7600': 'Radio failure',
      '7700': 'General emergency',
      '7777': 'Quick Reaction Alert fighter intercept'
    };
    // -> { short, long, kind } for any squawk this app knows how to explain, else null.
    function describeSquawk(code) {
      const c = String(code || '');
      if (SQUAWK_SHORT_LABELS[c]) return { short: SQUAWK_SHORT_LABELS[c], long: ALERT_SQUAWK_LONG[c] || '', kind: 'alert' };
      return Object.prototype.hasOwnProperty.call(UK_SQUAWK_CODES, c) ? UK_SQUAWK_CODES[c] : null;
    }

    // ---------------------------------------------------------------------
    // Rare-aircraft alerts
    // ---------------------------------------------------------------------
    // Matches on the ICAO type code. Civil rarities and warbirds mostly - military traffic already
    // has its own proximity alert (announceMilitaryAircraft), so a rare military aircraft only gets
    // the banner and chime here, not a second spoken announcement.
    const RARE_TYPES = {
      A388: 'Airbus A380', A3ST: 'Airbus Beluga', A337: 'Airbus Beluga XL', A124: 'Antonov An-124 Ruslan',
      AN22: 'Antonov An-22', BLCF: 'Boeing 747 Dreamlifter', B741: 'Boeing 747-100', B742: 'Boeing 747-200',
      B743: 'Boeing 747-300', VC10: 'Vickers VC10', SPIT: 'Supermarine Spitfire', HURI: 'Hawker Hurricane',
      LANC: 'Avro Lancaster', B17: 'B-17 Flying Fortress', B25: 'B-25 Mitchell', P51: 'P-51 Mustang',
      DC3: 'Douglas DC-3 Dakota'
    };
    // Special UK squawks that mark something worth looking up for (see UK_SQUAWK_CODES).
    const RARE_SQUAWKS = { '7003': 'Red Arrows', '7007': 'Open Skies observation aircraft' };
    const RARE_REPEAT_COOLDOWN_MS = 60 * 60 * 1000; // a loitering A380 shouldn't chime every few minutes
    const RARE_BANNER_MS = 15000;
    const rareAnnouncedAt = new Map();
    let rareBannerTimer = null;

    function classifyRare(ac) {
      const type = String(ac.t || '').trim().toUpperCase();
      if (Object.prototype.hasOwnProperty.call(RARE_TYPES, type)) return { label: RARE_TYPES[type], reason: 'type' };
      const sq = String(ac.squawk || '');
      if (Object.prototype.hasOwnProperty.call(RARE_SQUAWKS, sq)) return { label: RARE_SQUAWKS[sq], reason: 'squawk' };
      return null;
    }

    function playRareTone() {
      if (!audioAlertsEnabled) return;
      try {
        if (!audioCtx) initKioskAudio();
        if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
        const t0 = audioCtx.currentTime;
        // Three rising notes - deliberately unlike the falling single chirp used for military.
        [[660, 0], [880, 0.16], [1320, 0.32]].forEach(([freq, at]) => {
          const osc = audioCtx.createOscillator();
          const gain = audioCtx.createGain();
          osc.type = 'triangle';
          osc.frequency.setValueAtTime(freq, t0 + at);
          gain.gain.setValueAtTime(0.0001, t0 + at);
          gain.gain.exponentialRampToValueAtTime(0.14, t0 + at + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.001, t0 + at + 0.22);
          osc.connect(gain);
          gain.connect(audioCtx.destination);
          osc.start(t0 + at);
          osc.stop(t0 + at + 0.25);
        });
      } catch (e) {}
    }

    function hideRareBanner() {
      clearTimeout(rareBannerTimer);
      const el = document.getElementById('rare-banner');
      if (el) el.hidden = true;
    }

    function showRareBanner(ac, rare, dist) {
      const el = document.getElementById('rare-banner');
      if (!el) return;
      const callsign = (ac.flight || '').trim() || String(ac.hex).toUpperCase();
      el.textContent = '';
      el.appendChild(adEl('span', 'rb-star', '★'));
      const body = adEl('span', 'rb-text');
      body.appendChild(adEl('strong', null, rare.label));
      body.appendChild(document.createTextNode(` · ${callsign} · ${fmtDist(dist)}`));
      el.appendChild(body);
      el.onclick = () => {
        const live = liveAircraft.find((a) => a.hex === ac.hex) || ac;
        selectAircraft(live);
        hideRareBanner();
      };
      el.hidden = false;
      clearTimeout(rareBannerTimer);
      rareBannerTimer = setTimeout(hideRareBanner, RARE_BANNER_MS);
    }

    function announceRareAircraft(ac, rare, dist) {
      showRareBanner(ac, rare, dist);
      playRareTone();
      if (isMilitary(ac) || !('speechSynthesis' in window)) return;
      const callsign = (ac.flight || '').trim();
      const dir = getCardinalFromDeg(calcBearing(userConfig.lat, userConfig.lon, ac.lat, ac.lon));
      const altPart = (ac.alt_baro && Number.isFinite(Number(ac.alt_baro))) ? `, at ${spokenAlt(ac.alt_baro)}` : '';
      const text = `Rare aircraft spotted. ${rare.label}${callsign ? `, callsign ${callsign}` : ''}, ${spokenDist(dist)} to the ${dir}${altPart}.`;
      // Let the chime finish first. cancel() clears a stuck queue - see the keep-alive in startFeed().
      setTimeout(() => {
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
      }, 600);
    }

    function checkRareAircraft(acList) {
      if (!settings.rareAlerts) return;
      (acList || []).forEach((ac) => {
        if (!ac || !ac.hex || !Number.isFinite(ac.lat) || !Number.isFinite(ac.lon)) return;
        const rare = classifyRare(ac);
        if (!rare) return;
        const dist = calcDistanceNM(userConfig.lat, userConfig.lon, ac.lat, ac.lon);
        if (dist > userConfig.radiusNM) return;
        const last = rareAnnouncedAt.get(ac.hex);
        if (last !== undefined && Date.now() - last < RARE_REPEAT_COOLDOWN_MS) return;
        rareAnnouncedAt.set(ac.hex, Date.now());
        announceRareAircraft(ac, rare, dist);
      });
    }

    // Test hook, same idea as triggerTestSquawk: triggerTestRare('A388') injects a fake rare
    // type; a 4-digit argument (e.g. '7003') injects an ordinary jet with that squawk instead.
    // Also: ?testrare=A388 in the URL, or press 8 once the feed has started.
    function triggerTestRare(arg) {
      arg = String(arg || 'A388').toUpperCase();
      const isSquawk = /^[0-7]{4}$/.test(arg);
      testAircraft = Object.assign(buildTestAircraft(isSquawk ? arg : '2000'), {
        flight: 'TESTRARE ', t: isSquawk ? 'B738' : arg, category: 'A5'
      });
      testAircraftExpiryAt = Date.now() + TEST_AIRCRAFT_TTL_MS;
      liveAircraft = liveAircraft.filter((a) => !a.hex || !a.hex.startsWith('TEST')).concat([testAircraft]);
      recomputeAircraftPixelCache();
      updateUIState(true);
    }
    window.triggerTestRare = triggerTestRare;

    // ---------------------------------------------------------------------
    // Shareable links
    // ---------------------------------------------------------------------
    // Builds a link to this site that carries the current setup: location (?pc=, unless the
    // "include my postcode" setting is off), any non-default settings, and optionally one aircraft
    // (?ac=<hex>) which the page selects as soon as it shows up in the feed. The location goes in
    // ?pc= rather than the older /radar/<postcode> path form because that path isn't a real file -
    // the server answers it with 404.html - whereas the query string always loads index.html.
    function buildShareLink(opts) {
      opts = opts || {};
      const q = new URLSearchParams();
      const pc = settings.shareLocation ? getCookie(POSTCODE_COOKIE) : null;
      if (pc) q.set('pc', pc);
      if (settings.speed !== SETTINGS_DEFAULTS.speed) q.set('spd', settings.speed);
      if (settings.alt !== SETTINGS_DEFAULTS.alt) q.set('alt', settings.alt);
      if (settings.dist !== SETTINGS_DEFAULTS.dist) q.set('dst', settings.dist);
      if (settings.theme !== SETTINGS_DEFAULTS.theme) q.set('theme', settings.theme);
      if (settings.rareAlerts !== SETTINGS_DEFAULTS.rareAlerts) q.set('rare', settings.rareAlerts ? '1' : '0');
      if (opts.hex && /^[0-9a-f]{6}$/i.test(String(opts.hex))) q.set('ac', String(opts.hex).toLowerCase());
      let basePath = window.location.pathname;
      const radarIdx = basePath.toLowerCase().indexOf('/radar/');
      basePath = radarIdx !== -1 ? basePath.slice(0, radarIdx + 1) : basePath.replace(/[^/]*$/, '');
      const qs = q.toString();
      return `${window.location.origin}${basePath}${qs ? `?${qs}` : ''}`;
    }

    // ?ac=<hex> from a shared link: select that aircraft once it appears in the feed. Gives up
    // after a few minutes so a plane that has long since left doesn't keep the check running.
    const linkedAircraftHexParam = new URLSearchParams(window.location.search).get('ac');
    let linkedAircraftPending = (linkedAircraftHexParam && /^[0-9a-f]{6}$/i.test(linkedAircraftHexParam))
      ? linkedAircraftHexParam.toLowerCase() : null;
    const linkedAircraftDeadline = Date.now() + 5 * 60 * 1000;
    function checkLinkedAircraft() {
      if (!linkedAircraftPending) return;
      const ac = liveAircraft.find((a) => String(a.hex).toLowerCase() === linkedAircraftPending);
      if (ac) {
        linkedAircraftPending = null;
        selectAircraft(ac);
      } else if (Date.now() > linkedAircraftDeadline) {
        linkedAircraftPending = null;
      }
    }

    async function copyText(text) {
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch (e) { /* fall through to the textarea route */ }
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px;';
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, text.length);
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
      } catch (e) {
        return false;
      }
    }

    // ---------------------------------------------------------------------
    // Share an aircraft (image + link)
    // ---------------------------------------------------------------------
    // The photo, loaded with CORS so it can be drawn onto the canvas without tainting it (a
    // tainted canvas can't be exported). Null when there's no photo or its host doesn't allow it -
    // the card then gets a radar motif instead.
    let sharePhotoImg = null;
    let shareStatusTimer = null;

    function loadShareImage(url) {
      return new Promise((resolve) => {
        if (!url) { resolve(null); return; }
        const img = new Image();
        img.crossOrigin = 'anonymous';
        const timer = setTimeout(() => resolve(null), 6000);
        img.onload = () => { clearTimeout(timer); resolve(img.naturalWidth ? img : null); };
        img.onerror = () => { clearTimeout(timer); resolve(null); };
        img.src = url;
      });
    }

    function setShareStatus(text) {
      const el = document.getElementById('ad-share-status');
      if (!el) return;
      el.textContent = text || '';
      clearTimeout(shareStatusTimer);
      if (text) shareStatusTimer = setTimeout(() => { el.textContent = ''; }, 5000);
    }

    function cardRoundRect(g, x, y, w, h, r) {
      g.beginPath();
      g.moveTo(x + r, y);
      g.arcTo(x + w, y, x + w, y + h, r);
      g.arcTo(x + w, y + h, x, y + h, r);
      g.arcTo(x, y + h, x, y, r);
      g.arcTo(x, y, x + w, y, r);
      g.closePath();
    }

    // Draws the 1080x1350 share picture for an aircraft from its current data.
    function drawAircraftShareCard(ac, photoImg) {
      const W = 1080, H = 1350, PAD = 64;
      const t = currentTheme();
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const g = c.getContext('2d');
      const font = (px, weight) => `${weight || 400} ${px}px system-ui, -apple-system, "Segoe UI", sans-serif`;
      const fit = (text, maxW, startPx, weight) => {
        let px = startPx;
        g.font = font(px, weight);
        while (px > 22 && g.measureText(text).width > maxW) { px -= 2; g.font = font(px, weight); }
        return px;
      };

      const bg = g.createLinearGradient(0, 0, 0, H);
      bg.addColorStop(0, t.bg);
      bg.addColorStop(1, '#000000');
      g.fillStyle = bg;
      g.fillRect(0, 0, W, H);
      g.strokeStyle = accentRgba(0.55);
      g.lineWidth = 4;
      cardRoundRect(g, 24, 24, W - 48, H - 48, 28);
      g.stroke();

      g.textBaseline = 'alphabetic';
      g.fillStyle = t.accent;
      g.font = font(34, 700);
      g.fillText('AERO SENTRY', PAD, 104);
      g.fillStyle = t.dim;
      g.font = font(30);
      g.textAlign = 'right';
      g.fillText(new Date().toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }), W - PAD, 104);
      g.textAlign = 'left';

      // Photo (cover-cropped), or a radar motif when there isn't one.
      const px = PAD, py = 136, pw = W - PAD * 2, ph = 460;
      g.save();
      cardRoundRect(g, px, py, pw, ph, 24);
      g.clip();
      if (photoImg) {
        const scale = Math.max(pw / photoImg.naturalWidth, ph / photoImg.naturalHeight);
        const dw = photoImg.naturalWidth * scale, dh = photoImg.naturalHeight * scale;
        g.drawImage(photoImg, px + (pw - dw) / 2, py + (ph - dh) / 2, dw, dh);
      } else {
        g.fillStyle = t.card;
        g.fillRect(px, py, pw, ph);
        const cx = px + pw / 2, cy = py + ph / 2;
        g.strokeStyle = accentRgba(0.28);
        g.lineWidth = 2;
        [70, 140, 210].forEach((r) => { g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke(); });
        g.beginPath();
        g.moveTo(cx - 240, cy); g.lineTo(cx + 240, cy);
        g.moveTo(cx, cy - 215); g.lineTo(cx, cy + 215);
        g.stroke();
        g.fillStyle = t.accent;
        g.textAlign = 'center';
        g.font = font(120, 700);
        g.fillText('\u2708\uFE0E', cx, cy + 40);
        g.textAlign = 'left';
      }
      g.restore();
      g.strokeStyle = t.border;
      g.lineWidth = 3;
      cardRoundRect(g, px, py, pw, ph, 24);
      g.stroke();

      // Identity
      const callsign = (ac.flight || '').trim() || String(ac.hex).toUpperCase();
      g.fillStyle = t.accent;
      fit(callsign, W - PAD * 2, 128, 700);
      g.fillText(callsign, PAD, 730);
      g.fillStyle = t.dim;
      g.font = font(36);
      g.fillText([(ac.r || '').trim(), (ac.t || '').trim(), `ICAO ${String(ac.hex).toUpperCase()}`].filter(Boolean).join(' · '), PAD, 782);

      // Tags: rare / special squawk
      const tags = [];
      const rare = classifyRare(ac);
      if (rare) tags.push({ text: `\u2605 RARE · ${rare.label.toUpperCase()}`, color: '#ffb000' });
      const decoded = describeSquawk(ac.squawk);
      if (decoded && decoded.kind !== 'info') tags.push({ text: `${ac.squawk} · ${decoded.short}`, color: decoded.kind === 'alert' ? '#ff3333' : t.accent });
      let tx = PAD;
      tags.forEach((tag) => {
        g.font = font(28, 700);
        const tw = g.measureText(tag.text).width + 40;
        if (tx + tw > W - PAD) return;
        g.strokeStyle = tag.color;
        g.lineWidth = 3;
        cardRoundRect(g, tx, 812, tw, 52, 26);
        g.stroke();
        g.fillStyle = tag.color;
        g.fillText(tag.text, tx + 20, 848);
        tx += tw + 16;
      });

      // Route
      const route = resolveFlightRoute((ac.flight || '').trim() || `ICAO: ${ac.hex}`, ac);
      if (route) {
        g.fillStyle = '#f2f7f4';
        const routeText = `${route.fromCode} \u2192 ${route.toCode}`;
        fit(routeText, W - PAD * 2, 76, 700);
        g.fillText(routeText, PAD, 934);
        g.fillStyle = t.dim;
        const names = `${route.fromName || airportName(route.fromCode) || ''} \u2192 ${route.toName || airportName(route.toCode) || ''}`.trim();
        fit(names, W - PAD * 2, 30);
        g.fillText(names, PAD, 976);
      } else {
        g.fillStyle = t.dim;
        g.font = font(34);
        g.fillText('No verified route', PAD, 934);
      }

      // Stats
      const hasPos = Number.isFinite(ac.lat) && Number.isFinite(ac.lon);
      const vs = ac.baro_rate;
      const stats = [
        ['Altitude', typeof ac.alt_baro === 'number' ? fmtAlt(ac.alt_baro) : (ac.alt_baro === 'ground' ? 'On ground' : '--')],
        ['Speed', Number.isFinite(ac.gs) ? fmtSpeed(ac.gs) : '--'],
        ['Distance', hasPos ? fmtDist(calcDistanceNM(userConfig.lat, userConfig.lon, ac.lat, ac.lon)) : '--'],
        ['Heading', Number.isFinite(ac.track) ? `${Math.round(ac.track)}\u00B0 ${getCardinalFromDeg(ac.track)}` : '--'],
        ['Vertical', !Number.isFinite(vs) ? '--' : (vs > 30 ? `\u25B2 ${fmtVRate(vs)}` : (vs < -30 ? `\u25BC ${fmtVRate(vs)}` : 'Level'))],
        ['Squawk', ac.squawk ? String(ac.squawk) : '--']
      ];
      const gap = 24, cw = (W - PAD * 2 - gap * 2) / 3, ch = 112, gy = 1004;
      stats.forEach(([label, value], i) => {
        const x = PAD + (i % 3) * (cw + gap);
        const y = gy + Math.floor(i / 3) * (ch + gap);
        g.fillStyle = t.tint;
        cardRoundRect(g, x, y, cw, ch, 16);
        g.fill();
        g.strokeStyle = t.border;
        g.lineWidth = 2;
        cardRoundRect(g, x, y, cw, ch, 16);
        g.stroke();
        g.fillStyle = t.dim;
        g.font = font(22, 600);
        g.fillText(label.toUpperCase(), x + 20, y + 38);
        g.fillStyle = t.accent;
        fit(value, cw - 40, 40, 700);
        g.fillText(value, x + 20, y + 90);
      });

      g.fillStyle = t.dim;
      g.font = font(28);
      g.textAlign = 'center';
      g.fillText(`${window.location.host || 'aero-sentry'} · live ADS-B radar`, W / 2, H - 46);
      g.textAlign = 'left';
      return c;
    }

    function canvasToBlob(canvas) {
      return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'));
    }

    function aircraftShareText(ac) {
      const callsign = (ac.flight || '').trim() || String(ac.hex).toUpperCase();
      const bits = [];
      if ((ac.t || '').trim()) bits.push((ac.t || '').trim());
      if (Number.isFinite(ac.lat) && Number.isFinite(ac.lon)) bits.push(`${fmtDist(calcDistanceNM(userConfig.lat, userConfig.lon, ac.lat, ac.lon))} away`);
      if (typeof ac.alt_baro === 'number') bits.push(`at ${fmtAlt(ac.alt_baro)}`);
      return `Spotted ${callsign}${bits.length ? ` (${bits.join(', ')})` : ''} on Aero Sentry`;
    }

    // Share sheet with the picture + link where the browser supports sharing files (iOS, Android),
    // link-only share sheet where it doesn't, and a plain copy-to-clipboard as the desktop fallback.
    // The picture is drawn synchronously from cached data so the tap's "user gesture" is still
    // valid when navigator.share() is called - browsers reject share() after a long await.
    async function shareSelectedAircraft() {
      const ac = selectedSnapshot;
      if (!ac) return;
      const url = buildShareLink({ hex: ac.hex });
      const text = aircraftShareText(ac);
      const callsign = ((ac.flight || '').trim() || String(ac.hex)).replace(/[^A-Za-z0-9_-]/g, '') || 'aircraft';
      let file = null;
      try {
        const blob = await canvasToBlob(drawAircraftShareCard(ac, sharePhotoImg));
        if (blob) file = new File([blob], `${callsign}.png`, { type: 'image/png' });
      } catch (e) { file = null; }
      try {
        if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: text, text: `${text}\n${url}` });
          return;
        }
        if (navigator.share) {
          await navigator.share({ title: text, text, url });
          return;
        }
      } catch (err) {
        if (err && err.name === 'AbortError') return; // they closed the share sheet
        console.warn('[SHARE] share sheet failed, falling back to copy:', err);
      }
      setShareStatus((await copyText(url)) ? 'Link copied' : 'Could not copy the link');
    }

    async function copySelectedAircraftLink() {
      const ac = selectedSnapshot;
      if (!ac) return;
      const url = buildShareLink({ hex: ac.hex });
      if (await copyText(url)) setShareStatus('Link copied');
      else window.prompt('Copy this link', url);
    }

    function adEl(tag, className, text) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined && text !== null) node.textContent = text;
      return node;
    }

    function adSetText(id, text) {
      const node = document.getElementById(id);
      if (node) node.textContent = text;
    }

    function adStat(label, valueText, valueClass) {
      const cell = adEl('div', 'ad-stat');
      cell.appendChild(adEl('div', 'ad-stat-label', label));
      cell.appendChild(adEl('div', valueClass ? `ad-stat-value ${valueClass}` : 'ad-stat-value', valueText));
      return cell;
    }

    // Nearest aircraft to a point in scope pixels, within tolPx. The callsign label is a much
    // easier target than the blip itself (especially on a phone), so a tap inside it counts too -
    // ranked just behind a tap landing directly on a blip.
    function findAircraftAtPoint(x, y, tolPx) {
      let best = null;
      let bestDist = Infinity;
      for (const ac of liveAircraft) {
        if (!ac.hex || !ac.__pt) continue;
        let d = Math.hypot(ac.__pt.x - x, ac.__pt.y - y);
        const box = ac.__labelBox;
        if (box && x >= box.x - 3 && x <= box.x + box.w + 3 && y >= box.y - 3 && y <= box.y + box.h + 3) {
          d = Math.min(d, tolPx * 0.75);
        }
        if (d <= tolPx && d < bestDist) { best = ac; bestDist = d; }
      }
      return best;
    }

    function handleScopeClick(e) {
      // Clicks inside the panel itself bubble up to the scope - they're not scope taps. Use the
      // event's path (fixed when the click was dispatched) rather than e.target.closest(): a
      // button like "Try again" re-renders the panel from its own click handler, which detaches
      // it from the DOM before the event gets here, and closest() would then find nothing.
      const panelEl = document.getElementById('aircraft-detail');
      const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
      if (panelEl && (path.includes(panelEl) || (e.target && e.target.closest && e.target.closest('#aircraft-detail')))) return;
      const container = document.getElementById('radarContainer');
      if (!container) return;
      // getBoundingClientRect() already includes the burn-in shield's pixel shift (a translate).
      const rect = container.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
      const tol = Math.max(coarse ? 28 : 16, (coarse ? 22 : 12) * uiScale);
      const hit = findAircraftAtPoint(x, y, tol);
      if (!hit) { deselectAircraft(); return; }
      if (hit.hex === selectedHex) { resetAircraftDetailIdleTimer(); return; }
      selectAircraft(hit);
    }

    function resetAircraftDetailIdleTimer() {
      clearTimeout(aircraftDetailIdleTimer);
      aircraftDetailIdleTimer = setTimeout(deselectAircraft, AIRCRAFT_DETAIL_IDLE_MS);
    }

    function selectAircraft(ac) {
      selectedHex = ac.hex;
      selectedSnapshot = ac;
      selectedLostSince = 0;
      sharePhotoImg = null;
      buildAircraftDetailPanel(ac);
      renderAircraftDetailLive();
      resetAircraftDetailIdleTimer();

      // The route APIs are normally only queried for the scrollboard's target aircraft; look this
      // one up too. Cached, and a no-op for aircraft without a usable callsign.
      fetchRoutesForAircraft([ac])
        .then(() => { if (selectedHex === ac.hex) renderAircraftDetailLive(); })
        .catch((err) => console.warn('[DETAIL] route lookup failed:', err));
      resolveAircraftPhoto(ac)
        .then((url) => {
          if (selectedHex !== ac.hex) return null;
          setAircraftDetailPhoto(url);
          return loadShareImage(url);
        })
        .then((img) => { if (img && selectedHex === ac.hex) sharePhotoImg = img; })
        .catch(() => {});

      loadAircraftProfile(ac, false);
      renderAircraftDetailProfile();
    }

    function deselectAircraft() {
      if (!selectedHex) return;
      selectedHex = null;
      selectedSnapshot = null;
      selectedLostSince = 0;
      sharePhotoImg = null;
      clearTimeout(aircraftDetailIdleTimer);
      const panel = document.getElementById('aircraft-detail');
      if (panel) { panel.classList.add('hidden'); panel.textContent = ''; }
    }

    // Called after every successful poll (see updateUIState).
    function refreshAircraftDetail() {
      if (!selectedHex) return;
      const live = liveAircraft.find((a) => a.hex === selectedHex);
      if (live) {
        selectedSnapshot = live;
        selectedLostSince = 0;
      } else {
        if (!selectedLostSince) selectedLostSince = Date.now();
        if (Date.now() - selectedLostSince > AIRCRAFT_DETAIL_LOST_MS) { deselectAircraft(); return; }
      }
      renderAircraftDetailLive();
    }

    function buildAircraftDetailPanel(ac) {
      const panel = document.getElementById('aircraft-detail');
      if (!panel) return;
      panel.textContent = '';

      // Put the panel on the side of the scope away from the aircraft, so it doesn't cover
      // what was just tapped. Decided once per selection so it doesn't jump around as the
      // aircraft moves.
      const portrait = !!(window.matchMedia && window.matchMedia('(max-width: 1100px) and (orientation: portrait)').matches);
      const pt = ac.__pt;
      if (portrait) panel.dataset.side = pt && pt.y > viewH / 2 ? 'top' : 'bottom';
      else panel.dataset.side = pt && pt.x > viewW / 2 ? 'left' : 'right';

      // AI overview goes first - the very top of the panel, above the header/close button and
      // everything else - so it's the first thing visible rather than something you have to
      // scroll past the stats/route to find.
      const profile = adEl('div', 'ad-section ad-profile');
      profile.id = 'ad-profile';
      panel.appendChild(profile);

      const head = adEl('div', 'ad-head');
      const titles = adEl('div', 'ad-titles');
      const callsign = adEl('div', 'ad-callsign');
      callsign.id = 'ad-callsign';
      const sub = adEl('div', 'ad-sub');
      sub.id = 'ad-sub';
      const tags = adEl('div', 'ad-tags');
      tags.id = 'ad-tags';
      tags.hidden = true;
      titles.appendChild(callsign);
      titles.appendChild(sub);
      titles.appendChild(tags);
      const close = adEl('button', 'ad-close', '✕');
      close.type = 'button';
      close.setAttribute('aria-label', 'Close aircraft details');
      close.addEventListener('click', deselectAircraft);
      head.appendChild(titles);
      head.appendChild(close);
      panel.appendChild(head);

      const actions = adEl('div', 'ad-actions');
      const shareBtn = adEl('button', 'ad-btn', '⤴ Share');
      shareBtn.type = 'button';
      shareBtn.addEventListener('click', () => { resetAircraftDetailIdleTimer(); shareSelectedAircraft(); });
      const copyBtn = adEl('button', 'ad-btn', '🔗 Copy link');
      copyBtn.type = 'button';
      copyBtn.addEventListener('click', () => { resetAircraftDetailIdleTimer(); copySelectedAircraftLink(); });
      actions.appendChild(shareBtn);
      actions.appendChild(copyBtn);
      panel.appendChild(actions);
      const shareStatus = adEl('div', 'ad-fine');
      shareStatus.id = 'ad-share-status';
      shareStatus.setAttribute('aria-live', 'polite');
      panel.appendChild(shareStatus);

      const photo = adEl('div', 'ad-photo');
      photo.id = 'ad-photo';
      photo.hidden = true;
      panel.appendChild(photo);

      const lost = adEl('div', 'ad-lost');
      lost.id = 'ad-lost';
      lost.hidden = true;
      panel.appendChild(lost);

      const live = adEl('div', 'ad-live');
      live.id = 'ad-live';
      panel.appendChild(live);

      const route = adEl('div', 'ad-section ad-route');
      route.id = 'ad-route';
      panel.appendChild(route);

      panel.classList.remove('hidden');
    }

    function setAircraftDetailPhoto(url) {
      const box = document.getElementById('ad-photo');
      if (!box) return;
      box.textContent = '';
      if (url && /^https:\/\//i.test(url)) {
        const img = document.createElement('img');
        img.alt = 'Aircraft photo';
        img.referrerPolicy = 'no-referrer';
        img.src = url;
        box.appendChild(img);
        box.hidden = false;
      } else {
        box.hidden = true;
      }
    }

    function renderAircraftDetailLive() {
      const ac = selectedSnapshot;
      const panel = document.getElementById('aircraft-detail');
      if (!ac || !panel || panel.classList.contains('hidden')) return;

      const callsign = (ac.flight || '').trim();
      const reg = (ac.r || '').trim();
      const type = (ac.t || '').trim();
      const isAlert = isAlertSquawk(ac);
      const title = document.getElementById('ad-callsign');
      if (title) {
        title.textContent = callsign || String(ac.hex).toUpperCase();
        title.classList.toggle('alert', isAlert);
      }
      adSetText('ad-sub', [reg, type, `ICAO ${String(ac.hex).toUpperCase()}`].filter(Boolean).join(' · '));

      const tagsEl = document.getElementById('ad-tags');
      if (tagsEl) {
        tagsEl.textContent = '';
        const rare = classifyRare(ac);
        if (rare) tagsEl.appendChild(adEl('span', 'ad-tag rare', `★ Rare · ${rare.label}`));
        const decodedTag = describeSquawk(ac.squawk);
        if (decodedTag && decodedTag.kind === 'notable') tagsEl.appendChild(adEl('span', 'ad-tag', `${ac.squawk} · ${decodedTag.short}`));
        tagsEl.hidden = !tagsEl.childNodes.length;
      }

      const live = document.getElementById('ad-live');
      if (live) {
        live.textContent = '';
        // Real registry data for this specific airframe (when adsb.fi's feed has it) - not an
        // AI guess. The Gemini profile below only ever describes the aircraft TYPE (and is
        // cached per-type across every airframe of that type), so an individual tail number's
        // build year has to come from here, from the feed itself, or not be shown at all.
        const yearBuilt = Number(ac.year);
        if (Number.isInteger(yearBuilt) && yearBuilt >= 1900 && yearBuilt <= new Date().getFullYear()) {
          const age = new Date().getFullYear() - yearBuilt;
          live.appendChild(adStat('Age', `${age} yr${age === 1 ? '' : 's'} · built ${yearBuilt}`, null));
        }
        const hasPos = Number.isFinite(ac.lat) && Number.isFinite(ac.lon);
        if (hasPos) {
          const dist = calcDistanceNM(userConfig.lat, userConfig.lon, ac.lat, ac.lon);
          const brg = calcBearing(userConfig.lat, userConfig.lon, ac.lat, ac.lon);
          live.appendChild(adStat('Distance', fmtDist(dist), null));
          live.appendChild(adStat('Bearing', `${brg}° ${getCardinalFromDeg(brg)}`, null));
        }
        const alt = ac.alt_baro;
        live.appendChild(adStat('Altitude', typeof alt === 'number' ? fmtAlt(alt) : (alt === 'ground' ? 'On ground' : '--'), null));
        live.appendChild(adStat('Speed', Number.isFinite(ac.gs) ? fmtSpeedBoth(ac.gs) : '--', null));
        live.appendChild(adStat('Heading', Number.isFinite(ac.track) ? `${Math.round(ac.track)}° ${getCardinalFromDeg(ac.track)}` : '--', null));
        const vs = ac.baro_rate;
        if (Number.isFinite(vs) && vs > 30) live.appendChild(adStat('Vertical', `▲ +${fmtVRate(vs)}`, 'up'));
        else if (Number.isFinite(vs) && vs < -30) live.appendChild(adStat('Vertical', `▼ -${fmtVRate(vs)}`, 'down'));
        else live.appendChild(adStat('Vertical', Number.isFinite(vs) ? 'Level' : '--', null));
        const squawk = ac.squawk ? String(ac.squawk) : '';
        const decoded = squawk ? describeSquawk(squawk) : null;
        live.appendChild(adStat('Squawk', squawk ? (decoded ? `${squawk} · ${decoded.short}` : squawk) : '--', isAlert ? 'alert' : null));
        if (decoded && decoded.long && decoded.kind !== 'alert') live.appendChild(adEl('div', 'ad-note', decoded.long));
      }

      renderAircraftDetailRoute(ac, callsign);
    }

    function renderAircraftDetailRoute(ac, callsign) {
      const box = document.getElementById('ad-route');
      if (!box) return;
      box.textContent = '';
      box.appendChild(adEl('div', 'ad-section-title', 'Route'));

      const addRow = (label, text) => {
        const row = adEl('div', 'ad-route-row');
        row.appendChild(adEl('span', 'ad-route-label', label));
        row.appendChild(adEl('span', 'ad-route-value', text));
        box.appendChild(row);
      };

      const override = REGISTRATION_OVERRIDES[(ac.r || '').trim().toUpperCase()];
      if (override && override.route) {
        addRow('From', override.route.from);
        addRow('To', override.route.to);
        return;
      }

      const route = resolveFlightRoute(callsign || `ICAO: ${ac.hex}`, ac);
      if (route) {
        addRow('From', `${route.fromCode} - ${route.fromName || airportName(route.fromCode) || 'Aerodrome'}`);
        addRow('To', `${route.toCode} - ${route.toName || airportName(route.toCode) || 'Aerodrome'}`);
        const tag = route.source === 'opensky' ? 'Track-derived estimate, not a verified schedule'
          : `Verified route data (${route.source === 'hexdb' ? 'hexdb' : route.source})`;
        box.appendChild(adEl('div', 'ad-fine', tag));
        return;
      }

      const looking = /^[A-Z0-9]{3,8}$/.test(callsign.toUpperCase()) && routeCache[routeCacheKey(ac)] === undefined;
      box.appendChild(adEl('div', 'ad-dim', looking ? 'Looking up route…' : 'No verified route available'));
    }

    // Only the fields the backend whitelists. The backend builds the actual prompt itself.
    function buildAircraftInfoPayload(ac) {
      const str = (v) => (typeof v === 'string' ? v.trim() : '');
      const payload = { hex: str(ac.hex) };
      ['flight', 'r', 't', 'desc', 'ownOp', 'category'].forEach((k) => { const v = str(ac[k]); if (v) payload[k] = v; });
      if (ac.year !== undefined && ac.year !== null && ac.year !== '') payload.year = ac.year;
      return payload;
    }

    function aircraftProfileErrorState(status, code) {
      switch (code) {
        case 'not_configured': return { message: "Aircraft profiles aren't set up on this server yet.", retryable: false };
        case 'daily_limit': return { message: 'The daily limit for AI lookups has been reached. Try again tomorrow.', retryable: false };
        case 'rate_limited': return { message: 'Too many lookups just now - wait a minute and try again.', retryable: true };
        case 'ai_busy': return { message: 'Gemini is busy right now. Try again shortly.', retryable: true };
        case 'ai_timeout': return { message: 'Gemini took too long to answer.', retryable: true };
        case 'insufficient_data': return { message: "This aircraft isn't broadcasting enough (no type, registration or callsign) to look up.", retryable: false };
        default: return { message: "Couldn't get an aircraft profile right now.", retryable: true };
      }
    }

    async function loadAircraftProfile(ac, force) {
      const hex = ac.hex;
      const existing = aircraftProfileState[hex];
      if (!force && existing && existing.status !== 'error') return;

      // Simulated / injected contacts (TEST..., UFO..., SIM...) and TIS-B targets ("~...") have no
      // real ICAO address; there's nothing true to say about them.
      if (!/^[0-9A-Fa-f]{6}$/.test(hex || '')) {
        aircraftProfileState[hex] = { status: 'unavailable', message: 'No profile for simulated or non-ICAO contacts.' };
        return;
      }
      const payload = buildAircraftInfoPayload(ac);
      if (!payload.flight && !payload.r && !payload.t && !payload.desc) {
        aircraftProfileState[hex] = { status: 'unavailable', message: "This aircraft isn't broadcasting a type, registration or callsign, so there's nothing to look up." };
        return;
      }

      aircraftProfileState[hex] = { status: 'loading' };
      if (selectedHex === hex) renderAircraftDetailProfile();
      try {
        const res = await fetchWithTimeout(`${WORKER_URL}${AIRCRAFT_INFO_PATH_CLIENT}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify(payload)
        }, AIRCRAFT_INFO_TIMEOUT_MS);
        let data = null;
        try { data = await res.json(); } catch (parseErr) { /* non-JSON error page etc. */ }
        if (res.ok && data && data.ok === true) {
          aircraftProfileState[hex] = { status: 'ok', info: data.info || null, model: data.model || '' };
        } else {
          const code = data && data.error;
          const mapped = aircraftProfileErrorState(res.status, code);
          aircraftProfileState[hex] = { status: code === 'insufficient_data' ? 'unavailable' : 'error', message: mapped.message, retryable: mapped.retryable };
        }
      } catch (err) {
        const timedOut = err && err.name === 'AbortError';
        aircraftProfileState[hex] = { status: 'error', message: timedOut ? 'Gemini took too long to answer.' : "Couldn't reach the radar server.", retryable: true };
      }
      if (selectedHex === hex) renderAircraftDetailProfile();
    }

    function renderAircraftDetailProfile() {
      const box = document.getElementById('ad-profile');
      if (!box || !selectedHex) return;
      box.textContent = '';
      // Reset from any previous aircraft's confidence colouring - re-applied below once (and
      // only once) a real confidence value is known for this one.
      box.classList.remove('conf-high', 'conf-medium', 'conf-low');

      const title = adEl('div', 'ad-section-title');
      title.appendChild(adEl('span', null, 'Aircraft profile'));
      title.appendChild(adEl('span', 'ad-ai-badge', 'AI'));
      box.appendChild(title);

      const st = aircraftProfileState[selectedHex];
      if (!st || st.status === 'loading') {
        const skel = adEl('div', 'ad-skeleton');
        skel.appendChild(adEl('div', 'ad-skel-line w60'));
        skel.appendChild(adEl('div', 'ad-skel-line w90'));
        skel.appendChild(adEl('div', 'ad-skel-line w75'));
        box.appendChild(skel);
        box.appendChild(adEl('div', 'ad-dim', 'Asking Gemini…'));
        return;
      }
      if (st.status === 'unavailable' || st.status === 'error') {
        box.appendChild(adEl('div', 'ad-dim', st.message));
        if (st.status === 'error' && st.retryable) {
          const retry = adEl('button', 'ad-retry', 'Try again');
          retry.type = 'button';
          retry.addEventListener('click', () => { if (selectedSnapshot) loadAircraftProfile(selectedSnapshot, true); });
          box.appendChild(retry);
        }
        return;
      }

      const info = st.info;
      if (!info || typeof info !== 'object') {
        box.appendChild(adEl('div', 'ad-dim', 'No reliable details found for this aircraft.'));
        return;
      }

      // Defensive even though the server validates: only ever render strings/finite numbers.
      const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
      const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

      const name = str(info.aircraft_name);
      const maker = str(info.manufacturer);
      if (name) box.appendChild(adEl('div', 'ad-type-name', name));
      const chips = adEl('div', 'ad-chips');
      const catLabel = AIRCRAFT_CATEGORY_LABELS[info.category];
      if (catLabel) chips.appendChild(adEl('span', 'ad-chip', catLabel));
      if (maker && (!name || !name.toLowerCase().includes(maker.toLowerCase()))) chips.appendChild(adEl('span', 'ad-chip', maker));
      if (chips.childNodes.length) box.appendChild(chips);

      const operator = str(info.operator);
      if (operator) {
        const row = adEl('div', 'ad-route-row');
        row.appendChild(adEl('span', 'ad-route-label', 'Operator'));
        row.appendChild(adEl('span', 'ad-route-value', operator));
        box.appendChild(row);
      }

      const summary = str(info.summary);
      if (summary) box.appendChild(adEl('p', 'ad-summary', summary));

      const specs = [];
      if (str(info.engines)) specs.push(['Engines', str(info.engines)]);
      if (str(info.typical_capacity)) specs.push(['Capacity', str(info.typical_capacity)]);
      if (num(info.cruise_speed_kts) !== null) specs.push(['Cruise', fmtSpeed(num(info.cruise_speed_kts))]);
      if (num(info.range_nm) !== null) specs.push(['Range', fmtDist(num(info.range_nm), 0)]);
      if (num(info.service_ceiling_ft) !== null) specs.push(['Ceiling', fmtAlt(num(info.service_ceiling_ft))]);
      if (num(info.introduced_year) !== null) specs.push(['Introduced', String(num(info.introduced_year))]);
      if (specs.length) {
        const grid = adEl('div', 'ad-specs');
        specs.forEach(([label, value]) => grid.appendChild(adStat(label, value, null)));
        box.appendChild(grid);
      }

      const facts = Array.isArray(info.notable_facts) ? info.notable_facts.map(str).filter(Boolean).slice(0, 3) : [];
      if (facts.length) {
        const list = adEl('ul', 'ad-facts');
        facts.forEach((f) => list.appendChild(adEl('li', null, f)));
        box.appendChild(list);
      }

      const conf = ['high', 'medium', 'low'].includes(info.confidence) ? info.confidence : 'low';
      // Surface confidence at a glance, not just in the fine print below: a colour on the
      // section's own left border, and a matching dot right next to the "AI" badge at the top.
      box.classList.add(`conf-${conf}`);
      title.appendChild(adEl('span', `ad-conf-dot ${conf}`));
      const foot = adEl('div', 'ad-fine');
      const confBadge = adEl('span', `ad-conf ${conf}`, `${conf} confidence`);
      foot.appendChild(confBadge);
      foot.appendChild(document.createTextNode(' · AI-generated by Gemini, so double-check anything important.'));
      box.appendChild(foot);
    }

    // --- Daily AI summary panel -------------------------------------------------------------
    // Same POST /api/aircraft-info style backend contract as the per-aircraft profile above,
    // but hitting /api/daily-summary with today's aggregate sightings log (see
    // recordDailyLogEntries) instead of one aircraft's identity. Cached client-side per local
    // day too, so re-opening the panel later the same day doesn't re-request anything.
    const DAILY_SUMMARY_PATH_CLIENT = '/api/daily-summary';
    const DAILY_SUMMARY_CACHE_PREFIX = 'radarDailySummary:';
    const DAILY_SUMMARY_TIMEOUT_MS = 25000;
    let dailySummaryLoading = false;

    function loadCachedDailySummary() {
      try {
        const raw = localStorage.getItem(DAILY_SUMMARY_CACHE_PREFIX + todayLocalKey());
        return raw ? JSON.parse(raw) : null;
      } catch { return null; }
    }
    function saveCachedDailySummary(summary) {
      try { localStorage.setItem(DAILY_SUMMARY_CACHE_PREFIX + todayLocalKey(), JSON.stringify(summary)); } catch { /* ignore */ }
    }

    function openDailySummaryPanel() {
      const panel = document.getElementById('daily-summary-panel');
      if (!panel) return;
      panel.classList.remove('hidden');
      renderDailySummaryPanel();
    }
    function closeDailySummaryPanel() {
      const panel = document.getElementById('daily-summary-panel');
      if (panel) panel.classList.add('hidden');
    }

    function renderDailySummaryPanel(state) {
      const panel = document.getElementById('daily-summary-panel');
      if (!panel || panel.classList.contains('hidden')) return;
      panel.textContent = '';

      const head = adEl('div', 'ad-head');
      const titles = adEl('div', 'ad-titles');
      titles.appendChild(adEl('div', 'ad-callsign', "Today's AI Summary"));
      titles.appendChild(adEl('div', 'ad-sub', todayLocalKey()));
      const close = adEl('button', 'ad-close', '✕');
      close.type = 'button';
      close.setAttribute('aria-label', 'Close daily summary');
      close.addEventListener('click', closeDailySummaryPanel);
      head.appendChild(titles);
      head.appendChild(close);
      panel.appendChild(head);

      const box = adEl('div', 'ad-section ad-profile');
      panel.appendChild(box);
      const title = adEl('div', 'ad-section-title');
      title.appendChild(adEl('span', null, "Today's traffic"));
      title.appendChild(adEl('span', 'ad-ai-badge', 'AI'));
      box.appendChild(title);

      if (dailySummaryLoading) {
        const skel = adEl('div', 'ad-skeleton');
        skel.appendChild(adEl('div', 'ad-skel-line w60'));
        skel.appendChild(adEl('div', 'ad-skel-line w90'));
        skel.appendChild(adEl('div', 'ad-skel-line w75'));
        box.appendChild(skel);
        box.appendChild(adEl('div', 'ad-dim', 'Asking Gemini…'));
        return;
      }

      if (state && state.error) {
        box.appendChild(adEl('div', 'ad-dim', state.error));
        const retry = adEl('button', 'ad-retry', 'Try again');
        retry.type = 'button';
        retry.addEventListener('click', () => requestDailySummary(true));
        box.appendChild(retry);
        return;
      }

      const cached = loadCachedDailySummary();
      if (!cached) {
        box.appendChild(adEl('div', 'ad-dim', "Ask Gemini for a recap of today's notable (military/alert) traffic."));
        const btn = adEl('button', 'ad-retry', 'Generate summary');
        btn.type = 'button';
        btn.addEventListener('click', () => requestDailySummary(false));
        box.appendChild(btn);
        return;
      }

      const summary = cached.summary || {};
      if (summary.headline) box.appendChild(adEl('div', 'ad-type-name', summary.headline));
      if (summary.summary) box.appendChild(adEl('p', 'ad-summary', summary.summary));
      const highlights = Array.isArray(summary.highlights) ? summary.highlights.filter(Boolean) : [];
      if (highlights.length) {
        const list = adEl('ul', 'ad-facts');
        highlights.forEach((h) => list.appendChild(adEl('li', null, h)));
        box.appendChild(list);
      }

      const refresh = adEl('button', 'ad-retry', 'Refresh');
      refresh.type = 'button';
      refresh.title = 'Re-ask Gemini (uses today\'s latest log)';
      refresh.addEventListener('click', () => requestDailySummary(true));
      box.appendChild(refresh);

      const foot = adEl('div', 'ad-fine', cached.cached === false ? 'AI-generated by Gemini, so double-check anything important.' : 'Cached earlier today · AI-generated by Gemini.');
      box.appendChild(foot);
    }

    async function requestDailySummary(force) {
      if (dailySummaryLoading) return;
      dailySummaryLoading = true;
      renderDailySummaryPanel();
      const entries = loadDailyLog();
      try {
        const res = await fetchWithTimeout(`${WORKER_URL}${DAILY_SUMMARY_PATH_CLIENT}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({ entries, force: !!force }),
        }, DAILY_SUMMARY_TIMEOUT_MS);
        let data = null;
        try { data = await res.json(); } catch { /* non-JSON error page etc */ }
        dailySummaryLoading = false;
        if (res.ok && data && data.ok === true) {
          saveCachedDailySummary({ summary: data.summary, cached: data.cached });
          renderDailySummaryPanel();
        } else {
          const messages = {
            not_configured: "Daily summaries aren't set up on this server yet.",
            rate_limited: 'Too many requests just now - wait a minute and try again.',
            ai_busy: 'Gemini is busy right now. Try again shortly.',
            ai_timeout: 'Gemini took too long to answer.',
            daily_limit: 'The daily AI limit has been reached. Try again tomorrow.',
          };
          renderDailySummaryPanel({ error: messages[data && data.error] || "Couldn't get a summary right now." });
        }
      } catch (err) {
        dailySummaryLoading = false;
        const timedOut = err && err.name === 'AbortError';
        renderDailySummaryPanel({ error: timedOut ? 'Gemini took too long to answer.' : "Couldn't reach the radar server." });
      }
    }

    const radarContainerEl = document.getElementById('radarContainer');
    if (radarContainerEl) radarContainerEl.addEventListener('click', handleScopeClick);
    const aircraftDetailEl = document.getElementById('aircraft-detail');
    if (aircraftDetailEl) aircraftDetailEl.addEventListener('pointerdown', resetAircraftDetailIdleTimer);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && selectedHex) deselectAircraft(); });

    document.getElementById('start-overlay').addEventListener('click', startFeed);
    document.getElementById('start-overlay').addEventListener('touchstart', startFeed);

    // Postcode-entry overlay: first-visit prompt (see resolveStationCoords/startFeed above) and
    // the corner "change location" button, both any time after that too.
    const postcodeForm = document.getElementById('postcode-form');
    if (postcodeForm) postcodeForm.addEventListener('submit', handlePostcodeSubmit);
    const postcodeCancelBtn = document.getElementById('postcode-cancel');
    if (postcodeCancelBtn) postcodeCancelBtn.addEventListener('click', hidePostcodeOverlay);
    document.addEventListener('keydown', (e) => {
      const overlay = document.getElementById('postcode-overlay');
      if (e.key === 'Escape' && overlay && !overlay.classList.contains('hidden') && !needsPostcodePrompt) hidePostcodeOverlay();
    });
    const postcodeChangeBtn = document.getElementById('postcode-change-btn');
    if (postcodeChangeBtn) {
      postcodeChangeBtn.addEventListener('click', () => { forcedReconsent = false; showPostcodeOverlay(getCookie(POSTCODE_COOKIE) || '', true); });
    }
    const dailySummaryBtn = document.getElementById('daily-summary-btn');
    if (dailySummaryBtn) dailySummaryBtn.addEventListener('click', openDailySummaryPanel);
    const dailySummaryPanelEl = document.getElementById('daily-summary-panel');
    if (dailySummaryPanelEl) {
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !dailySummaryPanelEl.classList.contains('hidden')) closeDailySummaryPanel();
      });
    }

    // ---------------------------------------------------------------------
    // Settings panel (the ⚙️ corner button)
    // ---------------------------------------------------------------------
    function updateRadiusTexts() {
      const title = document.getElementById('mil-panel-title');
      if (title) title.textContent = `Active Military Transponders Within ${fmtDist(userConfig.radiusNM, 0).replace(' ', '')}`;
    }

    // Re-renders everything that shows a unit or a theme colour right now, instead of waiting for
    // the next poll to catch up.
    function refreshForSettings() {
      applyTheme();
      updateRadiusTexts();
      buildAltitudeLegend();
      if (radarCircle) radarCircle.setStyle({ color: currentTheme().accent, fillColor: currentTheme().accent });
      if (!feedStarted) return;
      try {
        renderStaticScopeLayer();
        renderFlightBoard(liveAircraft);
        updateNearestScrollboard(liveAircraft);
        if (selectedHex) {
          renderAircraftDetailLive();
          renderAircraftDetailProfile();
        }
      } catch (err) {
        console.warn('[SETTINGS] refresh after a change failed:', err);
      }
    }

    function initSettingsPanel() {
      const btn = document.getElementById('settings-btn');
      const panel = document.getElementById('settings-panel');
      const backdrop = document.getElementById('settings-backdrop');
      const closeBtn = document.getElementById('settings-close');
      const statusEl = document.getElementById('settings-status');
      if (!btn || !panel || !backdrop || !closeBtn || !statusEl) return;

      let statusTimer = null;
      const say = (text) => {
        statusEl.textContent = text || '';
        clearTimeout(statusTimer);
        if (text) statusTimer = setTimeout(() => { statusEl.textContent = ''; }, 4000);
      };

      function syncControls() {
        panel.querySelectorAll('[data-setting]').forEach((seg) => {
          seg.querySelectorAll('button[data-value]').forEach((b) => {
            const on = b.dataset.value === settings[seg.dataset.setting];
            b.classList.toggle('active', on);
            b.setAttribute('aria-pressed', on ? 'true' : 'false');
          });
        });
        panel.querySelectorAll('input[data-toggle]').forEach((cb) => { cb.checked = !!settings[cb.dataset.toggle]; });
      }
      function openPanel() {
        syncControls();
        say('');
        backdrop.hidden = false;
        panel.hidden = false;
        settingsOpen = true;
      }
      function closePanel() {
        panel.hidden = true;
        backdrop.hidden = true;
        settingsOpen = false;
      }

      btn.addEventListener('click', () => (settingsOpen ? closePanel() : openPanel()));
      closeBtn.addEventListener('click', closePanel);
      backdrop.addEventListener('click', closePanel);
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && settingsOpen) closePanel(); });

      panel.querySelectorAll('[data-setting]').forEach((seg) => {
        seg.addEventListener('click', (e) => {
          const b = e.target.closest('button[data-value]');
          if (!b) return;
          settings[seg.dataset.setting] = b.dataset.value;
          saveSettings();
          refreshForSettings();
          syncControls();
        });
      });
      panel.querySelectorAll('input[data-toggle]').forEach((cb) => {
        cb.addEventListener('change', () => {
          settings[cb.dataset.toggle] = cb.checked;
          saveSettings();
          refreshForSettings();
        });
      });

      document.getElementById('settings-copy-link').addEventListener('click', async () => {
        const url = buildShareLink();
        if (await copyText(url)) say(settings.shareLocation && getCookie(POSTCODE_COOKIE) ? 'Link copied (includes your postcode)' : 'Link copied');
        else window.prompt('Copy this link', url);
      });
      document.getElementById('settings-reset').addEventListener('click', () => {
        Object.assign(settings, SETTINGS_DEFAULTS);
        saveSettings();
        refreshForSettings();
        syncControls();
        say('Back to defaults');
      });

      updateRadiusTexts();
    }
    initSettingsPanel();

    // Unattended kiosk: the Pi's launcher (deploy/kiosk.sh) opens the page with ?autostart=1 so
    // it starts by itself instead of waiting for a tap. Normal visitors never see this - without
    // the parameter the tap-to-start overlay behaves exactly as before. For sound to work with no
    // real gesture, that browser must also be started with
    // --autoplay-policy=no-user-gesture-required (kiosk.sh does this).
    if (new URLSearchParams(location.search).get('autostart') === '1') startFeed();
