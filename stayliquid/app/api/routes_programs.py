import asyncio
import re
from datetime import date, datetime
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, field_validator
from starlette.concurrency import run_in_threadpool

from .. import presets, runner, storage
from ..runner import run_program
from ..scheduler import next_run_times, remove_program, scheduler, sync_program
from .routes_zones import MAX_RUN_MINUTES

router = APIRouter()

TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


def _validate_times(times: list[str] | None) -> list[str] | None:
    if times is None:
        return None
    if not times:
        raise ValueError("A program needs at least one cycle time.")
    for t in times:
        if not TIME_RE.match(t):
            raise ValueError(f"'{t}' is not a valid 24-hour HH:MM time.")
    if len(set(times)) != len(times):
        raise ValueError("Two cycles can't start at the same time.")
    return sorted(times)


DAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")


def _validate_weekdays(value: str | None) -> str | None:
    """Normalise "wed, mon" to "mon,wed". Anything else would be stored and then
    rejected by the scheduler - after the program had already been saved."""
    if value is None:
        return None
    days = [d.strip().lower() for d in value.split(",") if d.strip()]
    unknown = [d for d in days if d not in DAYS]
    if unknown:
        raise ValueError(f"Unknown day(s): {', '.join(unknown)}. Use mon,tue,wed,thu,fri,sat,sun.")
    return ",".join(d for d in DAYS if d in days)


def _validate_anchor(value: str | None) -> str | None:
    if value is None:
        return None
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError:
        raise ValueError("anchor_date must look like YYYY-MM-DD.") from None


def _check_schedule(program: dict) -> None:
    """The schedule has to be one the scheduler can actually build - otherwise
    the program saves fine and then silently never runs."""
    if program.get("schedule_type") == "interval":
        if not program.get("interval_days"):
            raise HTTPException(422, "An interval program needs interval_days.")
    elif not program.get("weekdays"):
        raise HTTPException(422, "A weekday program needs at least one day.")


class ProgramZoneIn(BaseModel):
    zone_id: int
    duration_minutes: float = Field(gt=0, le=MAX_RUN_MINUTES)
    sort_order: int = 0


class ProgramIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    stage: str = "custom"
    schedule_type: Literal["weekdays", "interval"] = "weekdays"
    weekdays: str | None = None               # "mon,wed,fri"
    interval_days: int | None = Field(default=None, ge=1, le=365)
    anchor_date: str | None = None            # "YYYY-MM-DD", defaults to today
    start_times: list[str]                     # one "HH:MM" per daily cycle
    run_mode: Literal["sequential", "simultaneous"] = "sequential"
    enabled: bool = True
    zones: list[ProgramZoneIn] = []

    @field_validator("start_times")
    @classmethod
    def check_times(cls, v):
        return _validate_times(v)

    @field_validator("weekdays")
    @classmethod
    def check_weekdays(cls, v):
        return _validate_weekdays(v)

    @field_validator("anchor_date")
    @classmethod
    def check_anchor(cls, v):
        return _validate_anchor(v)


class ProgramUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    stage: str | None = None
    schedule_type: Literal["weekdays", "interval"] | None = None
    weekdays: str | None = None
    interval_days: int | None = Field(default=None, ge=1, le=365)
    anchor_date: str | None = None
    start_times: list[str] | None = None
    run_mode: Literal["sequential", "simultaneous"] | None = None
    enabled: bool | None = None
    zones: list[ProgramZoneIn] | None = None

    @field_validator("start_times")
    @classmethod
    def check_times(cls, v):
        return _validate_times(v)

    @field_validator("weekdays")
    @classmethod
    def check_weekdays(cls, v):
        return _validate_weekdays(v)

    @field_validator("anchor_date")
    @classmethod
    def check_anchor(cls, v):
        return _validate_anchor(v)


@router.get("/presets")
async def list_presets():
    return presets.list_presets()


@router.get("/programs")
async def list_programs():
    programs = await run_in_threadpool(storage.list_programs)
    upcoming = next_run_times()
    return [{**p, "next_run_time": upcoming.get(p["id"])} for p in programs]


@router.get("/programs/{program_id}")
async def get_program(program_id: int):
    program = await run_in_threadpool(storage.get_program, program_id)
    if not program:
        raise HTTPException(404, "Program not found.")
    return program


@router.post("/programs")
async def create_program(body: ProgramIn):
    data = body.model_dump()
    # "Today" where the lawn is. Left to storage it would be the UTC date, which
    # is already tomorrow every evening in the Americas - so an interval program
    # saved after dinner would skip its first day.
    data["anchor_date"] = data.get("anchor_date") or datetime.now(scheduler.timezone).date().isoformat()
    _check_schedule(data)
    program = await run_in_threadpool(storage.create_program, data)
    sync_program(program)
    return program


@router.put("/programs/{program_id}")
async def update_program(program_id: int, body: ProgramUpdate):
    data = {k: v for k, v in body.model_dump().items() if v is not None}
    existing = await run_in_threadpool(storage.get_program, program_id)
    if not existing:
        raise HTTPException(404, "Program not found.")
    # Checked against the program as it will be once merged, since an update
    # only carries the fields it changes.
    _check_schedule({**existing, **data})
    program = await run_in_threadpool(storage.update_program, program_id, data)
    if not program:
        raise HTTPException(404, "Program not found.")
    sync_program(program)
    return program


@router.patch("/programs/{program_id}/toggle")
async def toggle_program(program_id: int):
    program = await run_in_threadpool(storage.get_program, program_id)
    if not program:
        raise HTTPException(404, "Program not found.")
    updated = await run_in_threadpool(
        storage.update_program, program_id, {"enabled": not program["enabled"]}
    )
    sync_program(updated)
    return updated


@router.delete("/programs/{program_id}")
async def delete_program(program_id: int):
    remove_program(program_id)
    # A run already under way would otherwise carry on through every zone.
    runner.stop_program(program_id)
    await run_in_threadpool(storage.delete_program, program_id)
    return {"ok": True}


@router.post("/programs/{program_id}/run_now")
async def run_program_now(program_id: int):
    program = await run_in_threadpool(storage.get_program, program_id)
    if not program:
        raise HTTPException(404, "Program not found.")
    if (await runner.pause_state())["active"]:
        raise HTTPException(409, "Watering is paused. Resume it first.")
    asyncio.create_task(run_program(program_id, trigger_source="manual"))
    return {"ok": True}
