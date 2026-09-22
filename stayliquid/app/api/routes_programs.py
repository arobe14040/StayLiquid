import asyncio

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from .. import storage
from ..presets import GROWTH_STAGE_PRESETS
from ..runner import run_program
from ..scheduler import remove_program, sync_program

router = APIRouter()


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
    start_time: str                            # "HH:MM"
    run_mode: str = "sequential"               # 'sequential' | 'simultaneous'
    enabled: bool = True
    zones: list[ProgramZoneIn] = []


class ProgramUpdate(BaseModel):
    name: str | None = None
    stage: str | None = None
    schedule_type: str | None = None
    weekdays: str | None = None
    interval_days: int | None = None
    anchor_date: str | None = None
    start_time: str | None = None
    run_mode: str | None = None
    enabled: bool | None = None
    zones: list[ProgramZoneIn] | None = None


@router.get("/presets")
async def list_presets():
    return GROWTH_STAGE_PRESETS


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
    data = body.model_dump()
    data["zones"] = [z for z in data["zones"]]
    program = await run_in_threadpool(storage.create_program, data)
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
    asyncio.create_task(run_program(program_id, trigger_source="manual"))
    return {"ok": True}
