# StayLiquid

## What it does

- **Zones** - wrap any `switch.*` or `valve.*` entity that controls a
  sprinkler valve as a named zone.
- **Programs** - a schedule (specific weekdays, or "every N days") plus an
  ordered list of zones with a duration each. Each program can be built from
  a lawn growth-stage preset or fully custom, and runs its zones either
  **sequentially** (one at a time - typical for most residential water
  pressure/flow) or **simultaneously** (all at once).
- **Dashboard** - what's running right now, the next few scheduled runs, and
  rain-delay buttons (24h / 48h / 72h / custom). A rain delay suspends every
  *scheduled* run until it expires; manual "Run now" / zone test-fires still
  work during a delay.
- **History** - a log of every run: which zone, which program, when, and
  whether it completed, errored, or was skipped for rain delay.

Weather-based auto rain-delay is not implemented yet - it's a manual button
for now, by design.

## First-time setup

1. Install and start the add-on (see the repo README for adding this
   repository to your Supervisor).
2. Open StayLiquid from the sidebar.
3. **Zones tab** - for each sprinkler valve, pick its entity from the
   dropdown (only `switch.*`/`valve.*` entities show up) and give it a
   name. Use **Run** with a short duration to test that the right valve
   actually turns on before you build a schedule around it.
4. **Programs tab** - click a growth-stage preset to prefill a sensible
   schedule and duration, adjust as needed, add your zones with a duration
   each, and save. Repeat for as many programs as you want (e.g. one per
   zone group, or one per season).
5. Check the **Dashboard** to confirm the next run times look right.

## Growth-stage presets

Presets are just starting points - picking one prefills the program form,
but the program you save is a fully independent, editable schedule. Default
presets assume a cool-season New England lawn:

| Preset | Typical window | Schedule |
|---|---|---|
| New Seed / Germination | Apr-May or late Aug-Sep | Daily, short duration |
| Establishment | 2-6 weeks after germination | Every other day |
| Active Growth | May-Jun, Sep-Oct | 2x/week |
| Peak Summer | Jul-Aug | 3x/week, deeper watering |
| Dormant / Winter Shutdown | Nov-Mar | Created disabled |

If you're on warm-season grass, the seasons run in the opposite direction -
create custom programs instead, or use the presets as a rough template and
shift the months.

## Sequential vs. simultaneous

Set per-program in the **Zone run mode** field:
- **One zone at a time** - zones run in the order you added them, each for
  its own duration, one after another. Use this if your water supply can't
  support multiple zones open at once (most residential setups).
- **All zones together** - every zone in the program turns on immediately;
  each turns off independently once its own duration elapses.

## Rain delay

The three preset buttons (24h/48h/72h) and the custom-hours field all do the
same thing: set a single "delay until" timestamp. While active, every
*scheduled* program run is skipped and logged as `skipped_rain_delay` -
nothing is deleted or disabled, the schedule just resumes normally once the
delay expires (or you hit Clear). Manual "Run now" and zone test-fires
ignore the delay on purpose, so you can still hand-water if needed.

## Data & backups

Everything (zones, programs, rain-delay state, run history) lives in a
SQLite database at `/data/stayliquid.db` inside the add-on's own persistent
storage - it's included automatically in Home Assistant's normal add-on
backups.

## Known gaps / open items

- No weather API integration (planned as a future, opt-in feature - the
  manual rain-delay buttons are intentional for now).
- No notifications (persistent notification / mobile push on run
  start/finish, or on error) yet.
- No per-zone flow-rate/water-usage tracking.
- History has no pagination past the most recent 50 runs in the UI (the
  full log is retained in the database; the `limit` query param on
  `/api/history` can be raised).
