# Changelog

## 0.10.1

Fixes from a review of the whole add-on. Most are about pausing, and one
means `valve.*` zones work for the first time.

- **An expired pause could stop the schedule for good.** When a pause ran out
  and no zone happened to be held at that moment (you'd stopped it, or the
  add-on restarted mid-pause), the add-on never noticed the pause had ended.
  Every scheduled program after that was skipped as *watering paused*, while
  the Dashboard said you weren't paused at all. A pause now ends on time
  whether or not anything is waiting on it.
- **A pause that runs out ends the program**, as the docs always said.
  Previously only the zone that was held stopped, and the program went straight
  on to open the next one. The same goes for a zone that errors, since that can
  mean a valve that wouldn't close.
- **Shutting down can no longer open the next zone.** Closing a running valve
  during shutdown looked like "switched off in Home Assistant", so a program
  moved on to its next zone just as the add-on was stopping.
- **`valve.*` zones work.** They were being sent `turn_on`/`turn_off`, which
  valves don't have, so they failed to start. Their `open`/`closed` states also
  weren't recognised, so they always showed as off. They now use `open_valve`
  and `close_valve`, and read as on/off like a switch.
- **Disabled zones are actually skipped.** The Zones tab said programs skip a
  disabled zone, but they watered it anyway. A disabled zone also can't be run
  by hand now.
- **Deleting a zone or a program stops it** if it's watering, instead of leaving
  it to run out its time with nothing on the page able to stop it.
- **Large Home Assistant installs keep their live connection.** The initial
  state read could pass the WebSocket's 1 MiB message limit, which dropped the
  connection on every attempt and left the add-on polling.
- **Bad program settings are refused when saved**, not after. An unknown
  weekday, an interval program with no interval, a zero-minute zone and so on
  now get a clear error. One of these used to stop the add-on from starting at
  all; a program the scheduler can't handle is now logged and skipped instead.
  Manual runs are limited to 12 hours.
- **History follows renamed zones.** A zone's earlier runs today no longer
  vanish from its Dashboard lane when you rename it.
- **"Runs" in the History stats** counts only runs that watered for their full
  time. It was including skipped and stopped ones.
- Database writes from different requests can no longer interfere with each
  other.
- The Dashboard stops polling while its browser tab is hidden, and catches up
  as soon as the tab is shown again.

## 0.10.0

A redesign of all four tabs, from the mockups you picked - and a scheduling
fix that turned up while building it.

**Dashboard - the day as a timeline.** One lane per zone across today, with a
block for everything that watered, is watering (striped) or is still to come
(outlined), and a line at the current time. Failures and cut-short runs show in
their own colours, so an odd day is obvious at a glance. Zone control sits
underneath as a row of switches, then three tiles: the next cycle, how much
water each zone has had today, and rain delay with its buttons.

**Zones - a card per zone.** Name with its rename pencil, the entity, and an
on/off switch that runs the zone for the minutes in *Run for*. Each card says
what the zone is doing - *Watering, 6m left*, *On - opened outside the add-on*,
or when it last ran today. Add a zone from the button at the top.

**Programs - cards with a week strip.** The days a program runs are filled in,
its cycle times sit beside them as chips, and its next run is on the right.
Interval programs show *Every 3 days* instead.

**History - a timeline of the day.** Each run is a card on a rail, opened out
into its zones as numbered steps, so a program that failed at step 3 reads
exactly like that. What went wrong is spelled out on the card, with an
**Acknowledge** button right there. Red is kept for real failures; a rain-delay
skip or a zone someone stopped is amber. The "needs a look" panel now shows the
latest three with the rest folded away, and counts every outstanding problem -
it used to stop at 12, and *Mark all as seen* only cleared those.

### Fixes

- **Schedules now actually run in Home Assistant's timezone.** 0.2.1 made the
  add-on look the timezone up from Home Assistant, but the jobs never used it:
  APScheduler only applies the scheduler's timezone to triggers made from a
  name, and ours were built as objects, so they fell back to the container's
  own clock. That only matters when the container's `TZ` is out of date - the
  case the lookup was there for - but then every cycle ran hours off.
- **A new interval program no longer skips its first day** when saved in the
  evening. Its start date was the UTC date, which is already tomorrow for most
  of the Americas by dinner time.
- **Every time on the page is the lawn's time**, not the browser's. Viewed from
  another timezone, *Next run* no longer disagrees with a program's own cycle
  times, and *Today* on History is the lawn's today.
- The Programs tab no longer says *not scheduled* for a program that is. Its
  next-run times came from the Dashboard's short list, which three programs of
  three cycles each already overflow.
- A zone switch's label no longer contradicts the switch while a request is in
  flight (*Watering* beside a switch just turned off), and a request that fails
  puts the switch back straight away rather than at the next refresh.

