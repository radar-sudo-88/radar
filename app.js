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
    // The previous version depended on a local pw-silhouettes spritesheet. If the
    // JSON file was not physically deployed beside this HTML file, the web server
    // returned the site's HTML page instead of JSON, producing:
    //   Unexpected token '<', "<!DOCTYPE ..." is not valid JSON
    //
    // These silhouettes are now drawn directly on the radar canvas. This removes the
    // external/local spritesheet dependency entirely and gives the scope the same
    // compact top-down aircraft look as the reference image: bright filled aircraft,
    // dark outline, nose pointing along track, with different shapes for airliners,
    // light aircraft, helicopters and military aircraft.
    // ---------------------------------------------------------------------

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

    // Compatibility wrapper: keep the existing render call unchanged while making
    // the silhouette implementation completely self-contained.
    function drawPwSilhouette(ctx, ac, pt, heading, colorHex) {
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
