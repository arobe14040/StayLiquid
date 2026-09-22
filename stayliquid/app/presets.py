"""
Growth-stage preset templates.

These are just starting points for a new Program - picking one prefills the
program creation form (schedule + a default duration per zone), and the user
edits from there. Nothing here is "live"; once a program is created it's a
normal, independently-editable row in the database.

Tuned for a cool-season lawn (fescue / Kentucky bluegrass), which is the
default for New England. If you're on warm-season grass (Bermuda, zoysia,
etc.) these defaults run backwards - swap peak_summer and dormant, and shift
germination to early summer instead of spring/fall.
"""

GROWTH_STAGE_PRESETS = [
    {
        "id": "germination",
        "name": "New Seed / Germination",
        "typical_window": "Apr\u2013May or late Aug\u2013Sep",
        "note": "Frequent, light watering to keep the top inch of soil consistently moist.",
        "schedule_type": "weekdays",
        "weekdays": "mon,tue,wed,thu,fri,sat,sun",
        "interval_days": None,
        "start_time": "06:00",
        "run_mode": "sequential",
        "default_duration_minutes": 6,
    },
    {
        "id": "establishment",
        "name": "Establishment",
        "typical_window": "2\u20136 weeks after germination",
        "note": "Roots are developing - taper frequency, extend duration slightly.",
        "schedule_type": "interval",
        "weekdays": None,
        "interval_days": 2,
        "start_time": "05:30",
        "run_mode": "sequential",
        "default_duration_minutes": 12,
    },
    {
        "id": "active_growth",
        "name": "Active Growth (Spring/Fall)",
        "typical_window": "May\u2013Jun and Sep\u2013Oct",
        "note": "Normal maintenance watering for established, healthy turf.",
        "schedule_type": "weekdays",
        "weekdays": "mon,thu",
        "interval_days": None,
        "start_time": "05:00",
        "run_mode": "sequential",
        "default_duration_minutes": 20,
    },
    {
        "id": "peak_summer",
        "name": "Peak Summer / Heat Stress",
        "typical_window": "Jul\u2013Aug",
        "note": "Deep, less-frequent watering encourages deeper root growth and heat tolerance.",
        "schedule_type": "weekdays",
        "weekdays": "mon,wed,fri",
        "interval_days": None,
        "start_time": "04:30",
        "run_mode": "sequential",
        "default_duration_minutes": 30,
    },
    {
        "id": "dormant",
        "name": "Dormant / Winter Shutdown",
        "typical_window": "Nov\u2013Mar",
        "note": "Created disabled by default - enable manually if you get an unusual dry spell.",
        "schedule_type": "weekdays",
        "weekdays": "",
        "interval_days": None,
        "start_time": "06:00",
        "run_mode": "sequential",
        "default_duration_minutes": 0,
        "default_enabled": False,
    },
]


def get_preset(preset_id: str) -> dict | None:
    return next((p for p in GROWTH_STAGE_PRESETS if p["id"] == preset_id), None)
