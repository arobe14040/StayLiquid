from datetime import datetime

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger

from . import storage
from .runner import run_program

scheduler = AsyncIOScheduler(timezone="America/New_York")


def _job_id(program_id: int) -> str:
    return f"program-{program_id}"


def _build_trigger(program: dict):
    hour, minute = (int(x) for x in program["start_time"].split(":"))

    if program["schedule_type"] == "interval" and program.get("interval_days"):
        anchor = program.get("anchor_date") or datetime.now().date().isoformat()
        start_date = datetime.fromisoformat(f"{anchor}T{program['start_time']}:00")
        return IntervalTrigger(days=int(program["interval_days"]), start_date=start_date)

    weekdays = (program.get("weekdays") or "").strip()
    if not weekdays:
        return None  # nothing to schedule (e.g. a dormant-stage program left disabled)
    return CronTrigger(day_of_week=weekdays, hour=hour, minute=minute)


def sync_program(program: dict) -> None:
    """Add/replace/remove this program's job to match its current row."""
    job_id = _job_id(program["id"])
    existing = scheduler.get_job(job_id)
    if existing:
        existing.remove()

    if not program["enabled"]:
        return

    trigger = _build_trigger(program)
    if trigger is None:
        return

    scheduler.add_job(
        run_program,
        trigger=trigger,
        id=job_id,
        args=[program["id"]],
        kwargs={"trigger_source": "scheduled"},
        replace_existing=True,
        misfire_grace_time=3600,
    )


def remove_program(program_id: int) -> None:
    job = scheduler.get_job(_job_id(program_id))
    if job:
        job.remove()


def sync_all() -> None:
    """Rebuild every job from the database - called once at startup."""
    for job in scheduler.get_jobs():
        job.remove()
    for program in storage.list_programs():
        sync_program(program)


def next_events(limit: int = 5) -> list[dict]:
    events = []
    for job in scheduler.get_jobs():
        if job.next_run_time is None:
            continue
        program_id = job.args[0] if job.args else None
        program = storage.get_program(program_id) if program_id else None
        if not program:
            continue
        zone_names = ", ".join(z["zone_name"] for z in program["zones"]) or "(no zones)"
        events.append(
            {
                "program_id": program_id,
                "program_name": program["name"],
                "zones": zone_names,
                "run_mode": program["run_mode"],
                "next_run_time": job.next_run_time.isoformat(),
            }
        )
    events.sort(key=lambda e: e["next_run_time"])
    return events[:limit]