### API

- `GET /api/status` adds `timezone` and `planned_today` - every zone slot still
  due today, worked out by the scheduler.
- `GET /api/programs` adds each program's `next_run_time`.
- `GET /api/history/stats` adds `attention_total`.

## 0.9.1

The program builder now fits the screen instead of scrolling through it.

- **Two columns on a wide screen.** The steps were a 660px column scrolling
  vertically while most of the window went unused. On a 1100x760 laptop every
  step now fits with nothing cut off - the Zones step alone used to run 587px
  past the bottom.
- **Compact zone rows.** Five zones were taller than the modal on their own;
  each is now a single line with its number, runtime and controls.
- **The review timeline no longer scrolls sideways.** It was being laid out as
  a flex item 467px wide inside an 863px space - see below.
- **Full-screen on a phone**, rather than a card floating inside the viewport,
  with the padding trimmed so the space goes to content.
- Cycle rows are two tidy lines instead of wrapping into three.

Fixes a CSS class collision behind several of these: the builder's wizard
sections and the History tab's step chips were both `.step`, so the chip
styling - including `display: flex` - was silently being applied to the wizard.
The chips are now `.run-step`.

## 0.9.0

A panel of zone switches at the top of the Dashboard.

- One switch per zone, for the times you just want a zone on now. Collapse it
  with the heading and it stays how you left it.
- **It shows the valve, not just what the add-on is doing.** A zone switched on
  in Home Assistant or by hand reads as on here - *On - opened elsewhere* - and
  switching it off here closes it. Turning a zone off is now a dependable off
  rather than only cancelling a run of ours.
- **Turning one on waters it for 10 minutes**, not indefinitely: a switch with
  no timer behind it is one forgotten tap away from watering all night. The
  Zones tab still has **Test run** for a specific length.
- A zone whose state can't be read shows as *State unknown* and can't be
  switched, rather than guessing. Disabled zones and a paused system are shown
  and locked.
- `GET /api/status` now carries the zones and their states, so the Dashboard's
  existing poll covers the switches without a second request. When the event
  stream is down the fallback is shared and rate-limited, so polling can't turn
  into a request to Home Assistant every few seconds.

## 0.8.0

The History tab now reads as runs rather than as a list of zone rows.

- **A program is one run with numbered steps.** Its zones appear as a strip -
  `1 Back Lawn ✓  2 Front Lawn ✓  3 Garden Beds ✕  4 Side Strip ✕` - so which
  part of a program failed is obvious without piecing four rows together. The
  failures are then spelled out underneath.
- **Three outcomes, not two.** A zone that watered, one cut short on purpose
  (you stopped it, or it was switched off in Home Assistant), and one that
  failed now read differently. Lumping the middle in with either was
  misleading: "all 6 zones watered" was being shown for a run where one
  didn't.
- **The day's runs, not everything ever.** Defaults to today, with a date
  control and arrows to step through; each day is fetched when you pick it.
  Clicking a bar in the activity chart opens that day.
- **"Needs a look" can be marked as seen.** Clearing it only drops the flag -
  the runs stay in the history, and a failed run still shows as failed.
- Runs are now recorded with a group, a step number and a step count. Existing
  databases gain the columns on upgrade and their rows read as single-step
  runs.

## 0.7.0

**Pause watering** on the Dashboard, for when you need the pressure indoors.

- Shuts every open valve at once and holds the schedule. It's system-wide on
  purpose: pausing one zone would just hand the pressure to the next zone in
  the program.
- **A run keeps the time it still owes.** A zone six minutes into a twenty
  minute run resumes with fourteen left - not twenty, and not nothing.
- Programs due during a pause are skipped and logged, rather than queued to run
  hours later on top of the next cycle. Manual runs are refused while paused
  instead of quietly waiting for a resume that may not come.
- **It expires by itself** (two hours by default, shown on the Dashboard), so
  one left on by accident can't stop the lawn being watered indefinitely. On
  expiry, held runs are ended and logged rather than valves reopening after a
  long unattended gap.
- It survives a restart, so restarting the add-on can't start watering again
  while you're still using the water.
- New `POST /api/pause` and `DELETE /api/pause`.

## 0.6.0

Zone states are pushed from Home Assistant now, instead of asked for on a timer.

- **A valve switched off elsewhere is noticed straight away** - measured at
  under half a second end to end, where before it took up to about 30 seconds.
  The add-on holds one WebSocket connection to Home Assistant and subscribes to
  its zone entities, so the change arrives rather than being polled for.
- **The connection is never treated as the truth.** If it drops, the add-on
  reconnects with a backing-off delay and everything falls back to asking Home
  Assistant directly until it returns - slower, never stale, and never mistaken
  for "the valve is off".
