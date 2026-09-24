import os
from datetime import datetime, time, timedelta, timezone

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from .. import storage
from ..presets import inches_for
from .. import runner, state_watch
from ..runner import current_runs, rain_delay_active
from ..scheduler import next_events, planned_today, scheduler

router = APIRouter()

# Worth nagging about: something went wrong, or a run was skipped for a reason
# the user may not have intended. Deliberate stops are deliberately absent -
# being reminded of a button you just pressed is noise.
PROBLEM_STATUSES = ("error", "interrupted", "skipped_rain_delay", "skipped_unavailable")

# Didn't deliver its full watering, whatever the reason. Broader than the above,
# because "did this zone get its water?" and "should I be told about it?" are
# different questions.
FINISHED_STATUSES = ("completed", "running")


class RainDelayIn(BaseModel):
    hours: float


class PauseIn(BaseModel):
    # A pause exists so the house can have the pressure back, so it's measured
    # in minutes and expires by itself - one left on by accident would
    # otherwise stop the lawn being watered indefinitely.
    minutes: float = 120


@router.get("/status")
async def status():
    delay = await run_in_threadpool(storage.get_rain_delay)
    active = await rain_delay_active()

    # The dashboard's zone switches need the valves' real state, and it already
    # polls this - one call beats a second one alongside it.
    zones = await run_in_threadpool(storage.list_zones)
    states, live = await state_watch.zone_states({z["entity_id"] for z in zones})
    running_zone_ids = {r["zone_id"] for r in current_runs}

    return {
        "zones": [
            {
                "id": z["id"],
                "name": z["name"],
                "entity_id": z["entity_id"],
                "enabled": bool(z["enabled"]),
                "state": states.get(z["entity_id"]),
                "running": z["id"] in running_zone_ids,
            }
            for z in zones
        ],
        "zones_live": live,
        "version": os.environ.get("APP_VERSION", "dev"),
        # The zone every schedule runs in, so the page can show clock times as
        # they are at the lawn rather than wherever the viewer happens to be.
        "timezone": str(scheduler.timezone),
        "pause": await runner.pause_state(),
        "rain_delay": {"active": active, "until": delay.get("until") if delay else None},
        "current_runs": current_runs,
        "next_events": next_events(),
        # Reads a row per program, so keep it off the event loop.
        "planned_today": await run_in_threadpool(planned_today),
    }


@router.post("/raindelay")
async def set_rain_delay(body: RainDelayIn):
    until = (datetime.now(timezone.utc) + timedelta(hours=body.hours)).isoformat()
    return await run_in_threadpool(storage.set_rain_delay, until)


@router.delete("/raindelay")
async def clear_rain_delay():
    return await run_in_threadpool(storage.set_rain_delay, None)


@router.post("/pause")
async def pause_watering(body: PauseIn):
    """Close every open valve and hold the schedule, keeping each run's
    remaining time so it can carry on from where it stopped."""
    minutes = max(1.0, min(body.minutes, 12 * 60))
    until = (datetime.now(timezone.utc) + timedelta(minutes=minutes)).isoformat()
    await runner.pause_until(until)
    return await runner.pause_state()


@router.delete("/pause")
async def resume_watering():
    await runner.pause_until(None)
    return await runner.pause_state()


@router.get("/history/stats")
async def history_stats(days: int = 14):
    """Daily activity for the History tab. Runs are stored in UTC but bucketed
    into local days here, so "Tuesday" means the user's Tuesday."""
    days = max(1, min(days, 90))
    tz = scheduler.timezone
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days + 1)).isoformat()
    rows = await run_in_threadpool(storage.list_history_since, cutoff)

    today = datetime.now(tz).date()
    window = [today - timedelta(days=offset) for offset in range(days - 1, -1, -1)]
    buckets = {
        day: {
            "date": day.isoformat(),
            "weekday": day.strftime("%a"),
            "day_of_month": day.day,
            "runs": 0,
            "minutes": 0.0,
            "problems": 0,
        }
        for day in window
    }

    totals = {"runs": 0, "minutes": 0.0, "problems": 0, "errors": 0, "skipped": 0}
    zones_seen = set()

    for row in rows:
        started = _parse(row["started_at"])
        if started is None:
            continue
        bucket = buckets.get(started.astimezone(tz).date())
        if bucket is None:
            continue

        status = row["status"]
        is_problem = status in PROBLEM_STATUSES
        minutes = _elapsed_minutes(row) if not status.startswith("skipped") else 0.0

        bucket["minutes"] += minutes
        totals["minutes"] += minutes
        if is_problem:
            bucket["problems"] += 1
            totals["problems"] += 1
            totals["errors" if status in ("error", "interrupted") else "skipped"] += 1
        else:
            bucket["runs"] += 1
            totals["runs"] += 1
            if row["zone_id"]:
                zones_seen.add(row["zone_id"])

    by_day = []
    for day in window:
        entry = buckets[day]
        entry["minutes"] = round(entry["minutes"], 1)
        by_day.append(entry)

    return {
        "days": days,
        "timezone": str(tz),
        "totals": {
            **{k: (round(v, 1) if isinstance(v, float) else v) for k, v in totals.items()},
            "inches": inches_for(totals["minutes"]),
            "zones": len(zones_seen),
        },
        "by_day": by_day,
        # Not limited to the stats window: something that went wrong three weeks
        # ago and was never looked at is exactly what this panel is for.
        "attention": await run_in_threadpool(
            storage.list_unacknowledged, PROBLEM_STATUSES, 12
        ),
        # The list above is only the latest dozen; this is how many there are.
        "attention_total": await run_in_threadpool(
            storage.count_unacknowledged, PROBLEM_STATUSES
        ),
    }


