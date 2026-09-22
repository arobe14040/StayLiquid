import logging
import os
from datetime import datetime
from zoneinfo import ZoneInfo

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger

from . import ha_client, storage
from .runner import run_program

log = logging.getLogger("stayliquid.scheduler")

# Timezone is applied in apply_timezone() before the scheduler starts. Left
# unset here, APScheduler would resolve it from TZ, which is close but can be
# stale - see ha_client.get_supervisor_timezone.
scheduler = AsyncIOScheduler()


async def apply_timezone() -> str:
    """Point the scheduler at Home Assistant's timezone. "08:00" has to mean
    8am where the sprinklers are, not wherever the container thinks it is."""
    candidates = []
    try:
        supervisor_tz = await ha_client.get_supervisor_timezone()
        if supervisor_tz:
            candidates.append(supervisor_tz)
    except Exception:
        log.warning("Could not read the timezone from Supervisor; falling back to TZ.")

    env_tz = os.environ.get("TZ")
    if env_tz:
        candidates.append(env_tz)

    for name in candidates:
        try:
            scheduler.configure(timezone=ZoneInfo(name))
            log.info("Scheduling in %s", name)
            return name
        except Exception:
            log.warning("'%s' is not a timezone name we can use.", name)

    # APScheduler's own default is the container's local zone, which Supervisor
    # sets from Home Assistant anyway - so this is a reasonable last resort.
    fallback = str(scheduler.timezone)
    log.warning("Falling back to the container's local timezone (%s).", fallback)
    return fallback


def _job_prefix(program_id: int) -> str:
    return f"program-{program_id}-"


def _job_id(program_id: int, cycle_index: int) -> str:
    return f"{_job_prefix(program_id)}{cycle_index}"


def _build_trigger(program: dict, start_time: str):
    hour, minute = (int(x) for x in start_time.split(":"))

    if program["schedule_type"] == "interval" and program.get("interval_days"):
        anchor = program.get("anchor_date") or datetime.now().date().isoformat()
        start_date = datetime.fromisoformat(f"{anchor}T{start_time}:00")
        return IntervalTrigger(days=int(program["interval_days"]), start_date=start_date)

    weekdays = (program.get("weekdays") or "").strip()
    if not weekdays:
        return None  # nothing to schedule (e.g. a program saved with no days picked)
    return CronTrigger(day_of_week=weekdays, hour=hour, minute=minute)


def sync_program(program: dict) -> None:
    """Add/replace/remove this program's jobs to match its current row. A program
    with three daily cycles gets three jobs, since APScheduler triggers can't
    express "8:00, 11:30 and 15:00" as one rule."""
    remove_program(program["id"])

    if not program["enabled"]:
        return

    for index, start_time in enumerate(program.get("start_times") or []):
        trigger = _build_trigger(program, start_time)
        if trigger is None:
            continue
        scheduler.add_job(
            run_program,
            trigger=trigger,
            id=_job_id(program["id"], index),
            args=[program["id"]],
            kwargs={"trigger_source": "scheduled"},
            replace_existing=True,
            misfire_grace_time=3600,
        )


def remove_program(program_id: int) -> None:
    prefix = _job_prefix(program_id)
    for job in scheduler.get_jobs():
        if job.id.startswith(prefix):
            job.remove()


def sync_all() -> None:
    """Rebuild every job from the database - called once at startup."""
    for job in scheduler.get_jobs():
        job.remove()
    for program in storage.list_programs():
        sync_program(program)


def next_events(limit: int = 6) -> list[dict]:
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
                "zone_count": len(program["zones"]),
                "run_mode": program["run_mode"],
                "next_run_time": job.next_run_time.isoformat(),
            }
        )
    events.sort(key=lambda e: e["next_run_time"])
    return events[:limit]
