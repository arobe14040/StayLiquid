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

# Closing a valve is the safety-critical direction: a turn_on that fails just
# means dry grass, but a turn_off that fails means water running unattended.
TURN_OFF_ATTEMPTS = 4
TURN_OFF_RETRY_SECONDS = 5

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


async def _close_valve(entity_id: str, zone_name: str) -> bool:
    """Turn a zone off, retrying a few times. A single failed call here would
    otherwise leave the valve open until something else happened to close it."""
    for attempt in range(1, TURN_OFF_ATTEMPTS + 1):
        try:
            await ha_client.turn_off(entity_id)
            if attempt > 1:
                log.info("Closed %s (%s) on attempt %d", zone_name, entity_id, attempt)
            return True
        except Exception:
            log.exception(
                "Attempt %d/%d to close %s (%s) failed",
                attempt, TURN_OFF_ATTEMPTS, zone_name, entity_id,
            )
            if attempt < TURN_OFF_ATTEMPTS:
                await asyncio.sleep(TURN_OFF_RETRY_SECONDS)

    log.error(
        "GAVE UP closing %s (%s) - it may still be running. Check the valve.",
        zone_name, entity_id,
    )
    return False


async def _entity_unavailable(entity_id: str) -> bool:
    """True only when Home Assistant positively reports the entity as missing
    or unavailable. If the check itself fails we return False and let the
    turn_on attempt produce the real error, rather than skipping a good zone."""
    try:
        state = await ha_client.get_state(entity_id)
    except Exception:
        log.warning("Could not check the state of %s before running it.", entity_id)
        return False
    if state is None:
        return True
    return state.get("state") in ("unavailable", "unknown")


async def stop_all(reason: str) -> int:
    """Close every valve we currently believe is open.

    Called during shutdown, before the event loop cancels the run tasks. Without
    this, a zone caught mid-run stays open: the task's own cleanup can't finish
    because awaiting anything in a cancelled task raises immediately.
    """
    open_runs = list(current_runs)
    if not open_runs:
        return 0

    log.warning("Closing %d open zone(s) - %s", len(open_runs), reason)
    for entry in open_runs:
        # Claim the entry first so the zone's own cleanup doesn't double up.
        if entry in current_runs:
            current_runs.remove(entry)
        else:
            continue
        await _close_valve(entry["entity_id"], entry["zone_name"])
        await run_in_threadpool(storage.finish_run, entry["run_id"], "interrupted")
    return len(open_runs)


async def recover_orphaned_runs() -> int:
    """Close valves left open by an unclean stop.

    On a normal shutdown the run tasks get cancelled and close their own valves.
    A hard kill - SIGKILL, container crash, host power loss - unwinds nothing,
    so a zone can still be physically open with no process left to close it.
    The run log is the only record that survives, so anything still marked
    'running' at startup gets closed for real here.

    Only zones this add-on believes it opened are touched, so a zone somebody
    switched on by hand in Home Assistant is left alone.
    """
    orphans = await run_in_threadpool(storage.list_orphaned_runs)
    if not orphans:
        return 0

    log.warning("Found %d zone(s) still open from an unclean stop.", len(orphans))
    for orphan in orphans:
        entity_id = orphan.get("entity_id")
        if not entity_id:
            log.warning(
                "Run %s was open but its zone no longer exists - cannot close it.",
                orphan["id"],
            )
            continue
        await _close_valve(entity_id, orphan.get("zone_name") or entity_id)

    await run_in_threadpool(storage.close_orphaned_runs)
    return len(orphans)


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
    await _water(
        program_id=program["id"],
        program_name=program["name"],
        zone_id=zone["zone_id"],
        zone_name=zone["zone_name"],
        entity_id=zone["entity_id"],
        minutes=zone["duration_minutes"],
        trigger_source=trigger_source,
    )


async def run_zone_manual(zone_id: int, entity_id: str, zone_name: str, minutes: float) -> None:
    """One-off manual run of a single zone, outside of any program (e.g. a
    quick test-fire from the Zones tab). Logged with program_id = NULL."""
    await _water(
        program_id=None,
        program_name="Manual run",
        zone_id=zone_id,
        zone_name=zone_name,
        entity_id=entity_id,
        minutes=minutes,
        trigger_source="manual",
    )


async def _water(
    *,
    program_id: int | None,
    program_name: str,
    zone_id: int,
    zone_name: str,
    entity_id: str,
    minutes: float,
    trigger_source: str,
) -> None:
    """Open one valve, wait, close it - logging the outcome either way.

    Membership in current_runs is what says "this coroutine owns the valve". If
    stop_all() claims the entry during shutdown, the cleanup here stands down so
    the valve isn't closed and logged twice.
    """
    lock = _lock_for(entity_id)
    async with lock:
        if await _entity_unavailable(entity_id):
            log.error("Skipping %s - %s is unavailable in Home Assistant.", zone_name, entity_id)
            await run_in_threadpool(
                storage.log_skip, program_id, program_name, "skipped_unavailable",
                zone_id, zone_name, trigger_source,
            )
            return

        run_id = await run_in_threadpool(
            storage.start_run, program_id, program_name, zone_id, zone_name, trigger_source
        )
        entry = {
            "run_id": run_id,
            "program_id": program_id,
            "program_name": program_name,
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
            log.exception("Error running zone %s (%s)", zone_name, entity_id)
        finally:
            if entry in current_runs:
                current_runs.remove(entry)
                if not await _close_valve(entity_id, zone_name):
                    status = "error"
                await run_in_threadpool(storage.finish_run, run_id, status)