- **A running zone is still checked outright about once a minute** even with the
  stream healthy, so a dropped message can't leave it watering against a closed
  valve.
- The subscription follows the zone list, and re-reads current states whenever
  it changes or the connection comes back.
- `GET /api/zones/states` now answers from that live cache when it can, so the
  UI's refresh no longer costs a call to Home Assistant, and reports whether
  the stream was connected.
- New dependency: `websockets`.

## 0.5.0

A zone's test run is now a toggle you can turn off.

- **Test run became a start/stop toggle.** It starts a run for the minutes in
  the box beside it, then turns green and counts down - "Stop &middot; 7m left".
  Pressing it again closes the valve immediately rather than waiting out the
  timer, which previously there was no way to do short of restarting the
  add-on.
- The toggle flips back on its own when a run finishes, and the minutes box is
  locked while a run is going so the number can't drift from what's running.
- A run ended this way is logged **Stopped early**, so the history tells it
  apart from one that ran its full time.
- New `POST /api/zones/{id}/stop`. It works on any run of that zone, not just a
  test run, so a program's zone can be cut short from here too.

**The Zones tab now watches Home Assistant**, instead of only knowing what the
state was when the page was drawn.

- A zone switched on or off elsewhere - in Home Assistant, from a dashboard, or
  by hand at the valve - shows up here within a few seconds. Previously the
  page stayed as it was until you reloaded it.
- **A run whose valve is switched off elsewhere now ends** rather than counting
  down against a closed valve, and is logged "Switched off in Home Assistant"
  so it reads differently from one you stopped here. StayLiquid never reopens a
  valve somebody closed.
- Only a definite "off" from Home Assistant ends a run. An unreachable API or
  an `unavailable` entity is not treated as evidence, so a blip doesn't cut
  watering short, and the check leaves a zone alone for the first 20 seconds so
  a state that hasn't caught up yet isn't mistaken for a switch-off.
- New `GET /api/zones/states`, polled only while the Zones tab is open - one
  call to Home Assistant, filtered to the zones actually in use.

## 0.4.2

- **Zones can be renamed.** A pencil button on each zone opens a rename dialog
  with the current name selected, ready to type over. Programs using the zone
  follow the new name - the name lives in one place, so nothing needs updating
  afterwards.
- The dialog added in 0.4.1 now also handles a line of text, so renaming uses
  the same styled dialog as everything else rather than the browser's prompt.
  Save is disabled until the name has something in it, Enter saves, Escape
  backs out.

## 0.4.1

Replaces the browser's confirm boxes with dialogs that match the app.

- **Deleting a zone or program, and discarding an unsaved program, now use a
  proper dialog** instead of the browser's grey "Are you sure?" prompt.
- **They say what actually happens.** Deleting a program notes that run history
  is kept; deleting a zone notes that programs using it lose it; discarding
  distinguishes a new program from edits to a saved one.
- The destructive button is red and labelled for the action ("Delete zone", not
  "OK"), and **Cancel takes focus**, so a stray Enter cancels rather than
  deletes. Escape and a click outside both cancel.
- Filled danger buttons get their own foreground colour, so the label stays
  readable in dark mode where the danger hue is light (was white-on-salmon at
  about 2.6:1, now 7:1).

## 0.4.0

Step 2 of the builder is now a review of the defaults a stage fills in.

- **Picking a stage lands you on its numbers, ready to change.** The step is
  called Defaults, and it opens with a banner naming the stage it came from.
  Whatever you set here is what the later steps use.
- **How long each zone runs is set here**, instead of only being adjustable
  per-zone two steps later. It applies to every zone in the program, including
  ones added afterwards; a single zone can still be given its own runtime on
  the Zones step.
- **A live water readout** under the runtime - "each zone gets about 0.07" per
  cycle, so 0.21" across 3 cycles on a watering day" - so the minutes number
  means something while you're choosing it.
- On a phone the step strip now shows the numbers plus the step you're on,
  rather than four truncated labels.

## 0.3.2

Stops a stale page from taking the whole UI down with it.

- **One missing element no longer kills every later line of `app.js`.** Wiring
  up a button that isn't there threw, which stopped the rest of the file from
  running - including the constants near the bottom. The visible symptom was an
  unrelated tab failing with "Cannot access 'STATUS_PILL' before
  initialization". Event wiring now skips missing nodes and logs which one.
- **It says what's actually wrong.** If anything was missing, the page shows
  "This page is out of date. Reload the page to get the current version."
- Status labels moved to the top of the file with the other constants, so they
  can't land in the temporal dead zone again.

This combination showed up when a browser paired a fresh `app.js` with an
`index.html` it still had cached - the caching fix in 0.3.1 is what prevents
the mismatch; this is the damage control for when it happens anyway.

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
