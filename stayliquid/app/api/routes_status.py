import os
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from .. import storage
from ..presets import inches_for
from ..runner import current_runs, rain_delay_active
from ..scheduler import next_events, scheduler

router = APIRouter()

# Anything in here is worth the user's attention on the History tab.
PROBLEM_STATUSES = ("error", "interrupted", "skipped_rain_delay", "skipped_unavailable")


class RainDelayIn(BaseModel):
    hours: float


@router.get("/status")
async def status():
    delay = await run_in_threadpool(storage.get_rain_delay)
    active = await rain_delay_active()
    return {
        "version": os.environ.get("APP_VERSION", "dev"),
        "rain_delay": {"active": active, "until": delay.get("until") if delay else None},
        "current_runs": current_runs,
        "next_events": next_events(),
    }


@router.post("/raindelay")
async def set_rain_delay(body: RainDelayIn):
    until = (datetime.now(timezone.utc) + timedelta(hours=body.hours)).isoformat()
    return await run_in_threadpool(storage.set_rain_delay, until)


@router.delete("/raindelay")
async def clear_rain_delay():
    return await run_in_threadpool(storage.set_rain_delay, None)


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
        "attention": [r for r in rows if r["status"] in PROBLEM_STATUSES][:8],
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


@router.get("/history")
async def history(limit: int = 50):
    return await run_in_threadpool(storage.list_history, limit)
