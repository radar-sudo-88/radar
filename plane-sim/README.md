# plane-sim

Fly a fake aircraft with WASD that shows up live on the actual radar site (aero-sentry.co.uk or
wherever it's deployed) for anyone currently viewing it. Personal/admin tool - not linked from
the radar app itself, and there's no reason to leave this running when you're not using it.

## How it works

It rides on the `/api/simulate` feature already built into `cors-proxy/server.js` (see the
comment above `SIMULATE_KEY` there): that endpoint splices fake aircraft into every live
point-lookup response, server-side, so anyone's browser shows them exactly like a real one.

This server keeps the actual flight physics (speed, heading, altitude, position) in itself, not
in your browser - the page just reports which keys are currently held, about 10 times a second.
Roughly every 800ms this pushes the current position to cors-proxy under a fixed hex (`SIMWASD1`).
Stop flying (or close the tab) and it clears from the feed within ~15 seconds either way, since
every push sets a short TTL.

**Why the key never touches the browser:** unlike `pi-tools`, a leaked `SIMULATE_KEY` doesn't
just expose your Pi - it lets anyone reach your live *internet-facing* radar site and inject
aircraft onto it for every real visitor. So it's resolved server-side only (same order as
`deploy/simulate.js`: `$SIMULATE_KEY`, `~/.radar-simulate-key`, or the `radar.service` unit) and
the page itself talks only to this local server. Still: **keep this on your LAN only**, same as
`pi-tools` - never expose port 1113 through the tunnel or the internet.

## Requirements

cors-proxy needs `SIMULATE_KEY` set already (see the comment above `SIMULATE_KEY` in
`cors-proxy/server.js` for how to generate one) - without it, this refuses to start.

## Run it directly

```bash
cd plane-sim
node server.js
# or against a proxy on a different port:
PORT=1113 PROXY_URL=http://localhost:10004 node server.js
```

Open `http://192.168.0.187:1113` (swap in the Pi's LAN IP). Optionally enter a UK postcode to
choose a starting point, then **Take off**.

**Controls:** `W`/`S` throttle, `A`/`D` turn, `↑`/`↓` climb/descend. **Land / clear** removes it
from the feed immediately.

## Run it as a service

```bash
./plane-sim/install-service.sh
```

Custom port or proxy target:

```bash
PORT=1113 PROXY_URL=http://localhost:10004 ./plane-sim/install-service.sh
```

Remove it:

```bash
./plane-sim/install-service.sh uninstall
```
