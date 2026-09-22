"""
Executes a program: turns zone entities on/off in HA, respects rain delay,
writes to the run log, and keeps an in-memory snapshot of "what's running
right now" for the dashboard to poll.
"""
import asyncio
import logging
from datetime import datetime, timezone

from starlette.concurrency import run_in_threadpool

from . import ha_client, storage

log = logging.getLogger("stayliquid.runner")

# entity_id -> asyncio.Lock, so two programs can never fight over one zone
_zone_locks: dict[str, asyncio.Lock] = {}

# what the dashboard shows as "currently running" - list of dicts, cleared
# as each zone finishes. Kept in memory only; a restart clears it, which is
# fine since the scheduler also re-evaluates from the database on restart.
current_runs: list[dict] = []


def _lock_for(entity_id: str) -> asyncio.Lock:
    if entity_id not in _zone_locks:
        _zone_locks[entity_id] = asyncio.Lock()
    return _zone_locks[entity_id]


async def rain_delay_active() -> bool:
    delay = await run_in_threadpool(storage.get_rain_delay)
    until = delay.get("until") if delay else None
    if not until:
        return False
    return datetime.fromisoformat(until) > datetime.now(timezone.utc)


async def run_program(program_id: int, trigger_source: str = "scheduled") -> None:
    program = await run_in_threadpool(storage.get_program, program_id)
    if not program:
        return

    if trigger_source == "scheduled" and await rain_delay_active():
        await run_in_threadpool(
            storage.log_skip, program_id, program["name"], "skipped_rain_delay"
        )
        return

    zones = [z for z in program["zones"] if z["duration_minutes"] > 0]
    if not zones:
        return

    if program["run_mode"] == "simultaneous":
        await asyncio.gather(*(_run_zone(program, z, trigger_source) for z in zones))
    else:
        for z in zones:
            await _run_zone(program, z, trigger_source)


async def _run_zone(program: dict, zone: dict, trigger_source: str) -> None:
    entity_id = zone["entity_id"]
    lock = _lock_for(entity_id)
    async with lock:
        run_id = await run_in_threadpool(
            storage.start_run,
            program["id"], program["name"], zone["zone_id"], zone["zone_name"], trigger_source,
        )
        entry = {
            "run_id": run_id,
            "program_id": program["id"],
            "program_name": program["name"],
            "zone_id": zone["zone_id"],
            "zone_name": zone["zone_name"],
            "entity_id": entity_id,
            "started_at": datetime.now(timezone.utc).isoformat(),
            "duration_minutes": zone["duration_minutes"],
        }
        current_runs.append(entry)
        status = "completed"
        try:
            await ha_client.turn_on(entity_id)
            await asyncio.sleep(zone["duration_minutes"] * 60)
        except Exception:
            status = "error"
            log.exception("Error running zone %s (%s)", zone["zone_name"], entity_id)
        finally:
            try:
                await ha_client.turn_off(entity_id)
            except Exception:
                status = "error"
                log.exception("Error turning off zone %s (%s)", zone["zone_name"], entity_id)
            await run_in_threadpool(storage.finish_run, run_id, status)
            if entry in current_runs:
                current_runs.remove(entry)


async def run_zone_manual(zone_id: int, entity_id: str, zone_name: str, minutes: float) -> None:
    """One-off manual run of a single zone, outside of any program (e.g. a
    quick test-fire from the Zones tab). Logged with program_id = NULL."""
    lock = _lock_for(entity_id)
    async with lock:
        run_id = await run_in_threadpool(
            storage.start_run, None, "Manual run", zone_id, zone_name, "manual"
        )
        entry = {
            "run_id": run_id,
            "program_id": None,
            "program_name": "Manual run",
            "zone_id": zone_id,
            "zone_name": zone_name,
            "entity_id": entity_id,
            "started_at": datetime.now(timezone.utc).isoformat(),
            "duration_minutes": minutes,
        }
        current_runs.append(entry)
        status = "completed"
        try:
            await ha_client.turn_on(entity_id)
            await asyncio.sleep(minutes * 60)
        except Exception:
            status = "error"
            log.exception("Error running manual zone %s (%s)", zone_name, entity_id)
        finally:
            try:
                await ha_client.turn_off(entity_id)
            except Exception:
                status = "error"
                log.exception("Error turning off zone %s (%s)", zone_name, entity_id)
            await run_in_threadpool(storage.finish_run, run_id, status)
            if entry in current_runs:
                current_runs.remove(entry)
