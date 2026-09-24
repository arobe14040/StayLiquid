"""
Test harness: the real runner, storage and routes, against a throwaway sqlite
file and a fake Home Assistant that just remembers what it was told.

Run from the add-on folder:  pip install -r requirements.txt pytest && pytest
"""
import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import ha_client, runner, storage  # noqa: E402


class FakeHA:
    """Stands in for Home Assistant's REST API. Every valve starts closed."""

    def __init__(self) -> None:
        self.states: dict[str, str] = {}
        self.calls: list[tuple[str, str]] = []

    async def turn_on(self, entity_id: str) -> None:
        self.calls.append(("on", entity_id))
        self.states[entity_id] = "on"

    async def turn_off(self, entity_id: str) -> None:
        self.calls.append(("off", entity_id))
        self.states[entity_id] = "off"

    async def get_state(self, entity_id: str) -> dict:
        return {"entity_id": entity_id, "state": self.states.get(entity_id, "off")}

    def opened(self) -> list[str]:
        return [entity for action, entity in self.calls if action == "on"]


@pytest.fixture
def ha(monkeypatch, tmp_path):
    monkeypatch.setattr(storage, "DB_PATH", tmp_path / "stayliquid.db")
    monkeypatch.setattr(storage, "_conn", None)
    storage.init_db()

    fake = FakeHA()
    for name in ("turn_on", "turn_off", "get_state"):
        monkeypatch.setattr(ha_client, name, getattr(fake, name))

    # The runner keeps module-level state. Asyncio primitives bind to the loop
    # that first waits on them, and each test gets its own loop, so they're
    # replaced rather than reset.
    paused, resumed = asyncio.Event(), asyncio.Event()
    resumed.set()
    monkeypatch.setattr(runner, "_paused", paused)
    monkeypatch.setattr(runner, "_resumed", resumed)
    monkeypatch.setattr(runner, "_pause_timer", None, raising=False)
    monkeypatch.setattr(runner, "_shutting_down", False, raising=False)
    monkeypatch.setattr(runner, "_cancelled_programs", set(), raising=False)
    monkeypatch.setattr(runner, "_zone_locks", {})
    monkeypatch.setattr(runner, "_stop_events", {})
    runner.current_runs.clear()

    yield fake

    runner.current_runs.clear()
    storage.get_conn().close()


def add_zone(entity_id: str, name: str, enabled: bool = True) -> dict:
    zone = storage.create_zone(entity_id, name)
    if not enabled:
        zone = storage.update_zone(zone["id"], None, False)
    return zone


def add_program(zones: list[dict], seconds: float, run_mode: str = "sequential") -> dict:
    """A program whose zones each run for `seconds` - short enough for a test."""
    return storage.create_program({
        "name": "Test program",
        "schedule_type": "weekdays",
        "weekdays": "mon,tue,wed,thu,fri,sat,sun",
        "start_times": ["06:00"],
        "run_mode": run_mode,
        "zones": [
            {"zone_id": z["id"], "duration_minutes": seconds / 60, "sort_order": i}
            for i, z in enumerate(zones)
        ],
    })


def statuses(program_id: int) -> list[str]:
    rows = storage.get_conn().execute(
        "SELECT status FROM run_log WHERE program_id = ? ORDER BY id", (program_id,)
    ).fetchall()
    return [r["status"] for r in rows]
