# StayLiquid

## What it does

- **Zones** - wrap any `switch.*` or `valve.*` entity that controls a
  sprinkler valve as a named zone. The pencil next to a zone renames it;
  programs using it follow the new name straight away.
- **Programs** - a schedule (specific weekdays, or "every N days"), one or
  more **daily cycles**, and an ordered list of zones with a duration each.
  Each program can be built from a lawn growth-stage preset or fully custom,
  and runs its zones either **sequentially** (one at a time - typical for
  most residential water pressure/flow) or **simultaneously** (all at once).
- **Cycles** - one cycle waters every zone in the program once. A seedling
  program might run three cycles a day; established turf runs one. The
  Programs tab previews exactly when each zone starts and warns you if one
  cycle would still be running when the next is due to begin.
- **Dashboard** - what's running right now, the next few scheduled runs, and
  rain-delay buttons (12h / 24h / 48h / 72h / custom). A rain delay suspends
  every *scheduled* run until it expires; manual "Run now" / zone test-fires
  still work during a delay.
- **History** - an overview of the last two weeks: how much water went out,
  how long the system ran, a daily activity chart, and a log of every run.
  Anything that errored or was skipped is pulled out into a panel at the top.

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
4. **Programs tab** - hit **New program**. Pick the growth stage your lawn is
   at and the rest is filled in for you: cycle times, per-zone runtime, and
   every zone you've configured. Step through the schedule and zones, check the
   preview of exactly when each zone will start, and save. Repeat for as many
   programs as you want (e.g. one per zone group, or one per growth stage as
   the lawn matures).
5. Check the **Dashboard** to confirm the next run times look right.

## Growth-stage presets

Presets are starting points - picking one prefills the program builder (cycle
times, per-zone runtime, how often it repeats, and every zone you've
configured), but the program you save is a fully independent, editable
schedule. The four stages walk a new lawn from seed to established turf:

| Stage | When | Per zone | Cycles/day | Water per cycle |
|---|---|---|---|---|
| 1 - Before Germination | Seed down until sprouts (7-14 days) | 10 min | 3 (8:00, 11:30, 15:00) | ~0.07" |
| 2 - Sprouting | First sprouts through ~week 3 | 15 min | 2 (8:00, 13:00) | ~0.10" |
| 3 - Young Grass | ~Weeks 3-8, after the first mow | 40 min | 1 (6:00) | ~0.27" |
| 4 - Rooting In | Week 8 onward - your normal season | 75 min | 1 (5:00), every 3rd day | ~0.50" |

The progression is deliberate: early stages keep the seed bed damp with
frequent short cycles, then taper to long infrequent soaks that drive roots
deeper and make the lawn drought-tolerant.

### How the zone start times are worked out

Cycle times are when the *cycle* starts. In sequential mode each zone starts
when the previous one finishes, so a 4-zone Stage 1 program looks like this:

| Cycle | Zone 1 | Zone 2 | Zone 3 | Zone 4 |
|---|---|---|---|---|
| Morning | 8:00 | 8:10 | 8:20 | 8:30 |
| Midday | 11:30 | 11:40 | 11:50 | 12:00 |
| Afternoon | 3:00 | 3:10 | 3:20 | 3:30 |

Add or remove zones, change a duration, or switch to simultaneous mode and
the preview recalculates - so the schedule scales to however many zones you
actually have. In simultaneous mode every zone starts at the cycle time.

### Water estimates

The inch figures assume a precipitation rate of **0.4 in/hr**, typical for a
residential pop-up spray zone with head-to-head coverage. That's what makes
10 minutes ≈ 0.07" and 75 minutes ≈ 0.5". If you catch-cup your own zones and
measure something different, the estimates scale linearly - change
`PRECIP_RATE_IN_PER_HR` in `app/presets.py` and `PRECIP_RATE` in `web/app.js`
to match. The estimates are advisory only; they never affect run times.

## Sequential vs. simultaneous

Set per-program in the **Zone run mode** field:
- **One zone at a time** - zones run in the order you added them, each for
  its own duration, one after another. Use this if your water supply can't
  support multiple zones open at once (most residential setups).
- **All zones together** - every zone in the program turns on immediately;
  each turns off independently once its own duration elapses.

## Rain delay

The preset buttons (12h/24h/48h/72h) and the custom-hours field all do the
same thing: set a single "delay until" timestamp. While active, every
*scheduled* program run is skipped and logged as `skipped_rain_delay` -
nothing is deleted or disabled, the schedule just resumes normally once the
delay expires (or you hit Clear). Manual "Run now" and zone test-fires
ignore the delay on purpose, so you can still hand-water if needed.

## Timezone

Cycle times are local times: "08:00" means 8am where the sprinklers are. On
startup the add-on asks Supervisor for Home Assistant's configured timezone
and schedules in it, so changing the timezone in Home Assistant and restarting
the add-on is all that's needed. If Supervisor can't be reached it falls back
to the `TZ` variable Supervisor injects, then to the container's local zone.
The zone it settled on is logged at startup:

```
StayLiquid ready - 3 job(s) scheduled in America/New_York
```

## When things go wrong

A stuck-open valve is the expensive failure, so closing one is treated as more
important than opening one.

| What happens | What the add-on does |
|---|---|
| Zone entity is `unavailable` in HA | Skipped before the valve is touched, logged `skipped_unavailable`. Other zones in the program continue. |
| The turn-on call fails | That zone is logged `error` and the wait is abandoned immediately (it doesn't sit there for 40 minutes doing nothing). The rest of the program continues. |
| The turn-off call fails | Retried 4 times, 5 seconds apart. If every attempt fails the run is logged `error` and a `GAVE UP closing ...` line is written to the log - worth an eye on. |
| HA or Supervisor restarts mid-run | The wait is unaffected; the turn-off at the end simply happens once HA answers again. |
| The add-on is stopped or restarted mid-run | Open valves are closed during shutdown, before the run tasks are torn down, and their runs are logged `interrupted`. |
| The add-on is killed outright, or the host loses power | Nothing can run at that moment, so a valve can be left open. On next startup any run still marked `running` is treated as exactly that: the add-on closes that zone's valve and logs the run `interrupted`. Only zones this add-on opened are touched, so a zone you switched on by hand is left alone. |

Two things it deliberately does **not** do. It doesn't verify that a valve
physically responded - Home Assistant accepts a service call for an entity
whose device is offline, so a zone can report success without water moving; the
`unavailable` pre-check catches the common case but not a dead solenoid. And it
has no hardware watchdog: if the whole machine is off, nothing closes a valve
until it comes back. For a system that can flood something, a mechanical timer
or a normally-closed valve is the right backstop, not software.

## Data & backups

Everything (zones, programs, rain-delay state, run history) lives in a
SQLite database at `/data/stayliquid.db` inside the add-on's own persistent
storage - it's included automatically in Home Assistant's normal add-on
backups.

## Known gaps / open items

- No weather API integration (planned as a future, opt-in feature - the
  manual rain-delay buttons are intentional for now).
- No confirmation that a valve physically opened (see "When things go wrong").
- Rain delay is checked when a program starts, not before each zone, so a
  delay set mid-program won't stop the zones already under way.
- No notifications (persistent notification / mobile push on run
  start/finish, or on error) yet.
- No per-zone flow-rate/water-usage tracking.
- History has no pagination past the most recent 50 runs in the UI (the
  full log is retained in the database; the `limit` query param on
  `/api/history` can be raised).
