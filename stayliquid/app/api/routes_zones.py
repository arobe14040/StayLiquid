import asyncio

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from .. import ha_client, runner, state_watch, storage
from ..runner import run_zone_manual, stop_zone

router = APIRouter()


class ZoneCreate(BaseModel):
    entity_id: str
    name: str


class ZoneUpdate(BaseModel):
    name: str | None = None
    enabled: bool | None = None


class ManualRun(BaseModel):
    minutes: float = 5


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
    wanted = {z["entity_id"] for z in zones}
    if not wanted:
        return {"live": state_watch.watcher.is_live(), "states": {}}

    if state_watch.watcher.is_live():
        known = state_watch.watcher.known_states()
        if wanted <= known.keys():
            return {"live": True, "states": {k: known[k] for k in wanted}}

    try:
        entities = await ha_client.get_zone_candidate_entities()
    except Exception:
        raise HTTPException(503, "Could not reach Home Assistant.")
    return {
        "live": False,
        "states": {e["entity_id"]: e["state"] for e in entities if e["entity_id"] in wanted},
    }


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
    await run_in_threadpool(storage.delete_zone, zone_id)
    await state_watch.sync_watched_zones()
    return {"ok": True}


@router.post("/zones/{zone_id}/run")
async def run_zone_now(zone_id: int, body: ManualRun):
    zone = await _get_zone(zone_id)
    # Better to say so than to start a run that immediately sits and waits.
    if (await runner.pause_state())["active"]:
        raise HTTPException(409, "Watering is paused. Resume it first.")
    asyncio.create_task(
        run_zone_manual(zone_id, zone["entity_id"], zone["name"], body.minutes)
    )
    return {"ok": True}


@router.post("/zones/{zone_id}/stop")
async def stop_zone_now(zone_id: int):
    """Cut a run short. The valve closes as part of that run's own cleanup."""
    zone = await _get_zone(zone_id)
    return {"ok": True, "stopped": stop_zone(zone["entity_id"])}


async def _get_zone(zone_id: int) -> dict:
    zones = await run_in_threadpool(storage.list_zones)
    zone = next((z for z in zones if z["id"] == zone_id), None)
    if not zone:
        raise HTTPException(404, "Zone not found.")
    return zone
