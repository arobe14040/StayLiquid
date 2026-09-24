import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from conftest import add_program, add_zone

from app import ha_client, scheduler, state_watch, storage
from app.api.routes_programs import router as programs_router
from app.api.routes_status import router as status_router
from app.api.routes_zones import router as zones_router


@pytest.fixture
def client(ha):
    # The routes without the add-on's startup, which wants Home Assistant.
    app = FastAPI()
    for router in (zones_router, programs_router, status_router):
        app.include_router(router, prefix="/api")
    for job in scheduler.scheduler.get_jobs():
        job.remove()
    return TestClient(app)


def program_body(**overrides):
    body = {
        "name": "Lawn",
        "schedule_type": "weekdays",
        "weekdays": "mon,wed",
        "start_times": ["06:00"],
        "zones": [],
    }
    return {**body, **overrides}


@pytest.mark.parametrize("overrides", [
    {"weekdays": "mon,funday"},
    {"weekdays": ""},
    {"schedule_type": "interval", "weekdays": None, "interval_days": None},
    {"schedule_type": "interval", "interval_days": 0},
    {"schedule_type": "sometimes"},
    {"run_mode": "all-at-once"},
    {"anchor_date": "next tuesday"},
    {"name": ""},
])
def test_unschedulable_programs_are_refused(client, overrides):
    resp = client.post("/api/programs", json=program_body(**overrides))
    assert resp.status_code == 422, resp.text
    assert storage.list_programs() == []


def test_weekdays_are_normalised(client):
    resp = client.post("/api/programs", json=program_body(weekdays="Wed, mon"))
    assert resp.status_code == 200, resp.text
    assert resp.json()["weekdays"] == "mon,wed"


def test_update_is_checked_against_the_merged_program(client):
    program = client.post("/api/programs", json=program_body()).json()
    # Switching to interval without saying how often would never schedule.
    resp = client.put(f"/api/programs/{program['id']}", json={"schedule_type": "interval"})
    assert resp.status_code == 422, resp.text


def test_zero_minute_zone_is_refused(client):
    zone = add_zone("switch.front", "Front")
    resp = client.post("/api/programs", json=program_body(
        zones=[{"zone_id": zone["id"], "duration_minutes": 0}]
    ))
    assert resp.status_code == 422


@pytest.mark.parametrize("minutes", [0, -5, 100000])
def test_manual_run_minutes_are_bounded(client, minutes):
    zone = add_zone("switch.front", "Front")
    resp = client.post(f"/api/zones/{zone['id']}/run", json={"minutes": minutes})
    assert resp.status_code == 422


def test_disabled_zone_cannot_be_run_by_hand(client):
    zone = add_zone("switch.front", "Front", enabled=False)
    resp = client.post(f"/api/zones/{zone['id']}/run", json={"minutes": 5})
    assert resp.status_code == 409


def test_one_bad_program_does_not_stop_startup_scheduling(ha):
    good = add_program([], seconds=60)
    storage.get_conn().execute(
        "INSERT INTO programs (name, schedule_type, weekdays, start_times, created_at, updated_at)"
        " VALUES ('Broken', 'weekdays', 'funday', '06:00', 'x', 'x')"
    )
    storage.get_conn().commit()

    scheduler.sync_all()   # used to raise, which stopped the add-on starting

    job_ids = {job.id for job in scheduler.scheduler.get_jobs()}
    assert f"program-{good['id']}-0" in job_ids
    for job in scheduler.scheduler.get_jobs():
        job.remove()


def test_stats_count_only_full_runs(client):
    zone = add_zone("switch.front", "Front")
    for status in ("completed", "stopped", "skipped_paused"):
        storage.log_skip(None, "Test", status, zone["id"], "Front")
    totals = client.get("/api/history/stats").json()["totals"]
    assert totals["runs"] == 1


def test_history_steps_carry_their_zone_id(client):
    zone = add_zone("switch.front", "Front")
    storage.log_skip(None, "Test", "completed", zone["id"], "Front")
    runs = client.get("/api/history").json()["runs"]
    assert runs[0]["steps"][0]["zone_id"] == zone["id"]


# ---- valves ---------------------------------------------------------------

def test_valves_use_the_valve_services(monkeypatch):
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.path)
        return httpx.Response(200, json=[])

    real_client = httpx.AsyncClient
    monkeypatch.setattr(
        ha_client.httpx, "AsyncClient",
        lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw),
    )

    import asyncio

    async def scenario():
        await ha_client._call_service("valve.garden", "on")
        await ha_client._call_service("valve.garden", "off")
        await ha_client._call_service("switch.front", "on")

    asyncio.run(scenario())
    assert seen == [
        "/core/api/services/valve/open_valve",
        "/core/api/services/valve/close_valve",
        "/core/api/services/switch/turn_on",
    ]


def test_valve_states_read_as_on_and_off():
    watcher = state_watch.ZoneStateWatcher()
    watcher.watch({"valve.garden"})
    heard = []
    watcher.add_listener(lambda entity, state: heard.append(state))

    for state in ("open", "closing", "closed"):
        watcher._handle({
            "type": "event",
            "event": {"variables": {"trigger": {
                "entity_id": "valve.garden", "to_state": {"state": state},
            }}},
        })

    # open and closing both mean water is flowing; the listener only hears changes.
    assert heard == ["on", "off"]
    assert watcher.state_of("valve.garden") == "off"
