"""
Lawn growth-stage presets.

Picking a preset prefills the program builder - cycle times, per-zone runtime,
and how often it repeats. Nothing here stays "live": once a program is created
it's an ordinary editable row in the database.

Water estimates assume a precipitation rate of ~0.4 in/hr, typical for a
residential pop-up spray zone with head-to-head coverage. If you catch-cup your
own rate and it differs, everything scales linearly from PRECIP_RATE_IN_PER_HR.
"""

PRECIP_RATE_IN_PER_HR = 0.4


def inches_for(minutes: float) -> float:
    return round(minutes / 60 * PRECIP_RATE_IN_PER_HR, 2)


GROWTH_STAGE_PRESETS = [
    {
        "id": "pre_germination",
        "stage": 1,
        "name": "Before Germination",
        "tagline": "Seed is down, nothing has sprouted yet",
        "typical_window": "Day 0 until you see sprouts - usually 7-14 days",
        "goal": (
            "Keep the top quarter-inch of soil damp around the clock. Seed that "
            "dries out once is dead seed, so this stage trades depth for frequency."
        ),
        "duration_minutes": 10,
        "cycle_times": ["08:00", "11:30", "15:00"],
        "schedule_type": "weekdays",
        "weekdays": "mon,tue,wed,thu,fri,sat,sun",
        "interval_days": None,
        "run_mode": "sequential",
    },
    {
        "id": "sprouting",
        "stage": 2,
        "name": "Sprouting",
        "tagline": "Green fuzz is up, roots are hair-thin",
        "typical_window": "From first sprouts through about week 3",
        "goal": (
            "Still shallow-rooted and still easy to kill, but the seed coat is open. "
            "Back off to twice a day and water a little longer each time."
        ),
        "duration_minutes": 15,
        "cycle_times": ["08:00", "13:00"],
        "schedule_type": "weekdays",
        "weekdays": "mon,tue,wed,thu,fri,sat,sun",
        "interval_days": None,
        "run_mode": "sequential",
    },
    {
        "id": "young_grass",
        "stage": 3,
        "name": "Young Grass",
        "tagline": "Mowable, but not established",
        "typical_window": "Roughly weeks 3-8, after the first mow",
        "goal": (
            "Roots are reaching for water now, so give them a reason to go down. "
            "One longer soak a day beats several sips."
        ),
        "duration_minutes": 40,
        "cycle_times": ["06:00"],
        "schedule_type": "weekdays",
        "weekdays": "mon,tue,wed,thu,fri,sat,sun",
        "interval_days": None,
        "run_mode": "sequential",
    },
    {
        "id": "rooting_in",
        "stage": 4,
        "name": "Rooting In",
        "tagline": "Established turf, training roots deeper",
        "typical_window": "Week 8 onward - this is your normal season schedule",
        "goal": (
            "Deep and infrequent is the whole game. Long runs every third day push "
            "roots down and make the lawn far more drought-tolerant."
        ),
        "duration_minutes": 75,
        "cycle_times": ["05:00"],
        "schedule_type": "interval",
        "weekdays": None,
        "interval_days": 3,
        "run_mode": "sequential",
    },
]


def _decorate(preset: dict) -> dict:
    """Add the derived numbers the UI shows on each preset card."""
    minutes = preset["duration_minutes"]
    cycles = len(preset["cycle_times"])
    per_cycle = inches_for(minutes)
    return {
        **preset,
        "cycles_per_day": cycles,
        "inches_per_cycle": per_cycle,
        "inches_per_day": round(per_cycle * cycles, 2),
        "precip_rate_in_per_hr": PRECIP_RATE_IN_PER_HR,
    }


def list_presets() -> list[dict]:
    return [_decorate(p) for p in GROWTH_STAGE_PRESETS]


def get_preset(preset_id: str) -> dict | None:
    preset = next((p for p in GROWTH_STAGE_PRESETS if p["id"] == preset_id), None)
    return _decorate(preset) if preset else None
