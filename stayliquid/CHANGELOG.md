# Changelog

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
