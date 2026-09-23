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
    const PW_SILHOUETTES = {"shapes":{"B190D":{"d":"M 5.5304,5.7489 L 6.0576,5.7081 L 6.4310,5.6955 L 7.0241,5.7018 L 7.5293,5.7238 L 8.0439,5.7646 L 7.7898,5.7991 L 7.0178,5.8273 L 6.7260,5.8210 L 6.3839,5.8085 L 6.0042,5.7897 Z M 10.3109,5.7489 L 10.8381,5.7081 L 11.2115,5.6955 L 11.8046,5.7018 L 12.3098,5.7238 L 12.8245,5.7646 L 12.5703,5.7991 L 11.7983,5.8273 L 11.5065,5.8210 L 11.1644,5.8085 L 10.7847,5.7897 Z M 9.1712,1.4276 L 9.1199,1.4438 L 9.0718,1.4769 L 9.0036,1.6082 L 8.9132,1.8076 L 8.8274,2.0071 L 8.7008,2.4386 L 8.6201,2.7642 L 8.5669,3.0618 L 8.5013,3.5140 L 8.4661,3.8949 L 8.4460,4.2406 L 8.4408,4.5940 L 8.4310,6.5324 L 8.4109,6.7169 L 8.4258,6.9365 L 8.4233,7.0983 L 7.1133,7.2042 L 7.1081,6.8053 L 7.0957,6.3583 L 7.1282,6.3913 L 7.1613,6.4518 L 7.3127,6.3459 L 7.3127,6.2952 L 7.2724,6.2224 L 7.2269,6.1665 L 7.1815,6.1262 L 7.1184,6.1211 L 7.0580,6.1340 L 6.9996,5.9268 L 6.9644,5.7955 L 6.9293,5.6922 L 6.8657,5.5635 L 6.8254,5.5077 L 6.7980,5.4777 L 6.7675,5.4777 L 6.6942,5.5661 L 6.6389,5.6767 L 6.5960,5.7728 L 6.5681,5.8787 L 6.5226,6.0074 L 6.4926,6.1340 L 6.4492,6.1185 L 6.3913,6.1262 L 6.3335,6.1516 L 6.2932,6.1970 L 6.2627,6.2523 L 6.2373,6.3056 L 6.2224,6.3459 L 6.3939,6.4596 L 6.4115,6.4239 L 6.4270,6.3810 L 6.4492,6.3557 L 6.4647,6.3536 L 6.4518,6.4999 L 6.4291,6.7825 L 6.4167,7.1887 L 5.7428,7.4187 L 1.3229,7.6662 L 1.2573,7.6760 L 1.2092,7.6988 L 1.1663,7.7339 L 1.1286,7.7820 L 1.1110,7.8527 L 1.0909,8.1003 L 1.0681,8.1985 L 1.0506,8.3426 L 1.0377,8.5773 L 1.0578,8.5721 L 1.0806,8.4941 L 1.1183,8.4207 L 6.2120,9.2382 L 8.2088,9.2408 L 8.2997,9.3343 L 8.3525,9.4175 L 8.4083,9.4909 L 8.4083,13.1759 L 8.4233,13.3325 L 8.4791,13.5899 L 8.5674,14.0581 L 7.6502,14.5815 L 7.6171,14.6146 L 7.5954,14.6668 L 7.5954,14.9862 L 7.6202,15.0001 L 8.7132,14.8156 L 8.9007,15.8068 L 6.6342,16.6605 L 6.5986,16.6853 L 6.5763,16.7209 L 6.5598,16.7845 L 6.5515,17.3736 L 8.9333,17.1095 L 8.9416,17.2305 L 8.9664,17.3602 L 9.0134,17.4976 L 9.1713,17.5060 L 9.3271,17.4950 L 9.3741,17.3571 L 9.3989,17.2279 L 9.4072,17.1064 L 11.7889,17.3710 L 11.7806,16.7819 L 11.7641,16.7183 L 11.7424,16.6827 L 11.7062,16.6579 L 9.4402,15.8042 L 9.6273,14.8125 L 10.7208,14.9970 L 10.7451,14.9836 L 10.7451,14.6642 L 10.7234,14.6115 L 10.6903,14.5784 L 9.7730,14.0555 L 9.8619,13.5873 L 9.9172,13.3299 L 9.9322,13.1733 L 9.9322,9.4883 L 9.9880,9.4149 L 10.0407,9.3317 L 10.1317,9.2382 L 12.1284,9.2356 L 17.2222,8.4181 L 17.2599,8.4910 L 17.2826,8.5695 L 17.3028,8.5747 L 17.2899,8.3395 L 17.2723,8.1959 L 17.2496,8.0972 L 17.2294,7.8502 L 17.2119,7.7794 L 17.1741,7.7313 L 17.1313,7.6962 L 17.0832,7.6734 L 17.0176,7.6631 L 12.5977,7.4161 L 11.9238,7.1861 L 11.9114,6.7799 L 11.8887,6.4973 L 11.8758,6.3505 L 11.8913,6.3531 L 11.9140,6.3784 L 11.9290,6.4213 L 11.9466,6.4564 L 12.1181,6.3433 L 12.1031,6.3025 L 12.0778,6.2497 L 12.0473,6.1939 L 12.0070,6.1490 L 11.9491,6.1237 L 11.8913,6.1159 L 11.8484,6.1309 L 11.8179,6.0048 L 11.7724,5.8761 L 11.7445,5.7702 L 11.7016,5.6741 L 11.6463,5.5630 L 11.5729,5.4746 L 11.5430,5.4746 L 11.5151,5.5051 L 11.4748,5.5604 L 11.4117,5.6896 L 11.3760,5.7929 L 11.3409,5.9242 L 11.2825,6.1309 L 11.2221,6.1185 L 11.1590,6.1237 L 11.1135,6.1640 L 11.0681,6.2193 L 11.0277,6.2926 L 11.0277,6.3433 L 11.1792,6.4492 L 11.2122,6.3888 L 11.2448,6.3557 L 11.2324,6.8027 L 11.2272,7.2011 L 9.9172,7.0952 L 9.9146,6.9339 L 9.9296,6.7143 L 9.9095,6.5298 L 9.8997,4.5915 L 9.8945,4.2380 L 9.8743,3.8923 L 9.8392,3.5109 L 9.7736,3.0592 L 9.7203,2.7616 L 9.6397,2.4360 L 9.5136,2.0040 L 9.4273,1.8045 L 9.3369,1.6056 L 9.2687,1.4743 L 9.2206,1.4413 Z","a":[9.26,7.673]},"A388":{"d":"M 9.2606,1.2545 L 9.1858,1.2679 L 9.0990,1.3149 L 9.0297,1.3754 L 8.9718,1.4534 L 8.9336,1.5159 L 8.8824,1.6115 L 8.8199,1.7454 L 8.7398,1.9350 L 8.6458,2.2363 L 8.5744,2.5329 L 8.5254,2.7986 L 8.4876,3.1577 L 8.4742,3.4631 L 8.4742,5.3596 L 8.4628,5.4687 L 8.4298,5.5984 L 8.3874,5.7276 L 8.3000,5.8862 L 8.2112,6.0108 L 8.1130,6.1089 L 6.1896,7.6820 L 6.2030,7.5481 L 6.2118,7.4184 L 6.2165,7.2825 L 6.2118,7.1306 L 6.2010,6.9771 L 6.1694,6.7627 L 6.1694,6.7316 L 6.1498,6.7089 L 5.5297,6.7089 L 5.5116,6.7249 L 5.5069,6.7714 L 5.4847,6.8918 L 5.4692,7.0303 L 5.4578,7.1890 L 5.4578,7.3425 L 5.4666,7.5368 L 5.4826,7.7755 L 5.5116,7.9652 L 5.5782,7.9652 L 5.6232,8.1233 L 3.9566,9.3749 L 3.9654,9.2545 L 3.9789,9.1072 L 3.9768,8.9067 L 3.9747,8.7212 L 3.9520,8.5517 L 3.9344,8.4313 L 3.9298,8.3910 L 3.9096,8.3781 L 3.2983,8.3781 L 3.2786,8.3956 L 3.2719,8.4427 L 3.2585,8.5476 L 3.2404,8.6767 L 3.2316,8.8127 L 3.2295,8.9511 L 3.2337,9.1294 L 3.2430,9.3124 L 3.2559,9.4441 L 3.2786,9.6359 L 3.3474,9.6359 L 3.3923,9.7919 L 1.0209,11.5722 L 0.9470,11.6239 L 0.8824,11.6797 L 0.8199,11.7417 L 0.7754,11.8001 L 0.7284,11.8802 L 0.6927,11.9763 L 0.6705,12.0833 L 0.6597,12.2595 L 0.6328,12.7235 L 0.6571,12.7256 L 0.6659,12.7055 L 3.5060,11.5345 L 3.5014,11.6730 L 3.5148,11.7975 L 3.5463,11.9091 L 3.5887,12.0409 L 3.6176,12.0409 L 3.6533,11.9407 L 3.6843,11.8290 L 3.7065,11.7128 L 3.7091,11.5722 L 3.7112,11.4518 L 4.4140,11.1929 L 4.4114,11.3268 L 4.4207,11.4342 L 4.4538,11.5681 L 4.5029,11.6993 L 4.5297,11.6993 L 4.5721,11.5701 L 4.6057,11.4410 L 4.6191,11.3092 L 4.6191,11.1149 L 5.3193,10.8539 L 5.3219,11.0301 L 5.3374,11.1485 L 5.3684,11.2554 L 5.4067,11.3603 L 5.4356,11.3603 L 5.4733,11.2554 L 5.5136,11.1020 L 5.5291,10.9681 L 5.5291,10.7738 L 6.2273,10.5128 L 6.2340,10.5929 L 6.2542,10.6870 L 6.2810,10.7785 L 6.3167,10.8699 L 6.3368,10.8699 L 6.3704,10.8028 L 6.3994,10.7025 L 6.4216,10.5909 L 6.4392,10.4839 L 6.4392,10.4302 L 6.5265,10.3966 L 7.1420,10.2653 L 7.1399,10.3320 L 7.1580,10.4255 L 7.1843,10.5082 L 7.2267,10.6177 L 7.2515,10.6177 L 7.2892,10.5237 L 7.3208,10.4100 L 7.3383,10.3165 L 7.3451,10.2204 L 8.3000,10.0240 L 8.3176,10.2741 L 8.3533,10.5976 L 8.4070,11.0994 L 8.4695,11.6663 L 8.4695,12.4626 L 8.4850,12.8574 L 8.5031,13.1163 L 8.5496,13.5912 L 8.5899,13.9013 L 8.6525,14.2563 L 8.6948,14.4434 L 6.1270,16.4913 L 6.0712,16.5450 L 6.0314,16.6029 L 5.9979,16.6701 L 5.9756,16.7548 L 5.9307,17.2029 L 9.0251,16.0541 L 9.2013,16.9445 L 9.2281,16.9445 L 9.2416,17.2075 L 9.2571,17.2075 L 9.2685,17.2075 L 9.2793,17.2075 L 9.2927,16.9445 L 9.3196,16.9445 L 9.4958,16.0541 L 12.5902,17.2029 L 12.5453,16.7548 L 12.5230,16.6701 L 12.4894,16.6029 L 12.4497,16.5450 L 12.3938,16.4913 L 9.8260,14.4434 L 9.8684,14.2563 L 9.9309,13.9013 L 9.9713,13.5912 L 10.0178,13.1163 L 10.0359,12.8574 L 10.0514,12.4626 L 10.0514,11.6663 L 10.1139,11.0994 L 10.1676,10.5976 L 10.2033,10.2741 L 10.2209,10.0240 L 11.1758,10.2204 L 11.1825,10.3165 L 11.2001,10.4100 L 11.2316,10.5237 L 11.2693,10.6177 L 11.2942,10.6177 L 11.3365,10.5082 L 11.3629,10.4255 L 11.3810,10.3320 L 11.3789,10.2653 L 11.9943,10.3966 L 12.0817,10.4302 L 12.0817,10.4839 L 12.0992,10.5909 L 12.1215,10.7025 L 12.1504,10.8028 L 12.1840,10.8699 L 12.2041,10.8699 L 12.2398,10.7785 L 12.2667,10.6870 L 12.2868,10.5929 L 12.2935,10.5128 L 12.9917,10.7738 L 12.9917,10.9681 L 13.0072,11.1020 L 13.0475,11.2554 L 13.0852,11.3603 L 13.1141,11.3603 L 13.1524,11.2554 L 13.1834,11.1485 L 13.1989,11.0301 L 13.2015,10.8539 L 13.9017,11.1149 L 13.9017,11.3092 L 13.9151,11.4410 L 13.9487,11.5701 L 13.9911,11.6993 L 14.0180,11.6993 L 14.0671,11.5681 L 14.1001,11.4342 L 14.1094,11.3268 L 14.1068,11.1929 L 14.8096,11.4518 L 14.8117,11.5722 L 14.8143,11.7128 L 14.8366,11.8290 L 14.8676,11.9407 L 14.9032,12.0409 L 14.9322,12.0409 L 14.9745,11.9091 L 15.0061,11.7975 L 15.0195,11.6730 L 15.0148,11.5345 L 17.8549,12.7055 L 17.8637,12.7256 L 17.8880,12.7235 L 17.8612,12.2595 L 17.8503,12.0833 L 17.8281,11.9763 L 17.7924,11.8802 L 17.7454,11.8001 L 17.7010,11.7417 L 17.6384,11.6797 L 17.5738,11.6239 L 17.4999,11.5722 L 15.1285,9.7919 L 15.1735,9.6359 L 15.2422,9.6359 L 15.2649,9.4441 L 15.2779,9.3124 L 15.2872,9.1294 L 15.2913,8.9511 L 15.2892,8.8127 L 15.2804,8.6767 L 15.2623,8.5476 L 15.2488,8.4427 L 15.2421,8.3956 L 15.2225,8.3781 L 14.6112,8.3781 L 14.5910,8.3910 L 14.5864,8.4313 L 14.5688,8.5517 L 14.5466,8.7212 L 14.5440,8.9067 L 14.5419,9.1072 L 14.5554,9.2545 L 14.5642,9.3749 L 12.8976,8.1233 L 12.9425,7.9652 L 13.0092,7.9652 L 13.0381,7.7755 L 13.0542,7.5368 L 13.0630,7.3425 L 13.0630,7.1890 L 13.0516,7.0303 L 13.0361,6.8918 L 13.0139,6.7714 L 13.0092,6.7249 L 12.9916,6.7089 L 12.3710,6.7089 L 12.3513,6.7316 L 12.3513,6.7627 L 12.3198,6.9771 L 12.3090,7.1306 L 12.3043,7.2825 L 12.3090,7.4184 L 12.3178,7.5481 L 12.3312,7.6820 L 10.4078,6.1089 L 10.3096,6.0108 L 10.2207,5.8862 L 10.1334,5.7276 L 10.0910,5.5984 L 10.0580,5.4687 L 10.0466,5.3596 L 10.0466,3.4631 L 10.0333,3.1577 L 9.9956,2.7986 L 9.9465,2.5329 L 9.8751,2.2363 L 9.7811,1.9350 L 9.7010,1.7454 L 9.6385,1.6115 L 9.5873,1.5159 L 9.5491,1.4534 L 9.4912,1.3754 L 9.4219,1.3149 L 9.3351,1.2679 Z","a":[9.26,7.937]},"AS50":{"d":"M 9.6339,3.5457 L 9.7508,3.5670 L 10.0107,3.6572 L 10.2337,3.8058 L 10.3982,3.9916 L 10.5256,4.2410 L 10.6530,4.6391 L 10.7167,5.0584 L 10.7432,5.1009 L 10.7485,5.2708 L 10.7857,5.3663 L 10.7857,6.8885 L 10.8777,6.8885 L 10.8777,5.2801 L 10.9094,5.2431 L 10.9518,5.2484 L 10.9888,5.2748 L 10.9888,6.8938 L 11.0840,6.8938 L 11.0840,6.6927 L 11.1317,6.6927 L 11.1317,4.5553 L 11.2110,4.5553 L 11.2110,6.6980 L 11.2433,6.6894 L 11.2433,6.8303 L 11.3221,6.8303 L 11.3221,7.4123 L 11.3909,7.4123 L 11.3909,7.5869 L 11.0629,7.5869 L 11.0629,7.2694 L 10.9941,7.2694 L 10.9941,7.8197 L 10.9941,9.0048 L 10.8777,9.0048 L 10.8777,8.7720 L 10.4968,8.7720 L 10.4650,9.1529 L 10.4439,9.4386 L 10.4068,9.6026 L 10.3698,9.7243 L 10.3275,9.8725 L 10.2852,10.0153 L 10.2270,10.2058 L 10.1582,10.3804 L 10.0894,10.5021 L 10.0577,10.5497 L 10.0577,10.5973 L 10.1529,10.6026 L 10.1529,11.1158 L 10.0418,11.1158 L 9.9148,13.9093 L 11.2957,13.9093 L 11.2957,14.5495 L 9.8619,14.5495 L 9.8037,15.8404 L 10.0259,15.8404 L 10.0259,15.7928 L 10.1635,15.7928 L 10.1635,16.0097 L 10.0259,16.0097 L 10.0259,15.9462 L 9.7984,15.9462 L 9.6714,17.6604 L 9.4228,14.5336 L 8.0101,14.5336 L 8.0101,13.9146 L 9.3963,13.9146 L 9.2376,11.1052 L 9.1106,11.1052 L 9.1106,10.6026 L 9.2111,10.6026 L 9.1106,10.3328 L 9.0207,10.0100 L 8.9360,9.7137 L 8.8672,9.3487 L 8.7932,8.7667 L 8.3911,8.7667 L 8.3911,9.0312 L 8.2958,9.0312 L 8.2958,8.5762 L 8.2482,8.6768 L 8.1741,8.6979 L 8.1054,8.6503 L 8.0578,8.5604 L 8.0366,8.5180 L 8.0366,7.6715 L 8.0683,7.5869 L 8.1424,7.5657 L 8.2535,7.5763 L 8.2535,5.2801 L 8.2853,5.2431 L 8.3382,5.2325 L 8.3699,5.2695 L 8.3858,5.3383 L 8.3858,6.9203 L 8.5128,6.9203 L 8.4757,6.4229 L 8.4757,5.5341 L 8.5022,5.2114 L 8.5392,4.9309 L 8.6027,4.5818 L 8.7244,4.2537 L 8.8884,4.0051 L 9.0947,3.7829 L 9.3169,3.6559 L 9.5074,3.5765 Z M 7.5546,1.7632 L 7.2135,1.8748 L 7.1996,1.9048 L 8.8992,6.6487 L 9.2863,7.0373 L 9.4273,7.4213 A 0.4771,0.4771 0.00 0,0 9.1808,7.8388 A 0.4771,0.4771 0.00 0,0 9.3276,8.1830 L 5.5041,12.7310 L 5.7712,12.9703 L 5.8043,12.9677 L 9.0625,9.1240 L 9.2051,8.5943 L 9.4697,8.2770 A 0.4771,0.4771 0.00 0,0 9.6583,8.3158 A 0.4771,0.4771 0.00 0,0 10.1317,7.8977 L 10.1250,8.0088 L 15.9753,9.0465 L 16.0492,8.6951 L 16.0306,8.6677 L 11.0722,7.7680 L 10.5420,7.9091 L 10.1353,7.8388 A 0.4771,0.4771 0.00 0,0 9.6583,7.3618 A 0.4771,0.4771 0.00 0,0 9.5059,7.3866 L 9.5813,7.3489 Z","a":[8.202,5.821]},"R44":{"d":"M 9.2837,4.3656 L 9.1131,4.3770 L 8.9431,4.4375 L 8.7576,4.5775 L 8.6248,4.7439 L 8.4848,4.9863 L 8.4016,5.2855 L 8.3411,5.7852 L 8.3556,6.9448 L 8.2956,6.9438 L 8.2274,6.9401 L 8.0987,6.9288 L 8.0228,6.8797 L 8.0042,6.1562 L 8.0000,6.0389 L 7.9850,5.9862 L 7.9210,5.9821 L 7.8905,6.0048 L 7.8600,6.0694 L 7.8600,6.1790 L 7.9210,9.2537 L 7.9360,9.3142 L 7.9814,9.3782 L 8.0419,9.3782 L 8.0724,9.3292 L 8.0724,9.1059 L 8.2274,9.1436 L 8.4357,9.1514 L 8.4734,9.3441 L 8.5566,9.6511 L 8.6744,10.0599 L 8.8103,10.4081 L 8.9276,10.7564 L 9.0377,11.0898 L 9.1359,11.4913 L 9.1855,11.8773 L 9.2155,12.1310 L 9.2573,12.5098 L 9.2837,12.9599 L 9.2837,13.6948 L 8.3411,13.7211 L 8.3184,13.7589 L 8.3333,14.3268 L 8.3824,14.3609 L 9.3255,14.3459 L 9.4010,15.8151 L 9.4279,16.3943 L 9.5147,16.4662 L 9.4842,16.5380 L 9.4279,16.5835 L 9.3633,16.6290 L 9.3483,16.6026 L 9.3441,16.5303 L 9.3369,16.4739 L 9.2873,16.4434 L 9.2609,16.4812 L 9.2873,17.1855 L 9.3633,18.0371 L 9.3633,17.1933 L 9.4087,17.1969 L 9.4542,17.2501 L 9.5033,17.3333 L 9.5410,17.4051 L 9.5410,17.4997 L 9.5565,17.6170 L 9.5865,17.6775 L 9.6397,17.6775 L 9.6775,17.6247 L 9.7193,17.5147 L 9.7720,17.1777 L 9.7720,16.9431 L 10.0521,16.9431 L 10.1431,16.8791 L 10.0790,16.8181 L 9.7720,16.8259 L 9.7570,14.3382 L 10.7337,14.3196 L 10.7792,14.2891 L 10.7606,13.6757 L 10.7224,13.6571 L 9.7607,13.6871 L 9.7570,12.1993 L 9.7798,11.8660 L 9.8402,11.3699 L 9.9803,10.7606 L 10.2531,9.7762 L 10.3513,9.3519 L 10.3740,9.1018 L 10.6087,9.1018 L 10.7492,9.0568 L 10.7528,9.2537 L 10.7642,9.3064 L 10.7983,9.3369 L 10.8396,9.3369 L 10.8737,9.3256 L 10.9042,9.2873 L 10.9078,9.2310 L 10.7905,5.9935 L 10.7678,5.9480 L 10.7301,5.9252 L 10.7073,5.9408 L 10.6810,5.9862 L 10.6810,6.8301 L 10.3740,6.9097 L 10.3513,6.5314 L 10.3286,6.1526 L 10.3058,5.7438 L 10.2340,5.3196 L 10.1317,5.0054 L 9.9994,4.7821 L 9.8103,4.5625 L 9.6206,4.4452 L 9.4465,4.3770 Z M 10.8081,7.0600 L 10.8655,8.8610 L 10.6831,8.8883 L 10.5658,8.9194 L 10.3895,8.9194 L 10.4169,8.5168 L 10.4133,8.0750 L 10.4055,7.6367 L 10.3895,7.2967 L 10.3859,7.1169 L 10.5384,7.0657 Z M 7.9303,7.1355 L 8.1406,7.1696 L 8.2827,7.1877 L 8.3571,7.1804 L 8.3571,7.4920 L 8.3571,7.9034 L 8.3607,8.3535 L 8.3783,8.6832 L 8.4031,8.9380 L 8.2615,8.9416 L 8.1514,8.9240 L 7.9551,8.8863 Z M 7.2321,1.3022 L 6.7748,1.4774 L 8.6367,7.0104 L 8.8594,7.3127 L 8.9188,7.4559 L 9.1297,7.7267 L 9.2537,8.0982 A 0.2560,0.2560 0.00 0,0 9.1421,8.3096 A 0.2560,0.2560 0.00 0,0 9.3829,8.5654 L 9.4635,8.9302 L 9.4434,9.0139 L 11.5678,15.3148 L 12.0251,15.1396 L 10.1637,9.6066 L 9.9405,9.3043 L 9.8811,9.1612 L 9.6702,8.8904 L 9.5462,8.5183 A 0.2560,0.2560 0.00 0,0 9.6537,8.3096 A 0.2560,0.2560 0.00 0,0 9.4175,8.0543 L 9.3364,7.6869 L 9.3565,7.6032 Z","a":[9.26,5.292]},"A139":{"d":"M 7.5356,2.7977 L 7.3279,2.8354 L 7.1894,2.9171 L 7.0509,3.0308 L 6.9181,3.2070 L 6.7858,3.4276 L 6.6473,3.7175 L 6.5465,4.0514 L 6.4520,4.4922 L 6.3827,4.9273 L 6.3326,5.3996 L 6.3326,7.8697 L 5.9983,7.9514 L 5.9104,8.0335 L 5.8789,8.1405 L 5.8789,9.1105 L 5.9166,9.1926 L 6.0236,9.2872 L 6.4267,9.3751 L 7.0380,11.1460 L 7.3155,14.6047 L 5.7275,14.6424 L 5.5952,14.6931 L 5.4753,14.7809 L 5.3998,14.9008 L 5.3745,15.0393 L 5.3745,15.1845 L 7.3718,15.3292 L 7.3971,15.7576 L 7.2649,15.7891 L 7.1832,15.8336 L 7.1450,15.9214 L 7.1450,16.1545 L 7.1832,16.3628 L 7.2773,16.5452 L 7.3847,16.6459 L 7.4793,16.6842 L 7.5108,16.6775 L 7.5424,16.6842 L 7.6364,16.6459 L 7.7439,16.5452 L 7.8385,16.3628 L 7.8762,16.1545 L 7.8762,16.0449 L 8.2333,16.0449 L 8.2333,15.9509 L 7.8762,15.9509 L 7.8762,15.9214 L 7.8385,15.8336 L 7.7563,15.7891 L 7.6240,15.7576 L 7.6493,15.3292 L 9.6466,15.1845 L 9.6466,15.0393 L 9.6213,14.9008 L 9.5458,14.7809 L 9.4260,14.6931 L 9.2937,14.6424 L 7.7062,14.6047 L 7.9832,11.1460 L 8.5945,9.3751 L 8.9976,9.2872 L 9.1045,9.1926 L 9.1423,9.1105 L 9.1423,8.1405 L 9.1107,8.0335 L 9.0229,7.9514 L 8.6891,7.8692 L 8.6891,5.3996 L 8.6384,4.9273 L 8.5692,4.4922 L 8.4746,4.0514 L 8.3738,3.7175 L 8.2353,3.4276 L 8.1030,3.2070 L 7.9708,3.0308 L 7.8317,2.9171 L 7.6932,2.8354 L 7.5356,2.7977 Z M 7.6445,1.0790 L 7.5897,1.0930 L 7.4843,1.2025 L 7.3913,1.3364 L 7.3406,1.4537 L 7.3267,1.5689 L 7.3468,1.6903 L 7.4176,1.9394 L 7.5127,2.2226 L 9.2599,7.3567 L 9.3188,7.3308 L 9.4671,7.7339 A 0.3046,0.3046 0.00 0,0 9.4330,7.7763 L 8.9917,7.7840 L 8.9901,7.7112 L 3.8344,7.7835 L 3.6024,7.8021 L 3.3357,7.8176 L 3.1461,7.8114 L 2.9631,7.7923 L 2.8453,7.7603 L 2.7389,7.7344 L 2.6293,7.7179 L 2.5663,7.7292 L 2.5321,7.7690 L 2.5285,7.8259 L 2.5998,7.9597 L 2.6980,8.0894 L 2.7941,8.1737 L 2.8996,8.2228 L 3.0215,8.2414 L 3.2804,8.2507 L 3.5791,8.2481 L 9.0015,8.1726 L 8.9948,8.1086 L 9.4211,8.0920 A 0.3046,0.3046 0.00 0,0 9.4537,8.1390 L 9.3250,8.5597 L 9.2552,8.5390 L 7.7308,13.4648 L 7.6771,13.6906 L 7.6094,13.9495 L 7.5448,14.1278 L 7.4698,14.2963 L 7.4032,14.3981 L 7.3458,14.4911 L 7.2962,14.5903 L 7.2874,14.6539 L 7.3148,14.6988 L 7.3675,14.7195 L 7.5169,14.6932 L 7.6709,14.6394 L 7.7804,14.5743 L 7.8600,14.4896 L 7.9148,14.3790 L 8.0042,14.1361 L 8.0936,13.8508 L 9.6981,8.6703 L 9.6351,8.6574 L 9.7431,8.2750 L 10.0133,8.4641 L 9.9720,8.5240 L 14.1857,11.4960 L 14.3841,11.6174 L 14.6089,11.7616 L 14.7588,11.8778 L 14.8957,12.0013 L 14.9717,12.0959 L 15.0430,12.1796 L 15.1216,12.2572 L 15.1794,12.2856 L 15.2306,12.2732 L 15.2668,12.2298 L 15.2874,12.0794 L 15.2843,11.9166 L 15.2564,11.7915 L 15.2001,11.6897 L 15.1123,11.6034 L 14.9086,11.4437 L 14.6647,11.2706 L 10.2340,8.1437 L 10.2020,8.1995 L 9.9741,8.0471 A 0.3046,0.3046 0.00 0,0 9.9797,8.0300 L 10.2877,7.7980 L 10.3322,7.8559 L 14.4606,4.7672 L 14.6368,4.6157 L 14.8435,4.4468 L 15.0006,4.3403 L 15.1603,4.2478 L 15.2740,4.2049 L 15.3753,4.1631 L 15.4735,4.1119 L 15.5184,4.0659 L 15.5225,4.0132 L 15.4920,3.9656 L 15.3556,3.8995 L 15.1995,3.8520 L 15.0724,3.8401 L 14.9582,3.8623 L 14.8492,3.9191 L 14.6342,4.0633 L 14.3939,4.2416 L 10.0510,7.4895 L 10.0944,7.5375 L 9.8790,7.7070 A 0.3046,0.3046 0.00 0,0 9.7725,7.6517 L 9.6263,7.2275 L 9.6950,7.2032 L 8.0331,2.3218 L 7.9442,2.1074 L 7.8465,1.8583 L 7.7944,1.6764 L 7.7556,1.4960 L 7.7494,1.3746 L 7.7416,1.2650 L 7.7236,1.1560 L 7.6931,1.0992 Z","a":[9.79,6.085]},"B06":{"d":"M 9.2837,4.3656 L 9.1131,4.3770 L 8.9431,4.4375 L 8.7576,4.5775 L 8.6248,4.7439 L 8.4848,4.9863 L 8.4016,5.2855 L 8.3411,5.7852 L 8.3556,6.9448 L 8.2956,6.9438 L 8.2274,6.9401 L 8.0987,6.9288 L 8.0228,6.8797 L 8.0042,6.1562 L 8.0000,6.0389 L 7.9850,5.9862 L 7.9210,5.9821 L 7.8905,6.0048 L 7.8600,6.0694 L 7.8600,6.1790 L 7.9210,9.2537 L 7.9360,9.3142 L 7.9814,9.3782 L 8.0419,9.3782 L 8.0724,9.3292 L 8.0724,9.1059 L 8.2274,9.1436 L 8.4357,9.1514 L 8.4734,9.3441 L 8.5566,9.6511 L 8.6744,10.0599 L 8.8103,10.4081 L 8.9276,10.7564 L 9.0377,11.0898 L 9.1359,11.4913 L 9.1855,11.8773 L 9.2155,12.1310 L 9.2573,12.5098 L 9.2837,12.9599 L 9.2837,13.6948 L 8.3411,13.7211 L 8.3184,13.7589 L 8.3333,14.3268 L 8.3824,14.3609 L 9.3255,14.3459 L 9.4010,15.8151 L 9.4279,16.3943 L 9.5147,16.4662 L 9.4842,16.5380 L 9.4279,16.5835 L 9.3633,16.6290 L 9.3483,16.6026 L 9.3441,16.5303 L 9.3369,16.4739 L 9.2873,16.4434 L 9.2609,16.4812 L 9.2873,17.1855 L 9.3633,18.0371 L 9.3633,17.1933 L 9.4087,17.1969 L 9.4542,17.2501 L 9.5033,17.3333 L 9.5410,17.4051 L 9.5410,17.4997 L 9.5565,17.6170 L 9.5865,17.6775 L 9.6397,17.6775 L 9.6775,17.6247 L 9.7193,17.5147 L 9.7720,17.1777 L 9.7720,16.9431 L 10.0521,16.9431 L 10.1431,16.8791 L 10.0790,16.8181 L 9.7720,16.8259 L 9.7570,14.3382 L 10.7337,14.3196 L 10.7792,14.2891 L 10.7606,13.6757 L 10.7224,13.6571 L 9.7607,13.6871 L 9.7570,12.1993 L 9.7798,11.8660 L 9.8402,11.3699 L 9.9803,10.7606 L 10.2531,9.7762 L 10.3513,9.3519 L 10.3740,9.1018 L 10.6087,9.1018 L 10.7492,9.0568 L 10.7528,9.2537 L 10.7642,9.3064 L 10.7983,9.3369 L 10.8396,9.3369 L 10.8737,9.3256 L 10.9042,9.2873 L 10.9078,9.2310 L 10.7905,5.9935 L 10.7678,5.9480 L 10.7301,5.9252 L 10.7073,5.9408 L 10.6810,5.9862 L 10.6810,6.8301 L 10.3740,6.9097 L 10.3513,6.5314 L 10.3286,6.1526 L 10.3058,5.7438 L 10.2340,5.3196 L 10.1317,5.0054 L 9.9994,4.7821 L 9.8103,4.5625 L 9.6206,4.4452 L 9.4465,4.3770 Z M 10.8081,7.0600 L 10.8655,8.8610 L 10.6831,8.8883 L 10.5658,8.9194 L 10.3895,8.9194 L 10.4169,8.5168 L 10.4133,8.0750 L 10.4055,7.6367 L 10.3895,7.2967 L 10.3859,7.1169 L 10.5384,7.0657 Z M 7.9303,7.1355 L 8.1406,7.1696 L 8.2827,7.1877 L 8.3571,7.1804 L 8.3571,7.4920 L 8.3571,7.9034 L 8.3607,8.3535 L 8.3783,8.6832 L 8.4031,8.9380 L 8.2615,8.9416 L 8.1514,8.9240 L 7.9551,8.8863 Z M 7.2321,1.3022 L 6.7748,1.4774 L 8.6367,7.0104 L 8.8594,7.3127 L 8.9188,7.4559 L 9.1297,7.7267 L 9.2537,8.0982 A 0.2560,0.2560 0.00 0,0 9.1421,8.3096 A 0.2560,0.2560 0.00 0,0 9.3829,8.5654 L 9.4635,8.9302 L 9.4434,9.0139 L 11.5678,15.3148 L 12.0251,15.1396 L 10.1637,9.6066 L 9.9405,9.3043 L 9.8811,9.1612 L 9.6702,8.8904 L 9.5462,8.5183 A 0.2560,0.2560 0.00 0,0 9.6537,8.3096 A 0.2560,0.2560 0.00 0,0 9.4175,8.0543 L 9.3364,7.6869 L 9.3565,7.6032 Z","a":[9.26,8.202]},"A148":{"d":"M 9.2649,0.6784 L 9.2034,0.6867 L 9.1502,0.7130 L 9.0980,0.7590 L 8.8107,1.2479 L 8.7523,1.3621 L 8.6665,1.5435 L 8.5724,1.7786 L 8.5208,1.9238 L 8.4505,2.1682 L 8.3864,2.4514 L 8.3518,2.6576 L 8.3285,2.8488 L 8.3172,3.0162 L 8.3125,3.1708 L 8.3110,3.3837 L 8.3079,3.7046 L 8.3032,4.0673 L 8.3001,4.4162 L 8.2955,4.7717 L 8.2924,5.1877 L 8.2862,5.6182 L 8.2846,5.7727 L 7.9652,5.9463 L 7.5524,6.1685 L 7.3141,6.2972 L 7.3141,4.6074 L 7.3033,4.5743 L 7.2692,4.5319 L 7.2438,4.5149 L 6.4051,4.5149 L 6.3617,4.5226 L 6.3240,4.5479 L 6.2925,4.5867 L 6.2878,4.6043 L 6.2878,6.2879 L 6.2940,6.3783 L 6.3085,6.4770 L 6.3256,6.5643 L 6.3488,6.6444 L 6.3695,6.7085 L 6.3989,6.7835 L 0.9900,9.6934 L 0.9579,9.7269 L 0.8887,9.8262 L 0.8308,9.9249 L 0.7843,10.0406 L 0.7672,10.1006 L 0.7187,10.5021 L 0.7207,10.5228 L 0.7378,10.5341 L 0.7621,10.5305 L 8.1575,8.4981 L 8.1575,9.1043 L 8.1916,9.3291 L 8.2309,9.5115 L 8.2779,9.6996 L 8.3053,9.7699 L 8.3244,11.6333 L 8.6034,13.7040 L 8.9890,15.2967 L 6.6894,16.9746 L 6.6304,17.0159 L 6.5829,17.0635 L 6.5529,17.1084 L 6.5266,17.1658 L 6.5106,17.2371 L 6.5106,17.7926 L 9.1476,16.9146 L 9.1538,17.2686 L 9.2572,17.8515 L 9.3672,17.2686 L 9.3739,16.9146 L 12.0110,17.7926 L 12.0110,17.2371 L 11.9950,17.1658 L 11.9686,17.1084 L 11.9387,17.0635 L 11.8911,17.0159 L 11.8322,16.9746 L 9.5326,15.2967 L 9.9181,13.7040 L 10.1972,11.6333 L 10.2163,9.7699 L 10.2437,9.6996 L 10.2907,9.5115 L 10.3300,9.3291 L 10.3636,9.1043 L 10.3636,8.4981 L 17.7595,10.5305 L 17.7838,10.5341 L 17.8008,10.5227 L 17.8023,10.5021 L 17.7538,10.1006 L 17.7372,10.0406 L 17.6902,9.9248 L 17.6323,9.8261 L 17.5636,9.7269 L 17.5315,9.6933 L 12.1220,6.7834 L 12.1520,6.7085 L 12.1722,6.6444 L 12.1959,6.5643 L 12.2130,6.4770 L 12.2269,6.3783 L 12.2336,6.2879 L 12.2336,4.6043 L 12.2284,4.5867 L 12.1974,4.5479 L 12.1597,4.5226 L 12.1158,4.5149 L 11.2776,4.5149 L 11.2523,4.5319 L 11.2182,4.5743 L 11.2068,4.6074 L 11.2068,6.2972 L 10.9692,6.1685 L 10.5563,5.9463 L 10.2369,5.7727 L 10.2353,5.6182 L 10.2291,5.1877 L 10.2260,4.7717 L 10.2213,4.4162 L 10.2182,4.0673 L 10.2135,3.7046 L 10.2104,3.3837 L 10.2089,3.1708 L 10.2037,3.0162 L 10.1930,2.8488 L 10.1698,2.6576 L 10.1351,2.4514 L 10.0711,2.1682 L 10.0008,1.9238 L 9.9491,1.7786 L 9.8551,1.5435 L 9.7693,1.3621 L 9.7109,1.2479 L 9.4230,0.7590 L 9.3714,0.7130 L 9.3181,0.6867 Z","a":[9.26,6.879]},"P28A":{"d":"M 9.2336,3.4602 L 9.1824,3.5305 L 9.0832,3.7481 L 9.0403,3.9512 L 9.0263,4.0080 L 8.7002,4.0364 L 8.6294,4.0597 L 8.5917,4.1026 L 8.5680,4.2251 L 8.4403,5.7754 L 8.3881,6.6874 L 7.2822,7.1463 L 1.5777,7.1649 L 1.5115,7.2073 L 1.4216,7.3210 L 1.3601,7.4533 L 1.3084,7.6331 L 1.2609,7.8786 L 1.2516,8.0724 L 1.2423,8.1907 L 1.2041,8.2238 L 1.1855,8.2992 L 1.1901,8.3747 L 1.2185,8.4176 L 1.2470,8.4553 L 1.2470,8.7767 L 1.2754,9.0790 L 1.3178,9.2966 L 1.3792,9.4997 L 1.4500,9.6511 L 1.5255,9.7358 L 1.5777,9.7741 L 1.6578,9.7741 L 8.4212,9.8020 L 8.4589,10.2609 L 8.6010,11.4753 L 8.7757,12.8602 L 8.9741,14.2875 L 6.3324,14.2828 L 6.2332,14.3014 L 6.1386,14.3675 L 6.0772,14.4575 L 6.0348,14.5898 L 6.0203,14.7081 L 6.0348,14.8213 L 6.1619,15.3556 L 6.1903,15.4455 L 6.2425,15.4925 L 6.2849,15.5210 L 6.3278,15.5210 L 9.2578,15.5540 L 9.2966,15.6579 L 9.3059,15.5540 L 12.2365,15.5210 L 12.2788,15.5210 L 12.3212,15.4925 L 12.3734,15.4455 L 12.4018,15.3556 L 12.5295,14.8213 L 12.5434,14.7081 L 12.5295,14.5898 L 12.4871,14.4575 L 12.4256,14.3675 L 12.3310,14.3014 L 12.2318,14.2828 L 9.5896,14.2875 L 9.7880,12.8602 L 9.9632,11.4753 L 10.1048,10.2609 L 10.1425,9.8020 L 16.9059,9.7741 L 16.9860,9.7741 L 17.0382,9.7358 L 17.1137,9.6511 L 17.1845,9.4997 L 17.2460,9.2966 L 17.2889,9.0790 L 17.3173,8.7767 L 17.3173,8.4553 L 17.3452,8.4176 L 17.3736,8.3747 L 17.3783,8.2992 L 17.3597,8.2238 L 17.3220,8.1907 L 17.3122,8.0724 L 17.3029,7.8786 L 17.2554,7.6331 L 17.2037,7.4533 L 17.1421,7.3210 L 17.0522,7.2073 L 16.9860,7.1649 L 11.2815,7.1463 L 10.1756,6.6874 L 10.1234,5.7754 L 9.9958,4.2251 L 9.9725,4.1026 L 9.9348,4.0597 L 9.8635,4.0364 L 9.5374,4.0080 L 9.5234,3.9512 L 9.4811,3.7481 L 9.3813,3.5305 L 9.3278,3.4597 C 9.3142,3.4457 9.2429,3.4469 9.2336,3.4602 Z","a":[9.26,7.673]},"C208":{"d":"M 9.3124,3.9496 L 9.2625,3.9650 L 9.2163,4.0381 L 9.1625,4.1573 L 9.1202,4.3188 L 9.0894,4.4995 L 8.9047,4.5333 L 8.8124,4.6218 L 8.7240,4.9756 L 8.6279,5.4640 L 8.5894,5.7909 L 8.5855,6.0485 L 8.5586,6.0677 L 8.5132,6.1946 L 8.5093,6.8137 L 8.4785,7.0829 L 8.4785,7.2791 L 6.7814,7.3474 C 6.7814,7.3474 6.1522,7.3789 5.8375,7.3920 C 5.1924,7.4189 3.9018,7.4618 3.9018,7.4618 L 2.4633,7.5194 L 2.0634,7.5425 L 1.9672,7.6156 L 1.9734,8.3109 L 1.9734,8.6723 L 2.0733,8.6839 L 2.1310,8.7223 L 3.8515,8.8262 L 5.7976,8.9555 L 7.3781,9.0733 L 8.0842,9.0914 L 8.4434,9.0192 L 8.4418,9.3985 L 8.4556,9.7678 L 8.5778,10.8138 L 8.7684,12.1905 L 8.8915,12.9942 L 8.0724,13.1096 L 7.2456,13.2134 L 6.5111,13.3095 L 6.3842,13.3134 L 6.2996,13.3557 L 6.2958,14.0172 L 6.3689,14.0864 L 7.0341,14.1056 L 7.8032,14.1518 L 8.5723,14.1787 L 8.9992,14.1826 L 9.0992,14.2480 L 9.1415,14.5440 L 9.1721,14.5691 L 9.2047,14.5440 L 9.2470,14.2480 L 9.3470,14.1826 L 9.7739,14.1787 L 10.5430,14.1518 L 11.3121,14.1056 L 11.9774,14.0864 L 12.0504,14.0172 L 12.0465,13.3557 L 11.9619,13.3134 L 11.8350,13.3095 L 11.1005,13.2134 L 10.2738,13.1096 L 9.4547,12.9942 L 9.5777,12.1905 L 9.8238,10.8138 L 9.9738,9.7678 L 10.0084,9.4679 L 10.0276,9.1372 L 11.2467,9.0872 L 12.8272,9.0180 L 14.6692,8.9372 L 16.3689,8.8680 L 16.4266,8.8295 L 16.5265,8.8180 L 16.5265,8.4565 L 16.5534,7.7682 L 16.4573,7.6951 L 16.0574,7.6721 L 14.7230,7.5797 L 13.0886,7.4836 L 13.0886,7.0721 L 13.0502,6.9606 L 12.9541,6.8991 L 12.8694,6.8991 L 12.7849,6.9683 L 12.7579,7.0375 L 12.7426,7.1644 L 12.7387,7.4336 L 11.8849,7.4028 L 10.0699,7.2721 L 10.0699,7.0760 L 10.0392,6.8068 L 10.0353,6.1877 L 10.0314,6.0608 L 10.0045,6.0415 L 10.0006,5.7839 L 9.9622,5.4570 L 9.8661,4.9687 L 9.7777,4.6149 L 9.6853,4.5264 L 9.5354,4.4995 L 9.5046,4.3188 L 9.4623,4.1573 L 9.4085,4.0381 L 9.3623,3.9650 Z","a":[9.26,7.937]},"C402":{"d":"M 9.2448,1.8383 L 9.1385,1.8924 L 9.0341,2.0066 L 8.9436,2.1255 L 8.8341,2.2965 L 8.7250,2.5151 L 8.6512,2.7006 L 8.5845,2.9337 L 8.5039,3.3807 L 8.4227,3.9372 L 8.3731,4.4623 L 8.3375,4.9904 L 8.3137,5.5299 L 8.2972,6.2528 L 6.8301,6.2787 L 6.7918,6.2311 L 6.7898,5.7676 L 6.7799,5.1423 L 6.7799,5.0354 L 6.7541,4.9687 L 6.7112,4.9191 L 6.6709,4.8974 L 6.4926,4.8974 L 6.4327,4.8628 L 6.4280,4.7785 L 6.4068,4.6504 L 6.3712,4.5506 L 6.3164,4.4411 L 6.2311,4.3315 L 6.1500,4.4266 L 6.0885,4.5527 L 6.0286,4.7573 L 6.0193,4.8690 L 5.9717,4.8953 L 5.7909,4.8953 L 5.7552,4.9191 L 5.7102,4.9615 L 5.6839,5.0209 L 5.6746,5.1568 L 5.6653,6.2430 L 5.6059,6.3071 L 1.0077,6.5738 L 0.9767,6.6042 L 0.9746,6.8471 L 0.9364,6.8874 L 0.9152,6.9541 L 0.9152,7.0156 L 0.9457,7.0730 L 0.9813,7.1277 L 0.9839,7.8383 L 0.9958,7.8719 L 1.0289,7.8884 L 1.1074,7.8977 L 5.6555,8.4207 L 5.7790,8.5421 L 5.8219,8.8537 L 5.8363,8.8842 L 5.9433,8.9318 L 6.2311,9.0511 L 6.5918,8.9028 L 6.6213,8.8796 L 6.6399,8.8496 L 6.6647,8.6620 L 6.8244,8.4858 L 8.2062,8.4858 L 8.3075,8.5556 L 8.3075,9.0139 L 8.3173,9.2015 L 8.3339,9.4459 L 8.3721,9.7865 L 8.4269,10.1730 L 8.4935,10.5751 L 8.5581,10.9342 L 8.6248,11.2727 L 8.8935,12.6948 L 6.2094,13.0002 L 6.1717,13.0168 L 6.1350,13.0385 L 6.1051,13.0700 L 6.0849,13.1082 L 6.0735,13.1563 L 6.0720,13.3754 L 6.0849,13.5020 L 6.1200,13.6963 L 6.2063,14.0513 L 9.1493,14.3325 L 9.1679,14.6497 L 9.1927,14.9769 L 9.2543,15.4270 L 9.2961,14.9769 L 9.3214,14.6497 L 9.3395,14.3325 L 12.2825,14.0513 L 12.3693,13.6963 L 12.4039,13.5020 L 12.4173,13.3754 L 12.4152,13.1563 L 12.4039,13.1082 L 12.3837,13.0700 L 12.3543,13.0385 L 12.3176,13.0168 L 12.2793,13.0002 L 9.5953,12.6948 L 9.8645,11.2727 L 9.9306,10.9342 L 9.9957,10.5751 L 10.0619,10.1730 L 10.1167,9.7865 L 10.1549,9.4459 L 10.1715,9.2015 L 10.1818,9.0139 L 10.1818,8.5556 L 10.2831,8.4858 L 11.6649,8.4858 L 11.8241,8.6620 L 11.8494,8.8496 L 11.8675,8.8796 L 11.8974,8.9028 L 12.2581,9.0511 L 12.5455,8.9318 L 12.6529,8.8842 L 12.6669,8.8537 L 12.7098,8.5421 L 12.8333,8.4207 L 17.3813,7.8977 L 17.4599,7.8884 L 17.4930,7.8719 L 17.5048,7.8383 L 17.5074,7.1277 L 17.5431,7.0730 L 17.5741,7.0156 L 17.5741,6.9541 L 17.5524,6.8874 L 17.5147,6.8471 L 17.5121,6.6042 L 17.4811,6.5738 L 12.8834,6.3071 L 12.8240,6.2430 L 12.8142,5.1568 L 12.8049,5.0209 L 12.7785,4.9615 L 12.7336,4.9191 L 12.6979,4.8953 L 12.5171,4.8953 L 12.4695,4.8690 L 12.4602,4.7573 L 12.4008,4.5527 L 12.3388,4.4266 L 12.2582,4.3315 L 12.1724,4.4411 L 12.1176,4.5506 L 12.0819,4.6504 L 12.0607,4.7785 L 12.0566,4.8628 L 11.9967,4.8974 L 11.8184,4.8974 L 11.7776,4.9191 L 11.7352,4.9687 L 11.7088,5.0354 L 11.7088,5.1423 L 11.6996,5.7676 L 11.6970,6.2311 L 11.6587,6.2787 L 10.1921,6.2528 L 10.1756,5.5299 L 10.1518,4.9904 L 10.1162,4.4623 L 10.0661,3.9372 L 9.9854,3.3807 L 9.9043,2.9337 L 9.8376,2.7006 L 9.7643,2.5151 L 9.6547,2.2965 L 9.5452,2.1255 L 9.4552,2.0066 L 9.3503,1.8924 Z","a":[9.26,7.937]},"A225":{"d":"M 9.2856,0.3678 L 9.1695,0.3984 L 9.0196,0.5545 L 8.8511,0.8191 L 8.7168,1.1379 L 8.6181,1.4883 L 8.5256,1.9570 L 8.4910,2.1549 L 8.4367,2.6934 L 8.4331,5.4601 L 8.3344,5.6162 L 8.1116,5.8327 L 7.3592,6.3908 L 7.3561,5.8105 L 7.3081,5.4534 L 7.2476,5.3961 L 6.7629,5.3961 L 6.7024,5.4565 L 6.6673,5.8265 L 6.6673,6.2311 L 6.6962,6.5055 L 6.8301,6.5055 L 6.8301,6.7474 L 5.8451,7.4202 L 5.8580,7.0730 L 5.8358,6.6869 L 5.8007,6.4415 L 5.7366,6.4161 L 5.2684,6.4161 L 5.1935,6.4911 L 5.1661,6.8559 L 5.1661,7.1143 L 5.1852,7.5189 L 5.2395,7.5763 L 5.3289,7.5763 L 5.3289,7.7706 L 4.2804,8.5008 L 4.3026,8.1184 L 4.3026,7.7168 L 4.2773,7.4678 L 4.2354,7.3148 L 4.1749,7.2802 L 3.7450,7.2802 L 3.6907,7.3308 L 3.6618,7.4936 L 3.6334,7.7360 L 3.6334,8.1690 L 3.6778,8.4594 L 3.7703,8.4594 L 3.7703,8.6408 L 3.8690,8.6408 L 3.8690,8.7716 L 1.8164,10.1963 L 0.7803,10.9073 L 0.6434,11.0474 L 0.5447,11.2608 L 0.4775,11.5063 L 0.4584,11.7042 L 0.4584,12.0034 L 2.2149,11.3311 L 2.2149,11.4742 L 2.2784,11.5254 L 2.2784,11.3022 L 3.1548,10.9900 L 3.1548,11.1621 L 3.2158,11.2195 L 3.2158,10.9678 L 3.9104,10.7001 L 3.9104,10.8655 L 3.9806,10.8655 L 3.9806,10.6712 L 4.7103,10.3875 L 4.7103,10.5244 L 4.7790,10.5932 L 4.7790,10.3591 L 5.4338,10.1105 L 5.4338,10.3208 L 5.5454,10.2950 L 5.5454,10.0686 L 6.2115,9.8077 L 6.2115,9.9829 L 6.2916,10.0495 L 6.2916,9.7756 L 6.4952,9.6929 L 6.9226,9.6929 L 6.9639,9.9415 L 7.0104,9.9291 L 7.0595,9.6929 L 8.0414,9.6929 L 8.0414,9.9002 L 8.1241,9.9002 L 8.1241,9.6893 L 8.3886,9.6893 L 8.3886,11.0567 L 8.4336,11.7424 L 8.4429,12.4721 L 8.5354,13.3899 L 8.5705,14.0849 L 8.6119,14.5345 L 8.4651,14.6808 L 6.6166,15.7551 L 5.8549,16.1980 L 5.7113,15.8445 L 5.6601,15.8445 L 5.4689,16.3670 L 5.4152,16.7271 L 5.4152,17.0620 L 5.4787,17.4604 L 5.5997,17.6196 L 5.6730,18.1488 L 5.7655,17.6387 L 8.7648,16.5390 L 8.9049,16.5390 L 8.9529,16.9473 L 9.0072,17.0331 L 9.2785,17.0331 L 9.5622,17.0331 L 9.6165,16.9473 L 9.6640,16.5390 L 9.8041,16.5390 L 12.8034,17.6387 L 12.8959,18.1488 L 12.9692,17.6196 L 13.0907,17.4604 L 13.1542,17.0620 L 13.1542,16.7271 L 13.1000,16.3670 L 12.9088,15.8445 L 12.8576,15.8445 L 12.7145,16.1980 L 11.9528,15.7551 L 10.1038,14.6808 L 9.9570,14.5345 L 9.9989,14.0849 L 10.0340,13.3899 L 10.1260,12.4721 L 10.1358,11.7424 L 10.1802,11.0567 L 10.1802,9.6893 L 10.4448,9.6893 L 10.4448,9.9002 L 10.5280,9.9002 L 10.5280,9.6929 L 11.5093,9.6929 L 11.5590,9.9291 L 11.6049,9.9415 L 11.6468,9.6929 L 12.0737,9.6929 L 12.2778,9.7756 L 12.2778,10.0495 L 12.3574,9.9829 L 12.3574,9.8077 L 13.0235,10.0686 L 13.0235,10.2950 L 13.1351,10.3208 L 13.1351,10.1105 L 13.7903,10.3591 L 13.7903,10.5932 L 13.8586,10.5244 L 13.8586,10.3875 L 14.5887,10.6712 L 14.5887,10.8655 L 14.6585,10.8655 L 14.6585,10.7001 L 15.3536,10.9678 L 15.3536,11.2195 L 15.4140,11.1621 L 15.4140,10.9900 L 16.2904,11.3022 L 16.2904,11.5254 L 16.3545,11.4742 L 16.3545,11.3311 L 18.1105,12.0034 L 18.1105,11.7042 L 18.0914,11.5063 L 18.0247,11.2608 L 17.9255,11.0474 L 17.7885,10.9073 L 16.7530,10.1963 L 14.6998,8.7716 L 14.6998,8.6408 L 14.7991,8.6408 L 14.7991,8.4594 L 14.8916,8.4594 L 14.9360,8.1690 L 14.9360,7.7360 L 14.9071,7.4936 L 14.8787,7.3308 L 14.8244,7.2802 L 14.3940,7.2802 L 14.3335,7.3148 L 14.2922,7.4678 L 14.2668,7.7168 L 14.2668,8.1184 L 14.2891,8.5008 L 13.2405,7.7706 L 13.2405,7.5763 L 13.3294,7.5763 L 13.3837,7.5189 L 13.4028,7.1143 L 13.4028,6.8559 L 13.3759,6.4911 L 13.3010,6.4161 L 12.8323,6.4161 L 12.7687,6.4415 L 12.7336,6.6869 L 12.7114,7.0730 L 12.7238,7.4202 L 11.7388,6.7474 L 11.7388,6.5055 L 11.8732,6.5055 L 11.9016,6.2311 L 11.9016,5.8265 L 11.8665,5.4565 L 11.8060,5.3961 L 11.3213,5.3961 L 11.2608,5.4534 L 11.2133,5.8105 L 11.2102,6.3908 L 10.4578,5.8327 L 10.2345,5.6162 L 10.1358,5.4601 L 10.1327,2.6934 L 10.0785,2.1549 L 10.0433,1.9570 L 9.9508,1.4883 L 9.8521,1.1379 L 9.7183,0.8191 L 9.5493,0.5545 L 9.3994,0.3984 Z","a":[9.26,7.408]},"AN12":{"d":"M 9.1989,1.4366 L 9.1054,1.4599 L 8.9540,1.6257 L 8.8284,1.8438 L 8.7064,2.1213 L 8.5773,2.4500 L 8.5178,2.6830 L 8.4439,3.0267 L 8.3959,3.2887 L 8.3406,3.6732 L 8.2889,4.1057 L 8.2481,4.5382 L 8.2114,5.4617 L 8.2114,6.7329 L 8.1597,6.7701 L 8.1225,6.8513 L 8.1153,6.9474 L 7.2724,7.0988 L 7.2724,6.3634 L 7.2616,6.0642 L 7.1655,6.0642 L 7.1396,5.7206 L 7.1060,5.6467 L 7.0027,5.5211 L 6.8843,5.6612 L 6.8476,5.7170 L 6.7996,6.0534 L 6.7221,6.0534 L 6.7221,7.2063 L 5.0514,7.5127 L 5.0514,6.5112 L 4.9558,6.4487 L 4.9516,6.2492 L 4.9149,6.1159 L 4.8633,6.0162 L 4.7708,5.9314 L 4.6597,6.0348 L 4.6080,6.1567 L 4.6080,6.4523 L 4.5196,6.5262 L 4.5196,7.5572 L 4.4679,7.5980 L 0.6206,8.3478 L 0.5581,8.3850 L 0.5323,8.4589 L 0.5323,8.9431 L 0.6170,9.1131 L 8.1189,8.9540 L 8.1334,9.1018 L 8.1742,9.2201 L 8.2481,9.3571 L 8.2553,10.3436 L 8.2517,12.6530 L 8.2925,13.1816 L 8.3850,13.8503 L 8.5514,14.6043 L 8.5473,14.7412 L 8.4734,14.8151 L 6.5484,15.3210 L 6.4818,15.3510 L 6.4337,15.4213 L 6.4079,15.5283 L 6.4337,15.6502 L 6.4632,15.8497 L 6.5298,15.8977 L 8.9467,16.0827 L 8.9870,16.1602 L 8.9834,16.3339 L 9.0242,16.3964 L 9.0242,16.4817 L 9.1462,16.5664 L 9.1989,16.5887 L 9.2496,16.5664 L 9.3715,16.4817 L 9.3715,16.3964 L 9.4123,16.3339 L 9.4087,16.1602 L 9.4490,16.0827 L 11.8659,15.8977 L 11.9326,15.8497 L 11.9620,15.6502 L 11.9879,15.5283 L 11.9620,15.4213 L 11.9140,15.3510 L 11.8473,15.3210 L 9.9224,14.8151 L 9.8485,14.7412 L 9.8449,14.6043 L 10.0107,13.8503 L 10.1032,13.1816 L 10.1441,12.6530 L 10.1405,10.3436 L 10.1477,9.3571 L 10.2216,9.2201 L 10.2624,9.1018 L 10.2768,8.9540 L 17.7787,9.1131 L 17.8635,8.9431 L 17.8635,8.4589 L 17.8376,8.3850 L 17.7751,8.3478 L 13.9283,7.5980 L 13.8761,7.5572 L 13.8761,6.5262 L 13.7877,6.4523 L 13.7877,6.1567 L 13.7361,6.0348 L 13.6250,5.9314 L 13.5325,6.0162 L 13.4808,6.1159 L 13.4441,6.2492 L 13.4405,6.4487 L 13.3444,6.5112 L 13.3444,7.5127 L 11.6737,7.2063 L 11.6737,6.0534 L 11.5962,6.0534 L 11.5481,5.7170 L 11.5114,5.6612 L 11.3931,5.5211 L 11.2897,5.6467 L 11.2562,5.7206 L 11.2303,6.0642 L 11.1342,6.0642 L 11.1233,6.3634 L 11.1233,7.0988 L 10.2805,6.9474 L 10.2733,6.8513 L 10.2366,6.7701 L 10.1844,6.7329 L 10.1844,5.4617 L 10.1477,4.5382 L 10.1069,4.1057 L 10.0552,3.6732 L 9.9999,3.2887 L 9.9518,3.0267 L 9.8779,2.6830 L 9.8185,2.4500 L 9.6893,2.1213 L 9.5674,1.8438 L 9.4418,1.6257 L 9.2904,1.4599 Z","a":[9.26,8.202]},"E290":{"d":"M 9.2514,0.9198 L 9.1919,0.9400 L 9.0927,1.0279 L 8.9821,1.1736 L 8.9031,1.3172 L 8.8235,1.5203 L 8.7548,1.7301 L 8.6845,2.0304 L 8.6271,2.3968 L 8.5894,2.7301 L 8.5698,3.0169 L 8.5630,3.2132 L 8.5630,6.3588 L 8.5382,6.4239 L 8.5000,6.4973 L 8.4421,6.5862 L 8.3786,6.6570 L 8.3150,6.7076 L 7.5724,7.1029 L 7.5951,6.9841 L 7.6081,6.6673 L 7.6081,6.3252 L 7.5931,6.1247 L 7.5574,5.9826 L 7.5192,5.8994 L 7.4510,5.8157 L 7.1440,5.8028 L 6.9771,5.7976 L 6.6624,5.8208 L 6.5993,5.8689 L 6.5559,5.9676 L 6.5234,6.0844 L 6.4981,6.2616 L 6.4929,6.6952 L 6.5234,6.9867 L 6.5792,7.3944 L 6.7182,7.3944 L 6.7182,7.4988 L 6.7471,7.5484 L 2.2270,10.0304 L 2.1407,10.0966 L 2.0270,10.2283 L 1.6999,10.7074 L 1.5759,10.9203 L 1.5480,11.0443 L 1.5480,11.1890 L 1.5743,11.2045 L 1.6007,11.1781 L 1.6007,11.1053 L 2.1335,10.7275 L 2.2575,10.6691 L 4.3690,9.9596 L 4.3788,10.1064 L 4.4145,10.2841 L 4.4651,10.0836 L 4.4729,9.9291 L 5.8361,9.4806 L 5.8438,9.6578 L 5.8821,9.8480 L 5.9405,9.6532 L 5.9529,9.4475 L 6.8882,9.1741 L 7.4231,9.1741 L 7.4685,9.4124 L 7.5192,9.1762 L 8.3636,9.1762 L 8.5584,9.6098 L 8.5584,13.1227 L 8.5739,13.5258 L 8.6018,13.8069 L 8.6576,14.2508 L 8.7460,14.7097 L 8.9134,15.4724 L 7.1518,16.6688 L 7.0959,16.7804 L 7.0401,16.9628 L 6.9998,17.1349 L 6.9998,17.3173 L 9.0555,16.7902 L 9.0907,17.1173 L 9.1366,17.4062 L 9.1919,17.6067 L 9.2602,17.6067 L 9.3289,17.6067 L 9.3842,17.4062 L 9.4302,17.1173 L 9.4653,16.7902 L 11.5210,17.3173 L 11.5210,17.1349 L 11.4807,16.9628 L 11.4249,16.7804 L 11.3691,16.6688 L 9.6074,15.4724 L 9.7749,14.7097 L 9.8632,14.2508 L 9.9190,13.8069 L 9.9469,13.5258 L 9.9624,13.1227 L 9.9624,9.6098 L 10.1573,9.1762 L 11.0017,9.1762 L 11.0523,9.4124 L 11.0978,9.1741 L 11.6326,9.1741 L 12.5680,9.4475 L 12.5809,9.6532 L 12.6388,9.8480 L 12.6770,9.6578 L 12.6848,9.4806 L 14.0480,9.9291 L 14.0558,10.0836 L 14.1065,10.2841 L 14.1421,10.1064 L 14.1519,9.9596 L 16.2634,10.6691 L 16.3875,10.7275 L 16.9202,11.1053 L 16.9202,11.1781 L 16.9466,11.2045 L 16.9729,11.1890 L 16.9729,11.0443 L 16.9450,10.9203 L 16.8210,10.7074 L 16.4939,10.2283 L 16.3802,10.0966 L 16.2939,10.0304 L 11.7738,7.5484 L 11.8027,7.4988 L 11.8027,7.3944 L 11.9417,7.3944 L 11.9975,6.9867 L 12.0280,6.6952 L 12.0228,6.2616 L 11.9975,6.0844 L 11.9649,5.9676 L 11.9215,5.8689 L 11.8585,5.8208 L 11.5438,5.7976 L 11.3769,5.8028 L 11.0699,5.8157 L 11.0017,5.8994 L 10.9635,5.9826 L 10.9283,6.1247 L 10.9128,6.3252 L 10.9128,6.6673 L 10.9257,6.9841 L 10.9485,7.1029 L 10.2059,6.7076 L 10.1423,6.6570 L 10.0788,6.5862 L 10.0209,6.4973 L 9.9827,6.4239 L 9.9579,6.3588 L 9.9579,3.2132 L 9.9511,3.0169 L 9.9314,2.7301 L 9.8937,2.3968 L 9.8364,2.0304 L 9.7661,1.7301 L 9.6973,1.5203 L 9.6178,1.3172 L 9.5387,1.1736 L 9.4281,1.0279 L 9.3289,0.9400 Z","a":[9.26,7.673]},"A343":{"d":"M 9.2613,0.6332 L 9.2142,0.6456 L 9.1553,0.6952 L 9.0974,0.7701 L 9.0370,0.8673 L 8.9755,0.9954 L 8.8546,1.2812 L 8.7646,1.5359 L 8.6980,1.7540 L 8.6380,1.9943 L 8.5998,2.1731 L 8.5698,2.3452 L 8.5419,2.5214 L 8.5171,2.7741 L 8.5037,2.9560 L 8.4923,3.1989 L 8.4923,7.0638 L 7.0562,7.9459 L 7.0697,7.8301 L 7.0821,7.7278 L 7.0898,7.6141 L 7.0960,7.4901 L 7.0960,7.3754 L 7.0846,7.2348 L 7.0722,7.0529 L 7.0686,6.9775 L 7.0464,6.9553 L 6.5022,6.9553 L 6.4774,6.9713 L 6.4712,7.0565 L 6.4614,7.1821 L 6.4552,7.2891 L 6.4526,7.3888 L 6.4526,7.5402 L 6.4552,7.6441 L 6.4650,7.7500 L 6.4883,7.9531 L 6.5157,8.1180 L 6.5441,8.2534 L 4.3727,9.6011 L 4.3835,9.4998 L 4.3970,9.3660 L 4.4006,9.2104 L 4.4032,9.0383 L 4.4021,8.8523 L 4.3897,8.6885 L 4.3851,8.6291 L 4.3654,8.6130 L 3.8171,8.6130 L 3.7923,8.6332 L 3.7779,8.7918 L 3.7701,9.0161 L 3.7701,9.2120 L 3.7753,9.3660 L 3.7887,9.5050 L 3.8001,9.6181 L 3.8280,9.7820 L 3.8528,9.9163 L 1.4374,11.4129 L 1.4152,11.4325 L 1.3992,11.4583 L 1.3930,11.5090 L 1.3920,11.5917 L 1.1873,12.0583 L 1.1873,12.2774 L 1.3785,12.1410 L 4.0068,10.9927 L 4.0058,11.0506 L 4.0156,11.1075 L 4.0290,11.1664 L 4.0425,11.2196 L 4.0549,11.2527 L 4.0699,11.2899 L 4.0859,11.3240 L 4.1081,11.3255 L 4.1226,11.2981 L 4.1339,11.2599 L 4.1458,11.2216 L 4.1598,11.1751 L 4.1717,11.1219 L 4.1804,11.0593 L 4.1939,10.9224 L 4.4368,10.8423 L 4.4342,10.8981 L 4.4466,10.9756 L 4.4600,11.0299 L 4.4734,11.0718 L 4.4848,11.1074 L 4.4993,11.1493 L 4.5143,11.1715 L 4.5391,11.1700 L 4.5453,11.1467 L 4.5551,11.1163 L 4.5659,11.0780 L 4.5809,11.0372 L 4.5933,10.9866 L 4.6068,10.9214 L 4.6156,10.8842 L 4.6192,10.7809 L 5.3147,10.5396 L 5.3147,10.5902 L 5.3246,10.6569 L 5.3385,10.7168 L 5.3509,10.7602 L 5.3654,10.8021 L 5.3767,10.8388 L 5.3912,10.8672 L 5.4160,10.8662 L 5.4258,10.8424 L 5.4408,10.8083 L 5.4517,10.7685 L 5.4677,10.7230 L 5.4827,10.6631 L 5.4925,10.6063 L 5.5034,10.4729 L 6.1922,10.2378 L 6.1932,10.2884 L 6.2031,10.3515 L 6.2165,10.4094 L 6.2304,10.4523 L 6.2439,10.4905 L 6.2547,10.5272 L 6.2723,10.5670 L 6.2992,10.5655 L 6.3090,10.5288 L 6.3240,10.4942 L 6.3364,10.4487 L 6.3483,10.3996 L 6.3607,10.3490 L 6.3731,10.2689 L 6.3819,10.1717 L 7.0397,9.9386 L 7.1585,9.9386 L 7.1560,10.0141 L 7.1575,10.0802 L 7.1710,10.1433 L 7.1834,10.1913 L 7.1968,10.2368 L 7.2066,10.2776 L 7.2216,10.3097 L 7.2438,10.3329 L 7.2717,10.2947 L 7.2769,10.2673 L 7.2867,10.2306 L 7.3002,10.1826 L 7.3136,10.1355 L 7.3250,10.0606 L 7.3374,9.9387 L 8.3668,9.9387 L 8.3683,9.9965 L 8.3781,10.0792 L 8.3890,10.1459 L 8.4065,10.2218 L 8.4184,10.2699 L 8.4324,10.3257 L 8.4443,10.3857 L 8.4691,10.4523 L 8.4887,10.5076 L 8.4887,12.2052 L 8.4965,12.4698 L 8.5027,12.6460 L 8.5161,12.8847 L 8.5295,13.0759 L 8.5564,13.3539 L 8.5812,13.5622 L 8.6107,13.7953 L 8.6329,13.9689 L 8.6577,14.1213 L 8.6809,14.2691 L 8.7352,14.6081 L 8.7600,14.7864 L 8.9274,15.8716 L 6.7596,17.1599 L 6.7327,17.1858 L 6.6945,17.2374 L 6.6671,17.3165 L 6.6599,17.3940 L 6.6180,17.8446 L 9.1155,17.1351 L 9.1874,17.8301 L 9.2096,17.8482 L 9.2639,17.8503 L 9.3119,17.8482 L 9.3336,17.8301 L 9.4055,17.1351 L 11.9030,17.8446 L 11.8611,17.3940 L 11.8539,17.3165 L 11.8265,17.2374 L 11.7888,17.1858 L 11.7614,17.1599 L 9.5936,15.8716 L 9.7610,14.7864 L 9.7858,14.6081 L 9.8401,14.2691 L 9.8633,14.1213 L 9.8881,13.9689 L 9.9104,13.7953 L 9.9398,13.5622 L 9.9646,13.3539 L 9.9915,13.0759 L 10.0049,12.8847 L 10.0189,12.6460 L 10.0251,12.4698 L 10.0323,12.2052 L 10.0323,10.5076 L 10.0519,10.4523 L 10.0767,10.3857 L 10.0886,10.3252 L 10.1026,10.2699 L 10.1150,10.2218 L 10.1320,10.1459 L 10.1429,10.0792 L 10.1532,9.9965 L 10.1542,9.9387 L 11.1836,9.9387 L 11.1960,10.0606 L 11.2074,10.1355 L 11.2208,10.1826 L 11.2342,10.2306 L 11.2440,10.2673 L 11.2492,10.2947 L 11.2777,10.3329 L 11.2994,10.3097 L 11.3144,10.2777 L 11.3242,10.2368 L 11.3376,10.1914 L 11.3500,10.1433 L 11.3639,10.0803 L 11.3649,10.0141 L 11.3623,9.9387 L 11.4817,9.9387 L 12.1390,10.1717 L 12.1478,10.2689 L 12.1602,10.3490 L 12.1726,10.3996 L 12.1845,10.4487 L 12.1969,10.4942 L 12.2119,10.5288 L 12.2217,10.5655 L 12.2491,10.5670 L 12.2662,10.5272 L 12.2770,10.4905 L 12.2910,10.4523 L 12.3044,10.4094 L 12.3178,10.3515 L 12.3276,10.2885 L 12.3286,10.2378 L 13.0175,10.4729 L 13.0283,10.6063 L 13.0381,10.6631 L 13.0531,10.7231 L 13.0691,10.7685 L 13.0800,10.8083 L 13.0950,10.8424 L 13.1048,10.8662 L 13.1296,10.8672 L 13.1441,10.8388 L 13.1554,10.8021 L 13.1704,10.7602 L 13.1823,10.7168 L 13.1963,10.6569 L 13.2061,10.5902 L 13.2061,10.5396 L 13.9016,10.7809 L 13.9057,10.8842 L 13.9140,10.9215 L 13.9275,10.9866 L 13.9399,11.0372 L 13.9548,11.0780 L 13.9657,11.1163 L 13.9755,11.1468 L 13.9817,11.1700 L 14.0065,11.1715 L 14.0215,11.1493 L 14.0360,11.1074 L 14.0473,11.0718 L 14.0608,11.0299 L 14.0742,10.9756 L 14.0866,10.8981 L 14.0840,10.8423 L 14.3269,10.9224 L 14.3403,11.0594 L 14.3491,11.1219 L 14.3610,11.1751 L 14.3750,11.2216 L 14.3874,11.2599 L 14.3982,11.2981 L 14.4132,11.3255 L 14.4349,11.3240 L 14.4509,11.2899 L 14.4659,11.2527 L 14.4783,11.2196 L 14.4918,11.1664 L 14.5052,11.1075 L 14.5155,11.0506 L 14.5140,10.9927 L 17.1423,12.1410 L 17.3335,12.2774 L 17.3335,12.0583 L 17.1289,11.5917 L 17.1279,11.5090 L 17.1217,11.4584 L 17.1056,11.4325 L 17.0834,11.4129 L 14.6681,9.9163 L 14.6929,9.7820 L 14.7213,9.6182 L 14.7321,9.5050 L 14.7456,9.3660 L 14.7508,9.2120 L 14.7508,9.0161 L 14.7430,8.7918 L 14.7285,8.6332 L 14.7037,8.6130 L 14.1559,8.6130 L 14.1358,8.6291 L 14.1311,8.6885 L 14.1187,8.8523 L 14.1177,9.0383 L 14.1203,9.2104 L 14.1239,9.3660 L 14.1373,9.4998 L 14.1482,9.6011 L 11.9767,8.2534 L 12.0051,8.1180 L 12.0325,7.9531 L 12.0558,7.7500 L 12.0656,7.6441 L 12.0682,7.5402 L 12.0682,7.3888 L 12.0656,7.2891 L 12.0594,7.1821 L 12.0496,7.0565 L 12.0434,6.9713 L 12.0186,6.9553 L 11.4744,6.9553 L 11.4522,6.9775 L 11.4486,7.0529 L 11.4362,7.2348 L 11.4254,7.3754 L 11.4254,7.4901 L 11.4311,7.6141 L 11.4389,7.7278 L 11.4513,7.8301 L 11.4647,7.9459 L 10.0286,7.0638 L 10.0286,3.1989 L 10.0173,2.9560 L 10.0038,2.7741 L 9.9790,2.5214 L 9.9511,2.3452 L 9.9212,2.1731 L 9.8834,1.9943 L 9.8230,1.7540 L 9.7563,1.5359 L 9.6664,1.2812 L 9.5455,0.9954 L 9.4840,0.8673 L 9.4240,0.7701 L 9.3662,0.6952 L 9.3067,0.6456 Z","a":[9.26,8.467]},"A337":{"d":"M 9.2708,0.5266 L 9.2113,0.5498 L 9.0780,0.6863 L 8.9380,0.9328 L 8.7483,1.4061 L 8.4584,2.2686 L 8.3819,2.3921 L 8.2951,2.5885 L 8.2150,2.8815 L 8.1354,3.3481 L 8.1085,3.6577 L 8.1085,7.1660 L 7.0394,7.7721 L 7.0590,7.5592 L 7.1556,7.5592 L 7.1923,7.3060 L 7.2290,7.0259 L 7.2590,6.8027 L 7.2590,6.4730 L 7.2425,6.2963 L 7.2125,6.1764 L 7.1556,6.0963 L 6.4265,6.0963 L 6.3764,6.1366 L 6.3329,6.2198 L 6.3030,6.4632 L 6.3030,6.8027 L 6.3231,7.0693 L 6.3665,7.5391 L 6.4694,7.5391 L 6.4993,8.0786 L 2.3218,10.5172 L 2.2619,10.5642 L 2.2056,10.6340 L 2.1787,10.7074 L 2.1787,11.5533 L 2.2820,11.5533 L 2.2820,11.4432 L 3.5848,10.9771 L 3.5848,11.1404 L 3.6148,11.2701 L 3.6504,11.2608 L 3.6814,11.1637 L 3.6943,10.9373 L 4.4375,10.6671 L 4.4375,10.8774 L 4.4674,10.9936 L 4.5176,10.8670 L 4.5475,10.6242 L 5.0901,10.4273 L 5.0937,10.6640 L 5.1268,10.7441 L 5.1470,10.7441 L 5.1904,10.5942 L 5.1971,10.3906 L 5.9567,10.1074 L 5.9531,10.2707 L 5.9831,10.3808 L 6.0131,10.4309 L 6.0596,10.3508 L 6.0865,10.0578 L 6.3929,9.9410 L 7.4026,9.9410 L 7.4125,10.1575 L 7.4523,10.2743 L 7.5024,10.1741 L 7.5225,9.9379 L 8.1122,9.9379 L 8.1122,11.9564 L 8.1385,12.2964 L 8.1855,12.7563 L 8.2920,13.2891 L 8.7850,15.8109 L 6.8259,17.2238 L 6.8259,16.9871 L 6.8094,16.9039 L 6.7794,16.8569 L 6.7396,16.8935 L 6.7262,17.1602 L 6.7360,17.8263 L 6.7226,18.0397 L 6.7825,18.0397 L 9.0547,17.2170 L 9.1746,17.8563 L 9.2346,18.0299 L 9.2682,18.1162 L 9.3012,18.0299 L 9.3612,17.8563 L 9.4811,17.2170 L 11.7533,18.0397 L 11.8132,18.0397 L 11.7998,17.8263 L 11.8101,17.1602 L 11.7967,16.8935 L 11.7564,16.8569 L 11.7264,16.9039 L 11.7099,16.9871 L 11.7099,17.2238 L 9.7508,15.8109 L 10.2443,13.2891 L 10.3508,12.7563 L 10.3973,12.2964 L 10.4242,11.9564 L 10.4242,9.9379 L 11.0138,9.9379 L 11.0334,10.1741 L 11.0836,10.2743 L 11.1239,10.1575 L 11.1337,9.9410 L 12.1429,9.9410 L 12.4494,10.0578 L 12.4762,10.3508 L 12.5227,10.4309 L 12.5527,10.3808 L 12.5827,10.2707 L 12.5796,10.1074 L 13.3392,10.3906 L 13.3459,10.5942 L 13.3888,10.7440 L 13.4090,10.7440 L 13.4426,10.6639 L 13.4457,10.4273 L 13.9888,10.6242 L 14.0188,10.8670 L 14.0684,10.9936 L 14.0989,10.8774 L 14.0989,10.6670 L 14.8415,10.9373 L 14.8549,11.1637 L 14.8854,11.2608 L 14.9216,11.2701 L 14.9515,11.1404 L 14.9515,10.9771 L 16.2543,11.4432 L 16.2543,11.5533 L 16.3571,11.5533 L 16.3571,10.7074 L 16.3308,10.6340 L 16.2739,10.5642 L 16.2140,10.5172 L 12.0365,8.0786 L 12.0664,7.5391 L 12.1698,7.5391 L 12.2132,7.0693 L 12.2329,6.8027 L 12.2329,6.4632 L 12.2029,6.2198 L 12.1595,6.1366 L 12.1099,6.0963 L 11.3802,6.0963 L 11.3233,6.1764 L 11.2934,6.2963 L 11.2768,6.4730 L 11.2768,6.8027 L 11.3068,7.0259 L 11.3435,7.3060 L 11.3802,7.5592 L 11.4768,7.5592 L 11.4970,7.7721 L 10.4273,7.1660 L 10.4273,3.6577 L 10.4009,3.3481 L 10.3208,2.8815 L 10.2407,2.5885 L 10.1544,2.3921 L 10.0774,2.2686 L 9.7875,1.4061 L 9.5979,0.9328 L 9.4578,0.6863 L 9.3245,0.5498 Z","a":[9.26,8.467]},"RV9":{"d":"M 9.2608,3.3616 C 9.0863,3.3616 8.9221,3.9307 8.9221,4.1197 L 8.5890,4.1197 C 8.5155,4.1197 8.5208,4.1173 8.4945,4.2642 L 8.2847,5.6969 L 8.2479,6.4789 L 1.9661,6.4789 C 1.7690,6.4789 1.4332,6.6031 1.3919,6.9718 L 1.1388,9.0138 L 8.3239,9.0138 L 8.9293,12.7536 L 6.5251,12.7536 C 6.4060,12.7536 6.3100,12.8727 6.3100,12.9687 L 6.3100,14.3757 L 8.8522,14.3757 L 9.0905,13.8194 L 9.1586,14.0011 L 9.2097,14.6935 C 9.1813,14.7900 9.1932,14.7496 9.1813,14.7900 L 9.1927,14.9944 L 9.2604,15.0944 L 9.3283,14.9944 L 9.3396,14.7900 C 9.3112,14.6935 9.3175,14.7148 9.3112,14.6935 L 9.3622,14.0011 L 9.4304,13.8194 L 9.6687,14.3757 L 12.2109,14.3757 L 12.2109,12.9687 C 12.2109,12.8727 12.1150,12.7536 11.9958,12.7536 L 9.5916,12.7536 L 10.1970,9.0138 L 17.3821,9.0138 L 17.1289,6.9718 C 17.0877,6.6031 16.7520,6.4789 16.5548,6.4789 L 10.2729,6.4789 L 10.2362,5.6969 L 10.0263,4.2642 C 10.0001,4.1173 10.0053,4.1197 9.9318,4.1197 L 9.5988,4.1197 C 9.5988,3.9307 9.4351,3.3616 9.2606,3.3616 Z","a":[9.26,7.673]},"B772":{"d":"M 9.2980,0.7327 C 9.1703,0.7327 9.0358,0.9606 8.9743,1.1065 L 8.8238,1.4529 C 8.6737,1.7747 8.4796,2.5256 8.4796,4.0310 L 8.4796,6.4302 C 8.4796,6.6200 8.3272,6.7619 8.2469,6.8198 L 7.2215,7.4865 C 7.2502,7.3461 7.2646,7.1887 7.2645,6.8684 C 7.2645,6.3940 7.2103,6.1568 7.1767,6.1568 L 6.2410,6.1568 C 6.2070,6.1568 6.1439,6.4520 6.1439,6.8310 C 6.1439,7.2253 6.1775,7.5893 6.2205,7.5893 L 6.3419,7.5893 C 6.3419,7.6584 6.4390,7.9422 6.4614,7.9815 L 1.5028,11.2666 C 1.2824,11.4217 1.2712,11.4217 1.2395,11.9726 L 4.0783,11.0313 C 4.0783,11.1098 4.1023,11.2747 4.1417,11.2852 C 4.1737,11.2766 4.1886,11.0839 4.1886,10.9969 L 5.5313,10.5495 C 5.5313,10.6289 5.5502,10.7988 5.5788,10.8065 C 5.6085,10.7986 5.6402,10.5961 5.6402,10.5161 L 6.3969,10.2595 L 6.9670,10.2595 C 6.9670,10.3787 6.9995,10.5485 7.0265,10.5642 C 7.0572,10.5471 7.0861,10.3912 7.0861,10.2641 L 8.4799,10.2641 L 8.4799,13.5423 C 8.4799,13.8726 8.5942,14.6563 8.7572,15.2644 C 8.7708,15.3152 8.7437,15.3511 8.7216,15.3708 L 6.4088,17.2347 C 6.3759,17.2675 6.3658,17.4472 6.3658,17.5428 C 6.3658,17.6562 6.3753,17.8878 6.4088,17.8807 L 9.0571,16.9493 C 9.0727,16.9433 9.0547,16.7487 9.0416,16.6759 L 9.2685,17.6156 L 9.3341,17.6156 L 9.5610,16.6747 C 9.5431,16.7499 9.5503,16.9469 9.5503,16.9469 L 12.1963,17.8878 C 12.2094,17.8962 12.2237,17.6657 12.2237,17.5559 C 12.2237,17.4269 12.2189,17.2645 12.2022,17.2454 L 9.8727,15.3696 C 9.8467,15.3448 9.8350,15.3098 9.8476,15.2737 C 9.9952,14.6593 10.1273,13.8741 10.1273,13.5425 L 10.1273,10.2615 L 11.5176,10.2615 C 11.5176,10.3595 11.5485,10.5474 11.5737,10.5588 C 11.5967,10.5475 11.6254,10.3621 11.6254,10.2629 L 12.2012,10.2629 L 12.9703,10.5214 C 12.9703,10.6285 13.0027,10.7847 13.0238,10.7969 C 13.0502,10.7899 13.0802,10.6602 13.0802,10.5536 L 14.4053,10.9941 C 14.4053,11.1025 14.4416,11.2740 14.4680,11.2892 C 14.4933,11.2746 14.5187,11.1392 14.5187,11.0262 L 17.3511,11.9734 C 17.3425,11.4299 17.3309,11.4168 17.0910,11.2617 L 12.1420,7.9897 C 12.1733,7.9219 12.2697,7.6586 12.2697,7.5935 L 12.3870,7.5935 C 12.4104,7.5935 12.4574,7.2598 12.4574,6.8428 C 12.4574,6.4284 12.4026,6.1547 12.3557,6.1547 L 11.4330,6.1547 C 11.3912,6.1547 11.3340,6.3737 11.3340,6.8559 C 11.3340,7.1609 11.3556,7.4186 11.3731,7.4840 L 10.3513,6.8141 C 10.2445,6.7464 10.1324,6.6630 10.1324,6.4857 L 10.1324,4.0305 C 10.1324,2.5266 9.9260,1.7756 9.7749,1.4551 L 9.6294,1.1087 C 9.5694,0.9601 9.4383,0.7327 9.2979,0.7327 Z","a":[9.26,8.467]},"A332":{"d":"M 9.2888,0.7379 L 9.2480,0.7457 L 9.1948,0.7834 L 9.1281,0.8656 L 9.0578,0.9720 L 9.0010,1.0919 L 8.9436,1.2175 L 8.8770,1.3808 L 8.8088,1.5596 L 8.7385,1.7668 L 8.6853,1.9477 L 8.6243,2.1988 L 8.5555,2.5678 L 8.5178,2.7637 L 8.4930,3.0226 L 8.4718,3.3590 L 8.4718,6.5929 L 6.7830,7.6254 L 6.9029,7.0683 L 7.0130,7.0683 L 7.0456,6.8265 L 7.0792,6.4265 L 7.0792,6.0963 L 7.0652,5.8994 L 7.0394,5.6534 L 7.0208,5.6394 L 6.2275,5.6394 L 6.1996,5.6596 L 6.1774,5.9030 L 6.1614,6.0704 L 6.1614,6.3826 L 6.1795,6.7045 L 6.2218,7.0668 L 6.3386,7.0668 L 6.4756,7.7251 L 6.5257,7.7251 L 6.5278,7.7778 L 0.9746,11.2128 L 0.9142,11.2489 L 0.8723,11.2789 L 0.8542,11.3192 L 0.8439,11.4701 L 0.6305,11.9393 L 0.6305,12.1812 L 0.8361,12.0339 L 4.1196,10.6407 L 4.1176,10.7373 L 4.1377,10.8257 L 4.1703,10.9327 L 4.1982,11.0009 L 4.2183,11.0009 L 4.2525,10.9043 L 4.2871,10.7818 L 4.3088,10.6691 L 4.3088,10.5740 L 5.0602,10.3208 L 5.0622,10.4133 L 5.0901,10.5322 L 5.1201,10.6288 L 5.1423,10.6707 L 5.1666,10.6707 L 5.2131,10.5301 L 5.2431,10.3828 L 5.2514,10.2521 L 6.0002,9.9963 L 6.0002,10.0873 L 6.0265,10.1875 L 6.0648,10.3084 L 6.0870,10.3487 L 6.1092,10.3487 L 6.1433,10.2459 L 6.1774,10.1152 L 6.1976,10.0144 L 6.1976,9.9281 L 6.9045,9.6785 L 7.0290,9.6785 L 7.0332,9.8134 L 7.0533,9.9322 L 7.0916,10.0449 L 7.1158,10.0971 L 7.1458,10.0971 L 7.1779,9.9782 L 7.2182,9.8273 L 7.2285,9.6764 L 8.3318,9.6764 L 8.3478,9.8314 L 8.3742,9.9741 L 8.4062,10.1033 L 8.4687,10.2965 L 8.4687,12.0298 L 8.4925,12.4566 L 8.5349,12.9904 L 8.5773,13.3646 L 8.6336,13.7656 L 8.7245,14.3392 L 8.8046,14.8668 L 8.8832,15.3722 L 8.9318,15.6921 L 6.6363,17.0574 L 6.5779,17.1095 L 6.5319,17.1803 L 6.5097,17.2589 L 6.4570,17.8082 L 9.1369,17.0455 L 9.2134,17.7984 L 9.2893,17.7985 L 9.3643,17.7984 L 9.4408,17.0455 L 12.1207,17.8082 L 12.0680,17.2589 L 12.0463,17.1803 L 11.9998,17.1095 L 11.9414,17.0574 L 9.6459,15.6921 L 9.6945,15.3722 L 9.7730,14.8668 L 9.8537,14.3392 L 9.9441,13.7656 L 10.0004,13.3646 L 10.0428,12.9904 L 10.0852,12.4566 L 10.1089,12.0298 L 10.1089,10.2965 L 10.1715,10.1033 L 10.2040,9.9741 L 10.2299,9.8314 L 10.2459,9.6764 L 11.3497,9.6764 L 11.3595,9.8273 L 11.3998,9.9782 L 11.4318,10.0971 L 11.4623,10.0971 L 11.4861,10.0449 L 11.5243,9.9322 L 11.5445,9.8134 L 11.5486,9.6785 L 11.6737,9.6785 L 12.3801,9.9281 L 12.3801,10.0144 L 12.4002,10.1151 L 12.4343,10.2459 L 12.4689,10.3487 L 12.4912,10.3487 L 12.5129,10.3084 L 12.5511,10.1875 L 12.5775,10.0872 L 12.5775,9.9963 L 13.3263,10.2521 L 13.3346,10.3828 L 13.3650,10.5301 L 13.4110,10.6707 L 13.4353,10.6707 L 13.4575,10.6288 L 13.4875,10.5322 L 13.5159,10.4133 L 13.5180,10.3208 L 14.2689,10.5740 L 14.2689,10.6691 L 14.2911,10.7818 L 14.3252,10.9042 L 14.3593,11.0009 L 14.3795,11.0009 L 14.4079,10.9327 L 14.4399,10.8257 L 14.4601,10.7373 L 14.4580,10.6407 L 17.7420,12.0339 L 17.9472,12.1811 L 17.9472,11.9393 L 17.7338,11.4701 L 17.7240,11.3192 L 17.7059,11.2789 L 17.6635,11.2489 L 17.6030,11.2127 L 12.0499,7.7778 L 12.0520,7.7251 L 12.1026,7.7251 L 12.2396,7.0667 L 12.3564,7.0667 L 12.3982,6.7045 L 12.4163,6.3825 L 12.4163,6.0704 L 12.4003,5.9030 L 12.3781,5.6596 L 12.3502,5.6394 L 11.5569,5.6394 L 11.5388,5.6534 L 11.5125,5.8994 L 11.4985,6.0963 L 11.4985,6.4265 L 11.5321,6.8265 L 11.5647,7.0683 L 11.6753,7.0683 L 11.7946,7.6254 L 10.1058,6.5929 L 10.1058,3.3590 L 10.0847,3.0226 L 10.0604,2.7637 L 10.0221,2.5678 L 9.9534,2.1988 L 9.8929,1.9477 L 9.8397,1.7668 L 9.7689,1.5596 L 9.7007,1.3808 L 9.6340,1.2175 L 9.5772,1.0919 L 9.5198,0.9720 L 9.4496,0.8656 L 9.3829,0.7834 L 9.3297,0.7457 Z","a":[9.26,8.202]},"AS65":{"d":"M 9.0578,2.8104 L 9.2617,2.8636 L 9.4036,2.9611 L 9.5188,3.1917 L 9.6252,3.5906 L 9.7050,3.9098 L 9.7249,4.0073 L 9.8114,4.0073 L 9.8114,3.6815 L 9.8457,3.6617 L 9.8838,3.6999 L 9.8838,4.1203 L 9.7604,4.1203 L 9.8757,4.4461 L 10.1106,5.0778 L 10.2968,6.0774 L 10.3300,6.6249 L 10.3300,7.8860 L 10.8309,7.8860 L 10.8309,7.3253 L 10.8730,7.0261 L 10.9440,6.8155 L 10.9950,6.7180 L 10.9950,6.4343 L 11.1191,6.4343 L 11.1191,6.7224 L 11.1701,6.8177 L 11.2476,7.0083 L 11.3274,7.3319 L 11.3274,9.5617 L 11.2875,9.9340 L 11.2099,10.2066 L 11.0858,10.3884 L 10.9551,10.1867 L 10.8597,9.8919 L 10.8597,9.0740 L 10.2502,9.0740 L 10.2502,9.2536 L 10.1272,9.3766 L 10.1017,9.6614 L 10.0596,9.9606 L 10.0197,10.2089 L 9.9776,10.5192 L 9.9222,10.8139 L 9.8978,11.0976 L 9.8513,11.4079 L 9.7914,11.9244 L 9.7803,12.2967 L 9.7360,12.6270 L 9.6983,12.9107 L 9.6607,13.2143 L 9.7433,13.2620 L 9.7433,13.3872 L 9.7100,13.4448 L 9.7100,13.6487 L 9.6648,13.7271 L 9.5920,13.7466 L 9.4966,14.4865 L 10.8708,14.4865 L 10.8708,14.2516 L 10.9151,14.2516 L 11.1168,15.5659 L 11.0769,15.6302 L 11.0326,15.6302 L 10.9839,15.2490 L 9.3747,15.2490 L 9.3526,17.1906 L 9.3238,17.5186 L 9.2927,17.6560 L 9.1686,17.8467 L 9.1021,17.7159 L 9.0002,17.6405 L 8.9137,17.1862 L 8.8472,15.2512 L 7.3039,15.2512 L 7.3165,15.6349 L 7.2412,15.6035 L 7.0782,14.2432 L 7.1472,14.2181 L 7.2162,14.4877 L 8.7583,14.4877 L 8.6267,13.7479 L 8.5577,13.7542 L 8.5037,13.5535 L 8.4993,13.2786 L 8.5436,13.2387 L 8.4305,12.3211 L 8.3840,11.9598 L 8.2776,11.1442 L 8.2289,10.7630 L 8.1757,10.3773 L 7.9850,9.2735 L 7.8813,9.2457 L 7.8813,9.0145 L 7.2925,9.0145 L 7.2925,9.7172 L 7.2468,9.9742 L 7.1497,10.2199 L 7.0754,10.3170 L 7.0011,10.2370 L 6.8583,9.9685 L 6.8012,9.6943 L 6.8012,7.1351 L 6.8469,6.8837 L 6.9326,6.7066 L 6.9326,6.3924 L 7.0468,6.3924 L 7.0468,6.7295 L 7.1440,6.8666 L 7.2239,7.1179 L 7.2582,7.3122 L 7.2582,7.8862 L 7.8341,7.8862 L 7.8341,6.4679 L 7.8830,5.9116 L 7.9930,5.3309 L 8.0786,4.8907 L 8.2070,4.5545 L 8.3170,4.2916 L 8.3537,4.1021 L 8.2559,4.1021 L 8.2523,4.1344 L 8.2095,4.1344 L 8.1924,4.1105 L 8.1924,3.6709 L 8.2215,3.6709 L 8.2506,3.9788 L 8.3960,3.9788 L 8.4659,3.5872 L 8.5534,3.2856 L 8.6540,3.0683 L 8.7578,2.9191 L 8.9102,2.8380 Z M 11.8690,1.6676 L 11.7579,1.6986 L 11.6463,1.8190 L 10.9063,3.3528 L 10.9198,3.5042 L 9.3726,6.8885 L 9.3772,7.6238 L 9.2702,7.8471 L 9.0982,8.0786 A 0.3901,0.3901 0.00 0,0 8.8134,8.2021 L 8.5612,8.1411 L 2.6670,5.4395 L 2.4531,5.4751 L 2.3730,5.5640 L 2.2970,5.6978 L 2.3280,5.8095 L 2.4484,5.9206 L 3.9822,6.6611 L 4.1341,6.6477 L 7.5179,8.1948 L 8.2532,8.1902 L 8.4765,8.2972 L 8.7080,8.4687 A 0.3901,0.3901 0.00 0,0 8.8315,8.7535 L 8.7705,9.0062 L 6.0689,14.8999 L 6.1045,15.1138 L 6.1939,15.1944 L 6.3273,15.2699 L 6.4389,15.2389 L 6.5505,15.1185 L 7.2905,13.5847 L 7.2771,13.4333 L 8.8243,10.0495 L 8.8196,9.3136 L 8.9266,9.0909 L 9.0982,8.8589 A 0.3901,0.3901 0.00 0,0 9.3829,8.7354 L 9.6356,8.7964 L 15.5298,11.4980 L 15.7437,11.4623 L 15.8238,11.3735 L 15.8998,11.2396 L 15.8683,11.1280 L 15.7479,11.0169 L 14.2141,10.2769 L 14.0627,10.2898 L 10.6789,8.7431 L 9.9431,8.7473 L 9.7203,8.6403 L 9.4883,8.4687 A 0.3901,0.3901 0.00 0,0 9.3653,8.1840 L 9.4263,7.9313 L 12.1279,2.0376 L 12.0923,1.8237 L 12.0029,1.7430 Z","a":[8.996,6.615]},"H25A":{"d":"M 9.2326,1.0942 C 8.9011,1.0942 8.1472,3.0525 8.1472,4.6896 L 8.1472,7.2473 C 8.0707,7.2549 7.9406,7.3034 7.8896,7.3263 L 1.4280,10.1721 C 1.3541,10.2103 1.2240,10.2638 1.2240,10.4602 L 1.2240,11.3043 C 1.2240,11.3246 1.2215,11.3400 1.2521,11.3374 L 7.2113,10.8095 C 7.1884,11.3680 7.2343,12.3777 7.6576,13.3569 L 7.9330,13.3569 C 8.1166,13.3569 8.2160,13.7752 8.2364,13.8695 L 8.7031,13.8695 L 8.9351,14.8257 L 6.0358,16.0446 C 5.9523,16.0869 5.8224,16.2060 5.8224,16.4728 L 5.8224,17.3239 L 9.1329,16.8551 C 9.1726,17.1057 9.2267,17.0318 9.2447,17.3978 C 9.2447,17.4141 9.2518,17.4266 9.2599,17.4266 C 9.2680,17.4266 9.2761,17.4141 9.2761,17.3978 C 9.2942,17.0318 9.3483,17.1057 9.3879,16.8551 L 12.6984,17.3239 L 12.6984,16.4728 C 12.6984,16.2060 12.5686,16.0869 12.4850,16.0446 L 9.5857,14.8257 L 9.8178,13.8695 L 10.2844,13.8695 C 10.3048,13.7752 10.4043,13.3569 10.5879,13.3569 L 10.8633,13.3569 C 11.2866,12.3777 11.3325,11.3680 11.3095,10.8095 L 17.2687,11.3374 C 17.2993,11.3399 17.2968,11.3247 17.2968,11.3043 L 17.2968,10.4602 C 17.2968,10.2638 17.1667,10.2103 17.0928,10.1721 L 10.6312,7.3263 C 10.5802,7.3034 10.3992,7.2549 10.3227,7.2473 L 10.3125,4.6896 C 10.3125,3.0526 9.5641,1.0942 9.2326,1.0942 Z","a":[9.26,8.996]},"A306":{"d":"M 9.2609,0.3650 L 9.2124,0.3707 L 9.1581,0.4028 L 9.0909,0.4699 L 9.0294,0.5480 L 8.9581,0.6617 L 8.8889,0.7934 L 8.8031,0.9903 L 8.6863,1.2895 L 8.5850,1.6445 L 8.5090,1.9593 L 8.4377,2.3313 L 8.3959,2.6285 L 8.3566,3.0191 L 8.3375,3.3457 L 8.3328,3.5855 L 8.3328,6.2990 L 8.3256,6.3486 L 8.3070,6.3952 L 8.2791,6.4473 L 8.2346,6.5057 L 8.1742,6.5497 L 8.1514,6.5641 L 6.8880,7.3067 L 6.8988,7.2277 L 6.9055,7.1481 L 6.9066,7.0799 L 7.0569,7.0799 L 7.0699,6.9445 L 7.0848,6.7760 L 7.1034,6.5316 L 7.1096,6.4029 L 7.1096,6.0370 L 7.1003,5.8469 L 7.0885,5.7022 L 7.0709,5.5647 L 7.0590,5.5342 L 7.0404,5.5203 L 6.2337,5.5203 L 6.2089,5.5353 L 6.1939,5.5668 L 6.1872,5.6371 L 6.1671,5.8024 L 6.1603,5.9487 L 6.1603,6.4365 L 6.1634,6.5843 L 6.1733,6.7357 L 6.1919,6.9248 L 6.2120,7.0778 L 6.3614,7.0778 L 6.4027,7.5868 L 4.1465,8.9170 L 2.1482,10.0916 L 1.9926,10.1836 L 1.9353,10.2388 L 1.9027,10.3055 L 1.8888,10.3934 L 1.8888,11.2129 L 2.6520,10.9277 L 3.2675,10.7024 L 3.2675,10.8280 L 3.2825,10.9013 L 3.3063,10.9489 L 3.3238,10.9489 L 3.3497,10.8486 L 3.3636,10.7406 L 3.3636,10.6724 L 4.1057,10.3934 L 4.1057,10.5251 L 4.1403,10.6367 L 4.1594,10.6367 L 4.1941,10.5189 L 4.1997,10.4936 L 4.1997,10.3675 L 4.7899,10.1458 L 4.7899,10.2301 L 4.8018,10.3003 L 4.8302,10.3794 L 4.8472,10.3794 L 4.8726,10.2983 L 4.8906,10.2145 L 4.8906,10.1133 L 5.7733,9.7810 L 5.7733,9.8849 L 5.7903,9.9650 L 5.8131,10.0146 L 5.8317,10.0146 L 5.8596,9.9226 L 5.8725,9.8415 L 5.8725,9.7474 L 6.2611,9.6006 L 7.3251,9.6006 L 7.3251,9.7185 L 7.3391,9.7996 L 7.3660,9.8719 L 7.3856,9.8719 L 7.4114,9.8017 L 7.4264,9.7097 L 7.4264,9.5996 L 8.3349,9.5996 L 8.3349,11.9095 L 8.3494,12.2837 L 8.3731,12.7379 L 8.4088,13.1193 L 8.4496,13.5348 L 8.4853,13.9120 L 8.5189,14.2681 L 8.5633,14.6779 L 8.6279,15.2132 L 8.7199,15.7894 L 6.6601,17.3273 L 6.6275,17.3599 L 6.6089,17.3966 L 6.5970,17.4529 L 6.5970,18.1485 L 6.6244,18.1485 L 9.0175,17.2808 L 9.1669,18.0844 L 9.1798,18.1567 L 9.2620,18.1567 L 9.3405,18.1567 L 9.3540,18.0844 L 9.5028,17.2808 L 11.8959,18.1485 L 11.9233,18.1485 L 11.9233,17.4529 L 11.9114,17.3966 L 11.8928,17.3599 L 11.8603,17.3273 L 9.8004,15.7894 L 9.8924,15.2132 L 9.9570,14.6779 L 10.0015,14.2681 L 10.0350,13.9120 L 10.0707,13.5348 L 10.1120,13.1193 L 10.1477,12.7379 L 10.1715,12.2837 L 10.1854,11.9095 L 10.1854,9.5996 L 11.0939,9.5996 L 11.0939,9.7097 L 11.1089,9.8017 L 11.1347,9.8719 L 11.1544,9.8719 L 11.1812,9.7996 L 11.1952,9.7185 L 11.1952,9.6006 L 12.2597,9.6006 L 12.6478,9.7474 L 12.6478,9.8420 L 12.6607,9.9226 L 12.6886,10.0146 L 12.7072,10.0146 L 12.7300,9.9650 L 12.7470,9.8849 L 12.7470,9.7810 L 13.6297,10.1133 L 13.6297,10.2146 L 13.6483,10.2983 L 13.6731,10.3794 L 13.6901,10.3794 L 13.7185,10.3004 L 13.7304,10.2301 L 13.7304,10.1458 L 14.3211,10.3675 L 14.3211,10.4936 L 14.3263,10.5189 L 14.3609,10.6368 L 14.3805,10.6368 L 14.4152,10.5251 L 14.4152,10.3934 L 15.1567,10.6724 L 15.1567,10.7406 L 15.1707,10.8486 L 15.1970,10.9489 L 15.2141,10.9489 L 15.2378,10.9014 L 15.2528,10.8280 L 15.2528,10.7024 L 15.8683,10.9277 L 16.6321,11.2130 L 16.6321,10.3934 L 16.6176,10.3055 L 16.5856,10.2389 L 16.5282,10.1836 L 16.3721,10.0916 L 14.3738,8.9170 L 12.1181,7.5868 L 12.1590,7.0778 L 12.3083,7.0778 L 12.3290,6.9254 L 12.3471,6.7357 L 12.3569,6.5843 L 12.3600,6.4365 L 12.3600,5.9487 L 12.3538,5.8024 L 12.3331,5.6371 L 12.3264,5.5668 L 12.3114,5.5353 L 12.2866,5.5203 L 11.4799,5.5203 L 11.4613,5.5342 L 11.4494,5.5647 L 11.4324,5.7022 L 11.4205,5.8469 L 11.4107,6.0370 L 11.4107,6.4029 L 11.4169,6.5316 L 11.4355,6.7760 L 11.4505,6.9445 L 11.4634,7.0799 L 11.6138,7.0799 L 11.6148,7.1481 L 11.6215,7.2277 L 11.6323,7.3067 L 10.3694,6.5641 L 10.3466,6.5497 L 10.2862,6.5057 L 10.2417,6.4474 L 10.2133,6.3952 L 10.1952,6.3486 L 10.1874,6.2990 L 10.1874,3.5855 L 10.1834,3.3457 L 10.1637,3.0191 L 10.1250,2.6285 L 10.0826,2.3313 L 10.0113,1.9593 L 9.9353,1.6445 L 9.8340,1.2895 L 9.7172,0.9903 L 9.6315,0.7934 L 9.5622,0.6617 L 9.4909,0.5480 L 9.4294,0.4699 L 9.3622,0.4028 L 9.3085,0.3707 Z","a":[9.26,7.937]},"A35K":{"d":"M 9.2599,0.4428 L 9.1829,0.4702 L 9.0863,0.6009 L 9.0005,0.7684 L 8.9111,0.9771 L 8.7995,1.3456 L 8.7287,1.6252 L 8.6693,1.9269 L 8.6057,2.2659 L 8.5571,2.5677 L 8.5571,6.5277 L 8.4827,6.6729 L 7.1903,7.6827 L 7.2234,7.5597 L 7.2311,7.2915 L 7.2275,6.8667 L 7.2161,6.6621 L 7.1717,6.5871 L 7.0409,6.5277 L 6.5045,6.5277 L 6.3816,6.5799 L 6.3407,6.6579 L 6.3185,6.8739 L 6.2735,7.1277 L 6.2735,7.4517 L 6.3185,7.7535 L 6.3707,7.9695 L 6.5123,7.9953 L 6.5381,8.0553 L 6.5645,8.1596 L 2.2542,11.1770 L 2.0082,11.3672 L 1.8366,11.5124 L 1.6950,11.6540 L 1.5911,11.8214 L 1.5276,12.0002 L 1.5204,12.4100 L 1.5576,12.2612 L 1.6020,12.1532 L 1.6878,12.0638 L 1.7922,11.9703 L 2.0118,11.8514 L 2.3136,11.7207 L 5.1227,10.5698 L 5.1635,10.7486 L 5.2421,10.5249 L 6.1583,10.1564 L 6.2214,10.3311 L 6.3035,10.1151 L 6.8399,9.9513 L 7.3691,9.8882 L 8.4455,9.8882 L 8.4533,10.2980 L 8.4941,10.5698 L 8.5649,10.8303 L 8.5649,13.7738 L 8.5685,14.1908 L 8.6021,14.5706 L 8.6465,14.8502 L 8.6837,15.0440 L 8.8145,15.5768 L 8.8961,15.9752 L 7.2048,17.2867 L 7.0823,17.4655 L 7.0115,17.6965 L 6.9779,17.8526 L 6.9815,18.0314 L 9.0791,17.2754 L 9.1085,17.4206 L 9.1643,17.5844 L 9.2455,17.6733 L 9.3566,17.5844 L 9.4124,17.4206 L 9.4418,17.2754 L 11.5394,18.0314 L 11.5430,17.8526 L 11.5094,17.6965 L 11.4386,17.4655 L 11.3161,17.2867 L 9.6248,15.9752 L 9.7064,15.5768 L 9.8371,15.0440 L 9.8743,14.8502 L 9.9188,14.5706 L 9.9524,14.1908 L 9.9560,13.7738 L 9.9560,10.8303 L 10.0268,10.5698 L 10.0681,10.2980 L 10.0753,9.8882 L 11.1517,9.8882 L 11.6809,9.9513 L 12.2173,10.1151 L 12.2995,10.3311 L 12.3625,10.1564 L 13.2793,10.5249 L 13.3573,10.7486 L 13.3981,10.5698 L 16.2072,11.7207 L 16.5090,11.8514 L 16.7287,11.9703 L 16.8330,12.0638 L 16.9188,12.1532 L 16.9633,12.2612 L 17.0005,12.4100 L 16.9933,12.0002 L 16.9297,11.8214 L 16.8258,11.6540 L 16.6843,11.5124 L 16.5127,11.3672 L 16.2667,11.1770 L 11.9564,8.1596 L 11.9827,8.0553 L 12.0086,7.9953 L 12.1502,7.9695 L 12.2024,7.7535 L 12.2473,7.4517 L 12.2473,7.1277 L 12.2024,6.8739 L 12.1801,6.6579 L 12.1393,6.5799 L 12.0163,6.5277 L 11.4799,6.5277 L 11.3492,6.5871 L 11.3047,6.6621 L 11.2934,6.8667 L 11.2898,7.2915 L 11.2976,7.5597 L 11.3306,7.6827 L 10.0382,6.6729 L 9.9638,6.5277 L 9.9638,2.5677 L 9.9152,2.2659 L 9.8516,1.9269 L 9.7922,1.6252 L 9.7214,1.3456 L 9.6098,0.9771 L 9.5204,0.7684 L 9.4346,0.6009 L 9.3380,0.4702 Z","a":[9.26,8.202]},"A310":{"d":"M 9.2923,0.4399 L 9.1741,0.5746 L 8.9617,0.9028 L 8.7586,1.3622 L 8.6398,1.7870 L 8.4930,2.4334 L 8.4212,2.8334 L 8.3649,3.4174 L 8.3178,4.0204 L 8.3178,5.8699 L 8.2574,6.0286 L 8.1499,6.1991 L 7.9980,6.3578 L 6.8456,7.0290 L 6.8642,6.8073 L 6.9660,6.7247 L 7.0099,6.5035 L 7.0481,6.0663 L 7.0481,5.7686 L 7.0228,5.4772 L 7.0099,5.2622 L 6.9593,5.1986 L 6.8389,5.1671 L 6.2627,5.1671 L 6.1614,5.2178 L 6.1107,5.2875 L 6.0663,5.5407 L 6.0539,5.8637 L 6.0601,6.3769 L 6.1045,6.7123 L 6.1996,6.8197 L 6.2311,7.0921 L 6.2565,7.3706 L 1.5260,10.1885 L 1.4123,10.2836 L 1.3488,10.3787 L 1.3302,10.6510 L 1.3426,11.1197 L 1.3741,11.3854 L 1.4438,11.1068 L 3.1347,10.4862 L 3.1347,10.7208 L 3.1853,10.8345 L 3.2360,10.8345 L 3.2928,10.7017 L 3.2928,10.4293 L 4.3439,10.0242 L 4.3568,10.3658 L 4.4266,10.3658 L 4.4519,9.9860 L 5.5537,9.5493 L 5.5475,9.8593 L 5.5826,9.9208 L 5.6167,9.9208 L 5.6684,9.8320 L 5.6684,9.5172 L 6.1175,9.3276 L 7.3014,9.3276 L 7.3014,9.6692 L 7.3773,9.7519 L 7.4342,9.6630 L 7.4342,9.5110 L 7.4977,9.3147 L 8.2956,9.3147 L 8.3271,11.6262 L 8.3969,12.4809 L 8.4667,13.1966 L 8.7137,15.0203 L 6.5986,16.5525 L 6.4337,16.6791 L 6.3262,16.8057 L 6.3133,17.0212 L 6.3133,17.5850 L 6.3769,17.6289 L 9.0299,16.6667 L 9.1695,17.2553 L 9.2392,17.4454 L 9.2899,17.5276 L 9.2961,17.6795 L 9.3181,17.7115 L 9.3400,17.6795 L 9.3467,17.5276 L 9.3974,17.4454 L 9.4666,17.2553 L 9.6061,16.6667 L 12.2592,17.6289 L 12.3228,17.5850 L 12.3228,17.0212 L 12.3098,16.8057 L 12.2024,16.6791 L 12.0375,16.5525 L 9.9229,15.0203 L 10.1699,13.1966 L 10.2392,12.4809 L 10.3089,11.6262 L 10.3404,9.3147 L 11.1383,9.3147 L 11.2019,9.5110 L 11.2019,9.6630 L 11.2587,9.7519 L 11.3347,9.6692 L 11.3347,9.3276 L 12.5191,9.3276 L 12.9677,9.5172 L 12.9677,9.8320 L 13.0194,9.9208 L 13.0535,9.9208 L 13.0891,9.8593 L 13.0824,9.5493 L 14.1842,9.9860 L 14.2095,10.3658 L 14.2792,10.3658 L 14.2922,10.0242 L 15.3433,10.4293 L 15.3433,10.7017 L 15.4001,10.8345 L 15.4507,10.8345 L 15.5014,10.7208 L 15.5014,10.4862 L 17.1922,11.1068 L 17.2620,11.3854 L 17.2935,11.1197 L 17.3064,10.6510 L 17.2873,10.3787 L 17.2238,10.2836 L 17.1101,10.1885 L 12.3796,7.3706 L 12.4049,7.0921 L 12.4365,6.8197 L 12.5315,6.7123 L 12.5760,6.3769 L 12.5822,5.8637 L 12.5698,5.5407 L 12.5253,5.2875 L 12.4747,5.2178 L 12.3734,5.1671 L 11.7972,5.1671 L 11.6768,5.1986 L 11.6262,5.2622 L 11.6132,5.4772 L 11.5879,5.7686 L 11.5879,6.0663 L 11.6262,6.5035 L 11.6706,6.7247 L 11.7719,6.8073 L 11.7910,7.0290 L 10.6381,6.3578 L 10.4862,6.1991 L 10.3787,6.0286 L 10.3182,5.8699 L 10.3182,4.0204 L 10.2712,3.4174 L 10.2149,2.8334 L 10.1431,2.4334 L 9.9963,1.7870 L 9.8774,1.3622 L 9.6749,0.9028 L 9.4620,0.5746 L 9.3405,0.4403 C 9.3244,0.4304 9.3084,0.4302 9.2923,0.4399 Z","a":[9.26,7.408]},"C182":{"d":"M 9.2604,3.5414 L 9.0026,4.0421 C 8.7111,4.0589 8.6065,4.1373 8.5916,4.3074 L 8.4720,6.1326 L 5.8041,6.1326 L 1.4249,6.2784 C 1.3157,6.2797 1.1175,6.3511 1.1070,6.6047 L 1.1070,8.0341 L 1.4425,8.0632 L 5.7941,8.6946 L 8.5446,8.6946 L 8.9832,12.4148 L 6.9435,12.7265 C 6.7585,12.7662 6.7559,13.1201 6.7559,13.2259 C 6.7559,13.3450 6.8245,13.8310 6.8985,13.9050 L 8.7850,14.1560 L 9.1074,13.4954 C 9.1338,13.9789 9.1998,14.9988 9.2104,14.9988 C 9.2104,15.0411 9.3104,15.0437 9.3104,14.9988 C 9.3210,14.9988 9.3870,13.9789 9.4135,13.4954 L 9.7358,14.1560 L 11.6223,13.9050 C 11.6963,13.8310 11.7650,13.3450 11.7650,13.2259 C 11.7650,13.1201 11.7623,12.7662 11.5774,12.7265 L 9.5376,12.4148 L 9.9763,8.6946 L 12.7267,8.6946 L 17.0783,8.0632 L 17.4139,8.0341 L 17.4139,6.6047 C 17.4032,6.3511 17.2052,6.2797 17.0960,6.2784 L 12.7167,6.1326 L 10.0488,6.1326 L 9.9293,4.3074 C 9.9143,4.1373 9.8097,4.0589 9.5183,4.0421 Z","a":[9.26,7.144]},"B412":{"d":"M 9.2002,3.7050 L 9.0755,3.7348 L 8.8923,3.8157 L 8.6839,3.9901 L 8.5523,4.1520 L 8.4458,4.3561 L 8.3477,4.6585 L 8.2756,5.0115 L 8.2030,5.3519 L 8.0714,6.1221 L 7.9956,6.1221 L 7.9956,5.3514 L 7.9844,5.2756 L 7.9649,5.2310 L 7.9310,5.2198 L 7.8975,5.2449 L 7.8752,5.3040 L 7.8779,5.3710 L 7.8612,5.5198 L 7.8612,9.4642 L 7.8891,9.5005 L 7.9538,9.5005 L 7.9789,9.4447 L 7.9789,8.7354 L 8.0882,8.7354 L 8.2254,9.1782 L 8.3854,9.6800 L 8.3854,9.8060 L 8.4440,9.9716 L 8.6067,10.2237 L 8.6514,10.3669 L 8.7188,10.3669 L 8.8211,10.4734 L 8.9072,11.9106 L 8.9960,13.0910 L 9.0118,13.4147 L 7.8724,13.4147 L 7.8928,14.1928 L 9.0746,14.1919 L 9.0914,14.7165 L 9.0197,14.7546 L 9.0337,15.1174 L 9.1160,15.1611 L 9.1793,16.4275 L 9.1900,16.5782 L 9.2393,16.7624 L 9.2834,16.8638 L 9.3276,16.7624 L 9.3769,16.5782 L 9.4318,16.5401 L 9.5909,16.5401 L 9.6239,16.5754 L 9.6406,17.5782 L 9.6709,17.6112 L 9.6927,17.5782 L 9.7090,16.6689 L 9.7667,16.6331 L 9.7941,16.5647 L 9.8053,16.4657 L 9.7941,16.3834 L 9.7448,16.3285 L 9.7364,16.3587 L 9.6871,16.3587 L 9.6871,16.0210 L 9.6625,15.4578 L 9.6462,15.3783 L 9.6132,15.3862 L 9.6132,16.4628 L 9.4951,16.4628 L 9.3876,16.4275 L 9.4509,15.1611 L 9.5332,15.1173 L 9.5471,14.7546 L 9.4755,14.7164 L 9.4923,14.1918 L 10.6596,14.1862 L 10.6596,13.3947 L 9.5337,13.3947 L 9.5564,13.0775 L 9.6178,11.8836 L 9.6909,10.4395 L 9.7527,10.3669 L 9.8197,10.3669 L 9.8648,10.2237 L 10.0271,9.9716 L 10.0862,9.8061 L 10.0862,9.6800 L 10.2457,9.1782 L 10.3834,8.7354 L 10.4927,8.7354 L 10.4927,9.4447 L 10.5178,9.5005 L 10.5824,9.5005 L 10.6103,9.4642 L 10.6103,5.5198 L 10.5936,5.3710 L 10.5964,5.3040 L 10.5741,5.2449 L 10.5401,5.2198 L 10.5066,5.2310 L 10.4871,5.2756 L 10.4760,5.3514 L 10.4760,6.1221 L 10.4001,6.1221 L 10.2680,5.3519 L 10.1959,5.0115 L 10.1234,4.6585 L 10.0257,4.3561 L 9.9192,4.1520 L 9.7876,3.9901 L 9.5788,3.8157 L 9.3960,3.7348 Z M 14.0420,2.8372 L 13.9583,2.8432 L 9.9464,6.9662 L 9.7585,7.1657 L 9.6609,7.4053 L 9.5330,7.5355 L 9.4106,7.5322 L 9.2609,7.6820 L 9.4809,7.9029 L 9.6111,7.7727 L 9.6432,7.5908 L 9.7427,7.4946 L 9.7925,7.4518 L 9.9887,7.3625 L 10.0636,7.3057 L 10.3771,7.0774 L 13.5704,3.8111 L 13.8439,3.4925 L 14.1536,3.1195 L 14.1773,3.0176 L 14.1536,2.9334 L 14.0992,2.8548 Z M 9.4809,7.9029 L 9.2600,8.1224 L 9.3902,8.2527 L 9.5720,8.2847 L 9.6683,8.3847 L 9.7111,8.4345 L 9.7999,8.6308 L 9.8571,8.7052 L 10.0850,9.0191 L 13.3518,12.2119 L 13.6704,12.4854 L 14.0434,12.7952 L 14.1452,12.8194 L 14.2294,12.7952 L 14.3076,12.7412 L 14.3257,12.6840 L 14.3197,12.6003 L 10.1966,8.5884 L 9.9967,8.4001 L 9.7576,8.3024 L 9.6274,8.1745 L 9.6306,8.0527 Z M 9.2600,8.1224 L 9.0400,7.9020 L 8.9102,8.0322 L 8.8781,8.2141 L 8.7781,8.3103 L 8.7284,8.3526 L 8.5321,8.4419 L 8.4572,8.4992 L 8.1437,8.7270 L 4.9509,11.9934 L 4.6770,12.3124 L 4.3677,12.6849 L 4.3435,12.7873 L 4.3677,12.8715 L 4.4216,12.9496 L 4.4788,12.9677 L 4.5626,12.9617 L 8.5744,8.8387 L 8.7628,8.6387 L 8.8604,8.3992 L 8.9883,8.2690 L 9.1102,8.2727 Z M 9.0400,7.9020 L 9.2609,7.6820 L 9.1307,7.5518 L 8.9488,7.5197 L 8.8525,7.4201 L 8.8097,7.3704 L 8.7209,7.1741 L 8.6637,7.0992 L 8.4358,6.7858 L 5.1690,3.5925 L 4.8505,3.3190 L 4.4779,3.0093 L 4.3756,2.9855 L 4.2914,3.0093 L 4.2133,3.0637 L 4.1951,3.1209 L 4.2012,3.2046 L 8.3242,7.2160 L 8.5242,7.4043 L 8.7637,7.5020 L 8.8935,7.6299 L 8.8902,7.7522 Z","a":[9.26,7.937]},"C210":{"d":"M 9.2260,1.6283 L 9.2038,1.6356 L 9.1630,1.6929 L 9.0844,1.8826 L 9.0240,2.0939 L 9.0271,2.1244 L 9.0152,2.1813 L 8.9847,2.1993 L 8.9366,2.2417 L 8.8793,2.2779 L 8.7769,2.3110 L 8.7134,2.3415 L 8.6653,2.3807 L 8.6198,2.4288 L 8.5930,2.5042 L 8.5444,2.7394 L 8.5025,3.1667 L 8.4633,3.5197 L 8.4028,4.2798 L 8.3811,4.6436 L 8.3718,4.7522 L 8.3599,4.7945 L 8.3356,4.8245 L 8.2576,4.8338 L 1.6182,4.8100 L 1.5428,4.8224 L 1.4730,4.8493 L 1.4038,4.9010 L 1.3614,4.9640 L 1.3345,5.0514 L 1.3164,5.0850 L 1.2771,5.1180 L 1.2410,5.1997 L 1.2167,5.3294 L 1.1805,5.5826 L 1.1562,5.9144 L 1.1200,6.5779 L 1.1505,6.5903 L 8.4571,7.3050 L 8.9645,11.2127 L 6.5182,11.5192 L 6.4701,11.5342 L 6.4308,11.5585 L 6.3885,11.6034 L 6.3766,11.6520 L 6.3704,11.7306 L 6.3859,11.7455 L 6.4458,11.7512 L 6.6298,11.7512 L 6.6572,11.7574 L 6.6784,11.7786 L 6.6784,11.8148 L 6.3735,11.8298 L 6.3585,11.8660 L 6.3523,12.3398 L 6.3735,12.6685 L 6.3859,12.7228 L 6.4189,12.7589 L 6.4670,12.7894 L 8.9681,13.1915 L 9.0539,12.8116 L 9.0653,12.5589 L 9.0958,12.2907 L 9.2086,13.0411 L 9.1978,13.1893 L 9.1941,13.3614 L 9.1924,13.5364 L 9.2017,13.7284 L 9.2263,13.9374 L 9.2485,14.0774 L 9.2617,14.1428 L 9.2986,14.1729 L 9.3353,14.1383 L 9.3485,14.0767 L 9.3728,13.9346 L 9.3909,13.7206 L 9.3996,13.5336 L 9.3996,13.3553 L 9.3878,13.1837 L 9.3759,13.0447 L 9.4669,12.2842 L 9.4901,12.5559 L 9.5025,12.7972 L 9.6048,13.1987 L 12.1271,12.7822 L 12.1752,12.7522 L 12.2082,12.7161 L 12.2206,12.6618 L 12.2418,12.3326 L 12.2356,11.8593 L 12.2207,11.8231 L 11.9158,11.8076 L 11.9158,11.7714 L 11.9369,11.7507 L 11.9643,11.7445 L 12.1483,11.7445 L 12.2088,11.7383 L 12.2238,11.7234 L 12.2176,11.6448 L 12.2057,11.5967 L 12.1633,11.5513 L 12.1240,11.5275 L 12.0760,11.5120 L 9.6022,11.2014 L 10.0637,7.2947 L 17.3702,6.5795 L 17.4007,6.5676 L 17.3645,5.9041 L 17.3402,5.5723 L 17.3041,5.3186 L 17.2798,5.1889 L 17.2436,5.1077 L 17.2043,5.0742 L 17.1863,5.0411 L 17.1594,4.9538 L 17.1170,4.8902 L 17.0478,4.8390 L 16.9780,4.8116 L 16.9026,4.7998 L 10.2265,4.8178 L 10.1479,4.8091 L 10.1242,4.7786 L 10.1118,4.7367 L 10.1030,4.6277 L 10.0756,4.2747 L 10.0151,3.5146 L 9.9758,3.1616 L 9.9159,2.7425 L 9.8673,2.5068 L 9.8404,2.4314 L 9.7950,2.3833 L 9.7469,2.3440 L 9.6833,2.3141 L 9.5810,2.2805 L 9.5237,2.2443 L 9.4751,2.2024 L 9.4451,2.1844 L 9.4332,2.1270 L 9.4358,2.0965 L 9.3759,1.8857 L 9.2973,1.6955 L 9.2503,1.6340 Z","a":[9.26,7.144]},"AS55":{"d":"M 10.3188,3.0246 L 10.0527,3.0546 L 9.8243,3.1595 L 9.5881,3.3616 L 9.3333,3.7403 L 9.1757,4.2163 L 9.1194,4.8457 L 9.1194,5.4152 L 9.1235,6.1200 L 9.1643,6.5210 L 9.0207,6.5210 L 9.0207,4.8359 L 8.9685,4.7837 L 8.9210,4.7708 L 8.8760,4.8157 L 8.8760,6.7572 L 8.6285,6.7572 L 8.6285,8.6424 L 8.9096,8.6424 L 8.9096,8.7359 L 9.0222,8.7359 L 9.0222,8.4925 L 9.4382,8.4925 L 9.4682,9.2790 L 9.4904,9.6315 L 9.5431,9.7891 L 9.4641,9.8681 L 9.6780,10.2387 L 9.8165,10.1002 L 9.7979,10.2387 L 9.8878,10.3735 L 9.8878,10.7182 L 10.1054,13.8550 L 8.6326,13.8550 L 8.6326,14.5485 L 10.1503,14.5485 L 10.4051,17.8015 L 10.4351,17.8015 L 10.5400,16.0176 L 10.7911,16.0176 L 10.7911,16.0926 L 11.0676,16.0952 L 11.1337,16.0290 L 11.1337,15.9556 L 11.0573,15.8791 L 10.5622,15.8791 L 10.6077,14.5598 L 12.1626,14.5598 L 12.1626,13.8700 L 10.6485,13.8550 L 10.8025,10.7182 L 10.8025,10.3172 L 10.8660,10.2314 L 10.8547,10.1301 L 11.0195,10.2500 L 11.1885,9.8904 L 11.1058,9.8190 L 11.1735,9.6464 L 11.2185,9.2904 L 11.2293,8.4770 L 11.6448,8.4770 L 11.6448,8.6806 L 11.6980,8.7338 L 11.7451,8.7338 L 11.7952,8.6832 L 11.7616,6.9143 L 11.8293,6.9143 L 11.8293,7.2445 L 12.1983,7.2445 L 12.1983,7.0926 L 12.1254,7.0192 L 12.1254,6.4761 L 12.0386,6.4761 L 12.0386,6.3019 L 12.0055,6.3112 L 12.0055,4.0582 L 11.9285,4.0582 L 11.8696,4.0923 L 11.8696,4.2121 L 11.9265,4.2271 L 11.9265,6.3071 L 11.8779,6.3071 L 11.8779,6.4833 L 11.7544,6.4833 L 11.7544,4.7971 L 11.6453,4.7971 L 11.6453,6.4761 L 11.5255,6.4761 L 11.5255,4.9056 L 11.4655,4.5873 L 11.3942,4.2199 L 11.2593,3.7853 L 11.1286,3.5155 L 10.9332,3.2902 L 10.7084,3.1032 L 10.5364,3.0282 Z M 8.9974,6.6833 L 9.1721,6.6833 L 9.2202,7.2187 L 9.2465,7.4466 L 8.9871,7.4466 Z M 11.4831,6.9221 L 11.6474,6.9221 L 11.6474,8.3530 L 11.2500,8.3530 L 11.3823,7.7701 L 11.4407,7.3510 Z M 8.9974,8.0827 L 9.3525,8.0827 L 9.4160,8.3530 L 8.9923,8.3530 Z M 8.3029,1.1767 L 7.9055,1.3146 L 9.5488,6.2115 L 9.9514,6.6358 L 10.0666,7.0621 A 0.5088,0.5088 0.00 0,0 9.8351,7.4889 A 0.5088,0.5088 0.00 0,0 9.9948,7.8595 L 6.0085,12.6085 L 6.3366,12.9005 L 9.7075,8.8511 L 9.8506,8.2894 L 10.1379,7.9546 A 0.5088,0.5088 0.00 0,0 10.3436,7.9980 A 0.5088,0.5088 0.00 0,0 10.8201,7.6677 L 17.0037,9.2490 L 17.1117,8.8460 L 11.8541,7.4781 L 11.3239,7.5685 L 10.8526,7.4889 A 0.5088,0.5088 0.00 0,0 10.3436,6.9799 A 0.5088,0.5088 0.00 0,0 10.2604,6.9872 Z","a":[9.26,5.027]},"PC21":{"d":"M 9.2601,1.0833 L 9.2316,1.0895 L 9.1929,1.1281 L 9.1156,1.2828 L 9.0264,1.5267 L 8.9550,1.7765 L 8.8866,2.0709 L 8.7171,2.0471 L 8.5178,2.0293 L 8.2323,2.0322 L 7.9706,2.0561 L 7.6553,2.1185 L 7.5363,2.1542 L 7.5304,2.2315 L 7.9675,2.2434 L 8.1787,2.2464 L 8.3810,2.2702 L 8.5832,2.2761 L 8.7200,2.2761 L 8.7944,2.2612 L 8.8598,2.2404 L 8.7855,2.7490 L 8.7408,2.7341 L 8.6487,2.7282 L 8.5594,2.7400 L 8.4702,2.7787 L 8.4018,2.8323 L 8.3334,2.8947 L 8.2769,2.9691 L 8.2442,3.0494 L 8.2115,3.1296 L 8.2084,3.1564 L 8.2768,3.1772 L 8.3452,3.2278 L 8.4077,3.2932 L 8.4404,3.3765 C 8.5029,3.3884 8.4962,3.3871 8.5029,3.3884 L 8.5326,3.2664 L 8.5594,3.1980 L 8.6129,3.1296 L 8.6724,3.0880 L 8.7170,3.0672 L 8.7348,3.0701 L 8.7408,3.0940 L 8.6576,3.5639 L 8.5832,4.1260 L 8.5624,4.3609 L 8.5296,4.8665 L 8.5207,5.3781 L 8.5237,6.2643 L 8.4791,6.3119 L 7.9468,6.4279 L 7.3103,6.5736 L 6.3199,6.7937 L 5.2165,7.0435 L 3.9287,7.3291 L 3.3012,7.4777 L 3.2090,7.5075 L 3.1020,7.5640 L 2.9890,7.6651 L 2.9146,7.7663 L 2.8075,7.9744 L 2.7421,8.1767 L 2.6915,8.4235 L 2.6678,8.7001 L 2.6529,8.9737 L 2.6499,9.2622 L 3.7206,9.3038 L 4.5563,9.3187 L 5.3593,9.3395 L 6.5222,9.3722 L 7.6821,9.4079 L 8.3096,9.4258 L 8.5297,9.7321 L 8.5357,10.0712 L 8.5624,10.6065 L 8.5862,10.9604 L 8.6219,11.3233 L 8.6903,12.1917 L 8.7617,13.0155 L 8.7974,13.3665 L 8.6282,15.1784 L 8.6222,15.2487 L 8.5465,15.3347 L 8.1026,15.4656 L 7.2557,15.7090 L 6.5193,15.9217 L 6.3904,16.1918 L 6.3434,16.4148 L 6.3290,16.9221 L 6.3597,16.9446 L 7.0634,16.9650 L 8.1190,16.9998 L 9.0641,17.0387 L 9.1561,17.0407 L 9.1930,17.3271 L 9.2032,17.3680 L 9.2113,17.3946 L 9.2297,17.4191 L 9.2604,17.4362 L 9.2911,17.4191 L 9.3095,17.3946 L 9.3177,17.3680 L 9.3279,17.3271 L 9.3647,17.0407 L 9.4568,17.0387 L 10.4019,16.9998 L 11.4574,16.9650 L 12.1611,16.9446 L 12.1918,16.9221 L 12.1775,16.4148 L 12.1304,16.1918 L 12.0016,15.9217 L 11.2651,15.7090 L 10.4182,15.4656 L 9.9743,15.3347 L 9.8986,15.2487 L 9.8926,15.1784 L 9.7235,13.3665 L 9.7592,13.0155 L 9.8306,12.1917 L 9.8990,11.3233 L 9.9346,10.9604 L 9.9584,10.6065 L 9.9852,10.0712 L 9.9911,9.7321 L 10.2112,9.4258 L 10.8387,9.4079 L 11.9986,9.3722 L 13.1615,9.3395 L 13.9645,9.3187 L 14.8003,9.3038 L 15.8709,9.2622 L 15.8680,8.9737 L 15.8531,8.7001 L 15.8293,8.4235 L 15.7787,8.1767 L 15.7133,7.9744 L 15.6063,7.7662 L 15.5319,7.6651 L 15.4189,7.5640 L 15.3118,7.5075 L 15.2196,7.4777 L 14.5921,7.3291 L 13.3043,7.0435 L 12.2009,6.7937 L 11.2106,6.5736 L 10.5741,6.4279 L 10.0417,6.3119 L 9.9971,6.2643 L 10.0000,5.3780 L 9.9911,4.8665 L 9.9584,4.3609 L 9.9376,4.1260 L 9.8632,3.5638 L 9.7799,3.0940 L 9.7859,3.0701 L 9.8038,3.0672 L 9.8484,3.0880 L 9.9079,3.1296 L 9.9614,3.1980 L 9.9882,3.2664 L 10.0179,3.3884 C 10.0803,3.3765 10.0470,3.3828 10.0803,3.3765 L 10.1131,3.2932 L 10.1755,3.2278 L 10.2439,3.1772 L 10.3123,3.1564 L 10.3094,3.1296 L 10.2767,3.0493 L 10.2440,2.9690 L 10.1875,2.8947 L 10.1191,2.8322 L 10.0507,2.7787 L 9.9615,2.7400 L 9.8723,2.7281 L 9.7800,2.7341 L 9.7354,2.7490 L 9.6611,2.2404 L 9.7265,2.2612 L 9.8009,2.2761 L 9.9377,2.2761 L 10.1399,2.2702 L 10.3421,2.2463 L 10.5533,2.2434 L 10.9905,2.2315 L 10.9845,2.1542 L 10.8656,2.1185 L 10.5503,2.0561 L 10.2886,2.0322 L 10.0031,2.0293 L 9.8038,2.0471 L 9.6343,2.0709 L 9.5659,1.7765 L 9.4945,1.5267 L 9.4053,1.2828 L 9.3280,1.1281 L 9.2893,1.0895 Z","a":[9.26,7.673]},"EC45":{"d":"M 9.3545,3.2561 L 9.1586,3.2727 L 8.9436,3.3285 L 8.8170,3.3962 L 8.7328,3.4525 L 8.6512,3.5367 L 8.5835,3.6137 L 8.5204,3.7145 L 8.4620,3.8313 L 8.4057,3.9879 L 8.3566,4.1351 L 8.3054,4.4344 L 8.2796,4.6049 L 8.2398,4.7641 L 8.2140,4.9227 L 8.2140,5.1025 L 8.2259,5.3108 L 8.2491,5.4581 L 8.2584,5.5304 L 8.2517,5.6074 L 8.2305,5.7480 L 8.2119,5.8973 L 8.0998,5.8973 L 8.0998,5.1263 L 8.0925,4.9651 L 8.0812,4.8550 L 8.0693,4.8033 L 8.0414,4.7894 L 8.0083,4.8080 L 7.9943,4.8969 L 7.9876,4.9976 L 7.9876,5.1284 L 7.9876,5.9257 L 7.8848,5.9257 L 7.8848,5.3619 L 7.8822,5.2989 L 7.8755,5.2663 L 7.8450,5.2477 L 7.8026,5.2524 L 7.7747,5.2875 L 7.7680,5.3433 L 7.7680,5.7898 L 7.7680,8.7778 L 7.7737,8.8346 L 7.8062,8.8589 L 7.8465,8.8615 L 7.8765,8.8346 L 7.8843,8.7829 L 7.8843,8.4568 L 7.9897,8.4568 L 7.9897,8.6377 L 8.0972,8.6377 L 8.0972,8.4300 L 8.2377,8.4300 L 8.2377,8.5618 L 8.2486,8.7995 L 8.2703,8.9638 L 8.2889,9.0744 L 8.3669,9.4630 L 8.4155,9.6299 L 8.4563,9.7271 L 8.4641,9.8056 L 8.4806,9.9028 L 8.5158,9.9916 L 8.5183,10.0619 L 8.5478,10.1348 L 8.6020,10.2262 L 8.6532,10.3074 L 8.7690,10.4609 L 8.8232,10.5797 L 8.8930,10.7497 L 8.9715,10.8980 L 9.0444,11.0464 L 9.0821,11.0898 L 9.0930,12.2117 L 9.0981,13.1129 L 9.1064,14.0539 L 9.1173,14.1779 L 9.0578,14.2079 L 7.6765,14.2079 L 7.6765,14.2834 L 7.6848,14.3371 L 7.6822,14.3888 L 7.6714,14.4265 L 7.6471,14.4425 L 7.6145,14.4425 L 7.6037,14.4534 L 7.6037,14.5154 L 7.6171,14.5340 L 7.6822,14.6342 L 7.6957,14.8580 L 9.1199,14.8714 L 9.1142,14.9629 L 9.0899,15.0466 L 9.0444,15.1815 L 9.0201,15.2466 L 9.0119,15.3675 L 9.0119,17.4475 L 9.0201,17.6093 L 9.0553,17.7390 L 9.0982,17.8713 L 9.1199,17.9359 L 9.3653,17.9359 L 9.5896,17.9359 L 9.6113,17.8713 L 9.6542,17.7390 L 9.6893,17.6093 L 9.6976,17.4475 L 9.6976,15.3675 L 9.6893,15.2466 L 9.6651,15.1815 L 9.6196,15.0466 L 9.5953,14.9629 L 9.5896,14.8714 L 11.0138,14.8580 L 11.0273,14.6342 L 11.0924,14.5340 L 11.1058,14.5154 L 11.1058,14.4534 L 11.0950,14.4425 L 11.0624,14.4425 L 11.0381,14.4265 L 11.0273,14.3888 L 11.0247,14.3371 L 11.0330,14.2834 L 11.0330,14.2079 L 9.6516,14.2079 L 9.5922,14.1779 L 9.6030,14.0539 L 9.6113,13.1129 L 9.6165,12.2117 L 9.6273,11.0898 L 9.6650,11.0464 L 9.7379,10.8980 L 9.8165,10.7497 L 9.8862,10.5797 L 9.9405,10.4609 L 10.0562,10.3074 L 10.1074,10.2262 L 10.1617,10.1348 L 10.1911,10.0619 L 10.1937,9.9916 L 10.2289,9.9028 L 10.2454,9.8056 L 10.2532,9.7271 L 10.2940,9.6299 L 10.3426,9.4630 L 10.4206,9.0744 L 10.4397,8.9638 L 10.4609,8.7995 L 10.4718,8.5618 L 10.4718,8.4300 L 10.6123,8.4300 L 10.6123,8.6377 L 10.7198,8.6377 L 10.7198,8.4568 L 10.8253,8.4568 L 10.8253,8.7829 L 10.8331,8.8346 L 10.8630,8.8615 L 10.9033,8.8589 L 10.9359,8.8346 L 10.9416,8.7778 L 10.9416,5.7898 L 10.9416,5.3433 L 10.9349,5.2875 L 10.9070,5.2524 L 10.8646,5.2477 L 10.8341,5.2663 L 10.8274,5.2989 L 10.8248,5.3625 L 10.8248,5.9257 L 10.7218,5.9257 L 10.7218,5.1284 L 10.7218,4.9976 L 10.7151,4.8969 L 10.7012,4.8085 L 10.6681,4.7894 L 10.6402,4.8033 L 10.6288,4.8550 L 10.6169,4.9651 L 10.6097,5.1263 L 10.6097,5.8973 L 10.4976,5.8973 L 10.4790,5.7480 L 10.4578,5.6079 L 10.4511,5.5304 L 10.4604,5.4581 L 10.4836,5.3108 L 10.4955,5.1025 L 10.4955,4.9227 L 10.4696,4.7641 L 10.4299,4.6049 L 10.4040,4.4344 L 10.3529,4.1351 L 10.3038,3.9879 L 10.2474,3.8313 L 10.1890,3.7145 L 10.1260,3.6137 L 10.0583,3.5367 L 9.9767,3.4525 L 9.8924,3.3962 L 9.7663,3.3285 L 9.5508,3.2727 Z M 4.4757,2.6577 L 4.4101,2.7342 L 4.4059,2.8655 L 4.4173,3.0143 L 4.7625,3.3481 L 5.0400,3.6034 L 5.7733,4.3052 L 6.5273,5.0229 L 7.5944,6.0498 L 8.2760,6.6952 L 8.9101,7.2977 L 8.9214,7.3448 L 8.9643,7.3856 L 9.0604,7.4461 L 9.1013,7.4233 A 0.3221,0.3221 0.00 0,0 9.0460,7.6026 A 0.3221,0.3221 0.00 0,0 9.0527,7.6667 L 9.0289,7.6238 L 8.9633,7.7458 L 8.8821,7.8832 L 8.8842,7.9690 L 8.8641,8.0052 L 8.4444,8.3731 L 8.3809,8.4093 L 8.1442,8.4295 L 7.5752,9.0367 L 7.0316,9.6051 L 6.2373,10.4381 L 5.4700,11.2298 L 4.8219,11.9362 L 4.6690,12.1259 L 4.5108,12.3336 L 4.3935,12.4824 L 4.4700,12.5481 L 4.6008,12.5522 L 4.7501,12.5414 L 5.0839,12.1956 L 5.3392,11.9181 L 6.0410,11.1848 L 6.7582,10.4309 L 7.7851,9.3638 L 8.4305,8.6822 L 9.0330,8.0481 L 9.0806,8.0367 L 9.1214,7.9938 L 9.1819,7.8977 L 9.1483,7.8378 A 0.3221,0.3221 0.00 0,0 9.3679,7.9251 A 0.3221,0.3221 0.00 0,0 9.4444,7.9153 L 9.3974,7.9416 L 9.5188,8.0078 L 9.6568,8.0889 L 9.7426,8.0863 L 9.7787,8.1070 L 10.1462,8.5266 L 10.1823,8.5897 L 10.2030,8.8269 L 10.8097,9.3953 L 11.3786,9.9394 L 12.2111,10.7337 L 13.0033,11.5011 L 13.7098,12.1486 L 13.8994,12.3021 L 14.1071,12.4602 L 14.2560,12.5775 L 14.3211,12.5005 L 14.3257,12.3698 L 14.3144,12.2210 L 13.9692,11.8871 L 13.6917,11.6318 L 12.9584,10.9301 L 12.2044,10.2123 L 11.1373,9.1855 L 10.4557,8.5400 L 9.8216,7.9375 L 9.8103,7.8900 L 9.7674,7.8497 L 9.6712,7.7892 L 9.5937,7.8326 A 0.3221,0.3221 0.00 0,0 9.6898,7.6026 L 9.7560,7.4812 L 9.8371,7.3432 L 9.8351,7.2574 L 9.8552,7.2218 L 10.2748,6.8538 L 10.3379,6.8177 L 10.5751,6.7975 L 11.1435,6.1903 L 11.6877,5.6214 L 12.4819,4.7889 L 13.2493,3.9967 L 13.8968,3.2902 L 14.0503,3.1006 L 14.2084,2.8934 L 14.3257,2.7440 L 14.2493,2.6789 L 14.1180,2.6743 L 13.9692,2.6856 L 13.6353,3.0308 L 13.3801,3.3083 L 12.6783,4.0416 L 11.9605,4.7956 L 10.9337,5.8632 L 10.2883,6.5443 L 9.6857,7.1789 L 9.6387,7.1897 L 9.5979,7.2326 L 9.5374,7.3288 L 9.5384,7.3303 A 0.3221,0.3221 0.00 0,0 9.3679,7.2807 A 0.3221,0.3221 0.00 0,0 9.3188,7.2848 L 9.3183,7.2848 L 9.2129,7.2275 L 9.0749,7.1463 L 8.9891,7.1484 L 8.9529,7.1282 L 8.5850,6.7086 L 8.5493,6.6451 L 8.5287,6.4084 L 7.9220,5.8394 L 7.3530,5.2958 L 6.5205,4.5015 L 5.7283,3.7341 L 5.0219,3.0866 L 4.8323,2.9332 L 4.6245,2.7750 L 4.4757,2.6577 Z","a":[9.26,7.408]},"A359":{"d":"M 9.2613,0.2118 L 9.1822,0.2480 L 9.0452,0.4175 L 8.8825,0.7699 L 8.7584,1.1942 L 8.6406,1.7358 L 8.5688,2.0934 L 8.5130,2.5321 L 8.4685,3.0447 L 8.4685,6.1143 L 8.0856,6.5008 L 7.0004,7.3261 L 7.0412,7.1551 L 7.0671,6.9060 L 7.0970,6.6197 L 7.0970,6.1257 L 7.0634,6.0140 L 6.9746,5.9060 L 6.7663,5.8580 L 6.3575,5.8580 L 6.1643,5.9060 L 6.0826,5.9991 L 6.0563,6.0993 L 6.0377,6.3448 L 6.0377,6.6497 L 6.0676,7.0176 L 6.1121,7.3220 L 6.1607,7.4822 L 6.2867,7.4822 L 6.3575,7.6935 L 6.4278,7.7535 L 1.4891,11.2985 L 1.2214,11.5362 L 1.0545,11.7186 L 0.9429,11.9005 L 0.8871,12.1568 L 0.8871,12.4617 L 0.9615,12.2907 L 1.0876,12.1496 L 1.2400,12.0307 L 1.4297,11.9119 L 3.9603,10.8194 L 3.9939,10.8603 L 4.0419,10.7858 L 4.8042,10.4996 L 4.8042,10.6484 L 4.8486,10.7042 L 4.9153,10.6262 L 4.9194,10.4551 L 5.9560,10.0422 L 5.9632,10.2060 L 6.0154,10.2060 L 6.0826,9.9978 L 6.5730,9.7973 L 7.2045,9.7973 L 7.2159,9.9905 L 7.2681,10.0350 L 7.3125,9.9161 L 7.3234,9.7895 L 8.3864,9.7895 L 8.4572,10.3321 L 8.4572,12.8038 L 8.4866,13.2312 L 8.5279,13.5319 L 8.6018,14.2420 L 8.7248,14.9148 L 8.8437,15.6357 L 7.1192,17.0030 L 6.9968,17.1627 L 6.8965,17.3674 L 6.8071,17.6309 L 6.7999,17.8836 L 6.8035,17.9844 L 6.8629,17.8800 L 9.0592,17.0775 L 9.1036,17.3152 L 9.2225,17.5012 L 9.2614,17.7678 L 9.2985,17.5012 L 9.4173,17.3152 L 9.4618,17.0775 L 11.6585,17.8800 L 11.7179,17.9844 L 11.7215,17.8836 L 11.7137,17.6309 L 11.6249,17.3674 L 11.5246,17.1627 L 11.4016,17.0030 L 9.6777,15.6357 L 9.7966,14.9148 L 9.9190,14.2420 L 9.9934,13.5319 L 10.0343,13.2312 L 10.0637,12.8038 L 10.0637,10.3321 L 10.1345,9.7895 L 11.1975,9.7895 L 11.2084,9.9161 L 11.2533,10.0350 L 11.3050,9.9905 L 11.3164,9.7973 L 11.9484,9.7973 L 12.4388,9.9978 L 12.5054,10.2060 L 12.5576,10.2060 L 12.5648,10.0422 L 13.6020,10.4551 L 13.6056,10.6262 L 13.6722,10.7042 L 13.7172,10.6484 L 13.7172,10.4996 L 14.4789,10.7858 L 14.5270,10.8603 L 14.5606,10.8194 L 17.0912,11.9119 L 17.2808,12.0307 L 17.4333,12.1496 L 17.5599,12.2907 L 17.6338,12.4617 L 17.6338,12.1568 L 17.5786,11.9005 L 17.4669,11.7186 L 17.2995,11.5362 L 17.0318,11.2985 L 12.0931,7.7535 L 12.1639,7.6935 L 12.2342,7.4822 L 12.3608,7.4822 L 12.4089,7.3220 L 12.4538,7.0176 L 12.4833,6.6497 L 12.4833,6.3448 L 12.4647,6.0993 L 12.4388,5.9991 L 12.3572,5.9060 L 12.1639,5.8580 L 11.7552,5.8580 L 11.5469,5.9060 L 11.4575,6.0140 L 11.4244,6.1257 L 11.4244,6.6197 L 11.4539,6.9060 L 11.4797,7.1551 L 11.5205,7.3261 L 10.4359,6.5008 L 10.0529,6.1143 L 10.0529,3.0447 L 10.0085,2.5321 L 9.9527,2.0934 L 9.8803,1.7358 L 9.7630,1.1942 L 9.6390,0.7699 L 9.4757,0.4175 L 9.3388,0.2480 Z","a":[9.26,7.937]},"AN28":{"d":"M 9.5890,4.5917 L 9.5038,4.6168 L 9.3720,4.7134 L 9.2403,4.8586 L 9.1612,5.0121 L 9.0382,5.3020 L 8.9240,5.7898 L 8.9023,6.0534 L 8.8801,6.1939 L 8.8976,6.3609 L 8.9199,6.4528 L 8.9199,7.7840 L 7.7820,7.7665 L 7.7861,7.6481 L 7.7861,7.4548 L 7.7820,7.2879 L 7.7820,7.1779 L 7.7732,7.0326 L 7.7597,6.9097 L 7.7292,6.7913 L 7.6982,6.7076 L 7.6367,6.6420 L 7.6367,6.5278 L 7.5887,6.3960 L 7.5313,6.3169 L 7.4874,6.2994 L 7.4259,6.3257 L 7.3866,6.3960 L 7.3556,6.4968 L 7.3381,6.6285 L 7.2853,6.6988 L 7.2326,6.8569 L 7.2197,7.0373 L 7.2197,7.4373 L 7.2326,7.7137 L 7.2021,7.7711 L 4.7201,7.8853 L 1.4779,8.0347 L 1.3684,8.0522 L 1.3022,8.1401 L 1.2893,8.2455 L 1.2935,8.4388 L 1.3157,8.6362 L 1.3550,8.8341 L 1.3989,8.9746 L 1.4867,8.9963 L 7.0833,9.3788 L 8.9638,9.4051 L 8.9638,10.0552 L 8.9767,10.3100 L 8.9989,10.6128 L 9.0470,11.0350 L 9.1173,11.4344 L 9.3855,12.9062 L 7.6677,13.1563 L 7.6590,13.0380 L 7.6414,12.9413 L 7.6192,12.8886 L 7.5711,12.8886 L 7.5489,12.9501 L 7.5272,13.1651 L 7.5272,13.4948 L 7.5711,14.0570 L 7.6016,14.3686 L 7.6631,13.9909 L 7.6807,13.7800 L 7.7205,13.7800 L 7.9313,14.3206 L 9.6950,14.3423 L 11.2500,14.3206 L 11.4608,13.7800 L 11.5006,13.7800 L 11.5182,13.9909 L 11.5797,14.3686 L 11.6101,14.0570 L 11.6541,13.4948 L 11.6541,13.1651 L 11.6324,12.9501 L 11.6101,12.8886 L 11.5621,12.8886 L 11.5399,12.9413 L 11.5223,13.0380 L 11.5135,13.1563 L 9.7958,12.9062 L 10.0640,11.4344 L 10.1343,11.0350 L 10.1823,10.6128 L 10.2045,10.3100 L 10.2175,10.0552 L 10.2175,9.4051 L 12.0980,9.3788 L 17.6940,8.9963 L 17.7819,8.9746 L 17.8258,8.8341 L 17.8656,8.6362 L 17.8873,8.4388 L 17.8920,8.2455 L 17.8785,8.1401 L 17.8129,8.0522 L 17.7028,8.0347 L 14.4612,7.8853 L 11.9791,7.7711 L 11.9486,7.7137 L 11.9616,7.4373 L 11.9616,7.0373 L 11.9486,6.8569 L 11.8959,6.6988 L 11.8432,6.6285 L 11.8257,6.4968 L 11.7946,6.3960 L 11.7554,6.3257 L 11.6939,6.2994 L 11.6500,6.3169 L 11.5926,6.3960 L 11.5445,6.5278 L 11.5445,6.6420 L 11.4830,6.7076 L 11.4520,6.7913 L 11.4215,6.9097 L 11.4081,7.0326 L 11.3993,7.1779 L 11.3993,7.2879 L 11.3952,7.4548 L 11.3952,7.6481 L 11.3993,7.7665 L 10.2614,7.7840 L 10.2614,6.4528 L 10.2836,6.3609 L 10.3012,6.1939 L 10.2790,6.0534 L 10.2573,5.7898 L 10.1431,5.3020 L 10.0201,5.0121 L 9.9410,4.8586 L 9.8092,4.7134 L 9.6774,4.6168 Z","a":[9.26,8.202]},"A119":{"d":"M 8.7623,14.9975 L 8.7460,15.9051 L 8.7195,16.2702 L 8.6236,16.2866 L 8.6236,16.3192 L 8.7134,16.3335 L 8.7113,16.3539 L 8.6216,16.3804 L 8.5930,16.4130 L 8.5930,16.4559 L 8.5074,16.4742 L 8.5910,16.4844 L 8.5991,16.5395 L 8.6277,16.5782 L 8.6889,16.5986 L 8.6889,16.6109 L 8.6257,16.6211 L 8.6236,16.6619 L 8.7113,16.6761 L 8.7501,17.1269 L 8.7644,17.7755 L 8.7684,18.3548 L 8.7807,17.7490 L 8.7909,17.0331 L 8.8133,16.9739 L 8.8174,16.6823 L 8.8357,16.6659 L 8.8990,16.6679 L 8.9153,16.6516 L 8.9112,16.6231 L 8.8235,16.6190 L 8.8031,16.5904 L 8.8031,16.3334 L 8.9092,16.3252 L 8.9051,16.2824 L 8.8194,16.2497 L 8.7929,15.9254 Z M 9.3074,2.2159 L 9.2227,2.2304 L 9.0961,2.3053 L 8.9628,2.4319 L 8.8610,2.5807 L 8.7731,2.7683 L 8.6465,3.0871 L 8.5333,3.4556 L 8.4791,3.6680 L 8.4408,3.9367 L 8.3933,4.4023 L 8.3370,4.7568 L 8.2398,5.4012 L 8.2145,5.7557 L 8.2145,6.9334 L 8.2305,7.5210 L 8.2486,7.7199 L 8.2982,8.1514 L 8.3819,8.8858 L 8.4811,9.8438 L 8.5266,10.3503 L 8.6170,11.1931 L 8.7276,11.9662 L 8.8248,12.9424 L 8.7752,12.9987 L 8.6439,13.0126 L 8.6077,13.0462 L 8.6419,13.4421 L 8.6894,13.4824 L 8.7953,13.4689 L 8.8656,13.4984 L 8.9447,14.2420 L 7.4145,14.2823 L 7.3153,14.2963 L 7.2295,14.3573 L 7.1076,14.5242 L 7.1076,14.7975 L 7.4058,14.7975 L 9.0170,14.9267 L 9.1591,16.4409 L 8.8000,16.4409 L 8.8000,16.4925 L 9.1664,16.4925 L 9.2677,17.8599 L 9.3085,17.8733 L 9.3426,17.8620 L 9.4511,16.4770 L 9.5503,15.4781 L 9.5911,14.9288 L 10.6304,14.8611 L 11.2138,14.8089 L 11.4939,14.7572 L 11.5207,14.7138 L 11.5207,14.5557 L 11.4903,14.5361 L 11.4877,14.4678 L 11.4308,14.3955 L 11.3693,14.3387 L 11.2903,14.2989 L 11.2133,14.2813 L 9.6650,14.2394 L 9.7374,13.5170 L 9.8144,13.4798 L 9.9286,13.4906 L 9.9684,13.4643 L 10.0009,13.0473 L 9.9658,13.0163 L 9.8629,13.0054 L 9.7947,13.0276 L 9.8914,11.9910 L 9.9792,11.3802 L 10.0407,10.8908 L 10.0914,10.3834 L 10.1394,9.7684 L 10.3285,8.1566 L 10.3745,7.7411 L 10.3921,7.5019 L 10.3921,5.5867 L 10.3746,5.4023 L 10.3306,5.0948 L 10.2712,4.6669 L 10.2231,4.2494 L 10.1462,3.7248 L 10.0955,3.4985 L 10.0056,3.1843 L 9.8805,2.8417 L 9.7860,2.6443 L 9.7002,2.4970 L 9.5906,2.3652 L 9.4826,2.2794 L 9.3819,2.2314 Z M 8.2398,5.4012 L 8.2522,5.3160 L 8.0383,5.2648 L 8.0383,5.1687 L 8.0191,4.5594 L 7.9613,4.5098 L 7.9117,4.5594 L 7.9117,5.1687 L 7.9117,5.1702 L 7.9117,5.4539 L 7.9117,5.4550 L 7.9117,8.6672 L 7.9117,8.6687 L 7.9117,8.9519 L 7.9117,8.9535 L 7.9003,9.4113 L 7.9468,9.5157 L 7.9933,9.5157 L 8.0378,9.4170 L 8.0378,8.9535 L 8.0378,8.9519 L 8.0383,8.9519 L 8.0383,8.8558 L 8.2522,8.8046 L 8.2398,8.7199 L 8.0383,8.7581 L 8.0383,8.6672 L 8.0378,8.6672 L 8.0383,5.4550 L 8.0383,5.4539 L 8.0383,5.3630 Z M 10.6422,4.5098 L 10.5926,4.5594 L 10.5926,5.1702 L 10.5926,5.2663 L 10.3782,5.3175 L 10.3911,5.4023 L 10.5926,5.3640 L 10.5926,5.4550 L 10.5926,8.6687 L 10.5926,8.7592 L 10.3911,8.7209 L 10.3782,8.8062 L 10.5926,8.8573 L 10.5926,8.9535 L 10.5813,9.4113 L 10.6278,9.5157 L 10.6743,9.5157 L 10.7187,9.4170 L 10.7187,8.9535 L 10.7187,8.6687 L 10.7187,5.4550 L 10.7187,5.1702 L 10.7001,4.5594 Z M 4.2545,2.4784 L 4.1145,2.6143 L 4.1382,2.8427 L 4.1749,3.0003 L 4.2245,3.1078 L 4.3320,3.2179 L 8.7375,7.3990 L 8.8108,7.4078 L 8.8584,7.4920 L 8.9705,7.4833 L 9.0883,7.5386 A 0.2619,0.2619 0.00 0,0 9.0439,7.6848 L 8.7592,7.9230 L 8.7524,7.9706 L 8.7312,7.9897 L 8.7333,8.1060 L 8.6925,8.1623 L 8.5716,8.1793 L 7.9659,8.6170 L 5.5997,11.1559 L 5.5392,11.1647 L 5.3816,11.3414 L 5.3795,11.3911 L 4.5067,12.3305 L 4.4333,12.4039 L 4.4095,12.4773 L 4.3837,12.5331 L 4.3041,12.6018 L 4.1987,12.6861 L 4.0995,12.7357 L 4.2354,12.8757 L 4.4638,12.8519 L 4.6209,12.8153 L 4.7289,12.7656 L 4.8385,12.6582 L 9.0201,8.2527 L 9.0284,8.1794 L 9.1126,8.1318 L 9.1038,8.0197 L 9.1596,7.9024 A 0.2619,0.2619 0.00 0,0 9.3054,7.9468 L 9.5436,8.2310 L 9.5911,8.2378 L 9.6103,8.2589 L 9.7270,8.2569 L 9.7829,8.2982 L 9.8004,8.4186 L 10.2376,9.0243 L 12.7765,11.3910 L 12.7853,11.4510 L 12.9620,11.6086 L 13.0116,11.6107 L 13.9511,12.4835 L 14.0245,12.5569 L 14.0979,12.5807 L 14.1537,12.6065 L 14.2229,12.6861 L 14.3071,12.7915 L 14.3562,12.8907 L 14.4968,12.7553 L 14.4730,12.5264 L 14.4363,12.3693 L 14.3867,12.2613 L 14.2787,12.1518 L 9.8733,7.9701 L 9.7999,7.9618 L 9.7529,7.8776 L 9.6408,7.8864 L 9.5229,7.8306 A 0.2619,0.2619 0.00 0,0 9.5674,7.6848 L 9.8521,7.4466 L 9.8583,7.3991 L 9.8800,7.3800 L 9.8780,7.2637 L 9.9188,7.2074 L 10.0397,7.1903 L 10.6453,6.7526 L 13.0116,4.2137 L 13.0721,4.2049 L 13.2292,4.0282 L 13.2313,3.9786 L 14.1046,3.0391 L 14.1775,2.9657 L 14.2012,2.8924 L 14.2271,2.8366 L 14.3072,2.7673 L 14.4126,2.6836 L 14.5118,2.6340 L 14.3759,2.4939 L 14.1475,2.5172 L 13.9899,2.5539 L 13.8824,2.6035 L 13.7723,2.7115 L 9.5912,7.1169 L 9.5824,7.1903 L 9.4987,7.2373 L 9.5070,7.3495 L 9.4517,7.4673 A 0.2619,0.2619 0.00 0,0 9.3054,7.4228 L 9.0671,7.1386 L 9.0201,7.1319 L 9.0005,7.1102 L 8.8842,7.1122 L 8.8279,7.0714 L 8.8108,6.9510 L 8.3731,6.3453 L 5.8343,3.9786 L 5.8260,3.9181 L 5.6493,3.7610 L 5.5997,3.7589 L 4.6597,2.8861 L 4.5863,2.8127 L 4.5134,2.7890 L 4.4571,2.7631 L 4.3884,2.6836 L 4.3041,2.5776 Z","a":[9.26,5.027]},"AC90":{"d":"M 9.1571,3.0866 L 9.0279,3.2256 L 8.9033,3.3998 L 8.7741,3.6385 L 8.6450,3.9517 L 8.5752,4.2499 L 8.5008,4.6721 L 8.4661,5.0250 L 8.4362,5.4575 L 8.4362,7.6889 L 8.4165,8.4646 L 7.1143,8.4646 L 7.0941,8.1814 L 7.0745,7.9876 L 7.0445,7.8434 L 6.9500,7.8135 L 6.9551,7.6993 L 6.9303,7.5349 L 6.8755,7.3711 L 6.7913,7.2518 L 6.7117,7.3313 L 6.6471,7.4554 L 6.6172,7.5897 L 6.5975,7.7339 L 6.5975,7.8083 L 6.5278,7.8331 L 6.4978,7.9773 L 6.4730,8.1814 L 6.4332,8.4594 L 1.2640,8.4300 L 1.1648,8.4346 L 1.1100,8.4548 L 1.0754,8.5194 L 1.0702,8.6636 L 1.0651,8.9467 L 1.0899,9.0759 L 1.1198,9.1307 L 6.3340,10.4976 L 6.3882,10.7658 L 6.3934,11.3027 L 6.4182,11.4220 L 6.4534,11.4665 L 6.5624,11.5114 L 6.6719,11.5311 L 6.9055,11.5362 L 7.0497,11.5114 L 7.1639,11.4468 L 7.1985,11.3972 L 7.2233,11.3326 L 7.2187,11.0691 L 7.2337,10.7161 L 8.1080,10.9595 L 8.5008,10.9497 L 8.5654,11.7502 L 8.6150,12.2618 L 8.6548,12.7739 L 8.6899,13.1914 L 8.8687,15.1247 L 6.0751,15.6864 L 6.0751,15.9701 L 9.2449,16.5711 L 12.2918,15.9701 L 12.2918,15.6864 L 9.4986,15.1247 L 9.6774,13.1914 L 9.7121,12.7739 L 9.7519,12.2618 L 9.8015,11.7502 L 9.8661,10.9497 L 10.2588,10.9595 L 11.1337,10.7161 L 11.1487,11.0691 L 11.1435,11.3326 L 11.1683,11.3972 L 11.2035,11.4468 L 11.3177,11.5114 L 11.4618,11.5362 L 11.6954,11.5311 L 11.8044,11.5114 L 11.9140,11.4665 L 11.9486,11.4220 L 11.9734,11.3027 L 11.9786,10.7658 L 12.0334,10.4976 L 17.2470,9.1307 L 17.2770,9.0759 L 17.3018,8.9467 L 17.2966,8.6636 L 17.2920,8.5194 L 17.2568,8.4548 L 17.2026,8.4346 L 17.1028,8.4300 L 11.9336,8.4594 L 11.8938,8.1814 L 11.8690,7.9773 L 11.8396,7.8331 L 11.7698,7.8083 L 11.7698,7.7339 L 11.7497,7.5897 L 11.7202,7.4554 L 11.6556,7.3313 L 11.5760,7.2518 L 11.4913,7.3711 L 11.4365,7.5349 L 11.4117,7.6993 L 11.4169,7.8135 L 11.3223,7.8434 L 11.2929,7.9876 L 11.2727,8.1814 L 11.2531,8.4646 L 9.9508,8.4646 L 9.9307,7.6889 L 9.9307,5.4575 L 9.9012,5.0250 L 9.8661,4.6721 L 9.7917,4.2499 L 9.7219,3.9512 L 9.5927,3.6385 L 9.4635,3.3998 L 9.3395,3.2256 L 9.2103,3.0866 L 9.1571,3.0866 Z","a":[9.26,9.525]},"A140":{"d":"M 9.3038,1.7291 L 9.2578,1.7379 L 9.2118,1.7596 L 9.1571,1.7901 L 9.0956,1.8604 L 9.0160,1.9642 L 8.9307,2.0779 L 8.8418,2.2154 L 8.7772,2.3254 L 8.6920,2.4970 L 8.5938,2.6805 L 8.5142,2.8918 L 8.4470,3.1027 L 8.3979,3.2923 L 8.3463,3.5217 L 8.3122,3.7088 L 8.2879,3.8985 L 8.2636,4.1429 L 8.2512,4.3847 L 8.2450,5.1408 L 8.2450,8.4543 L 7.7649,8.4636 L 7.1861,8.4760 L 6.5805,8.4791 L 6.5805,7.9220 L 6.5712,7.7876 L 6.5531,7.7783 L 6.5531,7.6528 L 6.5407,7.5732 L 6.5314,7.5122 L 6.5195,7.4755 L 6.5040,7.4326 L 6.4885,7.3866 L 6.4885,7.2306 L 6.7030,7.2213 L 7.1158,7.2120 L 7.3608,7.2001 L 7.5473,7.1939 L 7.6269,7.1784 L 7.6393,7.1665 L 7.6269,7.1541 L 7.5076,7.1448 L 7.3024,7.1355 L 7.0332,7.1236 L 6.6905,7.1112 L 6.4947,7.1019 L 6.4735,7.0042 L 6.4518,6.9153 L 6.4213,6.8203 L 6.3324,6.6673 L 6.2590,6.5877 L 6.2224,6.5877 L 6.1428,6.6704 L 6.0570,6.8146 L 6.0141,6.9825 L 6.0022,7.0957 L 5.8095,7.1112 L 5.4668,7.1205 L 5.1976,7.1324 L 4.9894,7.1448 L 4.8700,7.1572 L 4.8607,7.1691 L 4.8731,7.1877 L 4.9527,7.1970 L 5.1423,7.2063 L 5.3904,7.2182 L 5.7971,7.2275 L 6.0022,7.2337 L 6.0053,7.3375 L 5.9805,7.4109 L 5.9531,7.4998 L 5.9350,7.5794 L 5.9257,7.6652 L 5.9201,7.7747 L 5.9082,7.7866 L 5.9071,7.9220 L 5.8978,7.9349 L 5.8978,8.5028 L 5.4126,8.5121 L 4.9315,8.5251 L 4.4401,8.5354 L 3.9471,8.5483 L 3.4685,8.5592 L 2.9735,8.5721 L 2.4820,8.5834 L 2.0020,8.5938 L 1.5079,8.6072 L 1.0175,8.6186 L 0.5380,8.6289 L 0.4961,8.6305 L 0.4599,8.6331 L 0.4310,8.6475 L 0.4145,8.6615 L 0.4010,8.6837 L 0.3922,8.7137 L 0.3804,8.7736 L 0.3741,8.8982 L 0.3426,8.9023 L 0.3142,8.9193 L 0.2935,8.9281 L 0.2698,8.9648 L 0.2610,8.9865 L 0.2506,9.0320 L 0.2398,9.1245 L 0.2295,9.3705 L 0.2233,9.6614 L 0.2388,9.6759 L 0.2972,9.6810 L 0.3907,9.6914 L 0.4806,9.7017 L 0.5886,9.7126 L 0.6821,9.7229 L 0.7772,9.7358 L 0.8718,9.7472 L 0.9633,9.7580 L 1.0594,9.7694 L 1.1674,9.7823 L 1.7978,9.8593 L 2.5492,9.9529 L 5.4555,10.3012 L 6.1304,10.3911 L 6.1474,10.4588 L 6.1697,10.5223 L 6.1945,10.5652 L 6.2193,10.6148 L 6.2358,10.6510 L 6.2699,10.6004 L 6.2958,10.5446 L 6.3164,10.4924 L 6.3531,10.4185 L 8.1721,10.6381 L 8.2305,10.9140 L 8.2450,10.9295 L 8.2491,12.1062 L 8.2605,12.4545 L 8.2724,12.7305 L 8.2843,12.9516 L 8.2946,13.1403 L 8.3075,13.2896 L 8.3215,13.4224 L 8.3323,13.5470 L 8.3427,13.6550 L 8.3540,13.7733 L 8.3675,13.8668 L 8.3804,13.9490 L 8.3907,14.0384 L 8.4036,14.1216 L 8.4165,14.2048 L 8.4269,14.2740 L 8.4388,14.3547 L 8.4491,14.4234 L 8.4620,14.4926 L 8.4724,14.5639 L 8.4853,14.6368 L 8.4972,14.7055 L 8.5090,14.7784 L 8.5204,14.8461 L 8.5313,14.9071 L 8.5442,14.9748 L 8.5530,15.0440 L 8.5649,15.1153 L 8.5623,15.1634 L 8.5530,15.2078 L 8.5220,15.2750 L 8.4672,15.3236 L 5.9986,16.0450 L 5.9299,16.0693 L 5.8637,16.1375 L 5.8265,16.2212 L 5.7976,16.4067 L 5.7976,16.9230 L 5.8152,16.9426 L 8.9416,16.9426 L 8.9726,17.0331 L 9.0031,17.1964 L 9.0496,17.4062 L 9.1312,17.7591 L 9.1467,17.7963 L 9.1839,17.8320 L 9.2439,17.8341 L 9.2966,18.4428 L 9.3560,17.8341 L 9.4155,17.8320 L 9.4532,17.7963 L 9.4687,17.7591 L 9.5503,17.4062 L 9.5963,17.1964 L 9.6273,17.0331 L 9.6583,16.9426 L 12.7842,16.9426 L 12.8018,16.9230 L 12.8018,16.4067 L 12.7734,16.2212 L 12.7357,16.1375 L 12.6695,16.0693 L 12.6013,16.0450 L 10.1322,15.3236 L 10.0780,15.2750 L 10.0464,15.2078 L 10.0376,15.1634 L 10.0350,15.1153 L 10.0464,15.0440 L 10.0557,14.9748 L 10.0686,14.9071 L 10.0790,14.8461 L 10.0908,14.7784 L 10.1027,14.7055 L 10.1141,14.6368 L 10.1270,14.5640 L 10.1374,14.4926 L 10.1508,14.4234 L 10.1611,14.3547 L 10.1725,14.2740 L 10.1834,14.2048 L 10.1963,14.1216 L 10.2092,14.0384 L 10.2195,13.9490 L 10.2324,13.8668 L 10.2454,13.7733 L 10.2573,13.6550 L 10.2676,13.5470 L 10.2779,13.4224 L 10.2924,13.2896 L 10.3053,13.1403 L 10.3157,12.9517 L 10.3275,12.7305 L 10.3389,12.4545 L 10.3508,12.1062 L 10.3549,10.9296 L 10.3689,10.9141 L 10.4278,10.6381 L 12.2468,10.4185 L 12.2829,10.4924 L 12.3041,10.5446 L 12.3300,10.6004 L 12.3636,10.6510 L 12.3806,10.6148 L 12.4054,10.5652 L 12.4302,10.5223 L 12.4524,10.4588 L 12.4690,10.3911 L 13.1439,10.3012 L 16.0502,9.9529 L 16.8021,9.8593 L 17.4325,9.7823 L 17.5405,9.7694 L 17.6366,9.7580 L 17.7276,9.7472 L 17.8227,9.7358 L 17.9177,9.7229 L 18.0113,9.7126 L 18.1193,9.7017 L 18.2087,9.6914 L 18.3027,9.6811 L 18.3611,9.6759 L 18.3766,9.6614 L 18.3699,9.3705 L 18.3596,9.1245 L 18.3492,9.0320 L 18.3389,8.9865 L 18.3296,8.9648 L 18.3064,8.9281 L 18.2857,8.9193 L 18.2573,8.9023 L 18.2257,8.8982 L 18.2195,8.7736 L 18.2077,8.7137 L 18.1984,8.6837 L 18.1854,8.6615 L 18.1684,8.6475 L 18.1400,8.6331 L 18.1038,8.6305 L 18.0619,8.6289 L 17.5824,8.6186 L 17.0920,8.6072 L 16.5979,8.5938 L 16.1179,8.5835 L 15.6264,8.5721 L 15.1308,8.5592 L 14.6523,8.5483 L 14.1598,8.5354 L 13.6679,8.5251 L 13.1868,8.5121 L 12.7021,8.5028 L 12.7021,7.9349 L 12.6928,7.9220 L 12.6918,7.7866 L 12.6799,7.7747 L 12.6742,7.6652 L 12.6649,7.5794 L 12.6468,7.4998 L 12.6189,7.4109 L 12.5946,7.3375 L 12.5977,7.2337 L 12.8028,7.2275 L 13.2095,7.2182 L 13.4576,7.2063 L 13.6472,7.1970 L 13.7268,7.1877 L 13.7392,7.1691 L 13.7299,7.1572 L 13.6105,7.1448 L 13.4023,7.1324 L 13.1330,7.1205 L 12.7904,7.1112 L 12.5977,7.0957 L 12.5853,6.9825 L 12.5424,6.8146 L 12.4566,6.6704 L 12.3775,6.5877 L 12.3403,6.5877 L 12.2670,6.6673 L 12.1786,6.8203 L 12.1476,6.9154 L 12.1264,7.0042 L 12.1052,7.1019 L 11.9093,7.1112 L 11.5662,7.1236 L 11.2970,7.1355 L 11.0923,7.1448 L 10.9730,7.1541 L 10.9606,7.1665 L 10.9730,7.1784 L 11.0525,7.1939 L 11.2391,7.2001 L 11.4840,7.2120 L 11.8969,7.2213 L 12.1109,7.2306 L 12.1109,7.3866 L 12.0959,7.4326 L 12.0804,7.4755 L 12.0680,7.5122 L 12.0592,7.5732 L 12.0468,7.6528 L 12.0468,7.7783 L 12.0282,7.7876 L 12.0194,7.9220 L 12.0194,8.4791 L 11.4132,8.4760 L 10.8350,8.4636 L 10.3544,8.4543 L 10.3544,5.1408 L 10.3487,4.3847 L 10.3363,4.1429 L 10.3120,3.8985 L 10.2872,3.7088 L 10.2536,3.5217 L 10.2014,3.2923 L 10.1529,3.1027 L 10.0852,2.8918 L 10.0056,2.6805 L 9.9079,2.4970 L 9.8221,2.3254 L 9.7581,2.2154 L 9.6692,2.0779 L 9.5834,1.9642 L 9.5038,1.8604 L 9.4428,1.7901 L 9.3875,1.7596 L 9.3421,1.7379 Z","a":[9.26,8.731]},"A342":{"d":"M 9.3140,0.8067 L 9.2594,0.8279 L 9.1839,0.9059 L 9.1111,1.0098 L 9.0046,1.2258 L 8.9002,1.4733 L 8.7989,1.7518 L 8.7312,1.9885 L 8.6636,2.2515 L 8.5959,2.6133 L 8.5592,2.8577 L 8.5282,3.1652 L 8.5152,3.3838 L 8.5152,3.5528 L 8.5152,6.5722 L 6.9898,7.5014 L 7.0135,7.3530 L 7.0290,7.1944 L 7.0316,7.0404 L 7.0316,6.8740 L 7.0213,6.6425 L 7.0027,6.4730 L 6.9820,6.4472 L 6.4223,6.4472 L 6.3939,6.4678 L 6.3810,6.6136 L 6.3707,6.7701 L 6.3650,6.9443 L 6.3681,7.0952 L 6.3707,7.2621 L 6.3862,7.4001 L 6.4043,7.5484 L 6.4275,7.6838 L 6.4539,7.8243 L 4.1656,9.2428 L 4.1765,9.1230 L 4.1868,9.0108 L 4.1946,8.8625 L 4.1997,8.7090 L 4.1946,8.5111 L 4.1817,8.3499 L 4.1682,8.2171 L 4.1501,8.2016 L 3.5776,8.2016 L 3.5595,8.2197 L 3.5517,8.2822 L 3.5388,8.4253 L 3.5254,8.5788 L 3.5254,8.7431 L 3.5279,8.9044 L 3.5414,9.0682 L 3.5646,9.2584 L 3.5853,9.4067 L 3.6194,9.5756 L 1.0713,11.1533 L 1.0346,11.1921 L 1.0242,11.2391 L 1.0191,11.3378 L 0.8030,11.8427 L 0.8030,12.0639 L 1.0087,11.9181 L 3.7858,10.7079 L 3.7832,10.7756 L 3.7987,10.8851 L 3.8354,11.0102 L 3.8561,11.0593 L 3.8902,11.0593 L 3.9238,10.9502 L 3.9579,10.8200 L 3.9734,10.6950 L 3.9734,10.6376 L 4.2364,10.5544 L 4.2390,10.6247 L 4.2571,10.7208 L 4.2804,10.8149 L 4.3145,10.9032 L 4.3403,10.9032 L 4.3770,10.7885 L 4.4080,10.6640 L 4.4261,10.5492 L 4.4261,10.4790 L 5.1630,10.2319 L 5.1604,10.3048 L 5.1811,10.4061 L 5.2147,10.5182 L 5.2410,10.5828 L 5.2669,10.5828 L 5.3036,10.4660 L 5.3320,10.3513 L 5.3526,10.2526 L 5.3526,10.1617 L 6.0896,9.9167 L 6.0896,9.9870 L 6.1128,10.0940 L 6.1490,10.2211 L 6.1727,10.2655 L 6.1960,10.2629 L 6.2353,10.1534 L 6.2637,10.0340 L 6.2818,9.9270 L 6.2844,9.8412 L 6.9820,9.6020 L 7.1045,9.6071 L 7.1045,9.7239 L 7.1251,9.8387 L 7.1541,9.9585 L 7.1799,10.0128 L 7.2083,10.0128 L 7.2450,9.9089 L 7.2760,9.7916 L 7.2890,9.6929 L 7.2998,9.6020 L 8.3824,9.6020 L 8.3928,9.7374 L 8.4186,9.8805 L 8.4501,10.0102 L 8.4889,10.1405 L 8.5152,10.2107 L 8.5152,11.7388 L 8.5178,11.9910 L 8.5307,12.2385 L 8.5540,12.6158 L 8.5803,12.8995 L 8.6165,13.1961 L 8.6816,13.6725 L 8.9705,15.5179 L 6.7112,16.8558 L 6.6621,16.9002 L 6.6151,16.9602 L 6.5893,17.0382 L 6.5319,17.5979 L 9.1710,16.8455 L 9.2439,17.5818 L 9.2806,17.6030 L 9.3467,17.6030 L 9.3834,17.5818 L 9.4563,16.8455 L 12.0954,17.5979 L 12.0380,17.0382 L 12.0122,16.9602 L 11.9652,16.9002 L 11.9155,16.8558 L 9.6563,15.5179 L 9.9451,13.6725 L 10.0102,13.1961 L 10.0469,12.8995 L 10.0728,12.6158 L 10.0965,12.2385 L 10.1095,11.9910 L 10.1121,11.7388 L 10.1121,10.2107 L 10.1379,10.1405 L 10.1772,10.0102 L 10.2082,9.8805 L 10.2345,9.7374 L 10.2449,9.6020 L 11.3275,9.6020 L 11.3378,9.6929 L 11.3507,9.7916 L 11.3823,9.9089 L 11.4184,10.0128 L 11.4474,10.0128 L 11.4732,9.9585 L 11.5016,9.8387 L 11.5228,9.7239 L 11.5228,9.6072 L 11.6448,9.6020 L 12.3424,9.8413 L 12.3450,9.9270 L 12.3636,10.0340 L 12.3920,10.1534 L 12.4313,10.2629 L 12.4546,10.2655 L 12.4778,10.2211 L 12.5145,10.0940 L 12.5378,9.9870 L 12.5378,9.9167 L 13.2742,10.1617 L 13.2742,10.2526 L 13.2953,10.3513 L 13.3238,10.4660 L 13.3605,10.5828 L 13.3863,10.5828 L 13.4121,10.5182 L 13.4462,10.4061 L 13.4669,10.3048 L 13.4643,10.2320 L 14.2007,10.4790 L 14.2007,10.5492 L 14.2193,10.6640 L 14.2503,10.7885 L 14.2870,10.9032 L 14.3128,10.9032 L 14.3464,10.8149 L 14.3702,10.7208 L 14.3883,10.6247 L 14.3909,10.5544 L 14.6539,10.6376 L 14.6539,10.6950 L 14.6694,10.8200 L 14.7035,10.9503 L 14.7371,11.0593 L 14.7712,11.0593 L 14.7919,11.0102 L 14.8281,10.8851 L 14.8441,10.7756 L 14.8415,10.7079 L 17.6186,11.9182 L 17.8243,12.0639 L 17.8243,11.8427 L 17.6083,11.3378 L 17.6031,11.2391 L 17.5922,11.1921 L 17.5560,11.1533 L 15.0079,9.5757 L 15.0415,9.4067 L 15.0626,9.2584 L 15.0859,9.0682 L 15.0988,8.9044 L 15.1014,8.7431 L 15.1014,8.5788 L 15.0885,8.4253 L 15.0756,8.2822 L 15.0678,8.2197 L 15.0497,8.2016 L 14.4766,8.2016 L 14.4585,8.2171 L 14.4456,8.3499 L 14.4327,8.5111 L 14.4275,8.7090 L 14.4327,8.8625 L 14.4405,9.0108 L 14.4508,9.1230 L 14.4611,9.2429 L 12.1734,7.8243 L 12.1993,7.6838 L 12.2230,7.5484 L 12.2411,7.4001 L 12.2566,7.2621 L 12.2592,7.0952 L 12.2618,6.9443 L 12.2566,6.7701 L 12.2463,6.6136 L 12.2334,6.4678 L 12.2044,6.4472 L 11.6448,6.4472 L 11.6241,6.4730 L 11.6060,6.6425 L 11.5957,6.8740 L 11.5957,7.0404 L 11.5983,7.1944 L 11.6138,7.3530 L 11.6370,7.5014 L 10.1121,6.5722 L 10.1121,3.5528 L 10.1121,3.3838 L 10.0991,3.1652 L 10.0676,2.8577 L 10.0314,2.6133 L 9.9637,2.2515 L 9.8960,1.9885 L 9.8283,1.7518 L 9.7265,1.4733 L 9.6227,1.2258 L 9.5157,1.0098 L 9.4428,0.9059 L 9.3674,0.8279 Z","a":[9.26,7.937]},"P32T":{"d":"M 9.1745,2.8907 L 9.0625,2.9285 L 9.0005,3.0319 L 8.9230,3.2231 L 8.8868,3.3729 L 8.8661,3.5176 L 8.8403,3.5331 L 8.8041,3.6210 L 8.7731,3.6416 L 8.7524,3.6365 L 8.7163,3.6055 L 8.6904,3.5590 L 8.4424,3.5590 L 8.3700,3.6313 L 8.3080,3.8742 L 8.2667,4.2147 L 8.2104,4.6075 L 8.1638,5.0565 L 8.1173,6.2394 L 7.1148,6.6580 L 5.0023,6.6580 L 1.2475,6.9680 L 1.1441,7.0042 L 1.0511,7.0921 L 0.9736,7.2264 L 0.9271,7.3861 L 0.9064,7.4636 L 0.8082,7.5825 L 0.8082,7.6445 L 0.9116,7.7272 L 0.9219,7.9959 L 0.9684,8.2129 L 1.0563,8.3726 L 1.1596,8.4811 L 1.2475,8.5225 L 4.8529,8.9101 L 8.2052,8.9307 L 8.9075,14.1940 L 6.5107,14.1940 L 6.4332,14.2353 L 6.3247,14.3490 L 6.2833,14.4523 L 6.2472,14.5815 L 6.2472,14.9329 L 6.2782,15.0926 L 6.3505,15.2528 L 6.4384,15.3768 L 6.5314,15.4544 L 9.1814,15.4544 L 11.8179,15.4544 L 11.9109,15.3768 L 11.9988,15.2528 L 12.0711,15.0926 L 12.1021,14.9329 L 12.1021,14.5815 L 12.0659,14.4523 L 12.0246,14.3490 L 11.9161,14.2353 L 11.8386,14.1940 L 9.4423,14.1940 L 10.1446,8.9307 L 13.4969,8.9100 L 17.1023,8.5225 L 17.1902,8.4811 L 17.2930,8.3726 L 17.3809,8.2129 L 17.4274,7.9959 L 17.4377,7.7272 L 17.5411,7.6445 L 17.5411,7.5825 L 17.4429,7.4636 L 17.4222,7.3861 L 17.3757,7.2264 L 17.2982,7.0921 L 17.2057,7.0042 L 17.1023,6.9680 L 13.3470,6.6580 L 11.2345,6.6580 L 10.2325,6.2394 L 10.1859,5.0565 L 10.1394,4.6075 L 10.0826,4.2147 L 10.0412,3.8742 L 9.9792,3.6313 L 9.9069,3.5590 L 9.6588,3.5590 L 9.6330,3.6055 L 9.5968,3.6365 L 9.5762,3.6416 L 9.5452,3.6210 L 9.5090,3.5331 L 9.4831,3.5176 L 9.4630,3.3729 L 9.4268,3.2231 L 9.3493,3.0319 L 9.2873,2.9285 Z","a":[9.26,7.673]},"B77W":{"d":"M 9.2141,1.3509 L 9.1441,1.3756 L 9.0088,1.5782 L 8.8909,1.9492 L 8.7219,2.4386 L 8.5530,2.9450 L 8.4181,3.5863 L 8.3509,3.9579 L 8.2749,4.4049 L 8.2749,6.4725 L 8.2408,6.7086 L 8.1142,6.9112 L 7.7851,7.1980 L 7.3463,7.4936 L 7.3804,7.1897 L 7.3804,6.7004 L 7.3463,6.4218 L 7.2114,6.2616 L 6.4942,6.2616 L 6.3929,6.2952 L 6.3087,6.5314 L 6.3087,7.5613 L 6.3593,7.7887 L 6.3593,8.0589 L 1.0852,10.8438 L 0.9669,10.9451 L 0.8738,11.2066 L 0.7390,11.7802 L 0.8149,11.7890 L 0.9080,11.7973 L 1.0511,11.7130 L 4.7558,10.5482 L 4.7558,10.8635 L 4.8684,10.8594 L 4.9258,10.7529 L 4.9749,10.4956 L 6.0136,10.1685 L 6.0136,10.4097 L 6.0994,10.4955 L 6.1914,10.4035 L 6.2425,10.1069 L 6.6719,9.9885 L 6.6719,10.3932 L 6.8843,10.3932 L 6.8843,9.9436 L 7.0642,9.9436 L 7.0642,10.1968 L 7.1257,10.3239 L 7.2357,10.3239 L 7.2357,9.9394 L 8.2336,9.9394 L 8.2336,12.7258 L 8.2651,13.2767 L 8.3091,13.5413 L 8.3680,13.9893 L 8.4636,14.5479 L 8.5587,15.0032 L 5.5904,17.0093 L 5.5687,17.3912 L 9.0878,16.4951 L 9.0878,17.0610 L 9.2169,17.2772 L 9.3384,17.0610 L 9.3384,16.4951 L 12.8581,17.3912 L 12.8359,17.0093 L 9.8676,15.0032 L 9.9632,14.5479 L 10.0588,13.9893 L 10.1172,13.5413 L 10.1617,13.2767 L 10.1932,12.7258 L 10.1932,9.9394 L 11.1905,9.9394 L 11.1905,10.3239 L 11.3011,10.3239 L 11.3621,10.1968 L 11.3621,9.9436 L 11.5419,9.9436 L 11.5419,10.3932 L 11.7548,10.3932 L 11.7548,9.9885 L 12.1843,10.1069 L 12.2354,10.4035 L 12.3274,10.4955 L 12.4132,10.4097 L 12.4132,10.1684 L 13.4514,10.4955 L 13.5005,10.7528 L 13.5578,10.8593 L 13.6705,10.8634 L 13.6705,10.5482 L 17.3752,11.7129 L 17.5188,11.7972 L 17.6113,11.7889 L 17.6873,11.7801 L 17.5524,11.2065 L 17.4594,10.9450 L 17.3416,10.8438 L 12.0675,8.0589 L 12.0675,7.7887 L 12.1181,7.5613 L 12.1181,6.5314 L 12.0334,6.2952 L 11.9321,6.2616 L 11.2148,6.2616 L 11.0799,6.4218 L 11.0464,6.7004 L 11.0464,7.1897 L 11.0799,7.4936 L 10.6412,7.1980 L 10.3120,6.9112 L 10.1854,6.7086 L 10.1518,6.4725 L 10.1518,4.4049 L 10.0759,3.9579 L 10.0082,3.5863 L 9.8733,2.9450 L 9.7043,2.4386 L 9.5359,1.9492 L 9.4175,1.5782 L 9.2826,1.3756 Z","a":[9.26,7.937]},"AN24":{"d":"M 9.2490,2.3606 L 9.2067,2.3719 L 9.1545,2.4009 L 9.0842,2.4619 L 9.0181,2.5389 L 8.9411,2.6495 L 8.8501,2.8040 L 8.7731,2.9667 L 8.6599,3.2504 L 8.5783,3.5248 L 8.4920,3.9155 L 8.4429,4.2473 L 8.4165,4.6178 L 8.4026,5.2023 L 8.4026,7.3453 L 7.2404,7.3453 L 7.2626,7.2295 L 7.2771,7.0941 L 7.2874,6.9448 L 7.2874,6.4993 L 7.2729,6.3019 L 7.2507,6.1221 L 7.1908,5.8906 L 7.1453,5.8477 L 7.0854,5.8477 L 7.0854,5.7485 L 7.0740,5.6617 L 7.0585,5.5950 L 7.0466,5.5418 L 7.0233,5.4834 L 6.9970,5.4364 L 6.9556,5.3883 L 6.9205,5.3661 L 6.9035,5.3625 L 6.8699,5.3687 L 6.8265,5.3976 L 6.7836,5.4544 L 6.7536,5.5221 L 6.7278,5.6069 L 6.7123,5.6968 L 6.7081,5.7516 L 6.7081,5.8503 L 6.6456,5.8503 L 6.6027,5.8890 L 6.5794,5.9841 L 6.5469,6.1247 L 6.5314,6.2497 L 6.5185,6.3784 L 6.5185,6.9432 L 6.5262,7.1034 L 6.5391,7.2125 L 6.5614,7.3468 L 6.4441,7.3468 L 0.6981,8.3277 L 0.6615,8.3421 L 0.6263,8.3731 L 0.6031,8.4109 L 0.5876,8.4708 L 0.5824,8.5282 L 0.5876,8.5995 L 0.5979,8.6909 L 0.6212,8.8263 L 0.6501,8.9447 L 0.6604,8.9653 L 0.6795,8.9772 L 0.6992,8.9808 L 6.6616,9.2661 L 6.6730,9.3390 L 6.6900,9.4428 L 6.7241,9.6030 L 6.7681,9.7787 L 6.8110,9.9193 L 6.8528,10.0361 L 6.8916,10.1260 L 6.9076,10.1405 L 6.9205,10.1415 L 6.9432,10.1249 L 6.9644,10.0877 L 6.9970,9.9999 L 7.0481,9.8417 L 7.0983,9.6340 L 7.1396,9.4381 L 7.1680,9.2697 L 7.1758,9.2309 L 8.4052,9.2309 L 8.4052,11.7946 L 8.4176,12.0928 L 8.4424,12.3605 L 8.4754,12.6819 L 8.5116,12.9604 L 8.5669,13.3149 L 8.7183,14.1045 L 8.8455,14.7060 L 6.7055,15.5282 L 6.6611,15.5504 L 6.6254,15.5809 L 6.5991,15.6274 L 6.5841,15.6951 L 6.5810,15.8745 L 6.5924,15.9670 L 6.6099,16.0662 L 6.6363,16.1535 L 6.6595,16.2114 L 6.6833,16.2362 L 6.7123,16.2362 L 8.9876,16.1204 L 9.0604,16.1188 L 9.1157,16.1328 L 9.1643,16.1767 L 9.1901,16.2237 L 9.2000,16.2759 L 9.2108,16.3090 L 9.2273,16.3312 L 9.2485,16.3379 L 9.2708,16.3312 L 9.2873,16.3090 L 9.2987,16.2759 L 9.3080,16.2237 L 9.3343,16.1767 L 9.3829,16.1328 L 9.4377,16.1188 L 9.5110,16.1204 L 11.7864,16.2362 L 11.8153,16.2362 L 11.8386,16.2114 L 11.8623,16.1535 L 11.8887,16.0667 L 11.9063,15.9670 L 11.9176,15.8745 L 11.9145,15.6951 L 11.8995,15.6274 L 11.8732,15.5809 L 11.8375,15.5504 L 11.7931,15.5282 L 9.6532,14.7060 L 9.7803,14.1045 L 9.9317,13.3149 L 9.9870,12.9604 L 10.0232,12.6819 L 10.0562,12.3605 L 10.0810,12.0928 L 10.0934,11.7946 L 10.0934,9.2310 L 11.3228,9.2310 L 11.3300,9.2697 L 11.3590,9.4382 L 11.4003,9.6340 L 11.4499,9.8418 L 11.5016,9.9999 L 11.5336,10.0878 L 11.5548,10.1250 L 11.5781,10.1415 L 11.5910,10.1405 L 11.6065,10.1260 L 11.6458,10.0361 L 11.6876,9.9193 L 11.7305,9.7788 L 11.7744,9.6031 L 11.8085,9.4429 L 11.8251,9.3390 L 11.8370,9.2661 L 17.7994,8.9809 L 17.8185,8.9773 L 17.8382,8.9654 L 17.8485,8.9447 L 17.8774,8.8264 L 17.9007,8.6910 L 17.9110,8.5995 L 17.9162,8.5282 L 17.9110,8.4708 L 17.8955,8.4109 L 17.8723,8.3732 L 17.8371,8.3422 L 17.8004,8.3277 L 12.0545,7.3469 L 11.9372,7.3469 L 11.9595,7.2125 L 11.9724,7.1035 L 11.9802,6.9433 L 11.9802,6.3784 L 11.9673,6.2497 L 11.9518,6.1247 L 11.9192,5.9841 L 11.8954,5.8890 L 11.8525,5.8503 L 11.7900,5.8503 L 11.7900,5.7516 L 11.7864,5.6968 L 11.7709,5.6069 L 11.7445,5.5221 L 11.7146,5.4544 L 11.6717,5.3976 L 11.6288,5.3687 L 11.5952,5.3625 L 11.5782,5.3661 L 11.5430,5.3883 L 11.5012,5.4364 L 11.4753,5.4834 L 11.4521,5.5418 L 11.4402,5.5950 L 11.4247,5.6617 L 11.4128,5.7485 L 11.4128,5.8477 L 11.3528,5.8477 L 11.3074,5.8906 L 11.2474,6.1221 L 11.2257,6.3019 L 11.2113,6.4993 L 11.2113,6.9448 L 11.2216,7.0941 L 11.2361,7.2295 L 11.2583,7.3453 L 10.0960,7.3453 L 10.0960,5.2023 L 10.0816,4.6178 L 10.0557,4.2473 L 10.0061,3.9155 L 9.9203,3.5248 L 9.8387,3.2504 L 9.7250,2.9667 L 9.6485,2.8040 L 9.5576,2.6495 L 9.4806,2.5389 L 9.4144,2.4619 L 9.3441,2.4009 L 9.2919,2.3719 L 9.2496,2.3606 Z","a":[9.26,8.202]},"DH8B":{"d":"M 9.2362,1.8562 L 9.1154,1.8844 L 8.9783,1.9823 L 8.8775,2.1151 L 8.7638,2.2981 L 8.6372,2.5507 L 8.5235,2.8096 L 8.4165,3.1378 L 8.3282,3.5104 L 8.2522,3.9145 L 8.2207,4.2680 L 8.2145,4.4700 L 8.2145,7.3298 L 8.1700,7.3675 L 6.7371,7.3675 L 6.7371,6.5407 L 6.7179,6.1934 L 6.6740,5.9852 L 6.5918,5.8208 L 6.4782,5.7133 L 6.4528,5.7066 L 6.4027,5.7454 L 6.2952,5.8777 L 6.2384,6.0544 L 6.2007,6.2249 L 6.2007,7.3737 L 0.6320,8.0052 L 0.5752,8.0305 L 0.5250,8.0998 L 0.4930,8.2010 L 0.4930,8.9524 L 3.3471,9.1100 L 3.3910,9.2175 L 3.4479,9.1162 L 4.7547,9.1798 L 4.7987,9.2868 L 4.8555,9.1860 L 6.1753,9.2490 L 6.1753,9.8738 L 6.2007,10.1141 L 6.2508,10.3162 L 6.3521,10.4676 L 6.4720,10.5244 L 6.5727,10.4738 L 6.6678,10.3730 L 6.7309,10.2464 L 6.7562,10.1327 L 6.7562,9.2682 L 8.2651,9.2490 L 8.2651,11.3135 L 8.3153,11.9889 L 8.3659,12.6328 L 8.4419,13.1821 L 8.6119,14.1924 L 8.9090,15.4802 L 6.7562,15.7830 L 6.6931,15.8399 L 6.6425,15.9665 L 6.6425,16.5850 L 6.6802,16.7871 L 6.7433,16.9261 L 9.1560,16.9261 L 9.1545,17.1912 L 9.2175,16.9261 L 11.6861,16.9261 L 11.7491,16.7871 L 11.7869,16.5850 L 11.7869,15.9665 L 11.7362,15.8399 L 11.6732,15.7830 L 9.5203,15.4802 L 9.8170,14.1924 L 9.9875,13.1821 L 10.0635,12.6328 L 10.1141,11.9889 L 10.1642,11.3135 L 10.1642,9.2490 L 11.6732,9.2682 L 11.6732,10.1327 L 11.6985,10.2464 L 11.7616,10.3725 L 11.8561,10.4738 L 11.9574,10.5244 L 12.0773,10.4676 L 12.1786,10.3162 L 12.2287,10.1141 L 12.2540,9.8738 L 12.2540,9.2490 L 13.5733,9.1860 L 13.6302,9.2868 L 13.6746,9.1793 L 14.9815,9.1162 L 15.0384,9.2175 L 15.0823,9.1100 L 17.9359,8.9524 L 17.9359,8.2010 L 17.9043,8.0998 L 17.8542,8.0305 L 17.7974,8.0052 L 12.2287,7.3737 L 12.2287,6.2249 L 12.1910,6.0544 L 12.1342,5.8777 L 12.0267,5.7449 L 11.9760,5.7066 L 11.9512,5.7133 L 11.8375,5.8208 L 11.7554,5.9852 L 11.7109,6.1934 L 11.6923,6.5407 L 11.6923,7.3675 L 10.2593,7.3675 L 10.2149,7.3298 L 10.2149,4.4700 L 10.2087,4.2680 L 10.1772,3.9145 L 10.1012,3.5104 L 10.0128,3.1378 L 9.9053,2.8096 L 9.7922,2.5507 L 9.6656,2.2981 L 9.5519,2.1151 L 9.4511,1.9823 L 9.3498,1.8877 Z","a":[9.26,7.937]},"A345":{"d":"M 9.2599,0.4331 L 9.2139,0.4522 L 9.1472,0.5158 L 9.0852,0.6016 L 9.0299,0.7013 L 8.9648,0.8439 L 8.8950,1.0139 L 8.8237,1.2010 L 8.7632,1.3850 L 8.7074,1.5850 L 8.6682,1.7483 L 8.6268,1.9291 L 8.5999,2.0847 L 8.5679,2.2909 L 8.5441,2.5224 L 8.5302,2.7606 L 8.5219,2.9616 L 8.5219,6.8751 L 7.1153,7.7396 L 7.1246,7.6606 L 7.1339,7.5443 L 7.1437,7.3955 L 7.1437,7.0704 L 7.1339,6.9402 L 7.1148,6.7738 L 7.0962,6.6276 L 7.0708,6.6022 L 6.4233,6.6022 L 6.3996,6.6229 L 6.3887,6.6834 L 6.3680,6.8182 L 6.3536,6.9578 L 6.3474,7.1035 L 6.3458,7.2988 L 6.3489,7.4559 L 6.3634,7.6079 L 6.3820,7.7985 L 6.4011,7.9458 L 6.4740,7.9458 L 6.4916,8.0233 L 6.5251,8.0998 L 4.3408,9.4512 L 4.3552,9.3416 L 4.3614,9.2021 L 4.3692,9.0672 L 4.3692,8.7091 L 4.3516,8.5391 L 4.3217,8.3406 L 4.2963,8.3153 L 3.6524,8.3153 L 3.6251,8.3313 L 3.6111,8.3964 L 3.5904,8.5597 L 3.5713,8.7292 L 3.5698,8.9390 L 3.5729,9.1339 L 3.5842,9.3163 L 3.6220,9.6542 L 3.6948,9.6542 L 3.7186,9.7431 L 3.7460,9.8160 L 1.2252,11.3771 L 1.2014,11.4040 L 1.1885,11.4324 L 1.1792,11.5818 L 0.9746,12.0350 L 0.9746,12.2686 L 1.1730,12.1223 L 3.8871,10.9389 L 3.8886,11.0200 L 3.9031,11.1007 L 3.9238,11.1818 L 3.9568,11.2722 L 3.9997,11.2722 L 4.0266,11.1756 L 4.0519,11.0707 L 4.0679,10.9818 L 4.0772,10.8691 L 4.3377,10.7823 L 4.3361,10.8707 L 4.3532,10.9580 L 4.3723,11.0293 L 4.3961,11.0960 L 4.4152,11.1213 L 4.4452,11.1213 L 4.4726,11.0309 L 4.4963,10.9296 L 4.5165,10.8392 L 4.5247,10.7120 L 5.2368,10.4712 L 5.2368,10.5296 L 5.2513,10.6154 L 5.2735,10.6898 L 5.3020,10.7772 L 5.3211,10.8123 L 5.3449,10.8123 L 5.3671,10.7503 L 5.3877,10.6836 L 5.4100,10.5994 L 5.4270,10.5110 L 5.4368,10.4015 L 6.1505,10.1539 L 6.1505,10.2253 L 6.1650,10.3079 L 6.1805,10.3746 L 6.1965,10.4314 L 6.2316,10.4965 L 6.2523,10.4965 L 6.2776,10.4268 L 6.3029,10.3524 L 6.3205,10.2826 L 6.3329,10.2015 L 6.3391,10.0873 L 7.0088,9.8542 L 7.1416,9.8542 L 7.1416,9.9808 L 7.1592,10.0682 L 7.1752,10.1379 L 7.1928,10.1870 L 7.2243,10.2475 L 7.2419,10.2475 L 7.2641,10.1953 L 7.2848,10.1395 L 7.3003,10.0795 L 7.3163,10.0098 L 7.3308,9.9224 L 7.3308,9.8511 L 8.4599,9.8511 L 8.4713,9.9653 L 8.4868,10.1095 L 8.5219,10.4904 L 8.5219,12.6174 L 8.5312,12.9171 L 8.5519,13.3140 L 8.5824,13.6804 L 8.6124,13.9579 L 8.6408,14.1609 L 8.7028,14.5955 L 8.7534,14.9268 L 8.9405,16.1438 L 6.8740,17.3680 L 6.8135,17.4238 L 6.7706,17.5029 L 6.7613,17.5633 L 6.7122,18.0501 L 9.1265,17.3633 L 9.1927,18.0315 L 9.2201,18.0501 L 9.2624,18.0516 L 9.3012,18.0501 L 9.3281,18.0315 L 9.3947,17.3633 L 11.8091,18.0501 L 11.7600,17.5633 L 11.7502,17.5029 L 11.7073,17.4238 L 11.6473,17.3680 L 9.5803,16.1438 L 9.7673,14.9268 L 9.8180,14.5955 L 9.8800,14.1609 L 9.9084,13.9579 L 9.9389,13.6804 L 9.9689,13.3140 L 9.9895,12.9171 L 9.9988,12.6174 L 9.9988,10.4904 L 10.0340,10.1095 L 10.0500,9.9653 L 10.0609,9.8511 L 11.1905,9.8511 L 11.1905,9.9224 L 11.2045,10.0098 L 11.2205,10.0795 L 11.2365,10.1395 L 11.2572,10.1953 L 11.2794,10.2475 L 11.2964,10.2475 L 11.3285,10.1870 L 11.3460,10.1379 L 11.3615,10.0682 L 11.3791,9.9809 L 11.3791,9.8542 L 11.5124,9.8542 L 12.1817,10.0873 L 12.1879,10.2015 L 12.2008,10.2826 L 12.2183,10.3524 L 12.2437,10.4268 L 12.2690,10.4966 L 12.2897,10.4966 L 12.3243,10.4314 L 12.3403,10.3746 L 12.3563,10.3079 L 12.3703,10.2253 L 12.3703,10.1540 L 13.0844,10.4015 L 13.0937,10.5110 L 13.1113,10.5994 L 13.1335,10.6836 L 13.1542,10.7503 L 13.1764,10.8123 L 13.2002,10.8123 L 13.2193,10.7772 L 13.2477,10.6898 L 13.2699,10.6154 L 13.2839,10.5296 L 13.2839,10.4712 L 13.9965,10.7121 L 14.0043,10.8392 L 14.0250,10.9296 L 14.0487,11.0309 L 14.0756,11.1213 L 14.1056,11.1213 L 14.1247,11.0960 L 14.1485,11.0293 L 14.1676,10.9580 L 14.1852,10.8707 L 14.1837,10.7818 L 14.4436,10.8692 L 14.4534,10.9818 L 14.4689,11.0707 L 14.4942,11.1756 L 14.5216,11.2722 L 14.5640,11.2722 L 14.5976,11.1818 L 14.6182,11.1007 L 14.6322,11.0201 L 14.6343,10.9389 L 17.3483,12.1223 L 17.5463,12.2686 L 17.5463,12.0350 L 17.3416,11.5818 L 17.3323,11.4324 L 17.3194,11.4040 L 17.2956,11.3772 L 14.7754,9.8160 L 14.8022,9.7431 L 14.8260,9.6543 L 14.8989,9.6543 L 14.9371,9.3163 L 14.9480,9.1339 L 14.9516,8.9391 L 14.9495,8.7293 L 14.9309,8.5598 L 14.9102,8.3965 L 14.8957,8.3313 L 14.8688,8.3153 L 14.2250,8.3153 L 14.1996,8.3406 L 14.1691,8.5391 L 14.1516,8.7091 L 14.1516,9.0672 L 14.1599,9.2021 L 14.1661,9.3416 L 14.1805,9.4512 L 11.9962,8.0998 L 12.0293,8.0234 L 12.0468,7.9458 L 12.1197,7.9458 L 12.1388,7.7986 L 12.1579,7.6079 L 12.1719,7.4559 L 12.1755,7.2988 L 12.1739,7.1035 L 12.1672,6.9578 L 12.1532,6.8183 L 12.1326,6.6834 L 12.1212,6.6229 L 12.0974,6.6023 L 11.4504,6.6023 L 11.4251,6.6276 L 11.4060,6.7738 L 11.3869,6.9402 L 11.3776,7.0704 L 11.3776,7.3955 L 11.3869,7.5443 L 11.3967,7.6606 L 11.4060,7.7396 L 9.9988,6.8751 L 9.9988,2.9616 L 9.9911,2.7606 L 9.9766,2.5224 L 9.9528,2.2909 L 9.9213,2.0847 L 9.8944,1.9291 L 9.8531,1.7483 L 9.8133,1.5850 L 9.7580,1.3850 L 9.6976,1.2010 L 9.6262,1.0139 L 9.5565,0.8439 L 9.4914,0.7013 L 9.4356,0.6016 L 9.3741,0.5158 L 9.3074,0.4522 Z","a":[9.26,8.202]},"A321":{"d":"M 9.2599,0.4520 L 9.1989,0.4654 L 9.1297,0.5135 L 9.0274,0.6194 L 8.8847,0.8313 L 8.7674,1.0685 L 8.6785,1.2809 L 8.6093,1.4793 L 8.5245,1.8069 L 8.4858,2.0803 L 8.4765,2.2617 L 8.4765,6.8159 L 8.4667,6.9224 L 8.4320,7.0107 L 8.3762,7.0919 L 8.3085,7.1534 L 8.2238,7.2014 L 8.1757,7.2268 L 7.3489,7.6469 L 7.3603,7.5833 L 7.3758,7.4273 L 7.3913,7.2423 L 7.3990,7.0821 L 7.4238,7.0743 L 7.3990,7.0128 L 7.3990,6.8526 L 7.3835,6.7141 L 7.3603,6.5963 L 7.3468,6.5441 L 7.3277,6.5307 L 6.6818,6.5307 L 6.6626,6.5441 L 6.6394,6.6252 L 6.6125,6.7947 L 6.6027,6.9916 L 6.6161,7.2324 L 6.6916,7.9068 L 6.7495,7.9166 L 6.7495,7.9554 L 2.6402,10.0814 L 2.5823,10.1160 L 2.5497,10.1485 L 2.5187,10.2043 L 2.5089,10.2664 L 2.5089,10.9118 L 2.5533,10.9118 L 2.5533,10.7134 L 4.5253,10.1253 L 4.5253,10.2565 L 4.5444,10.3568 L 4.5677,10.4204 L 4.5909,10.4204 L 4.6178,10.3392 L 4.6349,10.2297 L 4.6349,10.0927 L 5.9376,9.6995 L 5.9376,9.8385 L 5.9609,9.9480 L 5.9764,9.9945 L 6.0033,9.9945 L 6.0322,9.8979 L 6.0498,9.8039 L 6.0498,9.6685 L 6.6528,9.4835 L 6.9691,9.4835 L 6.9727,9.5723 L 7.0001,9.6282 L 7.0327,9.5687 L 7.0327,9.4876 L 7.2854,9.4974 L 7.2833,9.6070 L 7.3065,9.7227 L 7.3293,9.7899 L 7.3489,9.7884 L 7.3872,9.6974 L 7.4006,9.6049 L 7.4027,9.4990 L 8.4765,9.5145 L 8.4765,13.8243 L 8.4801,14.0785 L 8.5246,14.6645 L 8.5938,15.1234 L 8.6770,15.5027 L 8.7462,15.7957 L 8.7576,15.8733 L 8.7442,15.9291 L 8.7194,15.9807 L 8.6920,16.0118 L 8.6114,16.0660 L 6.8518,17.2205 L 6.8187,17.2551 L 6.7955,17.2933 L 6.7939,17.3378 L 6.7939,17.7522 L 8.9137,17.2473 L 8.9137,17.0582 L 8.9581,17.3455 L 9.0506,17.6752 L 9.1679,18.0338 L 9.1679,18.0685 L 9.2638,18.0689 L 9.3529,18.0685 L 9.3529,18.0338 L 9.4702,17.6752 L 9.5627,17.3455 L 9.6072,17.0582 L 9.6072,17.2473 L 11.7269,17.7522 L 11.7269,17.3378 L 11.7254,17.2933 L 11.7022,17.2551 L 11.6696,17.2205 L 9.9095,16.0660 L 9.8289,16.0118 L 9.8015,15.9807 L 9.7767,15.9291 L 9.7633,15.8733 L 9.7747,15.7957 L 9.8439,15.5027 L 9.9271,15.1234 L 9.9963,14.6645 L 10.0408,14.0785 L 10.0444,13.8243 L 10.0444,9.5145 L 11.1182,9.4990 L 11.1203,9.6049 L 11.1338,9.6974 L 11.1720,9.7884 L 11.1916,9.7899 L 11.2144,9.7227 L 11.2376,9.6070 L 11.2355,9.4974 L 11.4882,9.4876 L 11.4882,9.5687 L 11.5208,9.6282 L 11.5482,9.5723 L 11.5518,9.4835 L 11.8680,9.4835 L 12.4711,9.6685 L 12.4711,9.8039 L 12.4887,9.8979 L 12.5176,9.9945 L 12.5445,9.9945 L 12.5600,9.9480 L 12.5832,9.8385 L 12.5832,9.6995 L 13.8860,10.0927 L 13.8860,10.2297 L 13.9030,10.3392 L 13.9299,10.4204 L 13.9532,10.4204 L 13.9764,10.3568 L 13.9955,10.2565 L 13.9955,10.1253 L 15.9675,10.7134 L 15.9675,10.9118 L 16.0119,10.9118 L 16.0119,10.2664 L 16.0021,10.2043 L 15.9711,10.1485 L 15.9386,10.1160 L 15.8807,10.0814 L 11.7714,7.9554 L 11.7714,7.9166 L 11.8293,7.9068 L 11.9047,7.2324 L 11.9182,6.9916 L 11.9084,6.7947 L 11.8815,6.6252 L 11.8582,6.5441 L 11.8391,6.5307 L 11.1931,6.5307 L 11.1740,6.5441 L 11.1606,6.5963 L 11.1373,6.7141 L 11.1218,6.8526 L 11.1218,7.0128 L 11.0970,7.0743 L 11.1218,7.0821 L 11.1296,7.2423 L 11.1451,7.4273 L 11.1606,7.5833 L 11.1720,7.6469 L 10.3452,7.2268 L 10.2971,7.2014 L 10.2124,7.1534 L 10.1447,7.0919 L 10.0889,7.0107 L 10.0542,6.9224 L 10.0444,6.8159 L 10.0444,2.2617 L 10.0351,2.0803 L 9.9963,1.8069 L 9.9115,1.4793 L 9.8423,1.2809 L 9.7534,1.0685 L 9.6361,0.8313 L 9.4935,0.6194 L 9.3912,0.5135 L 9.3219,0.4654 L 9.2609,0.4520 Z","a":[9.26,8.202]},"A3ST":{"d":"M 9.2603,0.5680 L 9.1607,0.6130 L 9.0341,0.7711 L 8.8186,1.2336 L 8.6160,1.7592 L 8.4512,2.2723 L 8.4005,2.3545 L 8.3059,2.5762 L 8.2171,2.8992 L 8.1664,3.1462 L 8.1158,3.4753 L 8.1158,3.6908 L 8.1158,7.0917 L 7.0580,7.7061 L 7.0833,7.4720 L 7.1913,7.4720 L 7.2228,7.2059 L 7.2543,6.9144 L 7.2797,6.6736 L 7.2797,6.4266 L 7.2605,6.2431 L 7.2228,6.1289 L 7.1530,6.0468 L 6.4502,6.0468 L 6.3996,6.0783 L 6.3676,6.1925 L 6.3422,6.3889 L 6.3298,6.6297 L 6.3490,6.9459 L 6.3743,7.2565 L 6.4058,7.4591 L 6.5133,7.4591 L 6.5386,7.9976 L 2.4159,10.3979 L 2.3337,10.4672 L 2.2893,10.5690 L 2.2831,10.7524 L 2.2831,11.3922 L 2.3843,11.3922 L 2.3967,11.3224 L 2.4474,11.2656 L 2.4665,11.2527 L 3.6706,10.8387 L 3.7171,11.1224 L 3.7770,10.7964 L 4.5041,10.5375 L 4.5361,10.8496 L 4.6106,10.4878 L 5.1392,10.3173 L 5.1888,10.6119 L 5.2565,10.2641 L 5.9903,9.9876 L 6.0508,10.3070 L 6.1180,9.9380 L 6.4301,9.8140 L 7.4057,9.8140 L 7.4693,10.1685 L 7.5334,9.8171 L 8.1153,9.8171 L 8.1153,11.8180 L 8.1432,12.1901 L 8.1752,12.5270 L 8.2429,12.8996 L 8.3173,13.2438 L 8.3917,13.6127 L 8.5230,14.2793 L 8.7783,15.6059 L 6.8595,16.9893 L 6.8451,16.8332 L 6.8275,16.6808 L 6.8063,16.6203 L 6.7743,16.6275 L 6.7670,16.9112 L 6.7639,17.2233 L 6.7779,17.7835 L 9.0547,16.9711 L 9.2180,17.7695 L 9.2590,17.8403 L 9.3028,17.7695 L 9.4661,16.9711 L 11.7429,17.7835 L 11.7569,17.2233 L 11.7538,16.9112 L 11.7466,16.6275 L 11.7146,16.6203 L 11.6934,16.6808 L 11.6758,16.8332 L 11.6613,16.9893 L 9.7426,15.6059 L 9.9979,14.2793 L 10.1291,13.6127 L 10.2035,13.2438 L 10.2779,12.8996 L 10.3456,12.5270 L 10.3777,12.1901 L 10.4061,11.8180 L 10.4061,9.8171 L 10.9875,9.8171 L 11.0515,10.1685 L 11.1151,9.8140 L 12.0908,9.8140 L 12.4029,9.9380 L 12.4701,10.3070 L 12.5305,9.9876 L 13.2648,10.2641 L 13.3320,10.6119 L 13.3816,10.3173 L 13.9103,10.4878 L 13.9847,10.8496 L 14.0167,10.5374 L 14.7438,10.7963 L 14.8038,11.1224 L 14.8503,10.8387 L 16.0543,11.2526 L 16.0735,11.2656 L 16.1241,11.3224 L 16.1365,11.3922 L 16.2378,11.3922 L 16.2378,10.7524 L 16.2316,10.5690 L 16.1871,10.4672 L 16.1050,10.3979 L 11.9822,7.9975 L 12.0076,7.4591 L 12.1150,7.4591 L 12.1466,7.2565 L 12.1719,6.9459 L 12.1910,6.6297 L 12.1786,6.3889 L 12.1533,6.1925 L 12.1212,6.0783 L 12.0706,6.0468 L 11.3678,6.0468 L 11.2980,6.1289 L 11.2603,6.2431 L 11.2412,6.4266 L 11.2412,6.6736 L 11.2665,6.9144 L 11.2980,7.2059 L 11.3296,7.4720 L 11.4376,7.4720 L 11.4629,7.7061 L 10.4050,7.0917 L 10.4050,3.6908 L 10.4050,3.4753 L 10.3544,3.1462 L 10.3038,2.8992 L 10.2149,2.5762 L 10.1203,2.3545 L 10.0697,2.2723 L 9.9048,1.7592 L 9.7022,1.2336 L 9.4868,0.7711 L 9.3601,0.6130 Z","a":[9.26,8.202]},"F70":{"d":"M 9.2686,0.7493 L 9.1106,0.8165 L 8.9065,1.0319 L 8.7024,1.3384 L 8.5437,1.7689 L 8.4419,2.2453 L 8.4078,2.5285 L 8.3510,3.1181 L 8.3510,7.1773 L 8.0337,7.3602 L 6.7159,7.9902 L 3.6024,9.1519 L 1.7410,9.8149 L 1.6258,9.9384 L 1.5023,10.1482 L 1.4119,10.4117 L 1.3540,10.6339 L 1.3747,10.7166 L 4.5993,10.4448 L 4.6117,10.5352 L 4.6525,10.6960 L 4.6938,10.7373 L 4.7393,10.6836 L 4.7641,10.3993 L 6.2793,10.2965 L 6.2958,10.4035 L 6.3289,10.5600 L 6.3904,10.5724 L 6.4400,10.4076 L 6.4524,10.2634 L 8.2559,10.1068 L 8.2600,10.3461 L 8.3055,10.4980 L 8.3835,10.7290 L 8.2311,10.7290 L 8.1737,10.6711 L 8.1737,10.4613 L 8.1096,10.3973 L 7.4694,10.3973 L 7.4213,10.4458 L 7.3960,10.5404 L 7.3789,10.6024 L 7.3417,10.9306 L 7.3004,11.2396 L 7.3335,11.5605 L 7.4079,12.0344 L 7.4120,12.4912 L 7.4198,12.6891 L 7.4120,12.8865 L 7.4942,13.1299 L 7.5272,13.1914 L 7.6094,13.1175 L 7.6880,13.1216 L 7.7329,13.1831 L 7.8032,13.1216 L 7.8936,13.1257 L 7.9350,13.1955 L 8.0047,13.1216 L 8.0047,13.2161 L 8.0750,13.2859 L 8.1365,13.2942 L 8.1861,13.2451 L 8.2435,13.0637 L 8.6760,13.3810 L 8.8243,14.0275 L 8.9189,14.5954 L 8.9272,14.9168 L 8.9768,15.1189 L 9.1044,15.2750 L 9.1044,15.4770 L 6.6172,16.9761 L 6.5428,17.0459 L 6.4855,17.1611 L 6.4400,17.3673 L 6.4317,17.7502 L 6.6332,17.7048 L 9.1044,17.0955 L 9.1168,17.2066 L 9.1700,17.3549 L 9.2656,17.4428 L 9.3504,17.3549 L 9.4041,17.2066 L 9.4165,17.0955 L 11.8872,17.7048 L 12.0892,17.7502 L 12.0809,17.3673 L 12.0355,17.1611 L 11.9781,17.0459 L 11.9037,16.9761 L 9.4165,15.4770 L 9.4165,15.2750 L 9.5441,15.1189 L 9.5932,14.9168 L 9.6015,14.5954 L 9.6966,14.0275 L 9.8449,13.3810 L 10.2769,13.0637 L 10.3348,13.2451 L 10.3844,13.2942 L 10.4459,13.2859 L 10.5162,13.2161 L 10.5162,13.1216 L 10.5859,13.1955 L 10.6273,13.1257 L 10.7177,13.1216 L 10.7880,13.1831 L 10.8329,13.1216 L 10.9115,13.1175 L 10.9937,13.1914 L 11.0267,13.1299 L 11.1089,12.8865 L 11.1006,12.6891 L 11.1089,12.4912 L 11.1130,12.0344 L 11.1874,11.5605 L 11.2200,11.2396 L 11.1791,10.9306 L 11.1414,10.6024 L 11.1249,10.5404 L 11.0996,10.4458 L 11.0515,10.3973 L 10.4107,10.3973 L 10.3472,10.4613 L 10.3472,10.6711 L 10.2893,10.7290 L 10.1368,10.7290 L 10.2154,10.4980 L 10.2603,10.3461 L 10.2644,10.1068 L 12.0685,10.2634 L 12.0809,10.4076 L 12.1300,10.5724 L 12.1920,10.5600 L 12.2250,10.4035 L 12.2416,10.2965 L 13.7567,10.3993 L 13.7815,10.6836 L 13.8270,10.7373 L 13.8678,10.6960 L 13.9092,10.5352 L 13.9216,10.4448 L 17.1462,10.7166 L 17.1668,10.6339 L 17.1090,10.4117 L 17.0185,10.1482 L 16.8952,9.9384 L 16.7794,9.8149 L 14.9180,9.1519 L 11.8050,7.9902 L 10.4873,7.3602 L 10.1700,7.1773 L 10.1700,3.1181 L 10.1131,2.5285 L 10.0790,2.2453 L 9.9772,1.7689 L 9.8186,1.3384 L 9.6145,1.0319 L 9.4103,0.8165 Z","a":[9.26,8.467]},"B738":{"d":"M 9.2601,0.3639 C 9.1071,0.3653 8.9583,0.7272 8.8611,1.0490 C 8.7123,1.4667 8.4413,2.4229 8.4205,3.8882 L 8.4205,6.7534 L 7.6004,7.4392 C 7.6346,7.1514 7.6168,6.5294 7.5919,6.3850 C 7.5862,6.3423 7.5577,6.2877 7.5064,6.2853 L 6.8283,6.2853 C 6.7742,6.2881 6.7514,6.3394 6.7457,6.3850 C 6.7172,6.5389 6.6859,7.2597 6.7770,7.8153 L 6.9081,7.8153 C 6.9081,7.8153 6.9109,7.8523 6.9280,7.8808 C 6.9280,7.8808 6.8055,7.9606 6.6745,8.0346 C 5.7229,8.5446 4.8482,8.8922 1.7370,10.3937 C 1.6430,10.4364 1.6031,10.4649 1.6031,10.5361 L 1.6031,11.2990 C 1.6016,11.3219 1.6235,11.3271 1.6261,11.3013 C 1.6377,11.1838 1.6273,11.0574 1.7758,11.0238 L 5.0996,10.2801 C 5.0996,10.4319 5.1452,10.6890 5.1926,10.7012 C 5.2367,10.6939 5.2881,10.3805 5.2807,10.2360 L 6.5245,9.9569 C 6.5318,10.1136 6.5662,10.3838 6.6126,10.3805 C 6.6469,10.3781 6.7081,10.0744 6.7032,9.9226 L 7.0729,9.8345 L 7.2076,9.8345 C 7.2002,10.0230 7.2688,10.2923 7.2982,10.2923 C 7.3276,10.2923 7.3937,10.0206 7.3863,9.8345 L 8.4171,9.8345 L 8.4171,13.2083 C 8.4366,14.1362 8.5759,14.8037 8.8676,16.0606 L 6.1695,17.5468 C 6.1254,17.5712 6.0985,17.5859 6.0985,17.6031 L 6.0985,18.1221 L 9.1785,17.4929 C 9.1834,17.5443 9.2177,17.6618 9.2275,17.6692 L 9.2275,17.7671 L 9.2887,17.7671 L 9.2887,17.6678 C 9.2987,17.6585 9.3388,17.5453 9.3508,17.4962 L 12.4292,18.1271 L 12.4292,17.6275 C 12.4291,17.5974 12.4228,17.5847 12.3895,17.5625 L 9.6589,16.0570 C 9.9442,14.7902 10.0954,14.1614 10.0963,13.2328 L 10.0963,9.8346 L 11.1340,9.8346 C 11.1340,10.0895 11.2014,10.2904 11.2252,10.2905 C 11.2566,10.2906 11.3132,10.0988 11.3107,9.8357 L 11.4484,9.8357 L 11.8221,9.9193 C 11.8221,10.0791 11.8880,10.3772 11.9107,10.3766 C 11.9475,10.3692 11.9992,10.1234 11.9967,9.9586 L 13.2433,10.2365 C 13.2360,10.4381 13.3023,10.6864 13.3293,10.6938 C 13.3638,10.6766 13.4277,10.4848 13.4203,10.2758 L 16.7863,11.0356 C 16.8735,11.0616 16.8945,11.1438 16.9043,11.3085 C 16.9035,11.3251 16.9177,11.3228 16.9177,11.3063 L 16.9177,10.5665 C 16.9189,10.4956 16.9012,10.4554 16.8516,10.4247 C 14.5529,9.3147 12.5018,8.3949 11.8507,8.0333 L 11.5996,7.8832 C 11.6152,7.8614 11.6132,7.8387 11.6132,7.8159 L 11.7475,7.8159 C 11.8460,7.0960 11.8203,6.6263 11.7786,6.3831 C 11.7691,6.3262 11.7442,6.2914 11.7020,6.2889 L 11.0162,6.2889 C 10.9616,6.2887 10.9377,6.3349 10.9340,6.3837 C 10.8933,6.8401 10.8930,7.0976 10.9204,7.4292 L 10.0985,6.7354 L 10.0985,3.9099 C 10.0985,2.3810 9.7893,1.4717 9.6623,1.0452 C 9.5484,0.6774 9.4146,0.3628 9.2601,0.3639 Z","a":[9.26,8.202]},"C172":{"d":"M 7.8815,5.9575 L 9.1126,5.9266 L 9.3230,5.9204 L 10.4984,5.9699 L 9.3230,6.0008 L 9.0755,6.0008 Z M 9.2064,5.6983 L 9.1767,5.7129 L 9.1555,5.7531 L 9.1095,5.8673 L 9.0940,5.9748 L 9.0894,6.0870 L 8.8258,6.0916 L 8.7426,6.1154 L 8.6589,6.1660 L 8.6062,6.2472 L 8.5008,7.5101 L 8.4243,8.4233 L 5.3676,8.4408 L 1.1777,8.6692 L 1.1007,8.6806 L 1.0392,8.7266 L 0.9715,8.8320 L 0.9100,8.9834 L 0.8811,9.1044 L 0.8635,9.2098 L 0.8196,9.2206 L 0.8020,9.2490 L 0.8087,9.2950 L 0.8310,9.3390 L 0.8635,9.3788 L 0.8790,9.5369 L 0.9121,9.7255 L 0.9514,9.9033 L 1.0067,10.0945 L 1.0723,10.2898 L 1.1074,10.3317 L 1.1601,10.3668 L 1.2128,10.3803 L 5.3475,10.9244 L 8.4041,10.9244 L 8.4419,10.9797 L 8.5163,11.6029 L 8.6041,12.3693 L 8.9400,15.2570 L 6.9241,15.6853 L 6.8497,15.7008 L 6.7949,15.7381 L 6.7510,15.8063 L 6.7221,15.8853 L 6.7112,15.9773 L 6.7112,16.0698 L 6.7179,16.1509 L 6.7464,16.3287 L 6.7794,16.5173 L 6.8451,16.7592 L 6.8740,16.8295 L 6.9004,16.8625 L 6.9308,16.8687 L 8.8548,17.1457 L 9.0940,16.5111 L 9.1007,16.3551 L 9.1509,16.3551 L 9.2139,17.1390 L 9.2666,16.3551 L 9.3173,16.3551 L 9.3240,16.5111 L 9.5632,17.1457 L 11.4866,16.8687 L 11.5177,16.8625 L 11.5440,16.8295 L 11.5724,16.7592 L 11.6381,16.5173 L 11.6711,16.3287 L 11.6996,16.1509 L 11.7063,16.0698 L 11.7063,15.9773 L 11.6954,15.8853 L 11.6670,15.8063 L 11.6231,15.7381 L 11.5678,15.7008 L 11.4934,15.6853 L 9.4775,15.2570 L 9.8134,12.3693 L 9.9012,11.6029 L 9.9761,10.9797 L 10.0134,10.9244 L 13.0700,10.9244 L 17.2046,10.3803 L 17.2574,10.3668 L 17.3101,10.3317 L 17.3452,10.2898 L 17.4114,10.0945 L 17.4661,9.9033 L 17.5059,9.7255 L 17.5385,9.5369 L 17.5540,9.3788 L 17.5871,9.3390 L 17.6088,9.2950 L 17.6155,9.2490 L 17.5979,9.2206 L 17.5540,9.2098 L 17.5364,9.1044 L 17.5080,8.9834 L 17.4465,8.8320 L 17.3783,8.7266 L 17.3168,8.6806 L 17.2398,8.6692 L 13.0504,8.4408 L 9.9937,8.4233 L 9.9167,7.5101 L 9.8113,6.2472 L 9.7586,6.1660 L 9.6754,6.1154 L 9.5917,6.0916 L 9.3281,6.0870 L 9.3240,5.9748 L 9.3085,5.8673 L 9.2625,5.7531 L 9.2380,5.7129 Z","a":[9.26,9.525]},"A320":{"d":"M 9.2644,0.3967 C 9.0686,0.4042 8.9196,0.6631 8.8304,0.8415 L 8.6926,1.1359 C 8.4559,1.6677 8.4367,1.8839 8.4079,2.0502 C 8.3628,2.3056 8.3179,2.6824 8.3247,3.0070 L 8.3247,5.7687 C 8.2882,5.9188 8.2839,6.1525 8.2839,6.1525 C 8.2753,6.3112 8.2861,6.4720 8.1446,6.5449 L 7.0510,7.1088 C 7.0768,6.9416 7.0939,6.8644 7.0939,6.4784 L 7.1497,6.4784 C 7.1497,6.3519 7.1604,6.2790 7.0811,6.1954 C 7.0746,6.0367 7.0703,5.8673 6.9996,5.7859 C 6.9245,5.7494 6.2470,5.7408 6.1698,5.7859 C 6.0947,5.8459 6.0883,6.0475 6.0776,6.1590 C 6.0561,6.3798 6.0433,6.6071 6.0647,6.8065 C 6.0776,6.9416 6.1204,7.2546 6.1462,7.3490 C 6.1530,7.3746 6.1590,7.3807 6.1702,7.3824 L 6.2705,7.3884 L 6.2877,7.4982 L 1.5636,9.9306 C 1.2274,10.1338 1.2325,10.6039 1.2325,10.8037 L 1.2205,10.9735 C 1.2187,10.9941 1.2385,10.9958 1.2402,10.9753 L 1.2454,10.8029 L 3.5346,10.1356 L 3.5346,10.1605 L 3.5552,10.1546 C 3.5792,10.5346 3.6160,10.5346 3.6160,10.5346 C 3.6160,10.5346 3.6572,10.5371 3.6752,10.1195 L 3.7018,10.1109 L 3.7018,10.0894 L 5.2782,9.6280 C 5.2782,9.6657 5.3134,9.9479 5.3443,9.9496 C 5.3666,9.9514 5.4215,9.6803 5.4112,9.5928 L 6.2603,9.3424 L 6.5073,9.3389 C 6.5055,9.3767 6.5553,9.5499 6.5708,9.5516 C 6.5914,9.5516 6.6325,9.3853 6.6325,9.3424 L 6.8933,9.3424 C 6.8967,9.4487 6.9344,9.6614 6.9585,9.6614 C 6.9825,9.6632 7.0288,9.4299 7.0254,9.3441 L 8.3187,9.3441 L 8.3187,13.3907 C 8.3136,13.6223 8.4252,14.6221 8.6148,15.4530 C 8.6278,15.5283 8.5629,15.6893 8.4304,15.7880 L 6.4490,17.0006 C 6.3296,17.0759 6.3192,17.1201 6.2932,17.3044 L 6.2932,17.7173 L 8.8848,17.1434 C 8.9783,17.7069 9.1159,18.1276 9.1652,18.1276 L 9.3470,18.1276 C 9.4015,18.1276 9.5522,17.6913 9.6352,17.1408 L 12.2268,17.7173 L 12.2268,17.3538 C 12.2086,17.1512 12.1956,17.0785 12.0632,16.9980 L 10.0897,15.7930 C 9.9650,15.7099 9.8897,15.5178 9.9027,15.4607 C 10.0923,14.6141 10.1961,13.5495 10.1961,13.3495 L 10.1961,9.3402 L 11.4893,9.3402 C 11.4893,9.4544 11.5309,9.6570 11.5542,9.6570 C 11.5880,9.6570 11.6217,9.4570 11.6217,9.3402 L 11.8788,9.3402 C 11.8866,9.4051 11.9256,9.5505 11.9437,9.5505 C 11.9697,9.5505 12.0012,9.4090 12.0115,9.3415 L 12.2579,9.3415 L 13.0993,9.5869 C 13.0993,9.7063 13.1486,9.9478 13.1694,9.9478 C 13.1954,9.9478 13.2395,9.7245 13.2395,9.6258 L 14.8131,10.0854 L 14.8131,10.1096 L 14.8371,10.1158 L 14.8371,10.1158 C 14.8389,10.2325 14.8697,10.5309 14.8971,10.5309 C 14.9229,10.5309 14.9623,10.2753 14.9623,10.1536 L 14.9795,10.1588 L 14.9795,10.1330 L 17.2661,10.7986 L 17.2729,10.9753 C 17.2727,10.9923 17.3005,10.9923 17.3005,10.9742 L 17.2924,10.7922 L 17.2924,10.6373 C 17.2924,10.4690 17.2037,10.0774 16.9546,9.9293 L 12.2331,7.4906 L 12.2495,7.3901 C 12.3496,7.3813 12.3661,7.3934 12.3738,7.3560 C 12.4552,6.9413 12.4665,6.7103 12.4629,6.5387 C 12.4552,6.1680 12.4220,5.7779 12.3071,5.7665 C 11.9958,5.7423 11.9031,5.7445 11.5319,5.7819 C 11.4861,5.7862 11.4410,5.9483 11.4333,6.2101 C 11.3945,6.2481 11.3696,6.2764 11.3685,6.3250 L 11.3685,6.4767 L 11.4194,6.4767 C 11.4194,6.7237 11.4279,6.8222 11.4613,7.1039 L 10.3512,6.5339 C 10.2853,6.4970 10.2468,6.4086 10.2451,6.3202 L 10.2291,5.9875 C 10.2226,5.9490 10.2082,5.7706 10.1953,5.7545 L 10.1953,2.9994 C 10.1953,2.6579 10.1609,2.3010 10.1117,2.0486 C 10.0817,1.8916 10.0653,1.6654 9.8101,1.1041 L 9.6901,0.8456 C 9.5908,0.6600 9.4665,0.4018 9.2643,0.3966 Z","a":[9.26,7.673]},"F28":{"d":"M 9.2635,0.9051 L 9.1133,0.9401 L 8.9574,1.0649 L 8.8264,1.2770 L 8.6205,1.7074 L 8.4832,2.0880 L 8.3522,2.6058 L 8.2711,3.0737 L 8.2399,3.6913 L 8.2337,6.2991 L 8.0777,6.4363 L 6.3871,7.3783 L 3.3489,8.4701 L 2.0699,8.9317 L 1.9826,8.9754 L 1.9389,9.1189 L 1.9389,9.4682 L 1.9576,9.6242 L 2.0076,9.7739 L 2.0762,9.8925 L 3.1492,9.8051 L 5.8942,9.5805 L 8.0341,9.3809 L 8.2025,9.5930 L 8.2087,9.9361 L 8.0341,9.9423 L 8.0341,9.8051 L 7.9717,9.7614 L 7.8968,9.7115 L 7.4289,9.7176 L 7.3416,9.7613 L 7.3104,9.8424 L 7.3104,11.0402 L 7.3540,11.4270 L 7.4913,12.1382 L 7.5038,12.3503 L 7.5474,12.4377 L 7.6785,12.4689 L 7.8157,12.4689 L 7.9155,12.4439 L 7.9467,12.3691 L 7.9592,12.1632 L 8.5706,12.6124 L 8.8389,14.1533 L 9.0011,14.9581 L 9.0884,15.1889 L 9.0822,15.3137 L 6.7302,16.6737 L 6.5992,16.7922 L 6.5493,16.9856 L 6.5555,17.3724 L 6.6054,17.6157 L 6.7676,17.6094 L 9.1321,17.0916 L 9.1695,17.2725 L 9.2132,17.4347 L 9.2601,17.5302 L 9.3077,17.4347 L 9.3514,17.2725 L 9.3888,17.0916 L 11.7533,17.6094 L 11.9155,17.6157 L 11.9654,17.3724 L 11.9716,16.9856 L 11.9217,16.7922 L 11.7907,16.6737 L 9.4387,15.3137 L 9.4325,15.1889 L 9.5198,14.9581 L 9.6820,14.1533 L 9.9503,12.6124 L 10.5616,12.1632 L 10.5741,12.3691 L 10.6053,12.4439 L 10.7051,12.4689 L 10.8424,12.4689 L 10.9734,12.4377 L 11.0171,12.3503 L 11.0295,12.1382 L 11.1668,11.4270 L 11.2105,11.0402 L 11.2105,9.8424 L 11.1793,9.7613 L 11.0919,9.7176 L 10.6240,9.7115 L 10.5492,9.7614 L 10.4868,9.8051 L 10.4868,9.9423 L 10.3121,9.9361 L 10.3183,9.5930 L 10.4867,9.3809 L 12.6266,9.5805 L 15.3716,9.8051 L 16.4446,9.8924 L 16.5132,9.7739 L 16.5631,9.6242 L 16.5819,9.4682 L 16.5819,9.1189 L 16.5382,8.9754 L 16.4509,8.9317 L 15.1719,8.4701 L 12.1338,7.3783 L 10.4431,6.4363 L 10.2872,6.2991 L 10.2809,3.6913 L 10.2497,3.0737 L 10.1686,2.6058 L 10.0376,2.0880 L 9.9004,1.7074 L 9.6945,1.2770 L 9.5635,1.0649 L 9.4075,0.9401 Z","a":[9.26,7.673]},"A158":{"d":"M 9.2386,0.2844 L 9.1378,0.3387 L 9.0236,0.5004 L 8.8076,0.9505 L 8.5316,1.6404 L 8.3880,2.1680 L 8.2980,3.0021 L 8.2800,3.2662 L 8.2800,5.5875 L 8.1900,5.6774 L 7.2661,6.1812 L 7.3079,5.9657 L 7.3260,5.3658 L 7.3503,4.4000 L 7.3260,4.2976 L 7.2599,4.2196 L 6.3963,4.2196 L 6.3421,4.2501 L 6.2821,4.3219 L 6.2641,4.3999 L 6.2522,5.5694 L 6.2765,6.1094 L 6.2940,6.3373 L 6.3901,6.6494 L 0.9424,9.6172 L 0.8665,9.6983 L 0.7931,9.7976 L 0.7305,9.9557 L 0.6789,10.1583 L 0.6458,10.4750 L 3.3614,9.7376 L 3.4146,9.8787 L 3.4782,9.7035 L 5.4129,9.1495 L 5.4419,9.3195 L 5.5147,9.1154 L 6.6816,8.7945 L 6.7105,8.9645 L 6.7932,8.7506 L 7.6149,8.5273 L 7.6733,8.7020 L 7.7265,8.4881 L 8.1642,8.3811 L 8.1885,9.0229 L 8.2712,9.4653 L 8.3151,11.3029 L 8.3585,11.9690 L 8.4557,12.7173 L 8.7962,14.7058 L 8.9032,15.2112 L 8.9859,15.4396 L 6.6186,17.1945 L 6.5359,17.2772 L 6.4919,17.3697 L 6.4873,17.9774 L 9.1026,17.0684 L 9.1316,17.5692 L 9.1900,17.9045 L 9.2582,18.0601 L 9.3305,17.9045 L 9.3889,17.5692 L 9.4179,17.0684 L 12.0332,17.9774 L 12.0280,17.3697 L 11.9846,17.2772 L 11.9019,17.1945 L 9.5346,15.4396 L 9.6173,15.2112 L 9.7243,14.7058 L 10.0643,12.7173 L 10.1615,11.9690 L 10.2054,11.3029 L 10.2488,9.4653 L 10.3315,9.0229 L 10.3558,8.3811 L 10.7935,8.4881 L 10.8472,8.7020 L 10.9051,8.5273 L 11.7267,8.7506 L 11.8094,8.9645 L 11.8389,8.7945 L 13.0052,9.1154 L 13.0781,9.3195 L 13.1075,9.1495 L 15.0423,9.7035 L 15.1053,9.8787 L 15.1586,9.7376 L 17.8747,10.4750 L 17.8411,10.1583 L 17.7899,9.9557 L 17.7274,9.7976 L 17.6535,9.6983 L 17.5775,9.6172 L 12.1298,6.6494 L 12.2259,6.3373 L 12.2440,6.1094 L 12.2678,5.5694 L 12.2559,4.3999 L 12.2378,4.3219 L 12.1779,4.2501 L 12.1241,4.2196 L 11.2601,4.2196 L 11.1939,4.2976 L 11.1702,4.4000 L 11.1939,5.3658 L 11.2120,5.9657 L 11.2539,6.1812 L 10.3304,5.6774 L 10.2405,5.5875 L 10.2405,3.2662 L 10.2225,3.0021 L 10.1326,2.1680 L 9.9884,1.6404 L 9.7124,0.9505 L 9.4964,0.5004 L 9.3827,0.3387 Z","a":[9.26,6.879]},"B350":{"d":"M 9.2878,2.8820 L 9.1917,2.9052 L 9.1529,2.9259 L 9.0651,3.0577 L 8.9643,3.2778 L 8.8842,3.5006 L 8.8067,3.7564 L 8.7287,4.0773 L 8.6744,4.3853 L 8.6408,4.6152 L 8.5917,5.0576 L 8.5271,5.7433 L 8.5271,6.5867 L 7.1401,6.6513 L 7.1375,6.2218 L 7.1324,5.7666 L 7.1195,5.3165 L 7.3629,5.3165 L 7.3629,4.8483 L 7.3448,4.8121 L 7.3138,4.7708 L 7.2724,4.7423 L 7.2104,4.7191 L 7.1556,4.7062 L 7.0704,4.7062 L 7.0497,4.6023 L 7.0290,4.4964 L 7.0006,4.4059 L 6.8327,4.0488 L 6.7732,4.0127 L 6.7029,4.0049 L 6.6539,4.0359 L 6.5169,4.4292 L 6.4420,4.6591 L 6.2761,4.6695 L 6.2244,4.6927 L 6.1727,4.7579 L 6.1392,4.8328 L 6.1469,5.3139 L 6.3826,5.3113 L 6.3696,5.7356 L 6.3671,6.2296 L 6.3696,6.4006 L 6.3722,6.4988 L 5.6735,6.8378 L 1.4826,7.0652 L 1.4051,7.0704 L 1.3425,7.0781 L 1.2883,7.1040 L 1.2418,7.1505 L 1.2185,7.2001 L 1.2030,7.2647 L 1.2030,7.9757 L 6.2425,8.7597 L 8.3277,8.7597 L 8.3721,8.8057 L 8.4227,8.8615 L 8.4760,8.9364 L 8.5271,9.0268 L 8.5561,9.6671 L 8.5829,10.0537 L 8.6336,10.6138 L 8.6894,11.1234 L 8.8894,12.7662 L 8.9938,13.5527 L 9.0522,13.9072 L 9.1028,14.1128 L 6.6709,14.9872 L 6.6254,15.0327 L 6.5882,15.1019 L 6.5722,15.1660 L 6.5722,15.7980 L 9.1431,15.5686 L 9.1591,15.7076 L 9.1906,15.8538 L 9.2258,15.9525 L 9.2630,16.0140 L 9.2966,16.0150 L 9.2966,16.0166 L 9.3033,16.0156 L 9.3043,16.0156 L 9.3126,16.0140 L 9.3498,15.9525 L 9.3844,15.8538 L 9.4165,15.7076 L 9.4325,15.5686 L 12.0034,15.7980 L 12.0034,15.1660 L 11.9874,15.1019 L 11.9497,15.0327 L 11.9047,14.9872 L 9.4723,14.1128 L 9.5229,13.9072 L 9.5818,13.5527 L 9.6857,12.7662 L 9.8857,11.1234 L 9.9415,10.6138 L 9.9927,10.0537 L 10.0190,9.6671 L 10.0485,9.0268 L 10.0991,8.9364 L 10.1524,8.8615 L 10.2030,8.8057 L 10.2474,8.7597 L 12.3326,8.7597 L 17.3721,7.9757 L 17.3721,7.2647 L 17.3566,7.2001 L 17.3333,7.1505 L 17.2868,7.1040 L 17.2325,7.0781 L 17.1705,7.0704 L 17.0930,7.0652 L 12.9015,6.8378 L 12.2034,6.4988 L 12.2060,6.4006 L 12.2086,6.2296 L 12.2060,5.7356 L 12.1931,5.3113 L 12.4282,5.3139 L 12.4360,4.8328 L 12.4024,4.7578 L 12.3507,4.6927 L 12.2990,4.6695 L 12.1337,4.6591 L 12.0582,4.4292 L 11.9213,4.0359 L 11.8722,4.0049 L 11.8024,4.0127 L 11.7430,4.0488 L 11.5745,4.4059 L 11.5461,4.4964 L 11.5255,4.6023 L 11.5048,4.7062 L 11.4195,4.7062 L 11.3653,4.7191 L 11.3032,4.7423 L 11.2619,4.7708 L 11.2304,4.8121 L 11.2123,4.8483 L 11.2123,5.3165 L 11.4557,5.3165 L 11.4428,5.7666 L 11.4376,6.2218 L 11.4350,6.6513 L 10.0485,6.5867 L 10.0485,5.7433 L 9.9834,5.0576 L 9.9343,4.6152 L 9.9007,4.3853 L 9.8464,4.0773 L 9.7689,3.7564 L 9.6914,3.5006 L 9.6108,3.2778 L 9.5100,3.0577 L 9.4222,2.9259 L 9.3834,2.9052 Z","a":[9.26,7.408]},"PC12":{"d":"M 9.2452,2.0985 C 9.1056,2.0978 9.0234,2.5269 9.0101,2.5494 C 8.8082,2.4455 8.5835,2.4570 8.5835,2.4570 C 8.2256,2.4570 8.0911,2.5886 8.0911,2.5886 L 8.0811,2.6867 L 8.8310,2.6664 L 8.9882,2.6871 L 8.9656,2.7803 C 8.9245,2.8164 8.8593,3.0645 8.8593,3.0645 C 8.6468,3.0407 8.4867,3.3568 8.4867,3.3568 C 8.5557,3.4308 8.5683,3.4987 8.5683,3.4987 C 8.5861,3.5635 8.5808,3.6190 8.5808,3.6190 C 8.6628,3.4372 8.7821,3.3389 8.7821,3.3389 C 8.5136,4.4358 8.4997,4.7210 8.4997,4.7210 L 8.3863,5.6183 L 8.3830,6.9675 L 1.8330,7.2477 L 1.7292,7.3033 L 1.5948,7.5089 L 1.2381,8.2384 L 1.2148,8.4186 L 1.2466,8.6424 L 1.4714,8.4767 L 1.6815,8.3980 L 1.7950,8.4100 L 3.5782,8.5334 L 4.3160,8.6063 L 4.3454,8.7321 L 4.3788,8.6178 L 6.1237,8.8142 L 6.1629,8.9304 L 6.1922,8.8144 L 8.2338,9.0589 L 8.3257,9.1293 L 8.3915,9.3508 L 8.3866,10.7567 C 8.5211,11.9298 8.6295,12.3687 8.6295,12.3687 L 8.7359,13.4500 L 8.8389,13.6051 L 9.1013,14.6373 L 6.9022,14.9134 L 6.7629,15.1688 L 6.6367,15.5348 L 6.6616,15.7968 L 9.1242,15.9263 C 9.1567,16.2039 9.2385,16.3601 9.2385,16.3601 C 9.3353,16.1597 9.3408,15.9327 9.3408,15.9327 L 11.8145,15.7997 L 11.8393,15.5481 L 11.7131,15.1688 L 11.5738,14.9134 L 9.3750,14.6373 C 9.4845,14.2037 9.6267,13.6067 9.6267,13.6067 L 9.7390,13.4493 L 9.8418,12.3687 C 9.9920,11.5780 10.0810,10.7156 10.0810,10.7156 L 10.0809,9.3221 L 10.1313,9.1193 L 10.2403,9.0589 L 12.2794,8.8192 L 12.3234,8.9304 L 12.3430,8.8144 L 14.0957,8.6198 L 14.1263,8.7563 L 14.1781,8.6157 L 14.8832,8.5288 L 16.6792,8.4100 L 16.8620,8.4028 L 17.0624,8.4900 L 17.2998,8.6448 L 17.3063,8.2354 L 16.9415,7.4916 C 16.8308,7.2861 16.6810,7.2464 16.5929,7.2448 L 10.2240,6.9866 L 10.0837,6.9553 L 10.0664,5.6257 L 9.9640,4.6467 C 9.8390,3.8680 9.6844,3.3575 9.6844,3.3575 C 9.8202,3.4737 9.9098,3.6188 9.9098,3.6188 C 9.8563,3.4327 9.9816,3.3612 9.9816,3.3612 C 9.8146,3.0399 9.6190,3.0745 9.6190,3.0745 C 9.5599,2.7789 9.4924,2.7553 9.4924,2.7553 L 9.5192,2.6936 C 9.5835,2.7296 9.6168,2.6818 9.6168,2.6818 C 9.7745,2.6066 10.4460,2.6867 10.4460,2.6867 L 10.4359,2.5886 C 10.3738,2.4647 9.9598,2.4560 9.9598,2.4560 C 9.6993,2.4532 9.4518,2.5595 9.4518,2.5595 C 9.3751,2.0638 9.2457,2.0985 9.2457,2.0985 Z","a":[9.26,7.937]},"PA44":{"d":"M 9.2275,4.2287 L 9.1705,4.2370 L 9.1230,4.2643 L 9.0475,4.3672 L 8.8925,4.6307 L 8.7778,4.9191 L 8.6568,5.3025 L 8.5876,5.5583 L 8.4992,5.9939 L 8.4568,6.2988 L 8.4238,6.5774 L 8.3881,7.1344 L 7.3623,7.5277 L 7.0771,7.5344 L 7.0342,7.4853 L 7.0409,7.0068 L 7.0311,6.7381 L 7.0047,6.5608 L 6.9753,6.4332 L 6.9396,6.3743 L 6.8838,6.3087 L 6.7691,6.2368 L 6.6709,6.1743 L 6.6347,6.1319 L 6.6151,6.0859 L 6.6053,5.9743 L 6.5691,5.8400 L 6.5179,5.7331 L 6.4802,5.6896 L 6.4446,5.7351 L 6.3955,5.8338 L 6.3464,5.9810 L 6.3267,6.0859 L 6.3102,6.1319 L 6.2839,6.1676 L 6.2151,6.2007 L 6.1035,6.2663 L 6.0415,6.3087 L 5.9857,6.3908 L 5.9593,6.4725 L 5.9397,6.6234 L 5.9237,6.8823 L 5.9237,7.4326 L 5.9211,7.4952 L 5.8901,7.5308 L 5.3893,7.5386 L 5.1015,7.5665 L 1.1317,7.9757 L 1.0930,7.9928 L 1.0578,8.0207 L 1.0335,8.0693 L 1.0242,9.3162 L 1.0392,9.3555 L 1.0692,9.3891 L 1.1028,9.4134 L 1.8407,9.4862 L 5.5025,9.8103 L 5.5733,9.8046 L 6.0787,9.8103 L 6.1273,9.9146 L 6.1846,10.0097 L 6.2746,10.1069 L 6.3882,10.1927 L 6.4699,10.2149 L 6.5784,10.1963 L 6.6621,10.1461 L 6.7479,10.0733 L 6.8151,9.9854 L 6.8694,9.8888 L 6.8973,9.8159 L 8.4538,9.8159 L 8.4651,10.0154 L 8.4817,10.2412 L 8.5225,10.6567 L 8.5618,11.0371 L 8.6124,11.4830 L 8.7090,12.3052 L 8.8062,12.9853 L 9.0744,14.7490 L 9.0299,14.7939 L 7.3592,14.8011 L 7.2512,14.8068 L 7.1990,14.8482 L 7.1541,14.9097 L 7.1298,14.9970 L 7.1283,15.2022 L 7.1448,15.2936 L 7.1768,15.4445 L 7.2342,15.6667 L 7.2585,15.7169 L 7.2977,15.7561 L 7.3649,15.7597 L 9.2059,15.7706 L 11.0877,15.7597 L 11.1549,15.7561 L 11.1936,15.7169 L 11.2179,15.6667 L 11.2758,15.4445 L 11.3073,15.2936 L 11.3244,15.2022 L 11.3223,14.9970 L 11.2980,14.9097 L 11.2535,14.8482 L 11.2014,14.8068 L 11.0928,14.8011 L 9.4227,14.7939 L 9.3777,14.7490 L 9.6464,12.9853 L 9.7431,12.3052 L 9.8402,11.4830 L 9.8903,11.0371 L 9.9296,10.6567 L 9.9709,10.2412 L 9.9875,10.0154 L 9.9988,9.8159 L 11.5553,9.8159 L 11.5832,9.8888 L 11.6375,9.9854 L 11.7047,10.0733 L 11.7905,10.1461 L 11.8742,10.1963 L 11.9822,10.2149 L 12.0643,10.1927 L 12.1780,10.1069 L 12.2674,10.0097 L 12.3253,9.9146 L 12.3739,9.8103 L 12.8793,9.8046 L 12.9501,9.8103 L 16.6114,9.4862 L 17.3498,9.4134 L 17.3834,9.3891 L 17.4134,9.3555 L 17.4284,9.3162 L 17.4191,8.0693 L 17.3948,8.0207 L 17.3591,7.9928 L 17.3209,7.9757 L 13.3506,7.5665 L 13.0627,7.5386 L 12.5620,7.5308 L 12.5310,7.4952 L 12.5289,7.4326 L 12.5289,6.8823 L 12.5123,6.6234 L 12.4927,6.4725 L 12.4663,6.3908 L 12.4111,6.3087 L 12.3485,6.2663 L 12.2369,6.2007 L 12.1682,6.1676 L 12.1423,6.1319 L 12.1258,6.0859 L 12.1061,5.9810 L 12.0571,5.8338 L 12.0080,5.7351 L 11.9679,5.6896 L 11.9289,5.7335 L 11.8834,5.8400 L 11.8473,5.9743 L 11.8375,6.0859 L 11.8178,6.1319 L 11.7817,6.1743 L 11.6835,6.2368 L 11.5687,6.3087 L 11.5129,6.3743 L 11.4768,6.4332 L 11.4473,6.5608 L 11.4210,6.7381 L 11.4112,7.0068 L 11.4179,7.4853 L 11.3755,7.5344 L 11.0902,7.5277 L 10.0645,7.1344 L 10.0283,6.5774 L 9.9958,6.2988 L 9.9529,5.9939 L 9.8645,5.5583 L 9.7958,5.3025 L 9.6743,4.9191 L 9.5596,4.6307 L 9.4051,4.3672 L 9.3297,4.2643 L 9.2816,4.2370 Z","a":[9.26,7.673]},"A21N":{"d":"M 9.2527,0.3973 L 9.2201,0.3983 L 9.2201,0.3983 L 9.1870,0.4174 L 9.1410,0.4516 L 9.1023,0.4877 L 9.0527,0.5379 L 9.0062,0.5916 L 8.9633,0.6500 L 8.9188,0.7187 L 8.8816,0.7859 L 8.8051,0.9358 L 8.7545,1.0417 L 8.7095,1.1523 L 8.6543,1.2959 L 8.6010,1.4525 L 8.5592,1.6060 L 8.5282,1.7460 L 8.4961,1.9403 L 8.4842,2.0881 L 8.4806,2.3310 L 8.4806,6.8083 L 8.4754,6.8713 L 8.4579,6.9473 L 8.4212,7.0155 L 8.3783,7.0739 L 8.3189,7.1359 L 8.2600,7.1736 L 8.1742,7.2165 L 7.3484,7.6403 L 7.3510,7.5519 L 7.3649,7.4558 L 7.3763,7.3436 L 7.3851,7.2067 L 7.3907,7.0884 L 7.3907,6.8811 L 7.3882,6.7654 L 7.3753,6.6713 L 7.3520,6.5711 L 7.3406,6.5292 L 7.3163,6.5091 L 6.6797,6.5091 L 6.6544,6.5246 L 6.6378,6.5654 L 6.6260,6.6305 L 6.6079,6.7318 L 6.5980,6.8393 L 6.5960,7.0310 L 6.5991,7.1592 L 6.6079,7.2806 L 6.6301,7.5059 L 6.6533,7.7054 L 6.6962,7.9736 L 2.5952,10.0902 L 2.5513,10.1212 L 2.5202,10.1507 L 2.4872,10.1982 L 2.4665,10.2515 L 2.4665,10.9233 L 2.5073,10.9233 L 2.5073,10.7305 L 4.4969,10.1311 L 4.4948,10.2417 L 4.5046,10.3264 L 4.5258,10.3848 L 4.5475,10.4303 L 4.5630,10.4303 L 4.5765,10.3925 L 4.5961,10.3254 L 4.6095,10.2448 L 4.6126,10.1941 L 4.6126,10.0959 L 5.9169,9.7063 L 5.9149,9.8133 L 5.9262,9.8830 L 5.9428,9.9492 L 5.9603,10.0039 L 5.9836,10.0039 L 6.0012,9.9580 L 6.0198,9.8861 L 6.0332,9.8034 L 6.0332,9.6686 L 6.6399,9.4846 L 6.9680,9.4898 L 6.9680,9.5585 L 6.9753,9.6045 L 6.9866,9.6365 L 7.0011,9.6365 L 7.0156,9.6045 L 7.0228,9.5538 L 7.0228,9.4877 L 7.2781,9.4944 L 7.2760,9.6200 L 7.2925,9.6965 L 7.3122,9.7678 L 7.3267,9.7957 L 7.3484,9.7957 L 7.3587,9.7647 L 7.3773,9.6939 L 7.3907,9.6226 L 7.3928,9.4996 L 8.4744,9.5140 L 8.4744,13.9009 L 8.4811,14.1877 L 8.4940,14.3675 L 8.5126,14.5773 L 8.5338,14.7618 L 8.5581,14.9385 L 8.5855,15.1080 L 8.6465,15.4072 L 8.7018,15.6444 L 8.7545,15.8687 L 8.7581,15.9193 L 8.7436,15.9891 L 8.7116,16.0428 L 8.6708,16.0806 L 6.8368,17.2846 L 6.8109,17.3089 L 6.7934,17.3342 L 6.7835,17.3683 L 6.7835,17.8097 L 8.9178,17.3063 L 8.9178,17.1797 L 8.9411,17.3012 L 8.9710,17.4278 L 9.0237,17.6278 L 9.1080,17.9047 L 9.1751,18.1001 L 9.1751,18.1409 L 9.2594,18.1425 L 9.3457,18.1409 L 9.3457,18.1001 L 9.4134,17.9047 L 9.4971,17.6278 L 9.5498,17.4278 L 9.5798,17.3012 L 9.6030,17.1797 L 9.6030,17.3063 L 11.7373,17.8097 L 11.7373,17.3683 L 11.7275,17.3342 L 11.7099,17.3089 L 11.6846,17.2846 L 9.8501,16.0806 L 9.8092,16.0428 L 9.7772,15.9891 L 9.7632,15.9193 L 9.7663,15.8687 L 9.8191,15.6444 L 9.8744,15.4072 L 9.9353,15.1080 L 9.9627,14.9385 L 9.9870,14.7618 L 10.0082,14.5773 L 10.0268,14.3675 L 10.0402,14.1877 L 10.0464,13.9009 L 10.0464,9.5140 L 11.1280,9.4996 L 11.1301,9.6226 L 11.1436,9.6939 L 11.1622,9.7647 L 11.1725,9.7957 L 11.1942,9.7957 L 11.2087,9.7678 L 11.2288,9.6965 L 11.2454,9.6200 L 11.2428,9.4944 L 11.4980,9.4877 L 11.4980,9.5538 L 11.5058,9.6045 L 11.5198,9.6365 L 11.5343,9.6365 L 11.5456,9.6045 L 11.5534,9.5585 L 11.5534,9.4898 L 11.8811,9.4846 L 12.4877,9.6686 L 12.4877,9.8034 L 12.5012,9.8861 L 12.5198,9.9579 L 12.5374,10.0039 L 12.5606,10.0039 L 12.5787,9.9492 L 12.5952,9.8830 L 12.6061,9.8132 L 12.6040,9.7063 L 13.9083,10.0959 L 13.9083,10.1941 L 13.9114,10.2447 L 13.9248,10.3254 L 13.9445,10.3925 L 13.9579,10.4303 L 13.9734,10.4303 L 13.9956,10.3848 L 14.0163,10.3264 L 14.0261,10.2416 L 14.0240,10.1311 L 16.0135,10.7305 L 16.0135,10.9233 L 16.0544,10.9233 L 16.0544,10.2515 L 16.0337,10.1982 L 16.0006,10.1507 L 15.9696,10.1212 L 15.9257,10.0902 L 11.8247,7.9736 L 11.8675,7.7054 L 11.8908,7.5059 L 11.9130,7.2806 L 11.9218,7.1591 L 11.9249,7.0310 L 11.9228,6.8393 L 11.9130,6.7318 L 11.8954,6.6305 L 11.8830,6.5654 L 11.8665,6.5246 L 11.8412,6.5091 L 11.2045,6.5091 L 11.1802,6.5292 L 11.1689,6.5711 L 11.1456,6.6713 L 11.1327,6.7654 L 11.1306,6.8811 L 11.1306,7.0883 L 11.1358,7.2067 L 11.1446,7.3436 L 11.1560,7.4558 L 11.1699,7.5519 L 11.1725,7.6402 L 10.3467,7.2165 L 10.2610,7.1736 L 10.2026,7.1359 L 10.1426,7.0744 L 10.0997,7.0155 L 10.0630,6.9473 L 10.0455,6.8713 L 10.0403,6.8083 L 10.0403,2.3310 L 10.0366,2.0881 L 10.0247,1.9403 L 9.9927,1.7460 L 9.9617,1.6060 L 9.9198,1.4525 L 9.8666,1.2959 L 9.8118,1.1523 L 9.7663,1.0417 L 9.7157,0.9358 L 9.6392,0.7859 L 9.6020,0.7187 L 9.5576,0.6500 L 9.5147,0.5916 L 9.4682,0.5379 L 9.4185,0.4877 L 9.3803,0.4516 L 9.3338,0.4174 L 9.3007,0.3983 L 9.2749,0.3973 Z","a":[9.26,8.202]},"P68":{"d":"M 9.2263,2.2767 L 9.1100,2.2955 L 9.0150,2.3590 L 8.9571,2.4381 L 8.9256,2.5802 L 8.9256,2.7590 L 8.8253,2.8908 L 8.7256,3.1331 L 8.6362,3.4489 L 8.5359,3.9858 L 8.4620,4.5284 L 8.3623,5.3707 L 8.3359,6.9768 L 7.2352,6.9768 L 7.2352,6.5552 L 6.8771,6.4342 L 6.8771,6.3236 L 6.8249,6.1500 L 6.7613,5.9867 L 6.6301,5.8446 L 6.4875,5.9919 L 6.3826,6.3025 L 6.3826,6.4182 L 5.9981,6.5712 L 5.9981,6.9820 L 1.0382,6.9820 L 0.8961,7.0239 L 0.7906,7.1396 L 0.6589,7.6926 L 0.6537,8.3297 L 0.7276,8.7617 L 0.8273,9.1565 L 0.8749,9.1932 L 2.4386,9.1932 L 2.4753,9.2459 L 2.8283,9.2459 L 2.9073,9.1720 L 8.3674,9.1720 L 8.4202,9.8728 L 8.5044,10.4831 L 8.6832,11.9311 L 8.9307,13.9428 L 8.2408,14.4797 L 6.6508,14.4797 L 6.5453,14.5376 L 6.4771,14.6218 L 6.4559,14.7324 L 6.4559,15.3381 L 6.5614,15.7696 L 6.6037,15.7856 L 9.1467,15.7856 L 9.2287,16.2352 L 9.2987,15.7856 L 11.8417,15.7856 L 11.8840,15.7696 L 11.9894,15.3381 L 11.9894,14.7324 L 11.9683,14.6218 L 11.8995,14.5376 L 11.7946,14.4797 L 10.2045,14.4797 L 9.5147,13.9428 L 9.7622,11.9311 L 9.9410,10.4831 L 10.0252,9.8728 L 10.0779,9.1720 L 15.5381,9.1720 L 15.6171,9.2459 L 15.9701,9.2459 L 16.0068,9.1932 L 17.5705,9.1932 L 17.6180,9.1565 L 17.7178,8.7617 L 17.7917,8.3297 L 17.7865,7.6926 L 17.6547,7.1396 L 17.5493,7.0239 L 17.4072,6.9820 L 12.4473,6.9820 L 12.4473,6.5712 L 12.0628,6.4182 L 12.0628,6.3025 L 11.9574,5.9919 L 11.8153,5.8446 L 11.6840,5.9867 L 11.6205,6.1500 L 11.5678,6.3236 L 11.5678,6.4342 L 11.2102,6.5552 L 11.2102,6.9768 L 10.1095,6.9768 L 10.0831,5.3707 L 9.9834,4.5284 L 9.9095,3.9858 L 9.8092,3.4489 L 9.7198,3.1331 L 9.6196,2.8908 L 9.5198,2.7590 L 9.5198,2.5802 L 9.4883,2.4381 L 9.4304,2.3590 L 9.3353,2.2955 Z","a":[9.26,7.937]},"A124":{"d":"M 9.2604,1.1911 L 9.1708,1.2160 L 9.0164,1.4052 L 8.7773,1.8385 L 8.5931,2.2269 L 8.4785,2.6552 L 8.4188,3.0884 L 8.3789,3.5067 L 8.3690,5.3443 L 8.3740,6.0515 L 7.3282,6.7586 L 7.2734,6.7586 L 7.3232,6.6839 L 7.3232,5.9818 L 7.2335,5.8622 L 6.7157,5.8622 L 6.6509,5.9568 L 6.6310,6.1760 L 6.6011,6.4050 L 6.6011,6.7985 L 6.6360,6.8732 L 6.6360,7.0325 L 6.6957,7.1022 L 6.7605,7.1022 L 6.7754,7.1371 L 6.1131,7.5803 L 5.5005,7.9389 L 5.5055,7.7148 L 5.5404,7.6351 L 5.5453,7.0823 L 5.5005,6.9230 L 4.9179,6.9230 L 4.8681,6.9777 L 4.8581,7.1719 L 4.8332,7.2566 L 4.8233,7.8492 L 4.8631,7.9289 L 4.8581,8.0484 L 4.9378,8.1381 L 4.9876,8.1381 L 4.9876,8.2277 L 3.4687,9.0842 L 1.9299,9.9358 L 1.1481,10.3840 L 1.0385,10.4538 L 0.9539,10.5484 L 0.8891,10.6529 L 0.8194,10.7874 L 0.7696,10.8920 L 0.7447,11.0364 L 0.7298,11.2306 L 0.7298,11.4198 L 1.2726,11.2704 L 3.0355,10.7525 L 3.3044,10.6679 L 3.3094,10.7027 L 3.3393,10.7426 L 3.4040,10.8173 L 3.4588,10.7625 L 3.5036,10.7127 L 3.4986,10.6081 L 4.2107,10.3890 L 4.2107,10.4686 L 4.2456,10.5433 L 4.2904,10.5533 L 4.3452,10.4786 L 4.3601,10.4239 L 4.3601,10.3392 L 5.0523,10.1151 L 5.0473,10.1749 L 5.0722,10.2446 L 5.1221,10.2695 L 5.1469,10.2595 L 5.1918,10.1848 L 5.1968,10.0653 L 5.9437,9.8561 L 5.9388,9.9507 L 5.9736,10.0005 L 6.0184,9.9906 L 6.0483,9.9358 L 6.0533,9.8163 L 6.8501,9.6221 L 6.8501,9.6818 L 6.8800,9.7516 L 6.9198,9.7914 L 6.9447,9.7814 L 6.9796,9.7067 L 7.0045,9.6370 L 7.0045,9.5723 L 8.0054,9.3432 L 8.0154,9.4329 L 8.0552,9.4976 L 8.0951,9.5076 L 8.1299,9.4777 L 8.1648,9.4030 L 8.1648,9.2984 L 8.3540,9.2585 L 8.3491,10.3840 L 8.3789,10.7575 L 8.3789,12.8690 L 8.4188,13.7355 L 8.4686,14.1339 L 8.5184,14.4227 L 8.5781,14.6667 L 8.5781,14.8410 L 8.0403,15.2643 L 7.4776,15.6826 L 6.9248,16.1059 L 6.3621,16.5492 L 6.2824,16.6736 L 6.2525,16.8031 L 6.2326,16.9376 L 6.2326,17.2862 L 6.2824,17.3260 L 6.4218,17.2762 L 7.8113,16.9625 L 8.9616,16.7234 L 9.0014,16.8728 L 9.0562,17.0272 L 9.0911,17.1617 L 9.1508,17.2613 L 9.2106,17.3160 L 9.2598,17.3294 L 9.3102,17.3160 L 9.3700,17.2613 L 9.4297,17.1617 L 9.4646,17.0272 L 9.5194,16.8728 L 9.5592,16.7234 L 10.7096,16.9625 L 12.0990,17.2762 L 12.2384,17.3260 L 12.2882,17.2862 L 12.2882,16.9376 L 12.2683,16.8031 L 12.2384,16.6736 L 12.1587,16.5492 L 11.5960,16.1059 L 11.0432,15.6826 L 10.4805,15.2643 L 9.9427,14.8410 L 9.9427,14.6667 L 10.0024,14.4227 L 10.0522,14.1339 L 10.1020,13.7355 L 10.1418,12.8690 L 10.1418,10.7575 L 10.1717,10.3840 L 10.1667,9.2585 L 10.3560,9.2984 L 10.3560,9.4030 L 10.3908,9.4777 L 10.4257,9.5075 L 10.4656,9.4976 L 10.5054,9.4328 L 10.5154,9.3432 L 11.5163,9.5723 L 11.5163,9.6370 L 11.5412,9.7067 L 11.5761,9.7814 L 11.6010,9.7914 L 11.6408,9.7516 L 11.6707,9.6818 L 11.6707,9.6221 L 12.4675,9.8163 L 12.4725,9.9358 L 12.5024,9.9906 L 12.5472,10.0005 L 12.5820,9.9507 L 12.5770,9.8561 L 13.3240,10.0653 L 13.3290,10.1848 L 13.3738,10.2595 L 13.3987,10.2695 L 13.4485,10.2446 L 13.4734,10.1749 L 13.4684,10.1151 L 14.1607,10.3392 L 14.1607,10.4239 L 14.1756,10.4786 L 14.2304,10.5534 L 14.2752,10.5434 L 14.3100,10.4687 L 14.3100,10.3890 L 15.0222,10.6081 L 15.0172,10.7127 L 15.0620,10.7625 L 15.1168,10.8173 L 15.1815,10.7426 L 15.2114,10.7027 L 15.2164,10.6679 L 15.4854,10.7526 L 17.2482,11.2704 L 17.7910,11.4199 L 17.7910,11.2306 L 17.7761,11.0364 L 17.7512,10.8920 L 17.7014,10.7874 L 17.6317,10.6530 L 17.5670,10.5484 L 17.4823,10.4538 L 17.3727,10.3840 L 16.5908,9.9358 L 15.0520,9.0842 L 13.5331,8.2277 L 13.5331,8.1381 L 13.5830,8.1381 L 13.6626,8.0484 L 13.6576,7.9289 L 13.6974,7.8492 L 13.6874,7.2566 L 13.6625,7.1719 L 13.6525,6.9777 L 13.6027,6.9230 L 13.0202,6.9230 L 12.9753,7.0823 L 12.9803,7.6351 L 13.0152,7.7147 L 13.0202,7.9389 L 12.4077,7.5803 L 11.7453,7.1371 L 11.7603,7.1022 L 11.8250,7.1022 L 11.8848,7.0325 L 11.8848,6.8732 L 11.9197,6.7985 L 11.9197,6.4050 L 11.8898,6.1760 L 11.8699,5.9568 L 11.8051,5.8622 L 11.2873,5.8622 L 11.1976,5.9818 L 11.1976,6.6839 L 11.2474,6.7586 L 11.1926,6.7586 L 10.1468,6.0515 L 10.1518,5.3443 L 10.1418,3.5067 L 10.1020,3.0884 L 10.0422,2.6552 L 9.9277,2.2269 L 9.7434,1.8385 L 9.5044,1.4052 L 9.3500,1.2160 Z","a":[9.26,7.673]},"A333":{"d":"M 9.3240,0.5080 L 9.2801,0.5178 L 9.2206,0.5695 L 9.1467,0.6651 L 9.0826,0.7798 L 9.0113,0.9276 L 8.9452,1.0919 L 8.8749,1.2723 L 8.8093,1.4645 L 8.7695,1.5953 L 8.7380,1.7089 L 8.6946,1.8877 L 8.6279,2.2360 L 8.5824,2.5518 L 8.5654,2.7549 L 8.5530,2.9941 L 8.5457,3.1032 L 8.5457,7.0213 L 6.9639,7.9949 L 7.0740,7.4709 L 7.1794,7.4709 L 7.2146,7.2027 L 7.2337,6.9355 L 7.2399,6.7722 L 7.2399,6.5593 L 7.2228,6.3092 L 7.2058,6.1479 L 7.1804,6.1252 L 6.4322,6.1252 L 6.4079,6.1469 L 6.3898,6.3552 L 6.3753,6.6632 L 6.3753,6.8461 L 6.3872,7.0621 L 6.4125,7.3226 L 6.4342,7.4688 L 6.5433,7.4688 L 6.6704,8.0915 L 6.7112,8.0915 L 6.7210,8.1411 L 1.3978,11.4313 L 1.3736,11.4520 L 1.3591,11.4799 L 1.3575,11.6055 L 1.1488,12.0773 L 1.1488,12.3036 L 1.3384,12.1667 L 3.9977,11.0024 L 4.4380,10.8510 L 4.4426,10.9513 L 4.4659,11.0412 L 4.4922,11.1280 L 4.5165,11.1838 L 4.5418,11.1838 L 4.5625,11.1197 L 4.5889,11.0252 L 4.6106,10.9332 L 4.6230,10.8428 L 4.6230,10.7844 L 5.3315,10.5425 L 5.3315,10.6154 L 5.3459,10.6903 L 5.3702,10.7663 L 5.4079,10.8727 L 5.4317,10.8727 L 5.4586,10.8040 L 5.4865,10.7131 L 5.5020,10.6216 L 5.5139,10.5461 L 5.5139,10.4800 L 6.2213,10.2366 L 6.2213,10.3043 L 6.2337,10.3870 L 6.2627,10.4784 L 6.3004,10.5704 L 6.3231,10.5704 L 6.3510,10.4981 L 6.3764,10.4071 L 6.3944,10.3167 L 6.4032,10.2330 L 6.4032,10.1741 L 7.0740,9.9394 L 7.1892,9.9394 L 7.1928,10.0371 L 7.2047,10.1172 L 7.2218,10.1813 L 7.2662,10.3275 L 7.2952,10.3275 L 7.3257,10.2500 L 7.3484,10.1570 L 7.3644,10.1038 L 7.3753,10.0361 L 7.3815,9.9415 L 8.4238,9.9415 L 8.4372,10.0821 L 8.4646,10.2237 L 8.5070,10.3906 L 8.5411,10.4882 L 8.5411,12.0628 L 8.5447,12.3842 L 8.5602,12.7134 L 8.5855,13.0834 L 8.6000,13.2405 L 8.6233,13.4715 L 8.6424,13.6240 L 8.6677,13.8405 L 8.6899,14.0084 L 8.7380,14.3216 L 8.7938,14.6678 L 8.8470,15.0290 L 8.9013,15.3753 L 8.9896,15.9458 L 6.8094,17.2413 L 6.7691,17.2749 L 6.7345,17.3235 L 6.7112,17.3788 L 6.6968,17.4491 L 6.6497,17.9488 L 9.1793,17.2263 L 9.2522,17.9338 L 9.2801,17.9524 L 9.3240,17.9565 L 9.3674,17.9524 L 9.3953,17.9338 L 9.4676,17.2263 L 11.9977,17.9488 L 11.9507,17.4491 L 11.9362,17.3788 L 11.9130,17.3235 L 11.8778,17.2749 L 11.8381,17.2413 L 9.6578,15.9458 L 9.7462,15.3753 L 9.8005,15.0290 L 9.8537,14.6678 L 9.9090,14.3216 L 9.9575,14.0084 L 9.9793,13.8405 L 10.0046,13.6240 L 10.0242,13.4715 L 10.0470,13.2405 L 10.0614,13.0834 L 10.0867,12.7134 L 10.1028,12.3842 L 10.1064,12.0628 L 10.1064,10.4882 L 10.1400,10.3906 L 10.1823,10.2237 L 10.2102,10.0821 L 10.2237,9.9415 L 11.2660,9.9415 L 11.2722,10.0361 L 11.2830,10.1038 L 11.2985,10.1570 L 11.3218,10.2500 L 11.3518,10.3275 L 11.3807,10.3275 L 11.4257,10.1813 L 11.4427,10.1172 L 11.4546,10.0371 L 11.4582,9.9394 L 11.5729,9.9394 L 12.2442,10.1741 L 12.2442,10.2330 L 12.2530,10.3167 L 12.2711,10.4071 L 12.2964,10.4981 L 12.3243,10.5704 L 12.3471,10.5704 L 12.3848,10.4784 L 12.4137,10.3870 L 12.4256,10.3043 L 12.4256,10.2366 L 13.1331,10.4800 L 13.1331,10.5461 L 13.1455,10.6216 L 13.1610,10.7131 L 13.1889,10.8040 L 13.2152,10.8727 L 13.2395,10.8727 L 13.2772,10.7663 L 13.3010,10.6903 L 13.3155,10.6154 L 13.3155,10.5425 L 14.0245,10.7844 L 14.0245,10.8428 L 14.0364,10.9332 L 14.0581,11.0252 L 14.0849,11.1197 L 14.1056,11.1838 L 14.1309,11.1838 L 14.1547,11.1280 L 14.1816,11.0412 L 14.2043,10.9513 L 14.2095,10.8510 L 14.6498,11.0024 L 17.3090,12.1667 L 17.4987,12.3036 L 17.4987,12.0773 L 17.2894,11.6055 L 17.2884,11.4799 L 17.2739,11.4520 L 17.2497,11.4313 L 11.9265,8.1411 L 11.9358,8.0915 L 11.9771,8.0915 L 12.1042,7.4688 L 12.2127,7.4688 L 12.2344,7.3225 L 12.2603,7.0621 L 12.2722,6.8461 L 12.2722,6.6632 L 12.2577,6.3552 L 12.2396,6.1469 L 12.2153,6.1252 L 11.4665,6.1252 L 11.4412,6.1479 L 11.4247,6.3092 L 11.4076,6.5593 L 11.4076,6.7722 L 11.4133,6.9355 L 11.4330,7.2027 L 11.4681,7.4709 L 11.5730,7.4709 L 11.6831,7.9949 L 10.1013,7.0213 L 10.1013,3.1032 L 10.0940,2.9941 L 10.0821,2.7549 L 10.0650,2.5518 L 10.0190,2.2360 L 9.9524,1.8877 L 9.9090,1.7089 L 9.8774,1.5953 L 9.8376,1.4645 L 9.7725,1.2723 L 9.7022,1.0919 L 9.6356,0.9276 L 9.5643,0.7798 L 9.5002,0.6651 L 9.4263,0.5695 L 9.3674,0.5178 Z","a":[9.26,8.467]},"GLEX":{"d":"M 9.2731,0.5524 C 9.1216,0.5524 8.4748,1.6799 8.4748,2.6505 L 8.4748,6.2384 L 1.2274,11.7888 C 1.1348,11.8603 0.9269,12.6133 0.8907,12.7482 L 0.8907,13.0407 L 1.1386,12.6112 L 1.1926,12.6651 C 1.2211,12.6651 1.2485,12.5411 1.2485,12.4563 L 3.2009,11.4689 C 3.2009,11.5762 3.2135,11.7235 3.2535,11.7235 C 3.2893,11.7235 3.3040,11.5279 3.3040,11.4164 L 4.9487,10.6051 C 4.9487,10.7250 4.9645,10.8579 5.0001,10.8579 C 5.0356,10.8579 5.0589,10.6837 5.0589,10.5598 L 6.5947,10.1245 C 6.5947,10.2087 6.5988,10.3897 6.6451,10.3897 C 6.6894,10.3897 6.6980,10.1757 6.6980,10.1025 L 8.4603,9.9343 C 8.4603,10.2066 8.6166,10.9215 8.6166,11.1281 L 8.4230,11.1281 C 8.4230,11.1281 8.3662,10.9430 8.3431,10.9430 L 7.5520,10.9430 C 7.5288,10.9430 7.3900,11.0355 7.3900,11.9550 C 7.3900,13.0154 7.6786,13.9105 7.7203,13.9769 L 8.2968,13.9769 C 8.3110,13.9469 8.3173,13.9285 8.3284,13.8949 L 8.8165,14.1410 C 8.8228,14.2441 8.9364,14.8080 8.9911,14.8732 L 6.6557,16.9646 C 6.5516,17.0687 6.5189,17.2234 6.5189,17.2865 L 6.5189,17.9366 L 9.1889,16.5564 C 9.2310,17.0004 9.2605,17.0130 9.2605,17.0130 C 9.2605,17.0130 9.2899,17.0004 9.3320,16.5564 L 12.0019,17.9366 L 12.0019,17.2865 C 12.0019,17.2234 11.9693,17.0687 11.8652,16.9646 L 9.5297,14.8732 C 9.5844,14.8080 9.6980,14.2441 9.7044,14.1410 L 10.1925,13.8949 C 10.2035,13.9285 10.2098,13.9469 10.2240,13.9769 L 10.8006,13.9769 C 10.8423,13.9105 11.1309,13.0154 11.1309,11.9550 C 11.1309,11.0355 10.9920,10.9430 10.9689,10.9430 L 10.1778,10.9430 C 10.1546,10.9430 10.0978,11.1281 10.0978,11.1281 L 9.9042,11.1281 C 9.9042,10.9215 10.0606,10.2066 10.0606,9.9343 L 11.8229,10.1025 C 11.8229,10.1757 11.8315,10.3897 11.8757,10.3897 C 11.9221,10.3897 11.9262,10.2087 11.9262,10.1245 L 13.4620,10.5598 C 13.4620,10.6837 13.4852,10.8579 13.5208,10.8579 C 13.5563,10.8579 13.5721,10.7250 13.5721,10.6051 L 15.2168,11.4164 C 15.2168,11.5279 15.2316,11.7235 15.2673,11.7235 C 15.3073,11.7235 15.3199,11.5762 15.3199,11.4689 L 17.2723,12.4563 C 17.2723,12.5411 17.2998,12.6651 17.3282,12.6651 L 17.3822,12.6112 L 17.6301,13.0406 L 17.6301,12.7482 C 17.5939,12.6133 17.3860,11.8603 17.2935,11.7888 L 10.0461,6.2384 L 10.0461,2.6505 C 10.0461,1.6799 9.4245,0.5524 9.2731,0.5524 Z","a":[9.26,8.202]},"F16":{"d":"M 9.0320,1.7787 L 8.9669,1.8526 L 8.8806,2.0536 L 8.7416,2.4303 L 8.6429,2.7947 L 8.5380,3.2453 L 8.4791,3.6313 L 8.4574,3.9186 L 8.4207,3.9615 L 8.3649,4.5207 L 8.2941,4.6380 L 8.2445,4.8018 L 8.2197,5.3449 L 8.1892,5.6725 L 8.1365,6.0461 L 8.0378,6.5464 L 7.9422,6.9231 L 7.8460,7.2533 L 7.7075,7.6238 L 7.6114,7.9571 L 7.5468,8.2445 L 7.4817,8.5380 L 7.4233,8.8372 L 7.3985,8.9023 L 6.3702,9.7792 L 5.6725,10.3813 L 4.9222,11.0019 L 4.0607,11.7119 L 4.0607,11.2582 L 4.0080,11.1099 L 3.9987,11.0019 L 3.8907,10.9957 L 3.8907,10.7363 L 4.0173,10.7363 L 3.9093,10.6283 L 3.9093,10.2547 L 3.8411,10.1870 L 3.7719,10.2562 L 3.7719,10.5265 L 3.5812,10.7172 L 3.7858,10.7172 L 3.7858,12.5026 L 3.5698,12.7186 L 3.5698,13.0710 L 3.6954,13.2886 L 3.8907,13.2886 L 4.0566,13.1227 L 7.7132,13.1227 L 7.7132,14.3955 L 5.8084,16.0786 L 5.8084,16.7390 L 6.1340,17.0651 L 7.6672,17.0651 L 7.6672,16.6837 L 8.1489,16.6837 L 8.1489,15.8869 L 8.2073,16.0166 L 8.2228,16.1835 L 8.2662,16.4460 L 8.3158,16.6527 L 8.3804,16.8842 L 8.7695,16.8842 L 8.7695,17.3721 L 9.0403,17.4526 L 9.2945,17.3721 L 9.2945,16.8842 L 9.6836,16.8842 L 9.7482,16.6527 L 9.7979,16.4460 L 9.8407,16.1835 L 9.8562,16.0166 L 9.9152,15.8869 L 9.9152,16.6837 L 10.3968,16.6837 L 10.3968,17.0651 L 11.9300,17.0651 L 12.2556,16.7390 L 12.2556,16.0786 L 10.3503,14.3955 L 10.3503,13.1227 L 14.0074,13.1227 L 14.1733,13.2886 L 14.3686,13.2886 L 14.4942,13.0710 L 14.4942,12.7186 L 14.2782,12.5026 L 14.2782,10.7172 L 14.4828,10.7172 L 14.2921,10.5265 L 14.2921,10.2562 L 14.2224,10.1870 L 14.1547,10.2547 L 14.1547,10.6283 L 14.0467,10.7363 L 14.1733,10.7363 L 14.1733,10.9957 L 14.0653,11.0019 L 14.0560,11.1099 L 14.0033,11.2582 L 14.0033,11.7119 L 13.1418,11.0019 L 12.3915,10.3813 L 11.6939,9.7792 L 10.6655,8.9023 L 10.6407,8.8372 L 10.5818,8.5380 L 10.5172,8.2445 L 10.4526,7.9571 L 10.3565,7.6238 L 10.2175,7.2533 L 10.1219,6.9231 L 10.0263,6.5464 L 9.9276,6.0461 L 9.8748,5.6725 L 9.8438,5.3449 L 9.8196,4.8018 L 9.7699,4.6380 L 9.6991,4.5207 L 9.6433,3.9615 L 9.6061,3.9186 L 9.5844,3.6313 L 9.5260,3.2453 L 9.4211,2.7947 L 9.3224,2.4303 L 9.1834,2.0536 L 9.0966,1.8526 Z","a":[8.996,10.848]},"DH8A":{"d":"M 9.2362,1.8562 L 9.1154,1.8844 L 8.9783,1.9823 L 8.8775,2.1151 L 8.7638,2.2981 L 8.6372,2.5507 L 8.5235,2.8096 L 8.4165,3.1378 L 8.3282,3.5104 L 8.2522,3.9145 L 8.2207,4.2680 L 8.2145,4.4700 L 8.2145,7.3298 L 8.1700,7.3675 L 6.7371,7.3675 L 6.7371,6.5407 L 6.7179,6.1934 L 6.6740,5.9852 L 6.5918,5.8208 L 6.4782,5.7133 L 6.4528,5.7066 L 6.4027,5.7454 L 6.2952,5.8777 L 6.2384,6.0544 L 6.2007,6.2249 L 6.2007,7.3737 L 0.6320,8.0052 L 0.5752,8.0305 L 0.5250,8.0998 L 0.4930,8.2010 L 0.4930,8.9524 L 3.3471,9.1100 L 3.3910,9.2175 L 3.4479,9.1162 L 4.7547,9.1798 L 4.7987,9.2868 L 4.8555,9.1860 L 6.1753,9.2490 L 6.1753,9.8738 L 6.2007,10.1141 L 6.2508,10.3162 L 6.3521,10.4676 L 6.4720,10.5244 L 6.5727,10.4738 L 6.6678,10.3730 L 6.7309,10.2464 L 6.7562,10.1327 L 6.7562,9.2682 L 8.2651,9.2490 L 8.2651,11.3135 L 8.3153,11.9889 L 8.3659,12.6328 L 8.4419,13.1821 L 8.6119,14.1924 L 8.9090,15.4802 L 6.7562,15.7830 L 6.6931,15.8399 L 6.6425,15.9665 L 6.6425,16.5850 L 6.6802,16.7871 L 6.7433,16.9261 L 9.1560,16.9261 L 9.1545,17.1912 L 9.2175,16.9261 L 11.6861,16.9261 L 11.7491,16.7871 L 11.7869,16.5850 L 11.7869,15.9665 L 11.7362,15.8399 L 11.6732,15.7830 L 9.5203,15.4802 L 9.8170,14.1924 L 9.9875,13.1821 L 10.0635,12.6328 L 10.1141,11.9889 L 10.1642,11.3135 L 10.1642,9.2490 L 11.6732,9.2682 L 11.6732,10.1327 L 11.6985,10.2464 L 11.7616,10.3725 L 11.8561,10.4738 L 11.9574,10.5244 L 12.0773,10.4676 L 12.1786,10.3162 L 12.2287,10.1141 L 12.2540,9.8738 L 12.2540,9.2490 L 13.5733,9.1860 L 13.6302,9.2868 L 13.6746,9.1793 L 14.9815,9.1162 L 15.0384,9.2175 L 15.0823,9.1100 L 17.9359,8.9524 L 17.9359,8.2010 L 17.9043,8.0998 L 17.8542,8.0305 L 17.7974,8.0052 L 12.2287,7.3737 L 12.2287,6.2249 L 12.1910,6.0544 L 12.1342,5.8777 L 12.0267,5.7449 L 11.9760,5.7066 L 11.9512,5.7133 L 11.8375,5.8208 L 11.7554,5.9852 L 11.7109,6.1934 L 11.6923,6.5407 L 11.6923,7.3675 L 10.2593,7.3675 L 10.2149,7.3298 L 10.2149,4.4700 L 10.2087,4.2680 L 10.1772,3.9145 L 10.1012,3.5104 L 10.0128,3.1378 L 9.9053,2.8096 L 9.7922,2.5507 L 9.6656,2.2981 L 9.5519,2.1151 L 9.4511,1.9823 L 9.3498,1.8877 Z","a":[9.26,7.937]},"B214":{"d":"M 6.9451,15.0278 L 6.9342,16.0246 L 6.8692,16.1059 L 6.8638,16.4688 L 6.8963,16.5501 L 6.8801,17.4765 L 6.9288,16.5284 L 6.9613,16.4472 L 6.9776,16.0409 L 6.9505,15.9975 Z M 7.3334,4.6023 L 7.1711,4.6116 L 6.9510,4.6421 L 6.7216,4.7522 L 6.5262,4.9418 L 6.4373,5.1253 L 6.3795,5.4126 L 6.3304,5.8410 L 6.2999,6.3515 L 6.2792,6.7427 L 6.2301,6.8280 L 6.1572,6.7551 L 6.1572,5.8730 L 6.1056,5.8213 L 6.0585,5.8684 L 6.0585,9.0243 L 6.1175,9.0832 L 6.1516,9.0243 L 6.1516,8.7752 L 6.2141,8.7126 L 6.3366,8.7126 L 6.4983,9.0367 L 6.6420,9.3178 L 6.7949,9.5932 L 6.9298,9.7705 L 6.9298,10.0702 L 6.8993,10.1069 L 6.9112,10.4588 L 6.9665,10.4769 L 7.0936,13.2323 L 5.9469,13.2323 L 5.9469,13.7568 L 7.1179,13.7568 L 7.1804,15.1102 L 7.2171,15.1345 L 7.2311,16.1608 L 7.1618,16.2295 L 6.9329,16.2295 L 6.9329,16.2750 L 7.1618,16.2750 L 7.2538,16.3396 L 7.2750,16.4223 L 7.3148,16.4223 L 7.3365,16.3639 L 7.3515,16.1680 L 7.3794,15.1252 L 7.4161,15.0978 L 7.4936,13.7769 L 8.6858,13.7769 L 8.6858,13.2416 L 7.5251,13.2416 L 7.6879,10.4619 L 7.7644,10.4681 L 7.7892,10.0702 L 7.6941,10.0304 L 7.6848,9.8500 L 7.7401,9.7767 L 7.8776,9.5689 L 8.0522,9.2723 L 8.1866,8.9938 L 8.3091,8.7095 L 8.4005,8.7095 L 8.4558,8.7643 L 8.4558,9.0243 L 8.5168,9.0764 L 8.5628,9.0367 L 8.5871,5.9051 L 8.5354,5.8715 L 8.4832,5.9051 L 8.4832,6.7613 L 8.4341,6.8135 L 8.3824,6.7216 L 8.3700,6.1221 L 8.3364,5.7123 L 8.2780,5.3516 L 8.1742,5.0002 L 8.0093,4.8168 L 7.8073,4.6819 L 7.5716,4.6147 Z M 6.1727,8.1122 L 6.1924,8.1902 L 6.2451,8.4207 L 6.3128,8.6310 L 6.2193,8.6429 L 6.1727,8.6160 Z M 8.4605,8.1649 L 8.4636,8.6031 L 8.4238,8.6382 L 8.3282,8.6315 L 8.3954,8.4253 Z M 6.0232,8.3267 L 5.9738,8.2830 L 6.0145,8.2307 L 6.0698,8.2714 L 6.9510,8.1987 L 7.0005,8.1638 L 7.1750,8.1522 L 7.2506,8.0795 L 7.1779,8.0271 L 7.1546,7.5879 L 7.0993,7.5530 L 6.6456,1.5909 L 6.6863,1.5443 L 6.7736,1.5385 L 6.8289,1.5734 L 7.1779,1.5705 L 7.6461,7.5472 L 7.3669,7.5676 L 7.4483,7.7886 L 7.4542,8.0242 L 7.4076,8.0591 L 7.4745,8.1260 L 7.6781,8.1056 L 7.7275,8.1405 L 8.5681,8.0678 L 8.6059,8.0242 L 8.6524,8.0707 L 8.6088,8.1173 L 8.5681,8.0911 L 7.7217,8.1725 L 7.6723,8.2132 L 7.4920,8.2394 L 7.4542,8.3179 L 7.5356,8.3732 L 7.5501,8.7367 L 7.5938,8.7949 L 8.0009,14.8211 L 7.9602,14.8850 L 7.8904,14.8908 L 7.8206,14.8385 L 7.5094,14.8559 L 7.4745,14.8065 L 7.0732,8.7920 L 7.3436,8.7804 L 7.2593,8.6262 L 7.2506,8.3848 L 7.2855,8.3325 L 7.1953,8.2656 L 6.9801,8.2801 L 6.9248,8.2365 L 6.0698,8.3005 Z","a":[9.26,6.35]},"AJ27":{"d":"M 9.2601,0.5137 L 9.1816,0.5362 L 8.9930,0.7202 L 8.8090,1.0091 L 8.6726,1.2923 L 8.5574,1.6705 L 8.4731,2.0535 L 8.4153,2.4943 L 8.3889,3.1666 L 8.3889,7.3922 L 8.3315,7.5968 L 2.4678,10.6416 L 2.3262,10.7832 L 2.2156,10.9775 L 2.1841,11.1666 L 2.1371,11.3082 L 2.0844,11.4343 L 2.0792,11.7542 L 2.1319,11.6022 L 2.2632,11.4606 L 2.3841,11.3924 L 2.4678,11.3661 L 6.5415,10.1429 L 8.3946,10.1584 L 8.3837,11.3185 L 8.1372,11.3185 L 8.0954,11.2503 L 7.3497,11.2503 L 7.2551,11.3609 L 7.2133,11.4813 L 7.2133,12.0224 L 7.2711,12.5154 L 7.3445,12.6311 L 7.4288,12.7148 L 7.4443,12.8776 L 7.4970,13.0037 L 7.6019,13.1298 L 7.7538,13.5391 L 7.9062,13.1138 L 8.0163,13.0352 L 8.0215,13.1561 L 8.2158,13.2559 L 8.5150,13.3448 L 8.5202,13.6497 L 8.5780,13.9959 L 8.6359,14.2687 L 8.6938,14.5473 L 8.7408,14.7783 L 8.7987,15.0144 L 8.8509,15.2191 L 8.9667,15.6077 L 6.5363,17.3187 L 6.5363,17.9646 L 9.1661,17.1404 L 9.2028,17.5342 L 9.2607,17.6494 L 9.3181,17.5342 L 9.3553,17.1404 L 11.9851,17.9646 L 11.9851,17.3187 L 9.5547,15.6077 L 9.6700,15.2191 L 9.7227,15.0144 L 9.7800,14.7783 L 9.8276,14.5473 L 9.8855,14.2687 L 9.9428,13.9959 L 10.0007,13.6497 L 10.0059,13.3448 L 10.3051,13.2559 L 10.4994,13.1561 L 10.5046,13.0352 L 10.6152,13.1138 L 10.7671,13.5391 L 10.9196,13.1298 L 11.0245,13.0037 L 11.0767,12.8776 L 11.0927,12.7148 L 11.1764,12.6311 L 11.2503,12.5154 L 11.3077,12.0224 L 11.3077,11.4813 L 11.2658,11.3609 L 11.1712,11.2503 L 10.4261,11.2503 L 10.3842,11.3185 L 10.1371,11.3185 L 10.1268,10.1584 L 11.9799,10.1429 L 16.0530,11.3661 L 16.1373,11.3924 L 16.2582,11.4606 L 16.3894,11.6022 L 16.4416,11.7542 L 16.4364,11.4343 L 16.3837,11.3082 L 16.3367,11.1666 L 16.3052,10.9775 L 16.1951,10.7832 L 16.0530,10.6416 L 10.1898,7.5968 L 10.1319,7.3922 L 10.1319,3.1666 L 10.1056,2.4943 L 10.0482,2.0535 L 9.9640,1.6705 L 9.8482,1.2923 L 9.7118,1.0091 L 9.5284,0.7202 L 9.3392,0.5362 Z","a":[9.26,8.731]},"A748":{"d":"M 6.1064,6.1724 L 6.8577,6.1318 L 6.8729,6.0963 L 7.1216,6.0912 L 7.1368,6.1216 L 7.8678,6.1724 L 7.1521,6.1978 L 7.1165,6.2333 L 6.8475,6.2384 L 6.8120,6.1978 Z M 10.6445,6.1724 L 11.3957,6.1318 L 11.4109,6.0963 L 11.6597,6.0912 L 11.6749,6.1216 L 12.4058,6.1724 L 11.6901,6.1978 L 11.6546,6.2333 L 11.3856,6.2384 L 11.3500,6.1978 Z M 9.2604,3.4220 L 9.1845,3.4380 L 9.0485,3.5502 L 8.9411,3.6618 L 8.7969,3.9253 L 8.6811,4.2328 L 8.6372,4.3847 L 8.5695,4.6958 L 8.5137,5.0157 L 8.4775,5.2591 L 8.4455,5.6503 L 8.4455,7.7308 L 7.2998,7.8186 L 7.2998,7.1841 L 7.3158,7.0802 L 7.3236,6.9484 L 7.3195,6.8084 L 7.2915,6.6967 L 7.2874,6.5608 L 7.2559,6.4249 L 7.2435,6.3572 L 7.2078,6.3056 L 7.1479,6.3056 L 7.1319,6.1056 L 7.0962,5.9459 L 7.0481,5.8420 L 7.0001,5.8100 L 6.9443,5.8503 L 6.9004,5.9340 L 6.8606,6.0616 L 6.8404,6.2332 L 6.8363,6.3056 L 6.7965,6.2973 L 6.7727,6.3335 L 6.7365,6.4089 L 6.6885,6.5727 L 6.6807,6.7887 L 6.6688,7.0084 L 6.6849,7.2238 L 6.6926,7.4233 L 6.6885,7.8708 L 0.6868,8.3659 L 0.6108,8.3778 L 0.5633,8.4140 L 0.5033,8.5137 L 0.4832,8.6294 L 0.5152,9.2563 L 4.0452,9.5121 L 4.0613,9.5400 L 4.0928,9.5519 L 4.1527,9.5477 L 4.1967,9.5157 L 4.2328,9.5038 L 5.4705,9.6036 L 5.4906,9.6278 L 5.5387,9.6439 L 5.5904,9.6315 L 5.6265,9.5999 L 7.1277,9.7033 L 7.1277,9.7596 L 7.1680,9.7632 L 7.2559,9.7632 L 7.2998,9.7116 L 8.1380,9.7834 L 8.1742,9.8035 L 8.2502,9.8035 L 8.4455,10.0071 L 8.4419,11.7523 L 8.4656,12.3548 L 8.5013,12.9382 L 8.5375,13.1858 L 8.5736,13.4374 L 8.5974,13.5930 L 6.1934,14.1082 L 6.1216,14.1402 L 6.0699,14.2038 L 6.0699,14.3635 L 6.0699,14.6632 L 6.0777,14.7748 L 6.0937,14.8348 L 6.1418,14.8668 L 6.2094,14.8668 L 9.0046,15.1185 L 9.0485,15.2420 L 9.1126,15.3660 L 9.1762,15.5055 L 9.2644,15.6094 L 9.3441,15.5055 L 9.4082,15.3660 L 9.4718,15.2420 L 9.5157,15.1185 L 12.3114,14.8668 L 12.3791,14.8668 L 12.4272,14.8348 L 12.4432,14.7748 L 12.4510,14.6632 L 12.4510,14.3635 L 12.4510,14.2038 L 12.3993,14.1402 L 12.3275,14.1082 L 9.9235,13.5930 L 9.9472,13.4374 L 9.9834,13.1858 L 10.0191,12.9382 L 10.0552,12.3548 L 10.0790,11.7523 L 10.0749,10.0071 L 10.2708,9.8035 L 10.3467,9.8035 L 10.3824,9.7834 L 11.2211,9.7116 L 11.2650,9.7632 L 11.3529,9.7632 L 11.3927,9.7596 L 11.3927,9.7038 L 12.8944,9.5999 L 12.9300,9.6315 L 12.9822,9.6439 L 13.0303,9.6278 L 13.0499,9.6036 L 14.2881,9.5038 L 14.3238,9.5157 L 14.3677,9.5477 L 14.4276,9.5519 L 14.4597,9.5400 L 14.4757,9.5121 L 18.0057,9.2563 L 18.0378,8.6294 L 18.0176,8.5137 L 17.9577,8.4140 L 17.9096,8.3778 L 17.8342,8.3659 L 11.8319,7.8708 L 11.8283,7.4233 L 11.8361,7.2238 L 11.8522,7.0084 L 11.8403,6.7887 L 11.8320,6.5727 L 11.7844,6.4089 L 11.7483,6.3335 L 11.7245,6.2973 L 11.6842,6.3056 L 11.6806,6.2332 L 11.6604,6.0616 L 11.6206,5.9340 L 11.5767,5.8503 L 11.5209,5.8100 L 11.4728,5.8420 L 11.4248,5.9459 L 11.3886,6.1056 L 11.3731,6.3056 L 11.3132,6.3056 L 11.2770,6.3572 L 11.2651,6.4249 L 11.2331,6.5608 L 11.2290,6.6967 L 11.2011,6.8084 L 11.1975,6.9484 L 11.2053,7.0802 L 11.2213,7.1841 L 11.2213,7.8186 L 10.0751,7.7308 L 10.0751,5.6503 L 10.0428,5.2591 L 10.0071,5.0157 L 9.9513,4.6958 L 9.8831,4.3847 L 9.8392,4.2328 L 9.7234,3.9253 L 9.5798,3.6618 L 9.4718,3.5502 L 9.3364,3.4380 Z","a":[9.26,8.731]},"C441":{"d":"M 9.2605,2.8506 L 9.2160,2.8560 L 9.0877,2.9229 L 8.9594,3.0959 L 8.8423,3.2911 L 8.7586,3.4975 L 8.6861,3.7876 L 8.6470,4.0945 L 8.5745,4.5854 L 8.5075,5.1098 L 8.4797,5.5449 L 8.4294,6.3873 L 8.3904,7.2520 L 8.3346,7.2910 L 7.0515,7.2910 L 6.9343,7.2353 L 6.9232,6.4152 L 6.9065,5.9187 L 6.8507,5.4947 L 6.7558,5.1432 L 6.6722,5.0093 L 6.5996,4.9480 L 6.5773,4.9426 L 6.4881,4.9928 L 6.3821,5.1379 L 6.3263,5.3108 L 6.2928,5.4893 L 6.2482,5.7236 L 6.2147,6.0416 L 6.1924,6.9788 L 6.1868,7.1908 L 6.0864,7.2521 L 3.6206,7.3581 L 1.5900,7.4362 L 1.2106,7.4696 L 1.1604,7.8713 L 1.1493,8.6188 L 1.5956,8.6914 L 2.1088,8.7528 L 5.9302,9.1991 L 6.1756,9.2045 L 6.2147,9.2435 L 6.4211,9.2658 L 6.5662,9.2712 L 6.7335,9.2600 L 6.9009,9.2433 L 6.9734,9.1931 L 8.2174,9.2042 L 8.3625,9.3381 L 8.3792,10.1024 L 8.4238,10.4929 L 8.4740,11.0731 L 8.5187,11.2962 L 8.5689,11.4971 L 8.8757,13.2209 L 6.1812,13.5389 L 6.0808,13.5724 L 6.0362,13.6338 L 6.0362,13.7844 L 6.0417,14.2084 L 6.0808,14.3646 L 7.3304,14.4650 L 8.7697,14.5710 L 8.8701,14.5764 L 8.8813,14.6043 L 9.1658,14.6154 L 9.1658,15.3239 L 9.2616,15.6439 L 9.3551,15.3239 L 9.3551,14.6155 L 9.6396,14.6043 L 9.6508,14.5764 L 9.7511,14.5710 L 11.1905,14.4650 L 12.4401,14.3646 L 12.4791,14.2084 L 12.4846,13.7845 L 12.4846,13.6338 L 12.4400,13.5724 L 12.3396,13.5389 L 9.6451,13.2209 L 9.9519,11.4971 L 10.0022,11.2963 L 10.0468,11.0731 L 10.0970,10.4930 L 10.1416,10.1025 L 10.1583,9.3382 L 10.3034,9.2043 L 11.5474,9.1932 L 11.6200,9.2433 L 11.7873,9.2601 L 11.9547,9.2712 L 12.0997,9.2658 L 12.3061,9.2435 L 12.3452,9.2045 L 12.5906,9.1991 L 16.4121,8.7528 L 16.9253,8.6914 L 17.3716,8.6189 L 17.3604,7.8713 L 17.3102,7.4696 L 16.9309,7.4362 L 14.9002,7.3582 L 12.4344,7.2522 L 12.3340,7.1909 L 12.3284,6.9788 L 12.3061,6.0416 L 12.2727,5.7237 L 12.2280,5.4894 L 12.1946,5.3109 L 12.1388,5.1379 L 12.0328,4.9929 L 11.9435,4.9427 L 11.9212,4.9481 L 11.8487,5.0094 L 11.7650,5.1433 L 11.6702,5.4947 L 11.6144,5.9187 L 11.5976,6.4152 L 11.5865,7.2353 L 11.4693,7.2911 L 10.1863,7.2911 L 10.1305,7.2520 L 10.0914,6.3873 L 10.0412,5.5449 L 10.0133,5.1098 L 9.9464,4.5854 L 9.8738,4.0945 L 9.8348,3.7877 L 9.7623,3.4976 L 9.6786,3.2912 L 9.5615,3.0959 L 9.4331,2.9230 L 9.3048,2.8560 Z","a":[9.26,8.202]},"SR22":{"d":"M 9.2301,4.0810 L 9.1126,4.1517 L 9.0289,4.3429 L 8.9870,4.5041 L 8.9514,4.7010 L 8.7664,4.7728 L 8.6346,4.8204 L 8.5514,4.8865 L 8.4853,5.0297 L 8.4078,5.3402 L 8.3240,6.3795 L 8.3240,7.3536 L 8.2703,7.5086 L 4.3997,7.6522 L 4.3517,7.5923 L 1.0723,7.7416 L 0.9472,7.8011 L 0.8155,8.0047 L 0.7261,8.2434 L 0.6780,8.4284 L 0.6186,8.4646 L 0.5824,8.6315 L 0.6305,8.6971 L 0.6124,8.8646 L 0.6604,8.9183 L 1.2335,8.9002 L 1.8309,8.9721 L 8.1747,9.6650 L 8.2584,9.7126 L 8.1452,9.8325 L 7.9835,9.8263 L 7.9778,9.9400 L 8.1571,9.9456 L 8.3184,9.7668 L 8.3778,9.8025 L 8.4558,10.2386 L 8.6052,10.8955 L 8.8796,12.1620 L 9.0708,13.1594 L 9.0889,13.4281 L 6.5500,13.7449 L 6.4782,13.7806 L 6.4125,13.9242 L 6.3707,14.1810 L 6.3650,14.4735 L 9.1364,14.5991 L 9.1426,14.7960 L 9.1664,15.3277 L 9.2351,15.5965 L 9.2945,15.3277 L 9.3188,14.7960 L 9.3245,14.5991 L 12.0964,14.4735 L 12.0902,14.1810 L 12.0484,13.9242 L 11.9827,13.7806 L 11.9109,13.7449 L 9.3726,13.4281 L 9.3901,13.1594 L 9.5813,12.1620 L 9.8562,10.8955 L 10.0056,10.2386 L 10.0831,9.8025 L 10.1431,9.7668 L 10.3043,9.9456 L 10.4836,9.9400 L 10.4774,9.8263 L 10.3162,9.8325 L 10.2025,9.7126 L 10.2862,9.6650 L 16.6300,8.9721 L 17.2274,8.9002 L 17.8010,8.9183 L 17.8485,8.8646 L 17.8310,8.6971 L 17.8785,8.6315 L 17.8428,8.4646 L 17.7829,8.4284 L 17.7354,8.2434 L 17.6454,8.0047 L 17.5142,7.8011 L 17.3886,7.7416 L 14.1092,7.5923 L 14.0617,7.6522 L 10.1906,7.5086 L 10.1368,7.3536 L 10.1368,6.3795 L 10.0531,5.3402 L 9.9756,5.0297 L 9.9100,4.8865 L 9.8263,4.8204 L 9.6950,4.7728 L 9.5095,4.7010 L 9.4738,4.5041 L 9.4320,4.3429 L 9.3483,4.1517 Z","a":[9.26,7.673]},"SW3":{"d":"M 9.2604,1.8289 C 9.2030,1.8289 9.0003,2.0234 8.7800,2.6923 C 8.3700,3.9373 8.3175,4.7139 8.3175,6.4966 L 8.3175,7.0689 L 7.0106,7.1487 C 7.0283,6.9538 7.0417,6.7324 7.0417,6.4402 C 7.0417,5.6831 6.9265,5.0366 6.8468,4.8285 C 6.9973,4.8816 7.6438,4.8772 7.9095,4.8772 C 8.0512,4.8772 8.0556,4.6868 7.9095,4.6868 L 6.8070,4.7178 C 6.7627,4.5894 6.6909,4.3987 6.6316,4.3987 C 6.5767,4.3987 6.5103,4.5850 6.4660,4.7178 L 5.3193,4.6824 C 5.1732,4.6824 5.1687,4.8639 5.3104,4.8639 C 5.4875,4.8639 6.2845,4.8861 6.4306,4.8197 C 6.3642,5.0543 6.2048,5.6831 6.2048,6.4447 C 6.2048,6.6926 6.1915,7.0025 6.2048,7.2018 L 1.3697,7.5028 C 1.2900,7.5117 1.1882,7.6003 1.1970,7.6888 L 1.2679,8.6895 L 8.1220,9.8186 C 8.1751,10.0223 8.3213,10.7616 8.3213,11.0096 C 8.3213,12.0280 8.5348,13.1539 8.6312,13.3209 L 6.8026,14.9149 C 6.6564,15.0433 6.5662,15.3498 6.5662,15.6194 L 6.5662,16.0262 L 9.0073,15.3178 L 9.0073,15.4152 C 9.0073,15.4464 9.0538,15.4749 9.1503,15.4749 C 9.1590,16.0121 9.2292,16.6920 9.2599,16.6920 C 9.2906,16.6920 9.3608,16.0121 9.3696,15.4749 C 9.4661,15.4749 9.5135,15.4464 9.5135,15.4152 L 9.5135,15.3178 L 11.9546,16.0262 L 11.9546,15.6194 C 11.9546,15.3498 11.8644,15.0433 11.7183,14.9149 L 9.8897,13.3209 C 9.9861,13.1539 10.1996,12.0280 10.1996,11.0096 C 10.1996,10.7616 10.3457,10.0223 10.3988,9.8186 L 17.2530,8.6895 L 17.3238,7.6888 C 17.3327,7.6003 17.2308,7.5117 17.1511,7.5028 L 12.3161,7.2018 C 12.3293,7.0025 12.3161,6.6926 12.3161,6.4447 C 12.3161,5.6831 12.1566,5.0543 12.0902,4.8197 C 12.2363,4.8861 13.0333,4.8639 13.2104,4.8639 C 13.3521,4.8639 13.3477,4.6824 13.2016,4.6824 L 12.0548,4.7178 C 12.0105,4.5850 11.9441,4.3987 11.8893,4.3987 C 11.8300,4.3987 11.7582,4.5894 11.7139,4.7178 L 10.6114,4.6868 C 10.4653,4.6868 10.4697,4.8772 10.6114,4.8772 C 10.8771,4.8772 11.5235,4.8816 11.6741,4.8285 C 11.5944,5.0366 11.4792,5.6831 11.4792,6.4402 C 11.4792,6.7324 11.4925,6.9538 11.5102,7.1487 L 10.2033,7.0689 L 10.2033,6.4966 C 10.2033,4.7139 10.1509,3.9373 9.7409,2.6923 C 9.5205,2.0234 9.3179,1.8289 9.2604,1.8289 Z","a":[9.26,8.202]},"AT25":{"d":"M 9.2405,0.9095 L 9.1695,0.9229 L 8.9953,1.0589 L 8.8971,1.1953 L 8.7685,1.3994 L 8.6320,1.7095 L 8.5338,1.9973 L 8.4584,2.3601 L 8.4279,2.7006 L 8.3902,3.0639 L 8.3556,7.1112 L 8.2770,7.2228 L 8.2326,7.3685 L 8.1762,7.6032 L 8.1654,7.7597 L 7.0585,7.7597 L 7.1143,7.4466 L 7.1029,7.0776 L 7.0693,6.7867 L 7.0135,6.5298 L 6.9128,6.3397 L 6.8290,6.2792 L 6.7334,6.3448 L 6.6384,6.5154 L 6.5479,6.7965 L 6.5179,7.0523 L 6.5128,7.4492 L 6.4978,7.7551 L 1.3276,8.1215 L 1.2273,8.1468 L 1.1519,8.1969 L 1.1167,8.2873 L 1.1069,8.3323 L 1.0216,8.3473 L 0.9710,8.4078 L 0.9462,8.7638 L 0.8811,8.8144 L 0.8005,8.8744 L 0.8056,8.9550 L 0.8408,9.0403 L 1.0263,9.0449 L 6.3924,9.4315 L 8.1892,9.4315 L 8.2041,9.7276 L 8.2496,10.1141 L 8.3649,10.4758 L 8.3649,12.7946 L 8.3902,13.2416 L 8.4455,13.6328 L 8.5555,14.4058 L 8.8568,16.2579 L 7.2006,16.5742 L 7.0952,16.6197 L 6.9944,16.7199 L 6.9944,17.3224 L 7.0399,17.3726 L 9.0878,17.4826 L 9.0878,17.6739 L 9.2383,17.8043 L 9.3865,17.6739 L 9.3865,17.4826 L 11.4344,17.3726 L 11.4794,17.3224 L 11.4794,16.7199 L 11.3791,16.6197 L 11.2737,16.5742 L 9.6175,16.2579 L 9.9183,14.4058 L 10.0288,13.6328 L 10.0841,13.2416 L 10.1095,12.7946 L 10.1095,10.4758 L 10.2247,10.1141 L 10.2697,9.7276 L 10.2852,9.4315 L 12.0819,9.4315 L 17.4475,9.0449 L 17.6335,9.0403 L 17.6687,8.9550 L 17.6739,8.8744 L 17.5933,8.8144 L 17.5282,8.7638 L 17.5028,8.4078 L 17.4527,8.3473 L 17.3674,8.3323 L 17.3576,8.2873 L 17.3225,8.1969 L 17.2470,8.1468 L 17.1468,8.1215 L 11.9766,7.7551 L 11.9616,7.4492 L 11.9564,7.0523 L 11.9264,6.7965 L 11.8360,6.5154 L 11.7404,6.3448 L 11.6453,6.2792 L 11.5611,6.3397 L 11.4608,6.5298 L 11.4045,6.7867 L 11.3709,7.0776 L 11.3600,7.4466 L 11.4158,7.7597 L 10.3089,7.7597 L 10.2976,7.6032 L 10.2418,7.3685 L 10.1973,7.2228 L 10.1188,7.1112 L 10.0841,3.0639 L 10.0464,2.7006 L 10.0159,2.3601 L 9.9405,1.9973 L 9.8418,1.7095 L 9.7059,1.3994 L 9.5772,1.1953 L 9.4790,1.0589 L 9.3049,0.9229 Z","a":[9.26,8.467]},"F100":{"d":"M 9.2672,1.4583 C 8.8356,1.4402 8.5880,3.0038 8.5880,3.0038 L 8.5880,7.6361 L 6.9698,8.4118 L 3.6645,9.6260 C 3.4622,9.7272 3.4622,9.8284 3.4622,9.8284 L 3.3272,10.3680 L 5.7219,10.1657 L 5.7556,10.5029 L 5.8231,10.1657 L 6.9699,10.0982 L 7.0710,10.5704 L 7.1722,10.0645 L 8.4539,9.9633 C 8.4539,10.2331 8.5888,10.5029 8.5888,10.5029 L 8.5888,11.4136 L 8.4876,11.4136 L 8.4876,11.2450 C 8.3864,11.0763 8.0829,11.0763 8.0829,11.0763 C 7.8130,11.0763 7.8130,11.1775 7.8130,11.1775 L 7.8130,11.9532 C 7.8130,12.5941 7.9142,13.2012 7.9142,13.2012 C 8.0154,13.2686 8.1841,13.2686 8.1841,13.2686 C 8.3527,13.2686 8.3864,13.2012 8.3864,13.2012 L 8.7237,13.5047 C 8.9261,14.6177 9.1622,15.2248 9.1622,15.2248 L 7.3071,16.3716 C 7.1048,16.5402 7.1048,16.8100 7.1048,16.8100 L 7.1048,17.0461 L 9.1622,16.5739 C 9.1622,16.8100 9.2633,16.9449 9.2633,16.9449 C 9.3308,16.8775 9.3983,16.5739 9.3983,16.5739 L 11.4219,17.0461 L 11.4219,16.7763 C 11.4219,16.5065 11.2195,16.3716 11.2195,16.3716 L 9.3645,15.2248 C 9.6343,14.6515 9.8030,13.5047 9.8030,13.5047 L 10.1740,13.2012 C 10.2414,13.2686 10.3764,13.2686 10.3764,13.2686 C 10.5450,13.2686 10.6125,13.2012 10.6125,13.2012 C 10.6799,12.7627 10.7136,11.9195 10.7136,11.9195 C 10.7474,11.5822 10.7136,11.1100 10.7136,11.1100 C 10.5787,11.0763 10.4438,11.0763 10.4438,11.0763 C 10.2077,11.0763 10.0728,11.1775 10.0728,11.1775 C 10.0391,11.2450 10.0391,11.4136 10.0391,11.4136 L 9.9716,11.4136 L 9.9716,10.3006 C 10.0391,10.2331 10.0391,9.9633 10.0391,9.9633 L 11.3882,10.0645 C 11.3882,10.2669 11.4894,10.5704 11.4894,10.5704 C 11.5231,10.4692 11.5568,10.0982 11.5568,10.0982 L 12.7036,10.1657 C 12.7036,10.2668 12.7710,10.5029 12.7710,10.5029 C 12.8048,10.3680 12.8048,10.1657 12.8048,10.1657 L 15.1994,10.3680 L 15.1320,9.9970 C 15.0645,9.6597 14.8621,9.6260 14.8621,9.6260 L 11.5906,8.4118 L 9.9716,7.6024 L 9.9716,3.0154 C 9.7018,1.3964 9.2672,1.4583 9.2672,1.4583 Z","a":[9.26,8.731]},"AT75":{"d":"M 9.2072,1.2004 L 9.1416,1.2149 L 8.9653,1.3436 L 8.7297,1.6629 L 8.5121,2.1404 L 8.3954,2.6505 L 8.3597,3.0954 L 8.3509,7.2559 L 8.2879,7.3727 L 8.1359,7.7696 L 8.1101,7.8140 L 8.0755,7.8212 L 7.0337,7.8212 L 7.0554,7.5928 L 7.0616,7.3112 L 7.0461,7.0611 L 7.0089,6.8476 L 6.9257,6.7086 L 6.9164,6.5970 L 6.8792,6.4332 L 6.8389,6.3438 L 6.7861,6.3066 L 6.7309,6.2911 L 6.6781,6.3128 L 6.6378,6.3531 L 6.5975,6.4394 L 6.5639,6.5908 L 6.5577,6.6869 L 6.4957,6.8228 L 6.4523,6.9960 L 6.4368,7.2714 L 6.4337,7.5122 L 6.4554,7.6667 L 6.4864,7.8336 L 1.2800,8.2171 L 1.2278,8.2419 L 1.1782,8.2977 L 1.1534,8.3747 L 1.1379,8.4491 L 1.0795,8.4615 L 1.0485,8.5111 L 1.0206,8.6191 L 1.0144,8.8139 L 1.0299,9.1540 L 6.3102,9.4134 L 8.2114,9.4134 L 8.2641,9.5436 L 8.3478,9.6826 L 8.3478,11.8623 L 8.3540,12.2421 L 8.3721,12.6411 L 8.4062,13.1144 L 8.4713,13.6431 L 8.6320,14.5950 L 8.8796,16.0016 L 7.2781,16.2832 L 7.2037,16.3323 L 7.1324,16.4347 L 7.0926,16.5892 L 7.0709,16.7902 L 7.0740,17.0434 L 8.9535,17.1488 L 9.0496,17.0284 L 9.0651,17.1519 L 9.1049,17.2847 L 9.1607,17.3591 L 9.2320,17.3958 L 9.3121,17.3498 L 9.3674,17.2759 L 9.4077,17.1426 L 9.4232,17.0191 L 9.5188,17.1395 L 11.3988,17.0346 L 11.4019,16.7809 L 11.3802,16.5799 L 11.3399,16.4253 L 11.2691,16.3235 L 11.1947,16.2739 L 9.5932,15.9928 L 9.8407,14.5862 L 10.0015,13.6338 L 10.0661,13.1051 L 10.1002,12.6323 L 10.1188,12.2334 L 10.1250,11.8530 L 10.1250,9.6733 L 10.2087,9.5343 L 10.2609,9.4046 L 12.1626,9.4046 L 17.4429,9.1447 L 17.4584,8.8046 L 17.4522,8.6098 L 17.4243,8.5018 L 17.3933,8.4522 L 17.3343,8.4398 L 17.3188,8.3659 L 17.2946,8.2884 L 17.2449,8.2331 L 17.1922,8.2083 L 11.9858,7.8248 L 12.0168,7.6579 L 12.0385,7.5034 L 12.0354,7.2621 L 12.0199,6.9872 L 11.9771,6.8141 L 11.9150,6.6776 L 11.9088,6.5820 L 11.8747,6.4306 L 11.8344,6.3438 L 11.7946,6.3035 L 11.7419,6.2823 L 11.6861,6.2973 L 11.6334,6.3345 L 11.5936,6.4244 L 11.5564,6.5882 L 11.5471,6.6993 L 11.4634,6.8383 L 11.4267,7.0518 L 11.4112,7.3024 L 11.4174,7.5835 L 11.4386,7.8124 L 10.3968,7.8124 L 10.3622,7.8047 L 10.3368,7.7603 L 10.1844,7.3634 L 10.1219,7.2471 L 10.1126,3.0866 L 10.0769,2.6417 L 9.9606,2.1311 L 9.7426,1.6536 L 9.5069,1.3343 L 9.3307,1.2061 L 9.2728,1.2035 Z M 11.9164,6.6050 L 12.9311,6.6766 L 12.9311,6.4976 Z","a":[9.26,7.673]},"DHC5":{"d":"M 9.2554,2.5211 L 9.1069,2.5554 L 9.0057,2.6412 L 8.9276,2.8122 L 8.9044,3.0618 L 8.8031,3.2096 L 8.6780,3.4902 L 8.5690,3.9109 L 8.4755,4.4721 L 8.4134,5.0328 L 8.3979,5.3056 L 8.3979,6.8094 L 6.9407,6.8094 L 6.9174,6.6223 L 6.8942,6.5443 L 6.8942,5.8353 L 6.6058,4.9547 L 6.4968,4.9547 L 6.2322,5.8120 L 6.2322,6.5676 L 6.1309,6.7934 L 1.0511,7.1985 L 0.8950,7.2611 L 0.7705,7.4249 L 0.7627,7.6739 L 0.8175,7.9075 L 0.9963,8.2584 L 6.2554,8.9281 L 6.4032,8.9436 L 6.4265,9.2475 L 6.4813,9.3803 L 6.6135,9.3726 L 6.6838,9.2165 L 6.7464,8.8971 L 8.3742,8.8971 L 8.3742,12.1925 L 8.4212,12.8080 L 8.4837,13.3377 L 8.5690,13.9454 L 8.7561,14.9583 L 6.5748,15.2079 L 6.4580,15.2699 L 6.4110,16.0176 L 6.4890,16.2905 L 6.5980,16.3530 L 9.2865,16.5711 L 11.9197,16.3530 L 12.0292,16.2905 L 12.1067,16.0176 L 12.0602,15.2699 L 11.9435,15.2079 L 9.7617,14.9583 L 9.9487,13.9454 L 10.0345,13.3377 L 10.0971,12.8080 L 10.1436,12.1925 L 10.1436,8.8971 L 11.7719,8.8971 L 11.8344,9.2165 L 11.9042,9.3726 L 12.0370,9.3803 L 12.0912,9.2475 L 12.1145,8.9436 L 12.2628,8.9281 L 17.5214,8.2584 L 17.7007,7.9075 L 17.7550,7.6739 L 17.7472,7.4249 L 17.6226,7.2611 L 17.4671,7.1985 L 12.3873,6.7934 L 12.2860,6.5676 L 12.2860,5.8120 L 12.0209,4.9547 L 11.9119,4.9547 L 11.6240,5.8353 L 11.6240,6.5443 L 11.6003,6.6223 L 11.5770,6.8094 L 10.1203,6.8094 L 10.1203,5.3056 L 10.1048,5.0328 L 10.0423,4.4721 L 9.9487,3.9109 L 9.8397,3.4902 L 9.7152,3.2096 L 9.6139,3.0618 L 9.5906,2.8122 L 9.5126,2.6412 L 9.4113,2.5554 Z","a":[9.26,7.673]},"CT4":{"d":"M 9.2541,2.8030 L 9.1147,2.8773 L 9.0408,3.0561 L 8.9664,3.3331 L 8.9483,3.5429 L 8.7633,3.5734 L 8.5783,3.6106 L 8.5044,3.7031 L 8.4553,4.0788 L 8.4119,4.5904 L 8.3690,5.0648 L 8.3442,5.4715 L 8.3013,5.9888 L 8.1902,6.0503 L 6.4833,6.8208 L 5.9660,6.8389 L 1.7069,7.1701 L 1.5922,7.2058 L 1.4919,7.3132 L 1.4056,7.4853 L 1.3627,7.7644 L 1.3415,8.8031 L 1.4490,8.8749 L 3.4473,9.2186 L 3.4830,9.2899 L 3.8556,9.3617 L 3.9202,9.2971 L 8.2605,10.0133 L 8.3395,10.5291 L 8.8982,14.0818 L 8.8982,14.2539 L 6.1045,14.4834 L 5.9542,14.5402 L 5.8467,14.6839 L 5.7609,14.9055 L 5.7392,16.0373 L 5.7965,16.0946 L 9.2759,16.0807 L 12.7140,16.0946 L 12.7713,16.0373 L 12.7496,14.9055 L 12.6638,14.6839 L 12.5563,14.5402 L 12.4060,14.4834 L 9.6123,14.2539 L 9.6123,14.0818 L 10.1710,10.5291 L 10.2500,10.0133 L 14.5903,9.2971 L 14.6549,9.3617 L 15.0275,9.2899 L 15.0632,9.2186 L 17.0615,8.8749 L 17.1690,8.8031 L 17.1478,7.7644 L 17.1049,7.4853 L 17.0186,7.3132 L 16.9183,7.2058 L 16.8036,7.1701 L 12.5445,6.8389 L 12.0272,6.8208 L 10.3203,6.0503 L 10.2092,5.9888 L 10.1663,5.4715 L 10.1415,5.0648 L 10.0986,4.5904 L 10.0552,4.0788 L 10.0061,3.7031 L 9.9322,3.6106 L 9.7472,3.5734 L 9.5622,3.5429 L 9.5441,3.3331 L 9.4702,3.0561 L 9.3963,2.8773 Z","a":[9.26,7.408]},"A109":{"d":"M 9.0247,3.7575 L 8.8804,3.7950 L 8.7473,3.8675 L 8.5628,4.0669 L 8.4703,4.2220 L 8.3752,4.4571 L 8.2770,4.7904 L 8.2114,5.1475 L 8.1576,5.5108 L 8.1370,6.0916 L 8.1339,6.7644 L 8.1339,8.8336 L 8.1726,9.2832 L 8.4372,11.7481 L 8.4796,12.2158 L 8.6392,14.2970 L 7.2621,14.3810 L 7.1861,14.4859 L 7.1861,14.7097 L 7.2197,14.7769 L 8.6858,14.9707 L 8.7783,15.8466 L 8.7871,16.1540 L 8.6522,16.3272 L 8.6522,16.4026 L 8.7659,16.5292 L 8.8966,17.0641 L 9.0439,17.0641 L 9.1364,16.7101 L 9.1912,16.4998 L 9.1870,16.3608 L 9.1658,16.1882 L 9.1493,16.0026 L 9.1452,15.8300 L 9.2335,14.9921 L 10.0020,14.9505 L 10.5725,14.8658 L 10.6893,14.8456 L 10.7265,14.7970 L 10.7265,14.5366 L 10.6955,14.4596 L 10.6236,14.4281 L 9.2997,14.2988 L 9.6511,10.8484 L 9.6511,10.8474 L 9.6971,10.4609 L 9.8201,9.5054 L 9.8857,8.5556 L 9.9028,7.8693 L 9.9286,7.2600 L 9.9286,6.3071 L 9.9198,6.0554 L 9.8888,5.6493 L 9.8599,5.4777 L 9.8397,5.3289 L 9.7658,4.8741 L 9.6883,4.5511 L 9.6113,4.3393 L 9.5023,4.1217 L 9.3824,3.9388 L 9.2966,3.8504 L 9.1673,3.7809 Z M 4.4946,3.2585 L 4.4057,3.2606 L 4.2393,3.4249 L 4.2393,3.5159 L 4.2683,3.5531 L 8.4737,7.7854 L 8.5109,7.7854 L 8.7228,7.9988 A 0.3737,0.3737 0.00 0,0 8.6370,8.2370 A 0.3737,0.3737 0.00 0,0 8.7217,8.4732 L 8.7150,8.4665 L 8.4757,8.7068 L 8.4148,8.7088 L 8.1605,8.9579 L 7.5549,9.2370 L 4.0305,12.7520 L 4.0326,12.8409 L 4.1969,13.0073 L 4.2879,13.0073 L 4.3251,12.9784 L 8.5574,8.7729 L 8.5574,8.7357 L 8.7708,8.5238 A 0.3737,0.3737 0.00 0,0 9.0106,8.6112 A 0.3737,0.3737 0.00 0,0 9.2494,8.5244 L 9.2499,8.5244 L 9.4886,8.7616 L 9.4907,8.8225 L 9.7398,9.0768 L 10.0188,9.6824 L 13.5339,13.2068 L 13.6227,13.2047 L 13.7892,13.0404 L 13.7892,12.9494 L 13.7602,12.9122 L 9.5548,8.6799 L 9.5175,8.6799 L 9.3052,8.4670 A 0.3737,0.3737 0.00 0,0 9.3842,8.2370 A 0.3737,0.3737 0.00 0,0 9.2793,7.9771 L 9.5124,7.7430 L 9.5734,7.7409 L 9.8276,7.4919 L 10.4332,7.2128 L 13.9576,3.6978 L 13.9555,3.6089 L 13.7912,3.4425 L 13.7002,3.4425 L 13.6630,3.4714 L 9.4307,7.6768 L 9.4307,7.7140 L 9.2173,7.9259 A 0.3737,0.3737 0.00 0,0 9.0106,7.8634 A 0.3737,0.3737 0.00 0,0 8.7750,7.9476 L 8.7801,7.9430 L 8.5398,7.7037 L 8.5378,7.6428 L 8.2887,7.3885 L 8.0096,6.7829 Z","a":[9.26,5.027]},"A319":{"d":"M 9.2896,0.4198 L 9.2291,0.4405 L 9.0745,0.5749 L 8.9061,0.7684 L 8.6939,1.1303 L 8.5379,1.5172 L 8.4443,1.9291 L 8.3445,2.4719 L 8.3320,2.8304 L 8.3008,2.8491 L 8.2883,2.8865 L 8.2821,4.6213 L 8.2758,6.1938 L 8.0706,6.4185 L 6.6978,7.1424 L 6.7602,6.9427 L 6.7976,6.7430 L 6.8413,6.4747 L 6.8475,5.9879 L 6.7914,5.5698 L 6.7289,5.3764 L 5.8616,5.3764 L 5.8241,5.5948 L 5.7867,6.2500 L 5.7992,6.8116 L 5.8491,7.1611 L 5.8865,7.2547 L 6.0800,7.4606 L 2.9973,9.0705 L 0.7509,10.2437 L 0.6073,10.3685 L 0.5262,10.5121 L 0.4888,10.6244 L 0.4888,11.1672 L 2.3671,10.5620 L 3.0847,10.3623 L 3.0847,10.5121 L 3.1408,10.6056 L 3.1908,10.5869 L 3.2220,10.5121 L 3.2220,10.3186 L 4.9326,9.7863 L 4.9389,9.9797 L 4.9701,10.0296 L 5.0200,10.0296 L 5.0699,9.9610 L 5.1074,9.8487 L 5.1074,9.7301 L 6.0550,9.4325 L 6.6693,9.4262 L 6.6631,9.5760 L 6.7005,9.6447 L 6.7567,9.6447 L 6.8129,9.6010 L 6.8129,9.4138 L 8.2486,9.4075 L 8.2424,11.1985 L 8.2173,12.2094 L 8.2417,13.2008 L 8.2589,13.7384 C 8.3088,14.2276 8.3926,14.7227 8.4799,15.2158 L 8.4268,15.3733 L 8.3067,15.5273 L 7.9885,15.7395 L 6.1477,16.9251 L 6.0229,17.0499 L 5.9479,17.2371 L 5.9479,17.6926 L 6.8965,17.4867 L 8.0322,17.2121 L 8.8247,17.0374 L 8.8434,17.3120 L 8.8808,17.5179 L 9.0369,18.1045 L 9.1671,18.1033 L 9.3083,18.1045 L 9.4643,17.5179 L 9.5017,17.3120 L 9.5205,17.0374 L 10.3130,17.2121 L 11.4487,17.4867 L 12.3972,17.6926 L 12.3972,17.2371 L 12.3223,17.0499 L 12.1975,16.9251 L 10.3567,15.7395 L 10.0384,15.5273 L 9.9573,15.3526 L 9.9198,15.2028 C 10.0135,14.6982 10.0979,14.1973 10.1383,13.6865 L 10.1944,13.1747 L 10.2256,12.2387 L 10.2568,11.2278 L 10.2506,9.4369 L 11.6734,9.4431 L 11.6734,9.6303 L 11.7295,9.6740 L 11.7857,9.6740 L 11.8231,9.6054 L 11.8168,9.4556 L 12.4659,9.4619 L 13.3832,9.7552 L 13.3832,9.8737 L 13.4206,9.9860 L 13.4705,10.0547 L 13.5205,10.0547 L 13.5516,10.0048 L 13.5578,9.8113 L 15.2988,10.3480 L 15.2988,10.5414 L 15.3301,10.6163 L 15.3800,10.6350 L 15.4361,10.5414 L 15.4361,10.3916 L 16.1538,10.5914 L 18.0321,11.1966 L 18.0321,10.6537 L 17.9946,10.5414 L 17.9135,10.3979 L 17.7700,10.2731 L 15.5235,9.0999 L 12.4409,7.4900 L 12.6343,7.2840 L 12.6717,7.1904 L 12.7216,6.8410 L 12.7341,6.2794 L 12.6967,5.6241 L 12.6592,5.4057 L 11.7918,5.4057 L 11.7294,5.5992 L 11.6733,6.0173 L 11.6795,6.5040 L 11.7232,6.7723 L 11.7606,6.9720 L 11.8230,7.1717 L 10.4501,6.4478 L 10.3129,6.2232 L 10.3067,4.6507 L 10.3005,2.9159 L 10.2880,2.8785 L 10.2567,2.8597 L 10.2443,2.4541 L 10.1445,1.9112 L 10.0509,1.4994 L 9.8949,1.1125 L 9.6827,0.7506 L 9.5142,0.5571 L 9.3520,0.4323 Z","a":[9.26,7.673]},"E190":{"d":"M 9.2635,0.9170 C 8.6008,1.2573 8.5891,2.6680 8.5891,2.6680 L 8.5891,6.9433 L 8.3045,7.4259 L 7.5558,7.8157 C 7.6734,7.6424 7.6796,7.0794 7.6796,7.0794 C 7.7105,6.6525 7.6115,6.5226 7.6115,6.5226 L 6.7639,6.5226 C 6.6525,6.6277 6.6587,7.1289 6.6587,7.1289 C 6.6525,7.6548 6.7886,7.7971 6.7886,7.7971 L 6.8629,7.8033 L 6.9248,8.1188 L 3.0330,10.0925 C 2.9031,10.1792 2.8846,10.2905 2.8846,10.2905 L 2.6433,11.1629 L 2.6433,11.3300 L 2.7175,11.3300 L 2.9650,10.9154 L 4.8706,10.4143 L 4.8706,10.6494 L 4.9139,10.7546 L 4.9634,10.6370 L 4.9634,10.3895 L 6.2380,10.0492 L 6.2380,10.2472 L 6.2813,10.3524 L 6.3246,10.2843 L 6.3246,10.0245 L 6.8938,9.8698 L 7.4259,9.8698 L 7.4259,10.0864 L 7.4754,10.1544 L 7.5249,10.1111 L 7.5249,9.8636 L 8.5829,9.8636 L 8.5829,13.3470 C 8.6122,14.5718 8.8613,15.5063 8.8613,15.5063 L 7.1537,16.7004 C 6.9743,16.8303 6.9866,17.0655 6.9866,17.0655 L 6.9804,17.4614 L 9.0531,16.9108 C 9.1645,17.6161 9.2573,17.6099 9.2573,17.6099 C 9.3439,17.6161 9.4862,16.8984 9.4862,16.8984 L 11.5527,17.4676 L 11.5465,17.1211 C 11.5280,16.7932 11.4475,16.7499 11.4475,16.7499 L 9.6657,15.5001 C 9.9812,14.0214 9.9565,13.3594 9.9565,13.3594 L 9.9565,9.8512 L 10.9773,9.8512 L 11.0206,10.1420 L 11.1073,9.8512 L 11.6394,9.8512 L 12.1776,10.0307 L 12.2333,10.3277 L 12.3138,10.0740 L 13.5698,10.4328 L 13.5945,10.7360 L 13.6749,10.4700 L 15.5497,10.9711 L 15.7538,11.2372 L 15.8095,11.3362 L 15.8776,11.3362 L 15.8776,11.1010 L 15.6424,10.2596 C 15.5991,10.1359 15.4506,10.0554 15.4506,10.0554 L 11.5899,8.1188 L 11.6456,7.8095 L 11.7198,7.8095 C 11.8559,7.7847 11.8868,7.1537 11.8868,7.1537 C 11.8745,6.4978 11.7631,6.4978 11.7631,6.4978 L 10.9155,6.4978 C 10.7855,6.7267 10.8103,7.0732 10.8103,7.0732 C 10.8227,7.5682 10.9588,7.8033 10.9588,7.8033 L 10.2720,7.4568 L 9.9565,6.9433 L 9.9565,2.6618 C 9.9379,1.2078 9.2635,0.9170 9.2635,0.9170 Z","a":[9.26,8.467]},"A318":{"d":"M 9.2604,1.6340 L 9.1571,1.6908 L 8.9664,1.8769 L 8.7654,2.1606 L 8.5845,2.5528 L 8.4248,3.0530 L 8.3370,3.9150 L 8.3370,6.5825 L 8.2853,6.6492 L 8.2853,6.7474 L 8.1458,6.9283 L 6.8921,7.5783 L 6.9541,7.3200 L 6.9851,6.9949 L 6.9903,6.7009 L 6.9799,6.3965 L 6.9438,6.1076 L 6.9179,5.9629 L 6.0513,5.9629 L 6.0151,6.1076 L 5.9893,6.4585 L 5.9790,6.8507 L 5.9841,7.2120 L 6.0151,7.5267 L 6.0565,7.7742 L 6.1340,7.9390 L 1.4438,10.3952 L 1.2630,10.5037 L 1.1136,10.6479 L 1.0258,10.8340 L 1.0258,11.4324 L 1.0723,11.3238 L 3.4561,10.6169 L 3.4561,10.7461 L 3.5176,10.8495 L 3.6003,10.7564 L 3.6003,10.5761 L 5.2100,10.0805 L 5.2100,10.2355 L 5.2824,10.3332 L 5.3599,10.2407 L 5.3599,10.0443 L 6.2420,9.7658 L 6.8099,9.7658 L 6.8254,9.9410 L 6.8921,10.0082 L 6.9696,9.9105 L 6.9799,9.7606 L 8.3163,9.7606 L 8.3163,11.7264 L 8.3680,12.4850 L 8.4145,12.9904 L 8.4972,13.4550 L 8.5690,13.7955 L 8.5276,13.9811 L 8.4558,14.1619 L 6.4590,15.4621 L 6.3143,15.5861 L 6.2575,15.6993 L 6.2472,15.8595 L 6.2472,16.2000 L 8.9044,15.5965 L 8.9457,15.9267 L 9.0181,16.2724 L 9.1007,16.6078 L 9.1984,16.6228 L 9.2574,16.7451 L 9.3224,16.6228 L 9.4201,16.6078 L 9.5028,16.2724 L 9.5751,15.9267 L 9.6165,15.5965 L 12.2737,16.2000 L 12.2737,15.8595 L 12.2633,15.6993 L 12.2065,15.5861 L 12.0618,15.4621 L 10.0650,14.1619 L 9.9932,13.9811 L 9.9519,13.7955 L 10.0242,13.4550 L 10.1064,12.9904 L 10.1529,12.4850 L 10.2046,11.7264 L 10.2046,9.7606 L 11.5409,9.7606 L 11.5512,9.9105 L 11.6288,10.0082 L 11.6959,9.9410 L 11.7114,9.7658 L 12.2788,9.7658 L 13.1610,10.0443 L 13.1610,10.2407 L 13.2385,10.3332 L 13.3108,10.2355 L 13.3108,10.0805 L 14.9205,10.5761 L 14.9205,10.7564 L 15.0032,10.8495 L 15.0652,10.7461 L 15.0652,10.6169 L 17.4486,11.3239 L 17.4951,11.4324 L 17.4951,10.8340 L 17.4077,10.6479 L 17.2579,10.5037 L 17.0775,10.3952 L 12.3874,7.9390 L 12.4644,7.7742 L 12.5057,7.5267 L 12.5367,7.2120 L 12.5419,6.8507 L 12.5316,6.4585 L 12.5057,6.1076 L 12.4696,5.9629 L 11.6029,5.9629 L 11.5771,6.1076 L 11.5409,6.3965 L 11.5306,6.7009 L 11.5358,6.9949 L 11.5668,7.3200 L 11.6288,7.5783 L 10.3751,6.9283 L 10.2355,6.7474 L 10.2355,6.6492 L 10.1839,6.5825 L 10.1839,3.9150 L 10.0965,3.0530 L 9.9363,2.5528 L 9.7560,2.1606 L 9.5545,1.8769 L 9.3638,1.6908 Z","a":[9.26,7.937]},"AN26":{"d":"M 9.2288,1.5289 L 9.1788,1.5410 L 8.9891,1.7053 L 8.7747,2.1420 L 8.5938,2.6613 L 8.4780,3.1719 L 8.3793,3.9548 L 8.3793,6.1547 L 7.3081,6.1547 L 7.3577,5.8746 L 7.3660,5.4048 L 7.3246,5.1248 L 7.2915,4.9273 L 7.1763,4.7460 L 7.0859,4.7377 L 7.0859,4.6059 L 7.0859,4.4659 L 7.0363,4.3501 L 6.9624,4.3010 L 6.8631,4.3667 L 6.8058,4.4659 L 6.8058,4.7377 L 6.7314,4.7542 L 6.6575,4.8777 L 6.6079,5.0260 L 6.5422,5.2813 L 6.5340,5.8332 L 6.5505,6.1299 L 6.4678,6.1299 L 0.8160,7.1107 L 0.7085,7.2094 L 0.6511,7.3494 L 0.6589,7.4895 L 0.7002,7.6212 L 0.7912,7.7447 L 0.8485,7.7778 L 6.6161,8.0088 L 6.6492,8.2641 L 6.7314,8.6429 L 6.8549,8.8821 L 7.0528,8.6429 L 7.1680,8.2724 L 7.2094,8.1158 L 8.3711,8.1158 L 8.3711,11.9719 L 8.3959,12.5734 L 8.4537,13.0757 L 8.5607,13.2075 L 6.3443,13.9986 L 6.2456,14.0973 L 6.1877,14.2456 L 6.1877,14.5009 L 6.2534,14.6084 L 6.3609,14.6906 L 8.9147,14.6906 L 8.9808,14.8389 L 9.1292,14.9789 L 9.2279,14.9955 L 9.3271,14.9789 L 9.4754,14.8389 L 9.5410,14.6906 L 12.0954,14.6906 L 12.2024,14.6084 L 12.2685,14.5009 L 12.2685,14.2456 L 12.2106,14.0973 L 12.1119,13.9986 L 9.8955,13.2075 L 10.0025,13.0757 L 10.0604,12.5734 L 10.0852,11.9719 L 10.0852,8.1158 L 11.2469,8.1158 L 11.2877,8.2724 L 11.4034,8.6429 L 11.6008,8.8821 L 11.7243,8.6429 L 11.8070,8.2641 L 11.8401,8.0088 L 17.6072,7.7778 L 17.6651,7.7447 L 17.7555,7.6212 L 17.7968,7.4895 L 17.8051,7.3494 L 17.7473,7.2094 L 17.6403,7.1107 L 11.9879,6.1299 L 11.9057,6.1299 L 11.9223,5.8332 L 11.9140,5.2813 L 11.8484,5.0260 L 11.7987,4.8777 L 11.7243,4.7542 L 11.6504,4.7377 L 11.6504,4.4659 L 11.5926,4.3667 L 11.4939,4.3010 L 11.4194,4.3501 L 11.3704,4.4659 L 11.3704,4.6059 L 11.3704,4.7377 L 11.2794,4.7460 L 11.1642,4.9273 L 11.1311,5.1248 L 11.0903,5.4048 L 11.0986,5.8746 L 11.1477,6.1547 L 10.0769,6.1547 L 10.0769,3.9548 L 9.9777,3.1719 L 9.8624,2.6613 L 9.6811,2.1420 L 9.4671,1.7053 L 9.2775,1.5410 Z","a":[9.26,7.937]},"TWEN":{"d":"M 9.2605,4.1243 C 9.2088,4.1243 9.0936,4.3977 9.0736,4.5896 L 7.9584,4.6134 L 9.0686,4.7552 C 8.6985,4.9007 8.6508,4.9433 8.6320,5.3171 L 8.4915,7.3769 C 8.2707,7.3330 8.0136,7.2678 7.8656,7.2678 L 2.9651,7.2678 C 2.8019,7.2678 2.7167,7.3758 2.7025,7.4822 L 2.5783,8.7134 L 4.9626,9.1320 L 8.5390,9.1320 C 8.5390,9.9410 9.0322,12.8042 9.0960,13.1768 L 7.2156,13.1768 C 6.9920,13.1768 7.1198,14.1844 7.2156,14.1808 L 9.2238,14.1808 L 9.2498,14.3966 L 9.2711,14.3966 L 9.2971,14.1808 L 11.3052,14.1808 C 11.4010,14.1848 11.5287,13.1768 11.3052,13.1768 L 9.4248,13.1768 C 9.4887,12.8042 9.9818,9.9410 9.9818,9.1320 L 13.5582,9.1320 L 15.9425,8.7134 L 15.8183,7.4822 C 15.8041,7.3758 15.7190,7.2678 15.5558,7.2678 L 10.6553,7.2678 C 10.5072,7.2678 10.2501,7.3330 10.0293,7.3769 L 9.8888,5.3171 C 9.8700,4.9433 9.8223,4.9007 9.4523,4.7552 L 10.5624,4.6134 L 9.4472,4.5896 C 9.4271,4.3977 9.3120,4.1243 9.2603,4.1243 Z","a":[9.26,8.202]},"SONX":{"d":"M 9.2605,3.9687 C 9.2605,3.9687 9.1124,4.0337 9.1072,4.2858 C 9.1072,4.3027 9.0695,4.3410 9.0230,4.3699 C 8.9961,4.3858 8.8012,4.4118 8.7778,4.4001 C 8.7531,4.3858 8.7505,4.3728 8.7258,4.3780 C 8.5180,4.4079 8.4556,4.4924 8.3647,4.8938 L 8.2620,5.3746 C 8.2464,5.4447 8.2282,5.5565 8.2256,5.6864 L 8.2256,6.5154 L 7.7319,6.8297 L 7.6539,6.8297 C 7.6539,6.4581 7.5669,6.3270 7.5162,6.2945 C 7.4626,6.3254 7.3525,6.4711 7.3525,6.8297 L 1.4902,6.8297 C 1.4123,6.8297 1.1524,7.0455 1.1524,7.4976 L 1.1524,9.6128 L 8.3296,9.6128 L 8.9584,13.7393 L 7.2070,14.6435 C 6.6642,14.7842 6.9108,15.3348 7.0095,15.7453 L 8.9272,15.7453 L 9.0805,15.3582 L 9.1351,15.8207 L 9.2286,15.8207 C 9.2286,15.8207 9.2001,16.0260 9.2260,16.0649 L 9.2624,16.0649 L 9.2988,16.0649 C 9.3248,16.0260 9.2962,15.8207 9.2962,15.8207 L 9.3897,15.8207 L 9.4443,15.3582 L 9.5976,15.7453 L 11.5153,15.7453 C 11.6140,15.3348 11.8606,14.7842 11.3178,14.6435 L 9.5664,13.7393 L 10.1952,9.6128 L 17.3724,9.6128 L 17.3724,7.4976 C 17.3724,7.0455 17.1125,6.8297 17.0346,6.8297 L 11.1723,6.8297 C 11.1723,6.4711 11.0622,6.3254 11.0086,6.2945 C 10.9579,6.3270 10.8709,6.4581 10.8709,6.8297 L 10.7929,6.8297 L 10.2992,6.5154 L 10.2992,5.6864 C 10.2966,5.5565 10.2784,5.4447 10.2628,5.3746 L 10.1602,4.8938 C 10.0693,4.4924 10.0069,4.4079 9.7990,4.3780 C 9.7743,4.3728 9.7717,4.3858 9.7470,4.4001 C 9.7236,4.4118 9.5287,4.3858 9.5018,4.3699 C 9.4553,4.3410 9.4177,4.3027 9.4177,4.2858 C 9.4125,4.0337 9.2605,3.9687 9.2604,3.9687 C 9.2604,3.9687 9.2605,3.9687 9.2605,3.9687 Z","a":[9.26,7.937]},"A19N":{"d":"M 9.2890,0.6121 L 9.2298,0.6323 L 9.0786,0.7638 L 8.9139,0.9530 L 8.7064,1.3070 L 8.5538,1.6854 L 8.4622,2.0883 L 8.3646,2.6192 L 8.3524,2.9698 L 8.3218,2.9881 L 8.3096,3.0248 L 8.3036,4.7215 L 8.2974,6.2595 L 8.0967,6.4793 L 6.7540,7.1873 L 6.8150,6.9919 L 6.8516,6.7966 L 6.8944,6.5342 L 6.9004,6.0581 L 6.8455,5.6492 L 6.7845,5.4600 L 5.9361,5.4600 L 5.8995,5.6736 L 5.8629,6.3144 L 5.8751,6.8637 C 5.8807,7.1428 5.9610,7.3050 6.1497,7.4985 L 3.1347,9.0732 L 0.9375,10.2206 L 0.7971,10.3427 L 0.7178,10.4831 L 0.6811,10.5929 L 0.6811,11.1239 L 2.5182,10.5319 L 3.2201,10.3366 L 3.2201,10.4831 L 3.2750,10.5746 L 3.3239,10.5563 L 3.3544,10.4831 L 3.3544,10.2938 L 5.0276,9.7732 L 5.0337,9.9624 L 5.0642,10.0112 L 5.1130,10.0112 L 5.1618,9.9441 L 5.1985,9.8342 L 5.1985,9.7183 L 6.1253,9.4272 L 6.7262,9.4210 L 6.7201,9.5675 L 6.7567,9.6346 L 6.8116,9.6346 L 6.8666,9.5919 L 6.8666,9.4088 L 8.2708,9.4027 L 8.2647,11.1543 L 8.2401,12.1431 L 8.2641,13.1127 L 8.2809,13.6386 L 8.3124,13.6791 L 8.3175,14.1025 L 8.3297,14.1513 L 8.3663,14.1757 L 8.4971,15.0836 L 8.4452,15.2377 L 8.3277,15.3883 L 8.0164,15.5959 L 6.2159,16.7555 L 6.0939,16.8775 L 6.0206,17.0607 L 6.0206,17.5062 L 6.9484,17.3048 L 8.0591,17.0362 L 8.8343,16.8653 L 8.8526,17.1339 L 8.8892,17.3353 L 9.0418,17.9090 L 9.1692,17.9078 L 9.3073,17.9090 L 9.4599,17.3353 L 9.4965,17.1339 L 9.5148,16.8653 L 10.2899,17.0362 L 11.4007,17.3048 L 12.3284,17.5062 L 12.3284,17.0607 L 12.2552,16.8775 L 12.1331,16.7555 L 10.3327,15.5959 L 10.0214,15.3883 L 9.9421,15.2174 L 9.9054,15.0709 L 10.0336,14.1249 L 10.0702,14.1005 L 10.0824,14.0517 L 10.0763,13.6122 L 10.1190,13.5878 L 10.1739,13.0873 L 10.2044,12.1719 L 10.2350,11.1831 L 10.2289,9.4314 L 11.6204,9.4376 L 11.6204,9.6207 L 11.6754,9.6635 L 11.7303,9.6635 L 11.7669,9.5963 L 11.7607,9.4498 L 12.3955,9.4559 L 13.2927,9.7428 L 13.2927,9.8588 L 13.3293,9.9686 L 13.3781,10.0357 L 13.4270,10.0357 L 13.4575,9.9869 L 13.4636,9.7977 L 15.1664,10.3226 L 15.1664,10.5118 L 15.1969,10.5850 L 15.2457,10.6034 L 15.3007,10.5118 L 15.3007,10.3653 L 16.0026,10.5607 L 17.8397,11.1527 L 17.8397,10.6217 L 17.8031,10.5118 L 17.7237,10.3715 L 17.5834,10.2494 L 15.3862,9.1020 L 12.3711,7.5273 C 12.5871,7.3568 12.6093,7.1479 12.6457,6.8925 L 12.6580,6.3432 L 12.6213,5.7024 L 12.5847,5.4888 L 11.7363,5.4888 L 11.6753,5.6780 L 11.6204,6.0869 L 11.6265,6.5629 L 11.6692,6.8254 L 11.7058,7.0207 L 11.7669,7.2160 L 10.4241,6.5080 L 10.2899,6.2883 L 10.2838,4.7503 L 10.2777,3.0535 L 10.2654,3.0169 L 10.2349,2.9986 L 10.2227,2.6019 L 10.1250,2.0709 L 10.0335,1.6681 L 9.8810,1.2896 L 9.6734,0.9356 L 9.5087,0.7464 L 9.3500,0.6243 Z","a":[9.26,7.937]},"B752":{"d":"M 9.3114,0.6808 L 9.2000,0.7286 L 9.0661,0.8630 L 8.9643,1.0077 L 8.8728,1.2056 L 8.7767,1.4521 L 8.7018,1.7312 L 8.6320,2.0955 L 8.6000,2.4489 L 8.6000,7.3257 L 7.3995,8.0005 L 7.4207,7.8186 L 7.4207,7.2611 L 7.4047,7.0363 L 7.3029,6.9505 L 6.7350,6.9505 L 6.6761,6.9774 L 6.5955,7.1861 L 6.5474,7.4915 L 6.5474,7.9954 L 6.6011,8.4403 L 2.5497,10.6428 L 2.4800,10.6965 L 2.4479,10.7658 L 2.4319,10.9161 L 2.4319,11.4303 L 2.4851,11.4303 L 2.5440,11.3502 L 2.6567,11.3073 L 4.7573,10.7926 L 4.7470,10.9590 L 4.7734,11.0071 L 4.8379,11.0071 L 4.8752,10.9590 L 4.8917,10.7658 L 6.0436,10.4820 L 6.0436,10.6211 L 6.0813,10.7068 L 6.1185,10.7068 L 6.1562,10.6428 L 6.1831,10.5518 L 6.1883,10.4392 L 6.6332,10.3265 L 7.2063,10.3265 L 7.2063,10.4764 L 7.2332,10.5621 L 7.2760,10.5621 L 7.3081,10.4981 L 7.3081,10.3213 L 8.6320,10.3213 L 8.6320,14.0456 L 8.6532,14.5009 L 8.6801,14.9298 L 8.7338,15.4120 L 8.7499,15.5675 L 7.5442,16.3980 L 6.7458,17.0145 L 6.6601,17.0894 L 6.6601,17.7271 L 6.7324,17.7074 L 9.0444,17.1483 L 9.0713,17.4160 L 9.1302,17.6682 L 9.2000,17.8986 L 9.2480,17.8986 L 9.3117,17.9429 L 9.3777,17.8986 L 9.4263,17.8986 L 9.4961,17.6682 L 9.5550,17.4160 L 9.5818,17.1483 L 11.8938,17.7074 L 11.9662,17.7271 L 11.9662,17.0894 L 11.8804,17.0145 L 11.0820,16.3980 L 9.8764,15.5675 L 9.8924,15.4120 L 9.9462,14.9298 L 9.9730,14.5009 L 9.9942,14.0456 L 9.9942,10.3213 L 11.3177,10.3213 L 11.3177,10.4981 L 11.3502,10.5621 L 11.3931,10.5621 L 11.4195,10.4764 L 11.4195,10.3265 L 11.9931,10.3265 L 12.4380,10.4392 L 12.4432,10.5518 L 12.4701,10.6428 L 12.5078,10.7068 L 12.5450,10.7068 L 12.5827,10.6211 L 12.5827,10.4820 L 13.7346,10.7658 L 13.7506,10.9590 L 13.7883,11.0071 L 13.8524,11.0071 L 13.8793,10.9590 L 13.8690,10.7926 L 15.9696,11.3073 L 16.0817,11.3502 L 16.1407,11.4303 L 16.1944,11.4303 L 16.1944,10.9161 L 16.1784,10.7658 L 16.1463,10.6965 L 16.0766,10.6428 L 12.0251,8.4403 L 12.0789,7.9954 L 12.0789,7.4915 L 12.0308,7.1861 L 11.9502,6.9774 L 11.8913,6.9505 L 11.3233,6.9505 L 11.2215,7.0363 L 11.2055,7.2611 L 11.2055,7.8186 L 11.2267,8.0005 L 10.0263,7.3257 L 10.0263,2.4489 L 9.9942,2.0955 L 9.9245,1.7312 L 9.8495,1.4521 L 9.7529,1.2056 L 9.6619,1.0077 L 9.5601,0.8630 L 9.4263,0.7286 Z","a":[9.26,8.467]},"A400":{"d":"M 3.1856,5.5950 L 3.3341,5.5545 L 3.6536,5.5365 L 4.0001,5.5365 L 4.3781,5.5365 L 4.7515,5.5365 L 5.0035,5.5590 L 5.1970,5.5725 L 5.2369,5.6017 L 5.0485,5.6265 L 4.7110,5.6490 L 4.3736,5.6805 L 3.9731,5.6760 L 3.7076,5.6625 L 3.4241,5.6355 L 3.2171,5.6175 Z M 10.9249,4.9960 L 11.0734,4.9555 L 11.3929,4.9375 L 11.7394,4.9375 L 12.1174,4.9375 L 12.4909,4.9375 L 12.7428,4.9600 L 12.9363,4.9735 L 12.9762,5.0026 L 12.7878,5.0275 L 12.4504,5.0500 L 12.1129,5.0815 L 11.7124,5.0770 L 11.4469,5.0635 L 11.1634,5.0365 L 10.9564,5.0185 Z M 13.2570,5.5950 L 13.4055,5.5545 L 13.7250,5.5365 L 14.0715,5.5365 L 14.4494,5.5365 L 14.8229,5.5365 L 15.0749,5.5590 L 15.2684,5.5725 L 15.3083,5.6017 L 15.1199,5.6265 L 14.7824,5.6490 L 14.4449,5.6805 L 14.0445,5.6760 L 13.7790,5.6625 L 13.4955,5.6355 L 13.2885,5.6175 Z M 5.5072,4.9960 L 5.6557,4.9555 L 5.9752,4.9375 L 6.3217,4.9375 L 6.6997,4.9375 L 7.0731,4.9375 L 7.3251,4.9600 L 7.5186,4.9735 L 7.5585,5.0026 L 7.3701,5.0275 L 7.0326,5.0500 L 6.6952,5.0815 L 6.2947,5.0770 L 6.0292,5.0635 L 5.7457,5.0365 L 5.5387,5.0185 Z M 9.2604,0.4558 L 9.1498,0.5111 L 8.9845,0.6692 L 8.8522,0.8527 L 8.7054,1.1064 L 8.5437,1.4376 L 8.3928,1.7611 L 8.2532,2.1322 L 8.1871,2.5549 L 8.1540,3.2241 L 8.1540,5.1428 L 8.0620,5.2607 L 7.9370,5.4741 L 7.8305,5.7056 L 7.8011,5.8637 L 6.8451,6.2053 L 6.8414,6.1464 L 6.8084,6.1133 L 6.8306,5.9263 L 6.8414,5.6648 L 6.8306,5.4188 L 6.8120,5.2751 L 6.7567,5.2090 L 6.7458,5.1506 L 6.7458,5.0695 L 6.7309,4.8674 L 6.7200,4.7201 L 6.6833,4.6431 L 6.6244,4.5878 L 6.5030,4.5878 L 6.4187,4.6504 L 6.3784,4.7274 L 6.3820,5.1428 L 6.3454,5.2167 L 6.2828,5.3671 L 6.2570,5.5144 L 6.2498,5.7164 L 6.2606,5.8673 L 6.2901,6.0255 L 6.2973,6.1945 L 6.2678,6.3671 L 4.4886,6.9665 L 4.4705,6.9262 L 4.4741,6.7825 L 4.5036,6.7531 L 4.5181,6.5179 L 4.5145,6.2534 L 4.5072,6.0327 L 4.4922,5.9149 L 4.4592,5.7976 L 4.4116,5.7423 L 4.4116,5.3857 L 4.3858,5.2974 L 4.3269,5.2384 L 4.2607,5.2126 L 4.1579,5.2240 L 4.0731,5.3010 L 4.0550,5.4116 L 4.0550,5.7387 L 4.0142,5.8307 L 3.9667,6.0177 L 3.9408,6.2715 L 3.9445,6.5143 L 3.9595,6.7898 L 3.9961,6.8559 L 4.0178,6.9076 L 4.0142,7.0290 L 3.9925,7.1133 L 1.1725,8.0801 L 1.0847,8.1282 L 1.0072,8.1943 L 0.9705,8.2749 L 0.9705,9.1390 L 3.6613,8.9405 L 3.6871,9.0801 L 3.7057,8.9261 L 4.8969,8.8377 L 4.9077,8.9550 L 4.9594,8.8263 L 5.9702,8.7457 L 5.9960,8.9442 L 6.0399,8.7385 L 7.4517,8.6356 L 7.4734,8.8522 L 7.5179,8.6243 L 7.7272,8.6170 L 7.7385,9.0878 L 7.7602,9.1829 L 7.8341,9.2677 L 8.1540,9.5472 L 8.1463,11.3301 L 8.1721,11.8520 L 8.2052,12.2861 L 8.2605,12.6499 L 8.3194,13.0251 L 8.4884,13.9992 L 8.6904,15.0099 L 8.6940,15.0575 L 8.6904,15.1019 L 8.6098,15.1753 L 6.1428,16.9948 L 5.9552,17.1530 L 5.8193,17.3002 L 5.6942,17.4620 L 5.6245,17.6790 L 5.5950,17.8702 L 5.5950,18.1090 L 9.0951,16.8078 L 9.1245,16.9437 L 9.1757,17.0868 L 9.2609,17.3075 L 9.3452,17.0868 L 9.3963,16.9437 L 9.4258,16.8078 L 12.9258,18.1090 L 12.9258,17.8702 L 12.8964,17.6790 L 12.8266,17.4620 L 12.7016,17.3002 L 12.5651,17.1530 L 12.3781,16.9948 L 9.9110,15.1753 L 9.8304,15.1019 L 9.8268,15.0575 L 9.8304,15.0099 L 10.0325,13.9992 L 10.2014,13.0251 L 10.2604,12.6499 L 10.3156,12.2861 L 10.3487,11.8520 L 10.3746,11.3301 L 10.3668,9.5472 L 10.6866,9.2677 L 10.7600,9.1829 L 10.7822,9.0878 L 10.7931,8.6170 L 11.0029,8.6243 L 11.0468,8.8522 L 11.0690,8.6356 L 12.4808,8.7385 L 12.5247,8.9442 L 12.5506,8.7457 L 13.5614,8.8263 L 13.6131,8.9550 L 13.6239,8.8377 L 14.8151,8.9261 L 14.8337,9.0801 L 14.8590,8.9405 L 17.5503,9.1390 L 17.5503,8.2749 L 17.5136,8.1943 L 17.4361,8.1282 L 17.3477,8.0801 L 14.5282,7.1133 L 14.5060,7.0290 L 14.5024,6.9076 L 14.5246,6.8559 L 14.5613,6.7898 L 14.5763,6.5143 L 14.5799,6.2715 L 14.5541,6.0177 L 14.5060,5.8307 L 14.4657,5.7387 L 14.4657,5.4116 L 14.4476,5.3010 L 14.3629,5.2240 L 14.2600,5.2126 L 14.1939,5.2384 L 14.1350,5.2974 L 14.1091,5.3857 L 14.1091,5.7423 L 14.0616,5.7976 L 14.0285,5.9149 L 14.0135,6.0327 L 14.0063,6.2534 L 14.0027,6.5179 L 14.0172,6.7531 L 14.0467,6.7825 L 14.0503,6.9262 L 14.0322,6.9665 L 12.2530,6.3671 L 12.2235,6.1945 L 12.2307,6.0255 L 12.2601,5.8673 L 12.2710,5.7164 L 12.2638,5.5144 L 12.2380,5.3671 L 12.1754,5.2167 L 12.1387,5.1428 L 12.1423,4.7274 L 12.1020,4.6504 L 12.0173,4.5878 L 11.8964,4.5878 L 11.8374,4.6431 L 11.8008,4.7201 L 11.7894,4.8674 L 11.7749,5.0695 L 11.7749,5.1506 L 11.7635,5.2090 L 11.7088,5.2751 L 11.6902,5.4188 L 11.6793,5.6648 L 11.6902,5.9263 L 11.7124,6.1133 L 11.6793,6.1464 L 11.6757,6.2053 L 10.7198,5.8637 L 10.6903,5.7056 L 10.5838,5.4741 L 10.4588,5.2607 L 10.3668,5.1428 L 10.3668,3.2241 L 10.3337,2.5549 L 10.2676,2.1322 L 10.1281,1.7611 L 9.9772,1.4376 L 9.8154,1.1064 L 9.6687,0.8527 L 9.5359,0.6692 L 9.3705,0.5111 Z","a":[9.26,7.144]},"PA31":{"d":"M 9.3162,2.4963 L 9.2041,2.5464 L 9.1064,2.6596 L 8.9545,2.9169 L 8.8119,3.2580 L 8.6279,3.8884 L 8.4884,4.6114 L 8.3855,5.4196 L 8.3494,5.9395 L 8.3494,6.2790 L 7.3970,6.7363 L 7.4182,6.1467 L 7.3923,5.6372 L 7.3536,5.1178 L 7.3231,4.9892 L 7.0399,4.8811 L 7.0140,4.6698 L 6.9908,4.4073 L 6.8776,4.1861 L 6.7541,4.0781 L 6.6120,4.2006 L 6.5174,4.4119 L 6.4606,4.8651 L 6.1790,4.9948 L 6.0901,5.7452 L 6.0265,6.8640 L 1.2774,7.1503 L 1.1188,7.2200 L 1.0826,7.3435 L 1.0775,7.8376 L 1.1343,8.1828 L 1.2216,8.3884 L 1.3126,8.4267 L 6.0689,9.3078 L 6.1262,10.0875 L 6.6637,10.2803 L 7.1076,10.1217 L 7.1644,10.0405 L 7.2016,9.6390 L 7.2228,9.5191 L 8.1091,9.6933 L 8.2594,9.8819 L 8.3514,10.9929 L 8.4651,12.1210 L 8.7049,13.7731 L 5.6198,14.1762 L 5.5382,14.2088 L 5.4689,14.3224 L 5.4730,14.6847 L 5.5263,14.8960 L 5.6074,15.0469 L 8.9839,15.4371 L 9.0697,15.6283 L 9.1266,16.1533 L 9.1834,15.6283 L 9.2687,15.4371 L 12.6457,15.1648 L 12.7269,15.0139 L 12.7796,14.8025 L 12.7837,14.4403 L 12.7149,14.3266 L 12.6333,14.2940 L 9.6025,13.7731 L 9.8913,12.1257 L 10.0376,11.0069 L 10.1110,9.9573 L 10.3223,9.7212 L 11.1522,9.5708 L 11.1972,9.6762 L 11.2013,10.1770 L 11.2581,10.2581 L 11.7589,10.3883 L 12.2633,10.2664 L 12.3578,9.3827 L 17.2268,8.6003 L 17.2991,8.5951 L 17.3865,8.3895 L 17.4433,8.0448 L 17.4381,7.5502 L 17.4019,7.4267 L 17.3043,7.3807 L 12.5175,6.9534 L 12.5020,5.8005 L 12.4508,5.1054 L 12.1314,4.9204 L 12.0751,4.4672 L 12.0079,4.2512 L 11.8844,4.1578 L 11.7609,4.2460 L 11.6529,4.4595 L 11.6012,4.7297 L 11.5759,4.9411 L 11.2927,5.0491 L 11.2617,5.1778 L 11.1997,5.6925 L 11.1744,6.2020 L 11.1537,6.8195 L 10.1858,6.2893 L 10.1858,5.9498 L 10.1503,5.4300 L 10.0779,4.6217 L 9.9699,3.9065 L 9.7896,3.2528 L 9.6816,2.9081 L 9.5374,2.6658 L 9.4242,2.5371 Z","a":[9.26,7.673]},"C560":{"d":"M 9.2605,1.7111 C 8.7771,1.7111 8.3053,3.1906 8.3053,4.8281 L 8.3053,7.7998 L 0.9215,8.2930 C 0.8751,8.2957 0.7875,8.3520 0.7892,8.4586 L 0.7892,8.6314 C 0.7041,8.6829 0.7049,8.7211 0.7892,8.8669 L 0.7912,9.2019 L 7.2575,10.2892 C 7.2307,10.5454 7.2914,11.6817 7.5667,12.0626 L 7.9508,12.0626 L 8.1172,12.7763 L 8.6005,13.2116 C 8.6545,13.6590 8.9509,14.8445 9.0213,15.0103 L 5.9770,15.5529 C 5.8866,15.5679 5.8213,15.6433 5.8213,15.7438 L 5.8263,16.3516 L 9.1720,16.6229 C 9.1972,16.8289 9.2565,16.8097 9.2565,16.8097 C 9.2565,16.8097 9.3237,16.8289 9.3488,16.6229 L 12.6945,16.3516 L 12.6995,15.7438 C 12.6995,15.6433 12.6342,15.5679 12.5438,15.5529 L 9.4996,15.0103 C 9.5699,14.8445 9.8663,13.6590 9.9203,13.2116 L 10.4036,12.7763 L 10.5700,12.0626 L 10.9541,12.0626 C 11.2294,11.6817 11.2903,10.5454 11.2635,10.2892 L 17.7297,9.2019 L 17.7317,8.8669 C 17.8159,8.7211 17.8168,8.6829 17.7317,8.6314 L 17.7317,8.4586 C 17.7333,8.3520 17.6457,8.2958 17.5993,8.2930 L 10.2157,7.7998 L 10.2157,4.8281 C 10.2157,3.1906 9.7438,1.7111 9.2605,1.7111 Z","a":[9.26,8.996]},"DA42":{"d":"M 9.2604,3.8368 C 8.9291,3.8368 8.5529,5.8383 8.5529,6.8816 L 7.6126,7.0786 C 7.6977,6.9354 7.6753,6.7518 7.5813,6.7518 C 7.6798,6.5547 7.4962,5.9906 7.2633,5.9906 C 7.2633,5.7756 7.1559,5.5518 7.0946,5.5166 C 7.0336,5.5518 6.9099,5.7723 6.9099,5.9876 C 6.7073,5.9813 6.5431,6.3960 6.5462,6.6778 C 6.5462,6.8836 6.6313,7.1338 6.6313,7.3206 L 3.7058,7.4662 L 1.0587,7.5549 C 0.9541,7.5549 0.8941,7.5707 0.8941,8.2768 C 0.8023,8.4541 0.6472,8.9702 0.7706,8.9702 C 0.8498,8.9702 1.0397,8.6821 1.0397,8.6821 L 3.0883,8.8056 L 6.6313,8.9227 C 6.6440,9.0272 6.7168,9.4325 6.7579,9.4325 L 7.2993,9.4325 C 7.3563,9.4325 7.4070,9.1063 7.4260,8.9860 L 8.5342,9.0747 C 8.5483,9.5555 9.1770,10.6578 9.1263,13.4694 L 7.4482,13.9000 C 7.4111,13.9072 7.0730,14.5519 7.2790,14.5519 C 7.3328,14.5519 7.4022,14.5072 7.4604,14.5094 C 7.7962,14.5251 8.4768,14.5922 8.6157,14.5922 L 8.6157,14.6840 L 9.2470,14.6840 L 9.9052,14.6840 L 9.9052,14.5922 C 10.0440,14.5922 10.7246,14.5251 11.0604,14.5094 C 11.1187,14.5072 11.1881,14.5519 11.2418,14.5519 C 11.4478,14.5519 11.1097,13.9072 11.0726,13.9000 L 9.3945,13.4694 C 9.3439,10.6578 9.9724,9.5555 9.9866,9.0747 L 11.0948,8.9860 C 11.1138,9.1063 11.1644,9.4325 11.2214,9.4325 L 11.7628,9.4325 C 11.8040,9.4325 11.8768,9.0272 11.8895,8.9227 L 15.4325,8.8056 L 17.4810,8.6821 C 17.4810,8.6821 17.6710,8.9702 17.7502,8.9702 C 17.8737,8.9702 17.7185,8.4541 17.6267,8.2768 C 17.6267,7.5707 17.5667,7.5549 17.4620,7.5549 L 14.8151,7.4662 L 11.8895,7.3206 C 11.8895,7.1338 11.9745,6.8836 11.9745,6.6778 C 11.9777,6.3960 11.8135,5.9813 11.6109,5.9876 C 11.6109,5.7723 11.4873,5.5518 11.4263,5.5166 C 11.3649,5.5518 11.2574,5.7756 11.2574,5.9906 C 11.0246,5.9906 10.8410,6.5547 10.9396,6.7518 C 10.8455,6.7518 10.8232,6.9354 10.9082,7.0786 L 9.9679,6.8816 C 9.9679,5.8383 9.5918,3.8368 9.2604,3.8368 Z","a":[9.26,7.937]},"SW4":{"d":"M 9.0950,1.5685 L 8.9898,1.7020 L 8.9395,1.8061 L 8.8119,2.0609 L 8.6987,2.3115 L 8.6279,2.5476 L 8.5473,2.8593 L 8.4863,3.1662 L 8.4434,3.5393 L 8.4103,3.9450 L 8.3917,4.4318 L 8.3540,5.5506 L 8.3540,7.5437 L 8.3302,7.6001 L 8.2641,7.6662 L 8.1649,7.7230 L 8.0424,7.7468 L 7.3386,7.7799 L 7.3525,7.4445 L 7.3386,7.0099 L 7.2962,6.4761 L 7.2487,6.1976 L 7.2207,6.0560 L 7.1639,5.8720 L 7.0978,5.7020 L 7.0554,5.6498 L 7.0316,5.6544 L 6.9655,5.7252 L 6.8947,5.8952 L 6.8430,6.0983 L 6.8048,6.2260 L 6.7577,6.4906 L 6.7154,6.7975 L 6.6823,7.5768 L 6.6730,7.8078 L 2.8903,8.0538 L 2.7724,8.0868 L 2.6872,8.1432 L 2.6303,8.2238 L 2.6117,8.3370 L 2.6303,8.4548 L 2.6402,9.0501 L 8.1840,9.9048 L 8.2403,9.9332 L 8.2832,9.9994 L 8.2832,13.6116 L 8.2879,13.9991 L 8.3302,14.2348 L 8.3917,14.5800 L 8.5003,15.0239 L 7.0647,16.2135 L 6.9701,16.3318 L 6.9040,16.5111 L 6.8854,16.8558 L 6.8761,17.1819 L 7.0223,17.1866 L 7.0838,17.1442 L 8.8026,16.6104 L 8.8687,16.8605 L 8.8687,17.2812 L 8.9442,17.3189 L 8.9442,17.5644 L 9.1045,17.5954 L 9.2604,17.5644 L 9.2604,17.3189 L 9.3359,17.2812 L 9.3359,16.8605 L 9.4020,16.6104 L 11.1208,17.1442 L 11.1823,17.1866 L 11.3285,17.1819 L 11.3192,16.8558 L 11.3006,16.5111 L 11.2345,16.3318 L 11.1399,16.2135 L 9.7043,15.0239 L 9.8128,14.5800 L 9.8743,14.2348 L 9.9167,13.9991 L 9.9214,13.6116 L 9.9214,9.9994 L 9.9643,9.9332 L 10.0206,9.9048 L 15.5644,9.0501 L 15.5742,8.4548 L 15.5928,8.3370 L 15.5742,8.2238 L 15.5174,8.1432 L 15.4321,8.0868 L 15.3143,8.0538 L 11.5316,7.8078 L 11.5223,7.5768 L 11.4892,6.7975 L 11.4468,6.4906 L 11.3998,6.2260 L 11.3616,6.0983 L 11.3099,5.8952 L 11.2391,5.7252 L 11.1729,5.6544 L 11.1492,5.6498 L 11.1068,5.7020 L 11.0407,5.8720 L 10.9838,6.0560 L 10.9559,6.1976 L 10.9084,6.4761 L 10.8660,7.0099 L 10.8520,7.4445 L 10.8660,7.7799 L 10.1622,7.7468 L 10.0397,7.7230 L 9.9405,7.6662 L 9.8743,7.6001 L 9.8505,7.5437 L 9.8505,5.5506 L 9.8128,4.4318 L 9.7942,3.9450 L 9.7612,3.5393 L 9.7183,3.1662 L 9.6573,2.8593 L 9.5767,2.5476 L 9.5059,2.3115 L 9.3927,2.0609 L 9.2651,1.8061 L 9.2093,1.7043 L 9.2093,1.7038 Z","a":[9.26,8.467]},"A338":{"d":"M 9.3811,1.4739 L 9.2940,1.5203 L 9.1653,1.6903 L 9.0625,1.9187 L 8.9374,2.2304 L 8.8377,2.5580 L 8.7509,2.9021 L 8.6961,3.2329 L 8.6449,3.5672 L 8.6160,3.9884 L 8.6160,6.5267 L 8.6062,6.6006 L 8.5550,6.6585 L 8.4196,6.8161 L 7.3401,7.4910 L 7.3691,7.3334 L 7.3913,7.0409 L 7.4073,6.7489 L 7.4073,6.4435 L 7.3334,6.3888 L 6.4627,6.3888 L 6.4177,6.4466 L 6.3986,6.7004 L 6.3758,6.9190 L 6.3758,7.1153 L 6.4017,7.3623 L 6.4435,7.6517 L 6.4916,7.7546 L 6.6265,7.7546 L 6.6461,7.8155 L 6.6973,7.8894 L 1.7033,11.0644 L 1.5425,11.2159 L 1.3885,11.4117 L 1.2242,11.6494 L 1.0733,11.8907 L 0.9193,12.1672 L 0.9193,12.3403 L 1.0475,12.2086 L 1.2470,12.0515 L 1.4847,11.8809 L 1.7064,11.7590 L 1.9730,11.6365 L 4.1424,10.7756 L 4.6054,10.6180 L 4.6245,10.7399 L 4.6726,10.8717 L 4.6984,10.9203 L 4.7496,10.8557 L 4.7661,10.6789 L 4.7785,10.5570 L 5.5273,10.2836 L 5.5340,10.3673 L 5.5759,10.4991 L 5.6177,10.5988 L 5.6627,10.5022 L 5.6849,10.3384 L 5.6947,10.2195 L 6.4115,9.9751 L 6.4239,10.0976 L 6.4627,10.2324 L 6.4885,10.2965 L 6.5304,10.1906 L 6.5593,10.0650 L 6.5753,9.9270 L 7.1438,9.7312 L 7.3081,9.7152 L 7.3303,9.8371 L 7.3722,9.9947 L 7.3949,10.0490 L 7.4492,9.9658 L 7.4750,9.8211 L 7.4910,9.6986 L 8.5581,9.5927 L 8.5674,9.8531 L 8.6093,10.0397 L 8.6093,11.6241 L 8.6351,12.2086 L 8.6770,12.8002 L 8.7152,13.2597 L 8.7478,13.5423 L 8.7767,13.8829 L 8.8470,14.3717 L 8.8925,14.6255 L 8.9405,14.9148 L 8.9664,15.1396 L 7.0699,16.4057 L 6.9867,16.4925 L 6.9128,16.5954 L 6.8642,16.7530 L 6.8192,16.9328 L 6.8161,17.1163 L 9.1653,16.3546 L 9.2713,16.8687 L 9.3789,16.8687 L 9.4852,16.8687 L 9.5911,16.3546 L 11.9404,17.1163 L 11.9373,16.9328 L 11.8923,16.7530 L 11.8437,16.5954 L 11.7698,16.4925 L 11.6866,16.4057 L 9.7906,15.1396 L 9.8159,14.9148 L 9.8645,14.6255 L 9.9095,14.3717 L 9.9797,13.8829 L 10.0087,13.5423 L 10.0412,13.2597 L 10.0795,12.8002 L 10.1213,12.2086 L 10.1472,11.6241 L 10.1472,10.0397 L 10.1890,9.8531 L 10.1983,9.5927 L 11.2655,9.6986 L 11.2815,9.8211 L 11.3073,9.9658 L 11.3616,10.0490 L 11.3843,9.9947 L 11.4262,9.8371 L 11.4484,9.7152 L 11.6127,9.7312 L 12.1812,9.9270 L 12.1972,10.0650 L 12.2261,10.1906 L 12.2680,10.2965 L 12.2938,10.2324 L 12.3326,10.0976 L 12.3450,9.9751 L 13.0617,10.2195 L 13.0715,10.3384 L 13.0938,10.5022 L 13.1387,10.5988 L 13.1806,10.4991 L 13.2224,10.3673 L 13.2286,10.2836 L 13.9774,10.5570 L 13.9904,10.6789 L 14.0064,10.8557 L 14.0581,10.9203 L 14.0839,10.8717 L 14.1320,10.7399 L 14.1511,10.6180 L 14.6141,10.7756 L 16.7835,11.6365 L 17.0501,11.7590 L 17.2718,11.8809 L 17.5095,12.0515 L 17.7090,12.2086 L 17.8372,12.3403 L 17.8372,12.1672 L 17.6832,11.8907 L 17.5323,11.6494 L 17.3679,11.4117 L 17.2139,11.2159 L 17.0532,11.0644 L 12.0592,7.8894 L 12.1104,7.8155 L 12.1300,7.7546 L 12.2649,7.7546 L 12.3129,7.6517 L 12.3548,7.3623 L 12.3806,7.1153 L 12.3806,6.9190 L 12.3579,6.7004 L 12.3388,6.4466 L 12.2938,6.3888 L 11.4231,6.3888 L 11.3487,6.4435 L 11.3487,6.7489 L 11.3652,7.0409 L 11.3874,7.3334 L 11.4164,7.4910 L 10.3363,6.8161 L 10.2015,6.6585 L 10.1503,6.6006 L 10.1405,6.5267 L 10.1405,3.9884 L 10.1115,3.5672 L 10.0604,3.2329 L 10.0056,2.9021 L 9.9188,2.5580 L 9.8190,2.2304 L 9.6940,1.9187 L 9.5911,1.6903 L 9.4625,1.5203 Z","a":[9.26,7.937]},"BE36":{"d":"M 9.3082,2.5130 L 9.2377,2.5590 L 9.1596,2.7399 L 9.0573,3.1207 L 8.9256,3.1352 L 8.8031,3.1988 L 8.7106,3.3207 L 8.6372,3.4918 L 8.5690,3.7750 L 8.5251,4.0535 L 8.4615,4.5470 L 8.3783,5.6115 L 7.1479,6.1438 L 3.3383,6.3293 L 3.3383,6.1877 L 2.9621,6.1924 L 2.9574,6.3391 L 1.4583,6.3929 L 1.3069,6.4074 L 1.1358,6.4906 L 1.0232,6.6223 L 0.9844,6.8668 L 0.9746,8.2191 L 2.5518,8.5271 L 2.5518,8.6543 L 3.1915,8.7710 L 3.1967,8.6491 L 8.4465,9.6258 L 8.4465,9.7772 L 8.0951,9.7870 L 8.0657,9.7286 L 8.0119,9.6945 L 7.9535,9.7333 L 7.9437,9.8211 L 7.9385,9.9384 L 7.9876,9.9725 L 8.0316,9.9529 L 8.0610,9.9043 L 8.0951,9.8847 L 8.4563,9.8898 L 8.5395,10.7931 L 8.6320,11.5698 L 8.9059,13.8942 L 6.5272,14.1774 L 6.4099,14.2167 L 6.3319,14.2947 L 6.2932,14.4069 L 6.2782,15.3448 L 6.3174,15.4523 L 6.4296,15.5401 L 7.9194,15.7453 L 7.9241,15.8528 L 9.0816,15.8672 L 9.2036,15.6719 L 9.2279,16.3706 L 9.3136,16.5000 L 9.3917,16.3706 L 9.4160,15.6719 L 9.5379,15.8672 L 10.6955,15.8528 L 10.7002,15.7453 L 12.1900,15.5401 L 12.3021,15.4523 L 12.3414,15.3448 L 12.3269,14.4069 L 12.2877,14.2947 L 12.2096,14.2167 L 12.0923,14.1774 L 9.7137,13.8942 L 9.9876,11.5698 L 10.0801,10.7931 L 10.1633,9.8898 L 10.5245,9.8847 L 10.5586,9.9043 L 10.5880,9.9529 L 10.6320,9.9725 L 10.6811,9.9384 L 10.6759,9.8211 L 10.6661,9.7333 L 10.6077,9.6945 L 10.5539,9.7286 L 10.5245,9.7870 L 10.1731,9.7772 L 10.1731,9.6258 L 15.4229,8.6491 L 15.4281,8.7710 L 16.0678,8.6543 L 16.0678,8.5271 L 17.6450,8.2191 L 17.6352,6.8668 L 17.5964,6.6223 L 17.4838,6.4906 L 17.3132,6.4074 L 17.1618,6.3929 L 15.6622,6.3391 L 15.6575,6.1924 L 15.2813,6.1877 L 15.2813,6.3293 L 11.4722,6.1438 L 10.2412,5.6115 L 10.1580,4.5470 L 10.0945,4.0535 L 10.0505,3.7750 L 9.9823,3.4918 L 9.9090,3.3207 L 9.8165,3.1988 L 9.6945,3.1352 L 9.5622,3.1207 L 9.4599,2.7399 L 9.3819,2.5590 Z","a":[9.26,6.879]},"B38M":{"d":"M 9.2604,0.6620 L 9.1990,0.6795 L 9.1215,0.7456 L 9.0223,0.9482 L 8.9376,1.1797 L 8.8347,1.4887 L 8.7314,1.8350 L 8.6249,2.2763 L 8.5805,2.5192 L 8.5216,2.8690 L 8.4776,3.1817 L 8.4518,3.6307 L 8.4373,3.8808 L 8.4373,6.9499 L 8.2937,7.1297 L 8.1536,7.2625 L 7.9810,7.3840 L 7.5800,7.6708 L 7.6312,7.4098 L 7.6720,7.1520 L 7.6901,6.8982 L 7.6901,6.7473 L 7.6643,6.5634 L 7.6239,6.4089 L 7.5650,6.3427 L 6.7150,6.3427 L 6.6819,6.3939 L 6.6416,6.5153 L 6.6121,6.6590 L 6.5971,6.7437 L 6.5971,7.1189 L 6.6121,7.3509 L 6.6380,7.5235 L 6.6674,7.7447 L 6.6891,7.8842 L 6.7222,7.9762 L 6.7889,7.9876 L 6.8106,7.9064 L 6.8328,7.9287 L 6.8478,8.0057 L 6.8772,8.0759 L 2.0124,10.6918 L 1.9938,10.7621 L 1.4419,11.4793 L 1.4455,11.5863 L 1.4197,11.6416 L 1.4569,11.6525 L 1.4569,11.6964 L 1.4936,11.6964 L 1.5230,11.6633 L 1.9866,11.3801 L 2.0346,11.4096 L 5.2618,10.3791 L 5.3021,10.7951 L 5.4236,10.3316 L 6.4059,10.0701 L 6.4685,10.4747 L 6.5754,10.0262 L 7.0240,9.8898 L 7.3774,9.8934 L 7.4436,10.2872 L 7.5506,9.8898 L 8.4373,9.8712 L 8.4373,13.1981 L 8.4668,13.6689 L 8.4849,13.9484 L 8.4999,14.1619 L 8.5179,14.3314 L 8.5769,14.7582 L 8.6394,15.1261 L 8.7830,15.7147 L 6.1486,17.5436 L 6.1486,17.8640 L 6.2034,17.8640 L 9.0223,17.1240 L 9.0626,17.3374 L 9.1696,17.6505 L 9.2357,17.6541 L 9.2853,17.6541 L 9.3520,17.6505 L 9.4585,17.3374 L 9.4988,17.1240 L 12.3177,17.8640 L 12.3730,17.8640 L 12.3730,17.5436 L 9.7380,15.7147 L 9.8817,15.1261 L 9.9442,14.7582 L 10.0031,14.3314 L 10.0217,14.1619 L 10.0362,13.9484 L 10.0548,13.6689 L 10.0843,13.1981 L 10.0843,9.8712 L 10.9710,9.8898 L 11.0775,10.2872 L 11.1436,9.8934 L 11.4971,9.8898 L 11.9462,10.0262 L 12.0526,10.4747 L 12.1151,10.0701 L 13.0975,10.3316 L 13.2190,10.7951 L 13.2598,10.3791 L 16.4870,11.4096 L 16.5345,11.3801 L 16.9980,11.6633 L 17.0275,11.6964 L 17.0647,11.6964 L 17.0647,11.6525 L 17.1014,11.6416 L 17.0756,11.5863 L 17.0792,11.4793 L 16.5273,10.7621 L 16.5087,10.6918 L 11.6444,8.0759 L 11.6738,8.0057 L 11.6883,7.9287 L 11.7105,7.9064 L 11.7327,7.9876 L 11.7989,7.9762 L 11.8319,7.8842 L 11.8542,7.7447 L 11.8836,7.5235 L 11.9089,7.3509 L 11.9239,7.1189 L 11.9239,6.7437 L 11.9089,6.6590 L 11.8800,6.5153 L 11.8392,6.3939 L 11.8061,6.3427 L 10.9560,6.3427 L 10.8971,6.4089 L 10.8568,6.5634 L 10.8310,6.7473 L 10.8310,6.8982 L 10.8496,7.1520 L 10.8899,7.4098 L 10.9416,7.6708 L 10.5406,7.3840 L 10.3674,7.2625 L 10.2274,7.1297 L 10.0843,6.9499 L 10.0843,3.8808 L 10.0693,3.6307 L 10.0434,3.1817 L 9.9995,2.8690 L 9.9406,2.5192 L 9.8962,2.2763 L 9.7897,1.8350 L 9.6869,1.4887 L 9.5835,1.1797 L 9.4988,0.9482 L 9.3995,0.7456 L 9.3225,0.6795 Z","a":[9.26,7.937]},"A346":{"d":"M 9.2609,0.3933 L 9.2155,0.4041 L 9.1565,0.4615 L 9.0992,0.5400 L 9.0346,0.6584 L 8.9772,0.7798 L 8.9219,0.9178 L 8.8573,1.0894 L 8.8005,1.2614 L 8.7540,1.4222 L 8.7126,1.5922 L 8.6553,1.8893 L 8.6232,2.1058 L 8.6036,2.3115 L 8.5948,2.5084 L 8.5948,7.5691 L 7.3081,8.3582 L 7.3205,8.2419 L 7.3293,8.0951 L 7.3386,7.9572 L 7.3386,7.7174 L 7.3241,7.5654 L 7.2900,7.3345 L 7.2631,7.3236 L 6.6905,7.3236 L 6.6673,7.3345 L 6.6549,7.3830 L 6.6404,7.4833 L 6.6244,7.6207 L 6.6120,7.7551 L 6.6099,7.9499 L 6.6156,8.1308 L 6.6280,8.2993 L 6.6601,8.5427 L 6.7283,8.5427 L 6.7443,8.6264 L 6.7727,8.6873 L 4.7883,9.9131 L 4.8007,9.8129 L 4.8100,9.6894 L 4.8173,9.5410 L 4.8173,9.3586 L 4.8137,9.2046 L 4.7971,9.0754 L 4.7775,8.9344 L 4.7703,8.8894 L 4.7491,8.8806 L 4.1605,8.8806 L 4.1439,8.8930 L 4.1264,8.9788 L 4.1119,9.1044 L 4.0974,9.2548 L 4.0907,9.4584 L 4.0995,9.7018 L 4.1134,9.8811 L 4.1388,10.0955 L 4.2085,10.0955 L 4.2282,10.1834 L 4.2499,10.2423 L 1.9627,11.6598 L 1.9466,11.6758 L 1.9322,11.7006 L 1.9306,11.7419 L 1.9249,11.8350 L 1.7374,12.2499 L 1.7374,12.4556 L 1.9182,12.3326 L 4.3822,11.2552 L 4.3822,11.3373 L 4.3930,11.4128 L 4.4214,11.4949 L 4.4483,11.5611 L 4.4679,11.5611 L 4.4964,11.5058 L 4.5289,11.3838 L 4.5465,11.2944 L 4.5537,11.1906 L 4.7795,11.1193 L 4.7832,11.2035 L 4.8007,11.2805 L 4.8224,11.3570 L 4.8545,11.4252 L 4.8762,11.4252 L 4.9062,11.3590 L 4.9315,11.2588 L 4.9511,11.1621 L 4.9563,11.0567 L 5.6043,10.8345 L 5.6059,10.9043 L 5.6224,10.9833 L 5.6436,11.0583 L 5.6761,11.1404 L 5.7009,11.1404 L 5.7294,11.0779 L 5.7547,10.9942 L 5.7707,10.9136 L 5.7816,10.8366 L 5.7816,10.7684 L 6.4311,10.5482 L 6.4347,10.6180 L 6.4487,10.6877 L 6.4704,10.7756 L 6.5024,10.8577 L 6.5241,10.8577 L 6.5526,10.7973 L 6.5722,10.7239 L 6.5903,10.6505 L 6.6063,10.5554 L 6.6084,10.4841 L 7.2218,10.2712 L 7.3313,10.2691 L 7.3313,10.3802 L 7.3525,10.4929 L 7.3866,10.5968 L 7.4078,10.6396 L 7.4259,10.6396 L 7.4564,10.5714 L 7.4745,10.4944 L 7.4957,10.4107 L 7.5081,10.3317 L 7.5081,10.2691 L 8.5318,10.2691 L 8.5426,10.4304 L 8.5571,10.6107 L 8.5840,10.8650 L 8.5840,13.1429 L 8.5891,13.4007 L 8.6000,13.6550 L 8.6305,14.0611 L 8.6537,14.2952 L 8.7075,14.6978 L 8.7679,15.0828 L 8.8362,15.5174 L 8.9669,16.3551 L 7.0931,17.4697 L 7.0414,17.5126 L 7.0094,17.5684 L 6.9892,17.6382 L 6.9463,18.0836 L 9.1333,17.4645 L 9.1943,18.0692 L 9.2118,18.0836 L 9.2584,18.0872 L 9.3090,18.0836 L 9.3271,18.0692 L 9.3875,17.4645 L 11.5745,18.0836 L 11.5316,17.6382 L 11.5120,17.5684 L 11.4794,17.5126 L 11.4277,17.4697 L 9.5539,16.3551 L 9.6847,15.5174 L 9.7529,15.0828 L 9.8139,14.6978 L 9.8671,14.2952 L 9.8903,14.0611 L 9.9208,13.6550 L 9.9317,13.4007 L 9.9369,13.1429 L 9.9369,10.8650 L 9.9637,10.6107 L 9.9782,10.4304 L 9.9890,10.2691 L 11.0128,10.2691 L 11.0128,10.3317 L 11.0252,10.4107 L 11.0469,10.4944 L 11.0644,10.5714 L 11.0949,10.6396 L 11.1130,10.6396 L 11.1342,10.5968 L 11.1683,10.4929 L 11.1900,10.3802 L 11.1900,10.2691 L 11.2990,10.2712 L 11.9130,10.4841 L 11.9145,10.5554 L 11.9305,10.6505 L 11.9486,10.7239 L 11.9682,10.7973 L 11.9966,10.8577 L 12.0183,10.8577 L 12.0504,10.7756 L 12.0721,10.6877 L 12.0860,10.6180 L 12.0896,10.5482 L 12.7392,10.7684 L 12.7392,10.8366 L 12.7500,10.9136 L 12.7661,10.9942 L 12.7914,11.0779 L 12.8198,11.1404 L 12.8451,11.1404 L 12.8772,11.0583 L 12.8989,10.9833 L 12.9149,10.9043 L 12.9164,10.8345 L 13.5644,11.0567 L 13.5696,11.1621 L 13.5892,11.2588 L 13.6146,11.3590 L 13.6451,11.4252 L 13.6662,11.4252 L 13.6983,11.3570 L 13.7200,11.2805 L 13.7381,11.2035 L 13.7417,11.1193 L 13.9670,11.1906 L 13.9742,11.2944 L 13.9918,11.3838 L 14.0243,11.5058 L 14.0527,11.5611 L 14.0724,11.5611 L 14.0992,11.4949 L 14.1282,11.4128 L 14.1385,11.3373 L 14.1385,11.2552 L 16.6030,12.3326 L 16.7833,12.4561 L 16.7833,12.2499 L 16.5957,11.8350 L 16.5900,11.7419 L 16.5884,11.7006 L 16.5740,11.6758 L 16.5579,11.6598 L 14.2713,10.2423 L 14.2925,10.1834 L 14.3121,10.0955 L 14.3819,10.0955 L 14.4072,9.8811 L 14.4211,9.7018 L 14.4304,9.4589 L 14.4232,9.2548 L 14.4088,9.1044 L 14.3943,8.9793 L 14.3767,8.8930 L 14.3607,8.8806 L 13.7716,8.8806 L 13.7504,8.8894 L 13.7432,8.9344 L 13.7235,9.0759 L 13.7075,9.2046 L 13.7039,9.3586 L 13.7039,9.5410 L 13.7111,9.6893 L 13.7199,9.8129 L 13.7323,9.9131 L 11.7480,8.6873 L 11.7764,8.6264 L 11.7924,8.5426 L 11.8606,8.5426 L 11.8926,8.2992 L 11.9056,8.1308 L 11.9108,7.9499 L 11.9092,7.7551 L 11.8962,7.6207 L 11.8802,7.4833 L 11.8663,7.3830 L 11.8534,7.3344 L 11.8301,7.3236 L 11.2575,7.3236 L 11.2307,7.3344 L 11.1965,7.5654 L 11.1826,7.7174 L 11.1826,7.9572 L 11.1914,8.0951 L 11.2002,8.2419 L 11.2126,8.3582 L 9.9265,7.5691 L 9.9265,2.5084 L 9.9172,2.3115 L 9.8976,2.1058 L 9.8655,1.8893 L 9.8082,1.5922 L 9.7674,1.4222 L 9.7209,1.2614 L 9.6635,1.0894 L 9.5989,0.9178 L 9.5436,0.7798 L 9.4862,0.6584 L 9.4216,0.5400 L 9.3643,0.4615 L 9.3054,0.4041 Z","a":[9.26,8.731]},"DH8D":{"d":"M 9.2085,1.5995 C 8.9724,1.5995 8.5921,2.6334 8.5921,3.3232 L 8.5921,7.9730 L 8.5008,8.0110 C 8.0403,8.0110 7.4087,8.0719 7.4087,8.0719 L 7.4087,7.0179 C 7.4087,6.8048 7.3136,6.4890 7.2223,6.4890 C 7.1424,6.4890 7.0206,6.7972 7.0206,7.0217 L 7.0206,8.0948 L 3.0063,8.4106 C 2.8807,8.4182 2.8655,8.4562 2.8617,8.4981 L 2.8236,8.9205 C 2.8198,8.9813 2.8236,8.9889 2.8579,8.9928 L 4.7261,9.1297 L 4.7604,9.2553 L 4.8061,9.1373 L 5.9590,9.2096 L 5.9894,9.3961 L 6.0579,9.2173 L 7.0168,9.2629 L 7.0168,9.8641 C 7.0168,9.9973 7.1195,10.4235 7.1956,10.4235 C 7.2722,10.4235 7.4277,10.0087 7.4277,9.8679 L 7.4277,9.3999 L 8.5426,9.3999 C 8.5845,9.4037 8.5921,9.4418 8.5921,9.4722 L 8.5921,12.1510 C 8.5921,12.7141 9.0106,15.6973 9.0106,15.6973 C 8.7062,15.7125 7.4201,15.9104 7.4201,15.9104 L 7.4201,16.5839 L 9.1819,16.5839 C 9.1933,16.7779 9.2351,16.9758 9.2351,16.9758 C 9.2351,16.9758 9.2884,16.7627 9.3036,16.5839 L 11.0311,16.5839 L 11.0311,15.9066 C 11.0311,15.9066 9.7488,15.7201 9.4558,15.6821 C 9.4558,15.6821 9.8325,12.7179 9.8325,12.1472 L 9.8325,9.4836 C 9.8363,9.4341 9.8706,9.4037 9.9124,9.4037 L 11.0578,9.4037 L 11.0578,9.8489 C 11.0578,10.0201 11.1567,10.4197 11.2290,10.4197 C 11.3089,10.4197 11.4611,10.0239 11.4611,9.8679 L 11.4611,9.3048 L 12.4200,9.2553 L 12.4885,9.3961 L 12.5303,9.2439 L 13.7099,9.1640 L 13.7479,9.2667 L 13.7860,9.1526 L 15.6353,9.0118 C 15.6847,9.0042 15.6999,8.9699 15.6999,8.9205 L 15.6885,8.5894 C 15.6809,8.4791 15.6124,8.4220 15.5287,8.4106 L 11.4573,8.1100 L 11.4573,7.0217 C 11.4573,6.7972 11.3355,6.4852 11.2518,6.4852 C 11.1719,6.4852 11.0387,6.7972 11.0387,7.0217 L 11.0387,8.0605 C 10.6354,8.0339 9.8820,8.0072 9.8820,8.0072 L 9.8059,7.9388 L 9.8059,3.3308 C 9.8059,2.6345 9.4444,1.5995 9.2085,1.5995 Z","a":[9.26,8.467]},"C206":{"d":"M 9.2196,2.5730 L 9.2196,2.5730 L 9.1657,2.6308 L 9.0292,2.9111 L 8.9885,3.1373 L 9.0282,3.1507 L 9.0301,3.2119 L 8.6591,3.2273 L 8.6007,3.2583 L 8.5351,3.3172 L 8.4932,3.4139 L 8.4658,3.5379 L 8.3872,4.9160 L 8.3872,5.3614 L 8.3454,5.7448 L 5.2028,5.7382 L 1.1048,5.9898 L 1.0216,6.0002 L 0.9632,6.0658 L 0.9080,6.2110 L 0.8180,6.5732 L 0.7421,7.7163 L 5.3650,8.3685 L 8.0440,8.3685 L 8.3101,8.2925 L 8.3928,8.2925 L 8.8935,12.9258 L 6.3939,13.2917 L 6.3076,13.3299 L 6.2384,13.3919 L 6.2038,13.4643 L 6.2038,14.4968 L 6.2523,14.5521 L 6.3350,14.6105 L 6.5665,14.6518 L 8.8899,15.1216 L 9.0036,14.6658 L 9.0522,14.3691 L 9.2321,15.7372 L 9.2770,15.7360 L 9.3147,15.7360 L 9.4459,14.3691 L 9.4940,14.6658 L 9.6082,15.1215 L 11.9316,14.6518 L 12.1631,14.6105 L 12.2458,14.5521 L 12.2938,14.4968 L 12.2938,13.4643 L 12.2597,13.3919 L 12.1905,13.3299 L 12.1042,13.2917 L 9.6046,12.9258 L 10.1053,8.2925 L 10.1880,8.2925 L 10.4541,8.3685 L 13.1330,8.3685 L 17.7560,7.7163 L 17.6801,6.5732 L 17.5901,6.2110 L 17.5348,6.0658 L 17.4759,6.0002 L 17.3933,5.9898 L 13.2953,5.7382 L 10.1193,5.7382 L 10.0707,5.3547 L 10.0707,4.9093 L 9.9984,3.5248 L 9.9705,3.4008 L 9.9291,3.3042 L 9.8635,3.2453 L 9.8051,3.2143 L 9.4356,3.2143 L 9.4356,3.1419 L 9.4873,3.1280 L 9.4149,2.9037 L 9.2820,2.6289 Z","a":[9.26,6.879]},"A339":{"d":"M 9.3461,0.9011 L 9.2604,0.9483 L 9.1452,1.0955 L 9.0367,1.3126 L 8.9457,1.5327 L 8.8542,1.8061 L 8.7530,2.1596 L 8.6760,2.5445 L 8.6129,2.9611 L 8.5850,3.2933 L 8.5850,6.7474 L 8.5638,6.8699 L 8.4625,6.9784 L 8.3401,7.0905 L 7.2760,7.7696 L 7.3003,7.6192 L 7.3288,7.3949 L 7.3458,7.0208 L 7.3458,6.7303 L 7.3179,6.6704 L 7.1045,6.6425 L 6.6249,6.6425 L 6.3975,6.6704 L 6.3453,6.7055 L 6.3309,6.8595 L 6.3205,7.1396 L 6.3242,7.3427 L 6.3417,7.6538 L 6.3764,7.8745 L 6.4187,8.0181 L 6.5552,8.0181 L 6.6389,8.1649 L 1.6030,11.3776 L 1.4035,11.5667 L 1.2180,11.7838 L 1.0604,12.0287 L 0.8961,12.3052 L 0.8155,12.4695 L 0.7912,12.6065 L 0.8118,12.6690 L 0.9276,12.5326 L 1.0707,12.4034 L 1.2495,12.2809 L 1.4314,12.1584 L 1.6552,12.0427 L 1.8340,11.9553 L 4.5532,10.9053 L 4.5532,11.0872 L 4.6163,11.2133 L 4.6514,11.2066 L 4.7000,11.0526 L 4.7000,10.8531 L 5.4596,10.5797 L 5.4668,10.7094 L 5.5227,10.8459 L 5.5609,10.8459 L 5.5997,10.7270 L 5.5997,10.5203 L 6.3624,10.2686 L 6.3764,10.4366 L 6.4223,10.5622 L 6.4570,10.5555 L 6.4849,10.4294 L 6.5164,10.3172 L 6.5133,10.2087 L 6.8771,10.0831 L 7.2724,10.0061 L 7.2724,10.1741 L 7.3251,10.3348 L 7.3706,10.3348 L 7.4125,10.2371 L 7.4197,9.9777 L 8.5323,9.8692 L 8.5462,10.1529 L 8.5710,10.3420 L 8.5710,12.7884 L 8.6201,13.3620 L 8.6548,13.8173 L 8.7002,14.3036 L 8.7426,14.7588 L 8.8227,15.2766 L 8.9281,15.9763 L 7.0208,17.2470 L 6.9226,17.3380 L 6.8456,17.4569 L 6.8001,17.6072 L 6.7650,17.7648 L 6.7582,17.9607 L 9.1167,17.2155 L 9.2186,17.7509 L 9.3471,17.7628 L 9.4754,17.7509 L 9.5772,17.2155 L 11.9357,17.9607 L 11.9290,17.7648 L 11.8939,17.6072 L 11.8484,17.4569 L 11.7714,17.3380 L 11.6732,17.2470 L 9.7658,15.9763 L 9.8713,15.2766 L 9.9514,14.7588 L 9.9937,14.3036 L 10.0392,13.8173 L 10.0738,13.3620 L 10.1229,12.7884 L 10.1229,10.3420 L 10.1477,10.1529 L 10.1617,9.8692 L 11.2743,9.9777 L 11.2815,10.2371 L 11.3233,10.3348 L 11.3688,10.3348 L 11.4215,10.1741 L 11.4215,10.0061 L 11.8168,10.0831 L 12.1806,10.2087 L 12.1775,10.3172 L 12.2090,10.4294 L 12.2370,10.5555 L 12.2721,10.5622 L 12.3176,10.4366 L 12.3315,10.2686 L 13.0943,10.5203 L 13.0943,10.7270 L 13.1330,10.8459 L 13.1713,10.8459 L 13.2271,10.7094 L 13.2343,10.5797 L 13.9939,10.8531 L 13.9939,11.0526 L 14.0425,11.2066 L 14.0776,11.2133 L 14.1407,11.0872 L 14.1407,10.9053 L 16.8599,11.9553 L 17.0387,12.0427 L 17.2624,12.1584 L 17.4443,12.2809 L 17.6231,12.4034 L 17.7663,12.5326 L 17.8820,12.6690 L 17.9032,12.6065 L 17.8784,12.4695 L 17.7978,12.3052 L 17.6335,12.0287 L 17.4759,11.7838 L 17.2903,11.5667 L 17.0909,11.3776 L 12.0550,8.1649 L 12.1387,8.0181 L 12.2751,8.0181 L 12.3175,7.8745 L 12.3521,7.6538 L 12.3697,7.3427 L 12.3733,7.1396 L 12.3630,6.8595 L 12.3490,6.7055 L 12.2963,6.6704 L 12.0689,6.6425 L 11.5894,6.6425 L 11.3759,6.6704 L 11.3480,6.7303 L 11.3480,7.0208 L 11.3651,7.3949 L 11.3935,7.6192 L 11.4178,7.7696 L 10.3539,7.0905 L 10.2314,6.9784 L 10.1301,6.8699 L 10.1089,6.7474 L 10.1089,3.2933 L 10.0810,2.9611 L 10.0180,2.5445 L 9.9410,2.1596 L 9.8397,1.8061 L 9.7488,1.5327 L 9.6573,1.3126 L 9.5493,1.0955 L 9.4335,0.9483 Z","a":[9.26,8.467]},"HAWK":{"d":"M 9.2507,1.8218 L 9.2507,1.8546 L 9.2327,1.8546 L 9.2327,1.9266 L 9.2496,1.9266 L 9.2496,2.2101 L 9.2327,2.2101 L 9.2327,2.6089 C 9.0887,2.6089 8.6636,3.5381 8.6636,4.6772 L 8.6636,7.5293 L 8.6286,7.5293 L 8.6286,7.4329 L 8.3307,7.4329 C 8.2796,7.4534 8.0734,7.5335 8.0734,7.7009 C 8.0734,8.1569 8.1417,8.5345 8.1417,8.5345 L 7.9651,8.6746 L 7.4995,8.9835 L 3.8980,10.8079 C 3.4880,11.0446 3.4095,11.5719 3.4078,11.7589 L 3.4078,12.1340 L 8.4913,11.5486 C 8.5123,11.6023 8.5583,11.7105 8.5883,11.7197 C 8.5883,12.2538 8.6780,13.8121 8.6780,13.8121 C 8.4294,14.0860 8.3673,14.2310 8.2706,14.8893 L 6.7813,15.9573 C 6.6995,16.0070 6.5420,16.2243 6.5420,16.6617 C 6.5420,16.6849 6.5578,16.7038 6.5880,16.6985 L 6.7939,16.6784 L 9.0067,16.1033 C 9.0237,16.1668 9.0293,16.1880 9.0505,16.1880 L 9.2145,16.1880 L 9.2145,16.2234 L 9.1961,16.2234 L 9.1961,16.2756 L 9.2584,16.2756 L 9.3248,16.2756 L 9.3248,16.2234 L 9.3064,16.2234 L 9.3064,16.1880 L 9.4703,16.1880 C 9.4915,16.1880 9.4972,16.1668 9.5141,16.1033 L 11.7270,16.6784 L 11.9329,16.6985 C 11.9631,16.7038 11.9789,16.6849 11.9789,16.6617 C 11.9789,16.2243 11.8214,16.0070 11.7395,15.9573 L 10.2502,14.8893 C 10.1536,14.2310 10.0914,14.0860 9.8428,13.8121 C 9.8428,13.8121 9.9326,12.2538 9.9326,11.7197 C 9.9625,11.7105 10.0085,11.6023 10.0295,11.5486 L 15.1130,12.1339 L 15.1130,11.7589 C 15.1113,11.5719 15.0328,11.0446 14.6228,10.8079 L 11.0213,8.9834 L 10.5557,8.6746 L 10.3792,8.5345 C 10.3792,8.5345 10.4474,8.1569 10.4474,7.7009 C 10.4474,7.5335 10.2412,7.4534 10.1901,7.4329 L 9.8923,7.4329 L 9.8923,7.5293 L 9.8573,7.5293 L 9.8573,4.6772 C 9.8573,3.5381 9.4322,2.6089 9.2881,2.6089 L 9.2881,2.2101 L 9.2712,2.2101 L 9.2712,1.9266 L 9.2881,1.9266 L 9.2881,1.8546 L 9.2701,1.8546 L 9.2701,1.8218 Z","a":[9.26,9.79]},"BL8":{"d":"M 9.2914,4.6659 L 9.1974,4.7739 L 9.1447,4.8881 L 9.1002,5.0886 L 9.0987,5.2591 L 9.0785,5.4358 L 8.6336,5.6720 L 8.5757,5.7195 L 8.5690,5.7774 L 8.5561,7.2058 L 8.6036,7.2771 L 8.5809,7.6243 L 7.7582,7.6114 L 7.7308,7.4786 L 7.6967,7.3220 L 7.6522,7.2063 L 7.5845,7.1040 L 7.5535,7.0735 L 7.5163,7.1040 L 7.4688,7.1618 L 7.4311,7.2574 L 7.4042,7.3799 L 7.3530,7.6218 L 1.5177,7.5701 L 1.0051,7.5727 L 0.9441,7.6166 L 0.8997,7.7256 L 0.8692,7.8858 L 0.8485,8.0626 L 0.8124,8.3204 L 0.7478,8.3985 L 0.7478,8.4563 L 0.8124,8.4780 L 0.8191,8.6992 L 0.8201,8.9219 L 0.8341,9.4025 L 0.8733,9.8966 L 1.1100,10.0619 L 1.4423,10.2790 L 8.4822,10.3291 L 8.5886,10.4407 L 8.6072,10.6324 L 8.6408,11.1476 L 9.0217,14.1945 L 8.7767,14.2498 L 7.1980,14.6622 L 6.9634,14.7268 L 6.8203,14.8084 L 6.7319,14.9045 L 6.6673,15.0167 L 6.6229,15.2037 L 6.6466,15.3774 L 6.7216,15.5443 L 6.8337,15.6564 L 6.9830,15.7396 L 7.2983,15.7939 L 8.7297,15.9381 L 9.1565,15.3954 L 9.1793,16.2311 L 9.2439,15.3903 L 9.6284,15.9381 L 11.1089,15.8156 L 11.4458,15.7613 L 11.5786,15.6729 L 11.6908,15.5603 L 11.7657,15.3939 L 11.7895,15.2203 L 11.7450,15.0327 L 11.6804,14.9205 L 11.5378,14.8084 L 11.3947,14.7268 L 11.1600,14.6622 L 9.6149,14.2332 L 9.4511,14.1991 L 9.7917,11.1838 L 9.8154,10.6495 L 9.8289,10.4862 L 9.9550,10.3534 L 17.0067,10.3942 L 17.4155,10.1456 L 17.5276,10.0640 L 17.6398,9.4340 L 17.6945,8.9509 L 17.7116,8.7266 L 17.7116,8.5530 L 17.7762,8.5902 L 17.7762,8.5323 L 17.7116,8.4543 L 17.7044,8.1990 L 17.6842,8.0217 L 17.6537,7.8621 L 17.6093,7.7530 L 17.5483,7.7086 L 17.0615,7.6988 L 11.1937,7.6579 L 11.1632,7.4161 L 11.1358,7.2936 L 11.0986,7.1980 L 11.0510,7.1401 L 11.0133,7.1096 L 10.9828,7.1401 L 10.9146,7.2425 L 10.8707,7.3582 L 10.8366,7.5148 L 10.8092,7.6476 L 9.9586,7.6476 L 9.9586,7.3210 L 10.0061,7.2492 L 10.0263,5.7588 L 10.0196,5.7009 L 9.9617,5.6529 L 9.5126,5.4317 L 9.5090,5.2446 L 9.4888,5.0679 L 9.4444,4.8839 L 9.3627,4.7341 Z","a":[9.26,7.673]},"B789":{"d":"M 9.2469,0.6464 C 9.0328,0.6464 8.3881,1.6425 8.3881,3.3438 L 8.3881,6.2340 L 6.7477,7.3814 C 6.8607,6.9931 6.8822,6.6182 6.8822,6.3939 C 6.8822,6.1097 6.8592,5.9315 6.8377,5.8178 C 6.8238,5.7595 6.7945,5.6426 6.7239,5.6426 L 5.8560,5.6426 C 5.7469,5.6426 5.7392,5.7718 5.7285,5.8194 C 5.7147,5.9300 5.6839,6.0774 5.6839,6.3970 C 5.6839,6.7298 5.7557,7.1913 5.8314,7.4540 L 6.0240,7.4540 C 6.0386,7.4970 6.1301,7.7474 6.1550,7.7915 L 1.0735,11.3704 C 0.9949,11.4242 0.8997,11.4870 0.8480,11.5767 L 0.3568,12.3593 L 0.3568,12.6635 L 0.9050,12.1963 C 0.9713,12.1412 1.1024,12.0479 1.1843,12.0085 L 3.5183,11.0004 C 3.5183,11.1834 3.5891,11.2818 3.6091,11.2818 C 3.6315,11.2818 3.6965,11.1498 3.6965,10.9226 L 4.8194,10.4370 C 4.8194,10.5935 4.8796,10.7179 4.9069,10.7179 C 4.9366,10.7179 4.9984,10.5855 4.9984,10.3575 L 5.9391,9.9474 L 6.5603,9.9474 C 6.5603,10.1344 6.6301,10.2764 6.6526,10.2764 C 6.6823,10.2764 6.7404,10.1349 6.7404,9.9489 L 8.3871,9.9489 L 8.3871,13.2638 C 8.3871,13.8352 8.5487,14.6745 8.5966,14.9052 C 8.6433,15.1107 8.5803,15.1937 8.5327,15.2382 L 6.4947,17.0504 C 6.4602,17.0827 6.4129,17.1349 6.4010,17.1902 L 6.2936,17.6241 L 8.9753,16.6470 C 9.0627,17.0076 9.1637,17.4521 9.1717,17.4521 C 9.1722,17.4521 9.1721,17.4527 9.1721,17.4528 L 9.2316,17.4528 L 9.2468,17.4528 L 9.3216,17.4528 C 9.3216,17.4528 9.3215,17.4521 9.3220,17.4521 C 9.3300,17.4521 9.4309,17.0076 9.5184,16.6470 L 12.2001,17.6241 L 12.0927,17.1902 C 12.0808,17.1349 12.0335,17.0827 11.9990,17.0504 L 9.9610,15.2382 C 9.9134,15.1937 9.8504,15.1107 9.8971,14.9052 C 9.9450,14.6745 10.1066,13.8352 10.1066,13.2638 L 10.1066,9.9489 L 11.7533,9.9489 C 11.7533,10.1349 11.8114,10.2764 11.8411,10.2764 C 11.8636,10.2764 11.9334,10.1344 11.9334,9.9474 L 12.5546,9.9474 L 13.4953,10.3575 C 13.4953,10.5855 13.5571,10.7179 13.5868,10.7179 C 13.6141,10.7179 13.6743,10.5935 13.6743,10.4370 L 14.7972,10.9226 C 14.7972,11.1498 14.8622,11.2818 14.8846,11.2818 C 14.9046,11.2818 14.9754,11.1834 14.9754,11.0004 L 17.3094,12.0085 C 17.3913,12.0479 17.5224,12.1412 17.5887,12.1963 L 18.1369,12.6635 L 18.1369,12.3593 L 17.6457,11.5767 C 17.5939,11.4870 17.4988,11.4242 17.4202,11.3704 L 12.3387,7.7915 C 12.3636,7.7474 12.4551,7.4970 12.4697,7.4540 L 12.6623,7.4540 C 12.7380,7.1913 12.8097,6.7298 12.8097,6.3970 C 12.8097,6.0774 12.7790,5.9300 12.7652,5.8194 C 12.7544,5.7718 12.7467,5.6426 12.6377,5.6426 L 11.7698,5.6426 C 11.6992,5.6426 11.6699,5.7595 11.6560,5.8178 C 11.6345,5.9315 11.6115,6.1097 11.6115,6.3939 C 11.6115,6.6182 11.6330,6.9931 11.7460,7.3814 L 10.1056,6.2340 L 10.1056,3.3438 C 10.1056,1.6425 9.4610,0.6464 9.2469,0.6464 Z","a":[9.26,7.937]},"DH8C":{"d":"M 9.2362,1.8562 L 9.1154,1.8844 L 8.9783,1.9823 L 8.8775,2.1151 L 8.7638,2.2981 L 8.6372,2.5507 L 8.5235,2.8096 L 8.4165,3.1378 L 8.3282,3.5104 L 8.2522,3.9145 L 8.2207,4.2680 L 8.2145,4.4700 L 8.2145,7.3298 L 8.1700,7.3675 L 6.7371,7.3675 L 6.7371,6.5407 L 6.7179,6.1934 L 6.6740,5.9852 L 6.5918,5.8208 L 6.4782,5.7133 L 6.4528,5.7066 L 6.4027,5.7454 L 6.2952,5.8777 L 6.2384,6.0544 L 6.2007,6.2249 L 6.2007,7.3737 L 0.6320,8.0052 L 0.5752,8.0305 L 0.5250,8.0998 L 0.4930,8.2010 L 0.4930,8.9524 L 3.3471,9.1100 L 3.3910,9.2175 L 3.4479,9.1162 L 4.7547,9.1798 L 4.7987,9.2868 L 4.8555,9.1860 L 6.1753,9.2490 L 6.1753,9.8738 L 6.2007,10.1141 L 6.2508,10.3162 L 6.3521,10.4676 L 6.4720,10.5244 L 6.5727,10.4738 L 6.6678,10.3730 L 6.7309,10.2464 L 6.7562,10.1327 L 6.7562,9.2682 L 8.2651,9.2490 L 8.2651,11.3135 L 8.3153,11.9889 L 8.3659,12.6328 L 8.4419,13.1821 L 8.6119,14.1924 L 8.9090,15.4802 L 6.7562,15.7830 L 6.6931,15.8399 L 6.6425,15.9665 L 6.6425,16.5850 L 6.6802,16.7871 L 6.7433,16.9261 L 9.1560,16.9261 L 9.1545,17.1912 L 9.2175,16.9261 L 11.6861,16.9261 L 11.7491,16.7871 L 11.7869,16.5850 L 11.7869,15.9665 L 11.7362,15.8399 L 11.6732,15.7830 L 9.5203,15.4802 L 9.8170,14.1924 L 9.9875,13.1821 L 10.0635,12.6328 L 10.1141,11.9889 L 10.1642,11.3135 L 10.1642,9.2490 L 11.6732,9.2682 L 11.6732,10.1327 L 11.6985,10.2464 L 11.7616,10.3725 L 11.8561,10.4738 L 11.9574,10.5244 L 12.0773,10.4676 L 12.1786,10.3162 L 12.2287,10.1141 L 12.2540,9.8738 L 12.2540,9.2490 L 13.5733,9.1860 L 13.6302,9.2868 L 13.6746,9.1793 L 14.9815,9.1162 L 15.0384,9.2175 L 15.0823,9.1100 L 17.9359,8.9524 L 17.9359,8.2010 L 17.9043,8.0998 L 17.8542,8.0305 L 17.7974,8.0052 L 12.2287,7.3737 L 12.2287,6.2249 L 12.1910,6.0544 L 12.1342,5.8777 L 12.0267,5.7449 L 11.9760,5.7066 L 11.9512,5.7133 L 11.8375,5.8208 L 11.7554,5.9852 L 11.7109,6.1934 L 11.6923,6.5407 L 11.6923,7.3675 L 10.2593,7.3675 L 10.2149,7.3298 L 10.2149,4.4700 L 10.2087,4.2680 L 10.1772,3.9145 L 10.1012,3.5104 L 10.0128,3.1378 L 9.9053,2.8096 L 9.7922,2.5507 L 9.6656,2.2981 L 9.5519,2.1151 L 9.4511,1.9823 L 9.3498,1.8877 Z","a":[9.26,7.937]},"A20N":{"d":"M 9.2878,0.3959 L 9.2052,0.4006 L 9.1287,0.4419 L 9.0739,0.4853 L 9.0088,0.5561 L 8.9535,0.6326 L 8.9044,0.7055 L 8.8259,0.8471 L 8.7494,1.0041 L 8.6667,1.1907 L 8.5825,1.3953 L 8.5174,1.5664 L 8.4781,1.6920 L 8.4466,1.8201 L 8.4031,2.0516 L 8.3799,2.1757 L 8.3582,2.3741 L 8.3422,2.5431 L 8.3323,2.6945 L 8.3246,2.8423 L 8.3210,3.0014 L 8.3210,3.6815 L 8.3189,4.2830 L 8.3210,4.8194 L 8.3210,5.3698 L 8.3210,5.7708 L 8.3091,5.8121 L 8.2915,5.9656 L 8.2776,6.2054 L 8.2678,6.3449 L 8.2579,6.3961 L 8.2326,6.4570 L 8.2011,6.5041 L 8.1618,6.5397 L 7.0528,7.1040 L 7.0709,6.9821 L 7.0823,6.8426 L 7.0885,6.7087 L 7.0921,6.5630 L 7.0921,6.4787 L 7.0823,6.1976 L 7.0689,6.0266 L 7.0570,5.9305 L 7.0373,5.8612 L 7.0136,5.8121 L 6.9919,5.7847 L 6.8720,5.7692 L 6.7226,5.7594 L 6.5712,5.7532 L 6.4022,5.7573 L 6.2885,5.7651 L 6.2095,5.7672 L 6.1821,5.7749 L 6.1485,5.8121 L 6.1211,5.8674 L 6.1015,5.9284 L 6.0880,6.0421 L 6.0762,6.1604 L 6.0643,6.2741 L 6.0565,6.4116 L 6.0524,6.5630 L 6.0565,6.7325 L 6.0622,6.8090 L 6.0777,6.9464 L 6.1056,7.1567 L 6.1428,7.3593 L 6.1568,7.3846 L 6.2668,7.3965 L 6.2803,7.5009 L 5.0065,8.1572 L 1.5648,9.9287 L 1.4961,9.9834 L 1.4268,10.0563 L 1.3664,10.1390 L 1.3152,10.2372 L 1.2775,10.3493 L 1.2480,10.4614 L 1.2346,10.5793 L 1.2186,10.9901 L 1.2403,10.9782 L 1.2522,10.7973 L 3.5342,10.1390 L 3.5538,10.2273 L 3.5714,10.3865 L 3.5972,10.5085 L 3.6169,10.5359 L 3.6422,10.4728 L 3.6582,10.3591 L 3.6737,10.2196 L 3.6778,10.1173 L 3.7073,10.0816 L 5.2757,9.6315 L 5.2798,9.7101 L 5.2953,9.8088 L 5.3170,9.9028 L 5.3429,9.9504 L 5.3744,9.8873 L 5.3940,9.7927 L 5.4075,9.6904 L 5.4173,9.5886 L 6.2606,9.3426 L 6.5082,9.3426 L 6.5102,9.3840 L 6.5438,9.5080 L 6.5712,9.5530 L 6.6105,9.4491 L 6.6379,9.3406 L 6.8916,9.3468 L 6.8895,9.4212 L 6.9112,9.5276 L 6.9428,9.6455 L 6.9583,9.6610 L 6.9939,9.5803 L 7.0156,9.4801 L 7.0254,9.3406 L 8.3225,9.3426 L 8.3168,13.3801 L 8.3287,13.5708 L 8.3463,13.7713 L 8.3716,14.0230 L 8.4011,14.2648 L 8.4683,14.6932 L 8.5272,15.0234 L 8.5742,15.2637 L 8.6176,15.4699 L 8.6057,15.5288 L 8.5804,15.6017 L 8.5525,15.6585 L 8.4858,15.7371 L 8.4290,15.7924 L 6.4456,17.0052 L 6.3847,17.0445 L 6.3392,17.0956 L 6.3154,17.1582 L 6.3061,17.2408 L 6.2901,17.3571 L 6.2880,17.5163 L 6.2880,17.7106 L 6.3020,17.7168 L 8.8868,17.1427 L 8.9122,17.3354 L 8.9478,17.4848 L 9.0047,17.7302 L 9.0558,17.9111 L 9.1225,18.0703 L 9.1623,18.1255 L 9.2605,18.1255 L 9.3586,18.1255 L 9.3979,18.0703 L 9.4651,17.9111 L 9.5163,17.7302 L 9.5731,17.4848 L 9.6082,17.3354 L 9.6341,17.1427 L 12.2189,17.7168 L 12.2329,17.7106 L 12.2329,17.5163 L 12.2308,17.3571 L 12.2148,17.2408 L 12.2050,17.1582 L 12.1817,17.0956 L 12.1362,17.0445 L 12.0753,17.0052 L 10.0919,15.7924 L 10.0351,15.7371 L 9.9679,15.6585 L 9.9405,15.6017 L 9.9152,15.5288 L 9.9033,15.4699 L 9.9467,15.2632 L 9.9937,15.0234 L 10.0526,14.6932 L 10.1193,14.2648 L 10.1487,14.0230 L 10.1746,13.7713 L 10.1922,13.5708 L 10.2040,13.3801 L 10.1978,9.3426 L 11.4954,9.3406 L 11.5052,9.4801 L 11.5269,9.5803 L 11.5621,9.6610 L 11.5781,9.6455 L 11.6096,9.5276 L 11.6308,9.4212 L 11.6292,9.3468 L 11.8824,9.3406 L 11.9103,9.4491 L 11.9496,9.5530 L 11.9770,9.5080 L 12.0106,9.3840 L 12.0122,9.3426 L 12.2602,9.3426 L 13.1036,9.5886 L 13.1134,9.6904 L 13.1268,9.7927 L 13.1465,9.8873 L 13.1780,9.9504 L 13.2038,9.9028 L 13.2250,9.8088 L 13.2410,9.7101 L 13.2446,9.6315 L 14.8135,10.0816 L 14.8430,10.1173 L 14.8466,10.2196 L 14.8626,10.3591 L 14.8781,10.4728 L 14.9040,10.5359 L 14.9236,10.5085 L 14.9489,10.3865 L 14.9670,10.2273 L 14.9866,10.1390 L 17.2687,10.7973 L 17.2806,10.9782 L 17.3023,10.9901 L 17.2862,10.5793 L 17.2723,10.4614 L 17.2428,10.3493 L 17.2056,10.2372 L 17.1545,10.1390 L 17.0935,10.0563 L 17.0248,9.9834 L 16.9560,9.9287 L 13.5139,8.1572 L 12.2400,7.5009 L 12.2540,7.3965 L 12.3641,7.3846 L 12.3780,7.3593 L 12.4152,7.1567 L 12.4426,6.9464 L 12.4586,6.8090 L 12.4643,6.7325 L 12.4684,6.5630 L 12.4643,6.4116 L 12.4565,6.2741 L 12.4446,6.1604 L 12.4328,6.0421 L 12.4193,5.9284 L 12.3997,5.8674 L 12.3718,5.8121 L 12.3387,5.7749 L 12.3108,5.7672 L 12.2322,5.7651 L 12.1185,5.7573 L 11.9490,5.7532 L 11.7982,5.7594 L 11.6483,5.7692 L 11.5284,5.7847 L 11.5072,5.8121 L 11.4834,5.8612 L 11.4638,5.9305 L 11.4519,6.0266 L 11.4380,6.1976 L 11.4282,6.4787 L 11.4282,6.5630 L 11.4323,6.7087 L 11.4380,6.8426 L 11.4499,6.9821 L 11.4674,7.1040 L 10.3590,6.5397 L 10.3197,6.5041 L 10.2882,6.4570 L 10.2629,6.3961 L 10.2531,6.3449 L 10.2433,6.2054 L 10.2294,5.9656 L 10.2118,5.8121 L 10.1999,5.7708 L 10.1999,5.3698 L 10.1999,4.8194 L 10.2020,4.2830 L 10.1999,3.6815 L 10.1999,3.0014 L 10.1963,2.8423 L 10.1880,2.6945 L 10.1782,2.5431 L 10.1627,2.3741 L 10.1410,2.1757 L 10.1173,2.0516 L 10.0744,1.8201 L 10.0428,1.6920 L 10.0036,1.5664 L 9.9385,1.3953 L 9.8542,1.1907 L 9.7715,1.0041 L 9.6951,0.8471 L 9.6160,0.7055 L 9.5669,0.6326 L 9.5121,0.5561 L 9.4470,0.4853 L 9.3922,0.4419 L 9.3152,0.4006 Z","a":[9.26,7.937]},"A169":{"d":"M 9.0631,3.6048 L 9.1926,3.6389 L 9.2982,3.7002 L 9.4140,3.8160 L 9.5128,3.9557 L 9.6082,4.1329 L 9.7105,4.3816 L 9.7990,4.6849 L 9.9115,5.0937 L 9.9626,5.3118 L 9.9932,5.6559 L 10.0035,5.9387 L 10.0035,8.4702 L 10.1806,8.4702 L 10.2488,8.4736 L 10.3169,8.5009 L 10.3714,8.5656 L 10.4089,8.7019 L 10.3953,8.8927 L 10.3510,9.1415 L 10.2829,9.3595 L 10.1909,9.5537 L 10.0955,9.6934 L 9.8842,9.6934 L 9.8229,9.9490 L 9.7513,10.2215 L 9.6662,10.4668 L 9.5639,10.6917 L 9.4481,10.8450 L 9.4447,11.2437 L 9.4311,11.5912 L 9.4140,11.9115 L 9.3902,12.2556 L 9.3629,12.6202 L 9.3254,13.0120 L 9.2811,13.4038 L 9.2334,13.7445 L 9.2232,13.8604 L 9.2028,13.9762 L 9.1857,14.0410 L 9.1857,14.0682 L 10.3987,14.0682 L 10.4703,14.1159 L 10.5350,14.1977 L 10.5861,14.2965 L 10.6099,14.4260 L 10.6099,14.5350 L 10.5963,14.5963 L 10.5588,14.6270 L 9.1619,14.6270 L 9.1551,14.7258 L 9.2130,14.7463 L 9.2777,14.7701 L 9.3084,14.8144 L 9.3084,14.9643 L 9.6866,14.9643 L 9.6866,15.0563 L 9.3016,15.0563 L 9.3016,15.2948 L 9.2494,15.3236 L 9.1744,15.3509 L 9.0857,15.3646 L 8.9834,15.3441 L 8.9186,15.3100 L 8.8436,15.2554 L 8.7890,15.1736 L 8.7549,15.0508 L 8.7583,14.9587 L 8.8061,14.8632 L 8.8674,14.7950 L 8.9186,14.7575 L 8.9595,14.7336 L 8.9595,14.6211 L 7.5817,14.6211 L 7.5407,14.6040 L 7.5169,14.5801 L 7.5100,14.4369 L 7.5271,14.3278 L 7.5646,14.2323 L 7.6158,14.1607 L 7.7147,14.0720 L 8.9323,14.0720 L 8.9288,14.0038 L 8.8879,13.7855 L 8.8504,13.5092 L 8.8231,13.2466 L 8.7924,12.9397 L 8.7413,12.4110 L 8.7003,11.6607 L 8.6833,11.2071 L 8.6696,10.8422 L 8.5776,10.7262 L 8.4957,10.5591 L 8.4309,10.3920 L 8.3456,10.1362 L 8.2604,9.7849 L 8.2365,9.6928 L 8.0421,9.6928 L 7.9534,9.5905 L 7.8647,9.4234 L 7.7897,9.2221 L 7.7488,9.0141 L 7.7317,8.8265 L 7.7249,8.6321 L 7.7522,8.5571 L 7.7999,8.5025 L 7.8613,8.4752 L 7.9330,8.4582 L 8.1205,8.4582 L 8.1205,5.8082 L 8.1615,5.3034 L 8.2160,5.0169 L 8.3218,4.6929 L 8.4514,4.2803 L 8.5673,4.0142 L 8.6867,3.8335 L 8.7924,3.7209 L 8.9084,3.6425 L 9.0141,3.6084 Z M 7.3122,2.0986 L 7.2755,2.1068 L 7.2140,2.1621 L 7.1448,2.2335 L 7.0838,2.3373 L 7.0611,2.4433 L 7.2347,3.0226 L 7.2549,3.0530 L 8.7090,7.3587 L 8.7540,7.3365 L 8.8336,7.5386 L 9.0764,7.8543 L 9.0764,7.4548 L 8.9989,7.2631 L 9.0336,7.2466 L 8.3339,5.1785 L 8.0972,4.4788 L 7.9137,3.9326 L 7.7385,3.4019 L 7.5732,2.9311 L 7.4998,2.7781 L 7.4672,2.6758 L 7.4321,2.5802 L 7.4099,2.4660 L 7.3954,2.3699 L 7.3877,2.2619 L 7.3794,2.1906 L 7.3546,2.1317 L 7.3122,2.0986 Z M 9.0764,7.8543 L 9.4563,7.7308 L 9.6149,7.5980 L 9.6413,7.6259 L 11.3921,6.3216 L 11.9843,5.8803 L 12.4473,5.5366 L 12.8974,5.2064 L 13.2943,4.9036 L 13.4173,4.7863 L 13.5041,4.7237 L 13.5847,4.6612 L 13.6865,4.6044 L 13.7728,4.5615 L 13.8731,4.5201 L 13.9387,4.4902 L 13.9873,4.4488 L 14.0053,4.3982 L 13.9862,4.3656 L 13.9149,4.3243 L 13.8255,4.2804 L 13.7077,4.2545 L 13.5997,4.2659 L 13.1026,4.6095 L 13.0798,4.6385 L 9.4340,7.3520 L 9.4692,7.3882 L 9.3018,7.5262 L 9.0764,7.8543 Z M 9.0764,7.8543 L 9.3111,8.1778 L 9.4868,8.2873 L 9.4682,8.3209 L 11.2500,9.5829 L 11.8525,10.0102 L 12.3222,10.3441 L 12.7760,10.6701 L 13.1863,10.9544 L 13.3356,11.0350 L 13.4219,11.0980 L 13.5067,11.1554 L 13.5919,11.2345 L 13.6596,11.3037 L 13.7299,11.3864 L 13.7785,11.4396 L 13.8327,11.4727 L 13.8870,11.4742 L 13.9118,11.4458 L 13.9289,11.3652 L 13.9428,11.2670 L 13.9314,11.1466 L 13.8870,11.0479 L 13.4064,10.6810 L 13.3718,10.6681 L 9.6645,8.0398 L 9.6413,8.0843 L 9.4583,7.9675 L 9.0764,7.8543 Z M 9.0764,7.8543 L 8.8413,8.1778 L 8.7912,8.3788 L 8.7535,8.3716 L 8.1039,10.4557 L 7.8843,11.1611 L 7.7117,11.7109 L 7.5417,12.2432 L 7.3985,12.7212 L 7.3680,12.8881 L 7.3344,12.9899 L 7.3060,13.0881 L 7.2569,13.1935 L 7.2120,13.2793 L 7.1551,13.3718 L 7.1200,13.4343 L 7.1050,13.4963 L 7.1205,13.5480 L 7.1551,13.5630 L 7.2368,13.5547 L 7.3350,13.5377 L 7.4455,13.4891 L 7.5262,13.4168 L 7.7261,12.8462 L 7.7277,12.8096 L 9.0821,8.4713 L 9.0325,8.4630 L 9.0868,8.2527 L 9.0764,7.8543 Z M 9.0764,7.8543 L 8.6961,7.7308 L 8.4899,7.7453 L 8.4848,7.7075 L 6.3019,7.7339 L 5.5635,7.7427 L 4.9868,7.7484 L 4.4282,7.7509 L 3.9290,7.7628 L 3.7610,7.7851 L 3.6540,7.7845 L 3.5517,7.7882 L 3.4365,7.7742 L 3.3409,7.7582 L 3.2355,7.7323 L 3.1652,7.7184 L 3.1011,7.7230 L 3.0572,7.7540 L 3.0536,7.7913 L 3.0871,7.8667 L 3.1331,7.9546 L 3.2132,8.0450 L 3.3073,8.0987 L 3.9119,8.1132 L 3.9470,8.1029 L 8.4915,8.0507 L 8.4842,8.0011 L 8.7008,7.9876 L 9.0764,7.8543 Z","a":[8.996,6.35]},"SF34":{"d":"M 9.2604,1.0382 C 8.2430,1.4583 8.2986,3.8526 8.2986,3.8526 L 8.2986,7.4010 L 6.8256,7.5731 L 6.8256,7.2339 L 6.8256,6.9809 L 6.9016,6.7834 L 6.8003,6.6873 C 6.7649,6.0140 6.7193,5.9280 6.7193,5.9280 C 6.9066,5.9482 7.0332,5.9432 7.0332,5.9432 C 7.7925,5.9280 7.7874,5.8622 7.7874,5.8622 C 7.6507,5.7762 7.0332,5.8116 7.0332,5.8116 L 6.6890,5.8217 C 6.5725,5.4674 6.4865,5.4674 6.4865,5.4674 C 6.3650,5.4978 6.2688,5.8268 6.2688,5.8268 L 5.9398,5.8217 C 5.1805,5.8268 5.1856,5.8825 5.1856,5.8825 C 5.1957,5.9635 5.9347,5.9483 5.9347,5.9483 C 6.0562,5.9685 6.2435,5.9432 6.2435,5.9432 C 6.0917,6.4798 6.1220,7.2289 6.1220,7.2289 L 6.1220,7.6592 L 0.6501,8.3071 C 0.4122,8.3830 0.4173,8.6969 0.4173,8.6969 L 0.3819,8.7728 L 0.4173,8.8234 L 0.4173,9.2030 L 6.2385,9.5473 C 6.2436,9.7750 6.4662,9.7700 6.4662,9.7700 C 6.6687,9.7902 6.6940,9.5675 6.6940,9.5675 L 8.2835,9.6637 L 8.2835,13.5006 C 8.2835,14.3308 8.4252,14.7509 8.4252,14.7509 L 5.8841,15.1761 C 5.6614,15.2318 5.6513,15.4494 5.6513,15.4494 L 5.6564,15.9455 C 5.6564,16.0062 5.7576,16.0113 5.7576,16.0113 L 8.6479,16.4061 L 8.8859,16.6136 C 9.0377,17.4134 9.2098,17.4134 9.2098,17.4134 L 9.2301,17.5248 L 9.2503,17.4185 C 9.4427,17.4033 9.5844,16.5985 9.5844,16.5985 L 9.8172,16.3808 L 12.7481,15.9556 C 12.8341,15.9353 12.8291,15.8948 12.8291,15.8948 L 12.8291,15.4949 C 12.8189,15.1811 12.6114,15.1457 12.6114,15.1457 L 10.0501,14.7306 C 10.2070,13.9511 10.1918,13.4955 10.1918,13.4955 L 10.1918,9.6383 L 11.7509,9.5472 C 11.7762,9.7598 11.9837,9.7497 11.9837,9.7497 C 12.2115,9.7548 12.2166,9.5118 12.2166,9.5118 L 18.0631,9.1575 L 18.0631,8.8082 L 18.1289,8.7424 L 18.0681,8.6715 C 18.0377,8.2564 17.8504,8.2514 17.8504,8.2514 L 12.3583,7.6237 L 12.3583,7.2137 L 12.3583,6.9302 C 12.3988,6.8847 12.3988,6.8189 12.3988,6.8189 C 12.4039,6.6873 12.3330,6.6518 12.3330,6.6518 C 12.3330,6.2368 12.2368,5.9128 12.2368,5.9128 C 12.3633,5.9482 12.5355,5.9179 12.5355,5.9179 C 13.3200,5.9786 13.2998,5.8470 13.2998,5.8470 C 13.2947,5.7711 12.5304,5.8065 12.5304,5.8065 C 12.4038,5.8014 12.2064,5.8116 12.2064,5.8116 C 12.0849,5.4471 11.9888,5.4471 11.9888,5.4471 C 11.8976,5.4522 11.7812,5.8166 11.7812,5.8166 C 10.6676,5.7761 10.7030,5.8723 10.7030,5.8723 C 10.7030,5.9432 11.4421,5.9432 11.4421,5.9432 C 11.6041,5.9533 11.7458,5.9280 11.7458,5.9280 C 11.6041,6.4747 11.6192,7.2188 11.6192,7.2188 L 11.6192,7.5478 L 10.2070,7.3858 L 10.2070,3.8577 C 10.2070,1.3619 9.2604,1.0382 9.2604,1.0382 Z","a":[9.26,8.467]},"ASK21":{"d":"M 9.2607,5.0358 L 9.2261,5.0518 L 9.1920,5.1180 L 9.1284,5.2900 L 9.0860,5.4404 L 9.0359,5.6311 L 9.0013,5.8218 L 8.9615,6.0492 L 8.9217,6.4166 L 8.9088,6.6657 L 8.9005,6.9086 L 8.9005,7.1018 L 8.9005,7.3214 L 8.9088,7.5064 L 8.9088,7.6548 L 8.9005,7.6734 L 3.9282,7.6734 L 2.7092,7.6940 L 1.6989,7.7028 L 0.7527,7.7147 L 0.7000,7.7178 L 0.6674,7.7411 L 0.6297,7.8113 L 0.6059,7.8961 L 0.6002,7.9958 L 0.6121,8.2062 L 0.6225,8.2289 L 3.9747,8.7038 L 8.6638,9.1513 L 8.7574,9.1699 L 8.8633,9.2014 L 8.9258,9.2262 L 8.9718,9.2764 L 8.9863,9.3451 L 9.1465,12.7284 L 7.7848,12.9490 L 7.7538,12.9511 L 7.7311,12.9764 L 7.7119,13.0514 L 7.7037,13.1263 L 7.7037,13.3759 L 9.1656,13.4803 L 9.2323,13.3697 L 9.2610,13.6157 L 9.2891,13.3697 L 9.3558,13.4803 L 10.8172,13.3759 L 10.8172,13.1263 L 10.8089,13.0514 L 10.7903,12.9764 L 10.7670,12.9511 L 10.7360,12.9490 L 9.3744,12.7284 L 9.5345,9.3451 L 9.5490,9.2764 L 9.5950,9.2262 L 9.6575,9.2014 L 9.7635,9.1699 L 9.8575,9.1513 L 14.5461,8.7038 L 17.8984,8.2289 L 17.9087,8.2061 L 17.9206,7.9958 L 17.9149,7.8961 L 17.8916,7.8113 L 17.8534,7.7411 L 17.8214,7.7178 L 17.7687,7.7147 L 16.8225,7.7028 L 15.8117,7.6940 L 14.5931,7.6734 L 9.6204,7.6734 L 9.6126,7.6548 L 9.6126,7.5064 L 9.6204,7.3214 L 9.6204,7.1018 L 9.6204,6.9086 L 9.6126,6.6657 L 9.5992,6.4166 L 9.5594,6.0492 L 9.5196,5.8218 L 9.4855,5.6311 L 9.4354,5.4404 L 9.3930,5.2900 L 9.3294,5.1180 L 9.2948,5.0518 Z","a":[9.26,8.202]}},"designators":{"B190":"B190D","A388":"A388","AS50":"AS50","R44":"R44","A139":"A139","B06":"B06","A148":"A148","P28A":"P28A","C208":"C208","C402":"C402","A225":"A225","AN12":"AN12","E290":"E290","A343":"A343","E295":"E290","A337":"A337","RV9":"RV9","B762":"B772","A332":"A332","B772":"B772","AS65":"AS65","H25A":"H25A","A306":"A306","A35K":"A35K","B190C":"B190D","A310":"A310","C182":"C182","B412":"B412","A30B":"A306","C210":"C210","AS55":"AS55","PC21":"PC21","EC45":"EC45","A359":"A359","AN28":"AN28","A119":"A119","AC90":"AC90","A140":"A140","A342":"A342","P32T":"P32T","B77W":"B77W","AN24":"AN24","DH8B":"DH8B","A345":"A345","A321":"A321","A3ST":"A3ST","F70":"F70","B738":"B738","C72R":"C172","A320":"A320","F28":"F28","A158":"A158","C172":"C172","B350":"B350","PC12":"PC12","PA44":"PA44","A21N":"A21N","P68":"P68","A124":"A124","A333":"A333","GLEX":"GLEX","F16":"F16","DH8A":"DH8A","B214":"B214","AJ27":"AJ27","A748":"A748","C441":"C441","SR22":"SR22","SW3":"SW3","AT25":"AT25","F100":"F100","AT75":"AT75","DHC5":"DHC5","CT4":"CT4","A109":"A109","A319":"A319","E190":"E190","A318":"A318","AN26":"AN26","E195":"E190","TWEN":"TWEN","SONX":"SONX","A19N":"A19N","B752":"B752","A400":"A400","EC35":"EC45","PA31":"PA31","C560":"C560","DA42":"DA42","SW4":"SW4","A338":"A338","BE36":"BE36","B38M":"B38M","A346":"A346","DH8D":"DH8D","C206":"C206","A339":"A339","HAWK":"HAWK","BL8":"BL8","B789":"B789","DH8C":"DH8C","B190D":"B190D","A20N":"A20N","A169":"A169","SF34":"SF34","ASK21":"ASK21"},"categories":{"A1":"C172","A2":"DH8B","A3":"B738","A4":"B752","A5":"B77W","A6":"F16","A7":"B06"}};

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
    const AIRCRAFT_INFO_TIMEOUT_MS = 90000;
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
    const DAILY_SUMMARY_TIMEOUT_MS = 90000;
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
