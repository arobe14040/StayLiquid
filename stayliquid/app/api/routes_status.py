from datetime import datetime, timedelta, timezone

from fastapi import APIRouter
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from .. import storage
from ..runner import current_runs, rain_delay_active
from ..scheduler import next_events

router = APIRouter()


class RainDelayIn(BaseModel):
    hours: float


@router.get("/status")
async def status():
    delay = await run_in_threadpool(storage.get_rain_delay)
    active = await rain_delay_active()
    return {
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


@router.get("/history")
async def history(limit: int = 50):
    return await run_in_threadpool(storage.list_history, limit)
