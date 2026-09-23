import asyncio
import re

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, field_validator
from starlette.concurrency import run_in_threadpool

from .. import presets, runner, storage
from ..runner import run_program
from ..scheduler import remove_program, sync_program

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


class ProgramZoneIn(BaseModel):
    zone_id: int
    duration_minutes: float
    sort_order: int = 0


class ProgramIn(BaseModel):
    name: str
    stage: str = "custom"
    schedule_type: str = "weekdays"          # 'weekdays' | 'interval'
    weekdays: str | None = None               # "mon,wed,fri"
    interval_days: int | None = None
    anchor_date: str | None = None            # "YYYY-MM-DD", defaults to today
    start_times: list[str]                     # one "HH:MM" per daily cycle
    run_mode: str = "sequential"               # 'sequential' | 'simultaneous'
    enabled: bool = True
    zones: list[ProgramZoneIn] = []

    @field_validator("start_times")
    @classmethod
    def check_times(cls, v):
        return _validate_times(v)


class ProgramUpdate(BaseModel):
    name: str | None = None
    stage: str | None = None
    schedule_type: str | None = None
    weekdays: str | None = None
    interval_days: int | None = None
    anchor_date: str | None = None
    start_times: list[str] | None = None
    run_mode: str | None = None
    enabled: bool | None = None
    zones: list[ProgramZoneIn] | None = None

    @field_validator("start_times")
    @classmethod
    def check_times(cls, v):
        return _validate_times(v)


@router.get("/presets")
async def list_presets():
    return presets.list_presets()


@router.get("/programs")
async def list_programs():
    return await run_in_threadpool(storage.list_programs)


@router.get("/programs/{program_id}")
async def get_program(program_id: int):
    program = await run_in_threadpool(storage.get_program, program_id)
    if not program:
        raise HTTPException(404, "Program not found.")
    return program


@router.post("/programs")
async def create_program(body: ProgramIn):
    program = await run_in_threadpool(storage.create_program, body.model_dump())
    sync_program(program)
    return program


@router.put("/programs/{program_id}")
async def update_program(program_id: int, body: ProgramUpdate):
    data = {k: v for k, v in body.model_dump().items() if v is not None}
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
