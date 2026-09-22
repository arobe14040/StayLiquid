# StayLiquid

A Home Assistant add-on for managing a sprinkler system: pick any switch/valve
entities as zones, build watering programs from lawn growth-stage presets (or
fully custom schedules), run several watering cycles a day, run zones
sequentially or simultaneously, and hit a rain-delay button when you don't
want the schedule to run.

The four growth-stage presets walk a new lawn from seed to established turf -
frequent short cycles while the seed bed has to stay damp, tapering to long
infrequent soaks that drive roots deeper. Pick one and the builder shows
exactly when each zone will start, for however many zones you have.

## Install

1. In Home Assistant: **Settings → Add-ons → Add-on Store → ⋮ (top right) → Repositories**
2. Add: `https://github.com/arobe14040/StayLiquid`
3. Find **StayLiquid** in the store, click **Install**, then **Start**.
4. Open it from the sidebar (it runs via Ingress — no extra port or login needed).

See [`stayliquid/DOCS.md`](stayliquid/DOCS.md) for how the add-on itself works
(zones, programs, presets, rain delay).

## Requirements

- Home Assistant OS or Supervised (this is a Supervisor add-on, not a
  Container/Core-compatible integration).
- One or more `switch.*` or `valve.*` entities that control your sprinkler
  valves (relay board, smart valve controller, etc. — anything already
  exposed to HA works).

## Status

Working, actively being built out — see open items in `stayliquid/DOCS.md`.
Weather-based rain delay is intentionally not implemented yet; for now rain
delay is manual (12h/24h/48h/72h/custom buttons in the UI).
