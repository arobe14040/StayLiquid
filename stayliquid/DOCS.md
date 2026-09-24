# StayLiquid

## What it does

- **Zones** - wrap any `switch.*` or `valve.*` entity that controls a
  sprinkler valve as a named zone. Each zone is a card: the pencil renames it
  (programs using it follow the new name straight away), and its switch opens
  the valve for the minutes in **Run for** and counts down - switching it off
  closes the valve immediately. The card says what the zone is doing or when it
  last ran today, and tracks what Home Assistant reports, so a zone switched on
  or off elsewhere shows up here too.
- **Programs** - a schedule (specific weekdays, or "every N days"), one or
  more **daily cycles**, and an ordered list of zones with a duration each.
  Each program can be built from a lawn growth-stage preset or fully custom,
  and runs its zones either **sequentially** (one at a time - typical for
  most residential water pressure/flow) or **simultaneously** (all at once).
  The Programs tab shows each as a card with the days it runs, its cycle
  times and its next run.
- **Cycles** - one cycle waters every zone in the program once. A seedling
  program might run three cycles a day; established turf runs one. The
  Programs tab previews exactly when each zone starts and warns you if one
  cycle would still be running when the next is due to begin.
- **Dashboard** - today as a timeline: a lane per zone with everything that
  watered, is watering and is still to come, and a line at the current time.
  Below it, a collapsible panel of zone switches, then the next cycle, today's
  water per zone, and rain-delay buttons (12h / 24h / 48h / 72h / custom). A
  rain delay suspends every *scheduled* run until it expires; manual "Run now"
  and zone switches still work during a delay.
- **History** - one day at a time (today by default; pick another with the
  date control), as a timeline of runs. A program shows as one run with its
  zones as numbered steps, so you can see at a glance which step failed and
  which watered, and what went wrong is written on the run with an
  **Acknowledge** button. Anything that errored or was skipped, on any day, is
  also collected in a panel at the top, which can be marked as seen in one go.
- **Times are the lawn's.** Schedules run in Home Assistant's timezone, and
  every time on the page is shown in it, wherever you're viewing from.

Weather-based auto rain-delay is not implemented yet - it's a manual button
for now, by design.

## First-time setup

1. Install and start the add-on (see the repo README for adding this
   repository to your Supervisor).
2. Open StayLiquid from the sidebar.
3. **Zones tab** - hit **Add a zone**, then for each sprinkler valve pick its
   entity from the dropdown (only `switch.*`/`valve.*` entities show up) and
   give it a name. Flip its switch with a short **Run for** time to test that
   the right valve actually turns on before you build a schedule around it.
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

## Zone switches

The **Zone control** panel on the Dashboard is a switch per zone, for the times
you just want a zone on now - moving a sprinkler, checking a head, watering a
dry patch. Collapse it with the heading if you don't need it; it stays how you
left it.

- **It shows the valve, not just what the add-on is doing.** A zone switched on
  in Home Assistant or by hand reads as on here, labelled *On - opened
  elsewhere*, and switching it off here closes it.
- **Turning one on waters it for 10 minutes**, not indefinitely. A switch with
  no timer behind it is one forgotten tap away from watering all night. For a
  specific length, use the zone's switch and **Run for** on the Zones tab.
- A zone whose state can't be read shows as *State unknown* and can't be
  switched, rather than guessing. Disabled zones and a paused system are shown
  and locked for the same reason.

## Pause

**Pause watering** on the Dashboard is for when you need the pressure indoors -
a shower, filling something, washing the car. It shuts every open valve at once
and holds the schedule.

It is deliberately system-wide. Pausing a single zone would just hand the
pressure to the next zone in the program, which is the opposite of what you
wanted.

- **Runs already going keep the time they still owe.** A zone 6 minutes into a
  20-minute run resumes with 14 minutes left, not 20 and not nothing.
- **Programs due during a pause are skipped**, logged `skipped_paused`, rather
  than queued to run hours later on top of the next cycle. A pause is meant to
  be short.
- **Manual runs are refused while paused** instead of silently sitting and
  waiting for a resume that might not come.
- **It expires on its own** (two hours by default, and the Dashboard shows when).
  A pause left on by accident would otherwise stop the lawn being watered
  indefinitely. When it expires, held runs are ended and logged
  `paused_expired` rather than valves reopening after a long unattended gap -
  and a program that was held doesn't move on to its remaining zones either.
  The schedule then carries on normally with the next cycle.
- **It survives a restart**, so restarting the add-on can't quietly start
  watering again while you're still using the water.

Pause and rain delay are different tools: rain delay skips *scheduled* runs for
a day or three and still allows manual ones; pause stops *everything*,
including what is running right now, for a few minutes.

## Rain delay

The preset buttons (12h/24h/48h/72h) and the custom-hours field all do the
same thing: set a single "delay until" timestamp. While active, every
*scheduled* program run is skipped and logged as `skipped_rain_delay` -
nothing is deleted or disabled, the schedule just resumes normally once the
delay expires (or you hit Clear). Manual "Run now" and zone test-fires
ignore the delay on purpose, so you can still hand-water if needed.

## How it follows Home Assistant

The add-on keeps one long-lived WebSocket connection to Home Assistant
(`ws://supervisor/core/websocket`, authenticated with the `SUPERVISOR_TOKEN`
the Supervisor injects) and subscribes to state changes for the zone entities.
Home Assistant pushes a change the moment it happens, so switching a valve off
anywhere else is reflected here immediately rather than on a timer.

The connection is treated as a convenience, never as the source of truth:

- If it drops, the add-on reconnects with a backing-off delay, and everything
  that needs a zone's state asks Home Assistant directly in the meantime. A
  dropped connection slows things down; it never looks like "the valve is off".
- A running zone is also checked outright about once a minute even while the
  stream is healthy, so a missed message can't leave it watering against a
  closed valve.
- The subscription follows the zone list - adding or removing a zone
  re-subscribes and re-reads the current states.

You'll see `Watching zone states over the Home Assistant event stream.` in the
add-on log when the connection is up.

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
| The zone is switched off elsewhere mid-run | Noticed in well under a second, because Home Assistant pushes the change. The run ends and is logged `stopped_external`. The add-on never reopens a valve somebody closed. Only a definite "off" counts - an unreachable API or an `unavailable` entity leaves the run alone. |
| The event stream drops | The add-on reconnects on its own, and falls back to asking Home Assistant every 10 seconds until it does, so a running zone is still watched - just less promptly. |
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
