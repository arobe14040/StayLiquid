"""
Talks to Home Assistant Core through the Supervisor's internal API proxy.

Because config.yaml sets `homeassistant_api: true`, the Supervisor injects a
SUPERVISOR_TOKEN environment variable into this container at startup and
makes Home Assistant's REST API reachable at http://supervisor/core/api -
no manual long-lived token needed.
"""
import os
import httpx

BASE_URL = "http://supervisor/core/api"
SUPERVISOR_URL = "http://supervisor"
TOKEN = os.environ.get("SUPERVISOR_TOKEN", "")

_headers = {
    "Authorization": f"Bearer {TOKEN}",
    "Content-Type": "application/json",
}

# Domains we consider valid "zone" entities. valve.* is the modern HA
# platform type for irrigation/water valves; switch.* covers the very common
# case of a sprinkler relay board exposed as plain switches.
ZONE_DOMAINS = ("switch", "valve")

# A valve reports open/closed (and opening/closing in between) where a switch
# reports on/off. Everything past this module speaks on/off, so the valve
# vocabulary is translated here, once. A closing valve still has water going
# through it, so it counts as on until it says closed.
_VALVE_STATES = {"open": "on", "opening": "on", "closing": "on", "closed": "off"}

# The services each domain uses to open and close. valve.* has no turn_on.
_SERVICES = {
    "switch": {"on": "turn_on", "off": "turn_off"},
    "valve": {"on": "open_valve", "off": "close_valve"},
}


def normalize_state(state: str | None) -> str | None:
    """Map a zone entity's state onto on/off, leaving anything else
    (unavailable, unknown) as it is."""
    if state is None:
        return None
    return _VALVE_STATES.get(state, state)


def transition_of(state: str | None) -> str | None:
    """'opening' or 'closing' while a valve is travelling, else None. On/off
    alone can't say this, and a valve can take several seconds to move - the
    page needs it to show "Closing..." rather than a switch that looks stuck."""
    return state if state in ("opening", "closing") else None


async def get_supervisor_timezone() -> str | None:
    """Home Assistant's configured timezone, e.g. "America/New_York".

    Supervisor also injects a TZ environment variable, but it's baked in when
    the container is created and is never refreshed - so if you change the
    timezone in Home Assistant, TZ keeps the old value until the add-on is
    rebuilt. /info is the live answer, so prefer it and fall back to TZ.
    """
    async with httpx.AsyncClient(base_url=SUPERVISOR_URL, headers=_headers, timeout=10) as client:
        resp = await client.get("/info")
        resp.raise_for_status()
        return resp.json().get("data", {}).get("timezone")


async def get_zone_candidate_entities() -> list[dict]:
    """All switch/valve entities currently known to HA, for the zone picker."""
    async with httpx.AsyncClient(base_url=BASE_URL, headers=_headers, timeout=10) as client:
        resp = await client.get("/states")
        resp.raise_for_status()
        states = resp.json()

    out = []
    for s in states:
        entity_id = s.get("entity_id", "")
        domain = entity_id.split(".", 1)[0] if "." in entity_id else ""
        if domain in ZONE_DOMAINS:
            out.append(
                {
                    "entity_id": entity_id,
                    "friendly_name": s.get("attributes", {}).get("friendly_name", entity_id),
                    "state": normalize_state(s.get("state")),
                    "raw_state": s.get("state"),
                }
            )
    out.sort(key=lambda e: e["friendly_name"])
    return out


async def get_state(entity_id: str) -> dict | None:
    """The entity's state object, with `state` already mapped onto on/off."""
    async with httpx.AsyncClient(base_url=BASE_URL, headers=_headers, timeout=10) as client:
        resp = await client.get(f"/states/{entity_id}")
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        state = resp.json()
    state["state"] = normalize_state(state.get("state"))
    return state


async def turn_on(entity_id: str) -> None:
    await _call_service(entity_id, "on")


async def turn_off(entity_id: str) -> None:
    await _call_service(entity_id, "off")


async def _call_service(entity_id: str, direction: str) -> None:
    domain = entity_id.split(".", 1)[0]
    service = _SERVICES.get(domain, _SERVICES["switch"])[direction]
    async with httpx.AsyncClient(base_url=BASE_URL, headers=_headers, timeout=10) as client:
        resp = await client.post(
            f"/services/{domain}/{service}",
            json={"entity_id": entity_id},
        )
        resp.raise_for_status()
