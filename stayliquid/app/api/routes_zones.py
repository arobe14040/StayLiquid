import asyncio

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from .. import ha_client, storage
from ..runner import run_zone_manual

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


@router.post("/zones")
async def create_zone(body: ZoneCreate):
    existing = await run_in_threadpool(storage.list_zones)
    if any(z["entity_id"] == body.entity_id for z in existing):
        raise HTTPException(400, "That entity is already a zone.")
    return await run_in_threadpool(storage.create_zone, body.entity_id, body.name)


@router.put("/zones/{zone_id}")
async def update_zone(zone_id: int, body: ZoneUpdate):
    zone = await run_in_threadpool(storage.update_zone, zone_id, body.name, body.enabled)
    if not zone:
        raise HTTPException(404, "Zone not found.")
    return zone


@router.delete("/zones/{zone_id}")
async def delete_zone(zone_id: int):
    await run_in_threadpool(storage.delete_zone, zone_id)
    return {"ok": True}


@router.post("/zones/{zone_id}/run")
async def run_zone_now(zone_id: int, body: ManualRun):
    zones = await run_in_threadpool(storage.list_zones)
    zone = next((z for z in zones if z["id"] == zone_id), None)
    if not zone:
        raise HTTPException(404, "Zone not found.")
    asyncio.create_task(
        run_zone_manual(zone_id, zone["entity_id"], zone["name"], body.minutes)
    )
    return {"ok": True}
