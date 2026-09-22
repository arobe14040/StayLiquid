# StayLiquid

A Home Assistant add-on for managing a sprinkler system: pick any switch/valve
entities as zones, build watering programs from lawn growth-stage presets (or
fully custom schedules), run zones sequentially or simultaneously, and hit a
rain-delay button when you don't want the schedule to run.

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

Early scaffold — see open items in `stayliquid/DOCS.md`. Weather-based rain
delay is intentionally not implemented yet; for now rain delay is manual
(24h/48h/72h/custom buttons in the UI).
