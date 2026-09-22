# Changelog

## 0.3.1

Fixes the frontend serving a stale copy of itself after an update.

- **Static files are now sent with `Cache-Control: no-cache`.** Starlette was
  sending only an ETag and last-modified date. With no explicit freshness
  directive a browser may apply heuristic caching and keep using the old
  `app.js` without ever asking whether it changed - so an add-on update could
  land while the UI stayed exactly as it was. Revalidation still returns a 304
  for an unchanged file, so this costs a round trip, not bandwidth.
- **The running version is now visible**, next to the title in the UI and in
  the add-on's startup log line, so "did my update actually land?" has an
  answer that doesn't depend on the browser.

## 0.3.0

Programs are built in a guided modal; History became a dashboard.

- **Programs tab leads with your programs.** The page is now just the list plus
  a "New program" button - no permanently-open builder taking up the screen.
- **The builder is a four-step modal**: pick a growth stage, set the schedule
  and cycles, choose zones, then review the timeline and save. Editing skips
  the first step. Each step is validated before you can move on, and saving
  jumps back to anything left incomplete.
- **History is now an overview.** Stat tiles for water applied, time watering,
  runs completed and anything needing a look; a 14-day bar chart of daily
  watering with hover detail; and runs grouped under Today / Yesterday / date.
- **Problems are called out.** Errors and skips get a panel at the top of the
  History tab, a red count tile, and a marker on the affected day in the chart -
  each with a written label, never colour alone.
- New `GET /api/history/stats` backs the overview, bucketing runs into local
  days using the add-on's configured timezone.

## 0.2.1

Follows Home Assistant's timezone, and handles zone failures properly.

- **Timezone is no longer hardcoded.** The scheduler asks Supervisor for Home
  Assistant's configured timezone at startup, falling back to the injected `TZ`
  and then the container's local zone. Cycle times now mean what they say
  wherever the system is installed.
- **Unavailable zones are skipped** rather than "watered" into the void, logged
  as `skipped_unavailable`, without the rest of the program being abandoned.
- **Failed turn-offs are retried** 4 times before giving up, and a run whose
  valve couldn't be closed is logged as an error with a loud log line.
- **A run cut short by a restart is logged `interrupted`** instead of
  `completed`. Open valves are now closed explicitly during shutdown, before
  the run tasks are torn down, rather than relying on task cancellation to get
  there.
- **Valves left open by a hard kill or power loss are closed at next startup** -
  any run still marked `running` is reconciled by actually closing that zone.
  Zones switched on by hand outside the add-on are untouched.
- Runs left `running` by an unclean stop no longer sit in the history forever.

## 0.2.0

Multiple watering cycles per day, and a rebuilt UI.

- **Programs can now run several cycles a day.** A program holds a list of
  cycle times instead of one start time, each scheduled as its own job. The
  Programs tab has a dedicated cycle editor - time pickers labelled by time of
  day, quick-set buttons for 1x/2x/3x, and add/remove per cycle.
- **Live schedule preview.** A cycle-by-zone grid shows exactly when every
  zone starts and when each cycle finishes, recalculated as you change zone
  count, durations, or run mode. Warns when one cycle would overrun the next.
- **Growth-stage presets replaced** with a four-stage progression from seed to
  established turf (before germination, sprouting, young grass, rooting in),
  each carrying its own cycle times and per-zone runtime. Picking one also
  adds every configured zone, so one click gives a complete schedule.
- **Water estimates** per zone, per cycle and per day, from an assumed
  0.4 in/hr precipitation rate.
- **UI overhaul** - new layout, light/dark theming, zone reordering, progress
  bars on running zones, relative times on upcoming runs, and toast messages
  in place of browser alerts.
- Existing databases migrate automatically: a program's old single start time
  becomes its first cycle.

## 0.1.0

Initial scaffold:
- Zone management (any switch/valve entity)
- Programs: growth-stage presets or custom schedules, sequential or
  simultaneous zone execution
- Dashboard: current runs, upcoming events, rain delay (24h/48h/72h/custom)
- Run history log
- No weather integration yet (manual rain delay only, by design)