def _parse(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed


def _elapsed_minutes(row: dict) -> float:
    started, ended = _parse(row["started_at"]), _parse(row["ended_at"])
    if not started or not ended:
        return 0.0
    return max(0.0, (ended - started).total_seconds() / 60)


class AcknowledgeIn(BaseModel):
    run_ids: list[int] | None = None


@router.get("/history")
async def history(date: str | None = None):
    """One local day's runs, grouped so a program reads as a single run with
    numbered steps rather than a loose pile of zone rows."""
    tz = scheduler.timezone
    try:
        day = datetime.fromisoformat(date).date() if date else datetime.now(tz).date()
    except ValueError:
        raise HTTPException(400, "Date must look like YYYY-MM-DD.")

    start = datetime.combine(day, time.min, tzinfo=tz)
    rows = await run_in_threadpool(
        storage.list_history_between,
        start.astimezone(timezone.utc).isoformat(),
        (start + timedelta(days=1)).astimezone(timezone.utc).isoformat(),
    )
    return {"date": day.isoformat(), "runs": _group_runs(rows)}


def _group_runs(rows: list[dict]) -> list[dict]:
    """Fold per-zone rows back into the executions they came from. Rows written
    before grouping existed have no group_id, so each stands alone."""
    grouped: dict[str, dict] = {}
    order: list[str] = []

    for row in rows:
        key = row["group_id"] or f"row-{row['id']}"
        if key not in grouped:
            grouped[key] = {
                "id": key,
                "program_id": row["program_id"],
                "program_name": row["program_name"] or "Manual run",
                "trigger_source": row["trigger_source"],
                "started_at": row["started_at"],
                "ended_at": row["ended_at"],
                "step_count": row["step_count"] or 0,
                "steps": [],
            }
            order.append(key)

        run = grouped[key]
        run["step_count"] = max(run["step_count"], row["step_count"] or 0)
        if row["ended_at"] and (not run["ended_at"] or row["ended_at"] > run["ended_at"]):
            run["ended_at"] = row["ended_at"]
        run["steps"].append({
            "id": row["id"],
            "step": row["step"],
            "zone_name": row["zone_name"],
            "status": row["status"],
            "started_at": row["started_at"],
            "ended_at": row["ended_at"],
            "minutes": round(_elapsed_minutes(row), 1),
            "acknowledged": bool(row["acknowledged_at"]),
        })

    runs = []
    for key in order:
        run = grouped[key]
        run["steps"].sort(key=lambda s: (s["step"] or 0, s["started_at"] or ""))
        unfinished = [s for s in run["steps"] if s["status"] not in FINISHED_STATUSES]
        run["problem_count"] = len([s for s in unfinished if s["status"] in PROBLEM_STATUSES])
        run["unfinished_count"] = len(unfinished)
        run["done_count"] = len(run["steps"]) - len(unfinished)
        run["minutes"] = round(sum(s["minutes"] for s in run["steps"]), 1)
        # A program-level skip has no zone at all, so there is no step strip to
        # draw - the run itself is the thing that didn't happen.
        run["whole_program"] = all(s["zone_name"] is None for s in run["steps"])
        runs.append(run)

    runs.sort(key=lambda r: r["started_at"] or "", reverse=True)
    return runs


@router.post("/history/acknowledge")
async def acknowledge(body: AcknowledgeIn):
    """Clear the 'needs a look' panel - the runs stay in the history, they just
    stop being flagged."""
    cleared = await run_in_threadpool(
        storage.acknowledge_runs, body.run_ids, PROBLEM_STATUSES
    )
    return {"cleared": cleared}
