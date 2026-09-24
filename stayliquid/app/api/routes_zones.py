import asyncio

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from .. import ha_client, runner, state_watch, storage
from ..runner import run_zone_manual, stop_zone

router = APIRouter()


# Twelve hours is far past any real watering; anything longer is a typo, and
# one that would otherwise run a valve for days.
MAX_RUN_MINUTES = 12 * 60


class ZoneCreate(BaseModel):
    entity_id: str = Field(pattern=r"^(switch|valve)\.\w+$")
    name: str = Field(min_length=1, max_length=100)


class ZoneUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    enabled: bool | None = None


class ManualRun(BaseModel):
    minutes: float = Field(default=5, gt=0, le=MAX_RUN_MINUTES)


@router.get("/ha/entities")
async def ha_entities():
    """switch.* / valve.* entities from HA, for the 'add a zone' picker."""
    return await ha_client.get_zone_candidate_entities()


@router.get("/zones")
async def list_zones():
    return await run_in_threadpool(storage.list_zones)


@router.get("/zones/states")
async def zone_states():
    """Current on/off for the configured zones.

    Served from the event-stream cache when it's connected, which costs nothing
    and is as current as Home Assistant itself. Falls back to asking outright,
    so a dropped stream degrades to slower rather than to stale.
    """
    zones = await run_in_threadpool(storage.list_zones)
    states, live = await state_watch.zone_states({z["entity_id"] for z in zones})
    return {"live": live, "states": states}


@router.post("/zones")
async def create_zone(body: ZoneCreate):
    existing = await run_in_threadpool(storage.list_zones)
    if any(z["entity_id"] == body.entity_id for z in existing):
        raise HTTPException(400, "That entity is already a zone.")
    zone = await run_in_threadpool(storage.create_zone, body.entity_id, body.name)
    await state_watch.sync_watched_zones()
    return zone


@router.put("/zones/{zone_id}")
async def update_zone(zone_id: int, body: ZoneUpdate):
    zone = await run_in_threadpool(storage.update_zone, zone_id, body.name, body.enabled)
    if not zone:
        raise HTTPException(404, "Zone not found.")
    return zone


@router.delete("/zones/{zone_id}")
async def delete_zone(zone_id: int):
    zone = await _get_zone(zone_id)
    # Once the zone is gone nothing on the page can stop it, so don't leave it
    # watering. The run's own cleanup closes the valve and logs it.
    stop_zone(zone["entity_id"])
    await run_in_threadpool(storage.delete_zone, zone_id)
    await state_watch.sync_watched_zones()
    return {"ok": True}


@router.post("/zones/{zone_id}/run")
async def run_zone_now(zone_id: int, body: ManualRun):
    zone = await _get_zone(zone_id)
    if not zone["enabled"]:
        raise HTTPException(409, "This zone is disabled. Enable it first.")
    # Better to say so than to start a run that immediately sits and waits.
    if (await runner.pause_state())["active"]:
        raise HTTPException(409, "Watering is paused. Resume it first.")
    asyncio.create_task(
        run_zone_manual(zone_id, zone["entity_id"], zone["name"], body.minutes)
    )
    return {"ok": True}


@router.post("/zones/{zone_id}/stop")
async def stop_zone_now(zone_id: int):
    """Turn a zone off, whoever opened it.

    A run of ours is cut short and its own cleanup closes the valve. A valve
    that's open without a run - switched on in Home Assistant, say - is closed
    here, so this is a dependable "off" rather than only a cancel.
    """
    zone = await _get_zone(zone_id)
    stopped = stop_zone(zone["entity_id"])
    if not stopped:
        await runner.turn_zone_off(zone["entity_id"], zone["name"])
    return {"ok": True, "stopped": stopped}


async def _get_zone(zone_id: int) -> dict:
    zones = await run_in_threadpool(storage.list_zones)
    zone = next((z for z in zones if z["id"] == zone_id), None)
    if not zone:
        raise HTTPException(404, "Zone not found.")
    return zone
