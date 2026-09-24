import asyncio
from datetime import datetime, timedelta, timezone

from conftest import add_program, add_zone, statuses

from app import runner, storage


def in_seconds(seconds: float) -> str:
    return (datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat()


def test_pause_expiring_with_nothing_held_reopens_the_gate(ha):
    """Used to stay shut for good, skipping every scheduled program after."""
    async def scenario():
        await runner.pause_until(in_seconds(0.3))
        assert runner._paused.is_set()
        await asyncio.sleep(1.2)
        assert not runner._paused.is_set()
        assert (await runner.pause_state())["active"] is False

    asyncio.run(scenario())


def test_stale_gate_does_not_skip_a_scheduled_program(ha):
    """A pause that ran out while the add-on wasn't looking must not count."""
    zone = add_zone("switch.front", "Front")
    program = add_program([zone], seconds=0.3)

    async def scenario():
        storage.set_pause(in_seconds(-60))   # expired a minute ago
        runner._paused.set()                  # ...but the gate never heard
        runner._resumed.clear()
        await runner.run_program(program["id"], "scheduled")

    asyncio.run(scenario())
    assert statuses(program["id"]) == ["completed"]
    assert ha.opened() == ["switch.front"]


def test_disabled_zone_is_left_out_of_a_program(ha):
    front = add_zone("switch.front", "Front")
    back = add_zone("switch.back", "Back", enabled=False)
    program = add_program([front, back], seconds=0.2)

    asyncio.run(runner.run_program(program["id"], "scheduled"))

    assert ha.opened() == ["switch.front"]
    assert statuses(program["id"]) == ["completed"]


def test_expired_pause_ends_the_program_instead_of_moving_on(ha):
    front = add_zone("switch.front", "Front")
    back = add_zone("switch.back", "Back")
    program = add_program([front, back], seconds=3)

    async def scenario():
        task = asyncio.create_task(runner.run_program(program["id"], "scheduled"))
        await asyncio.sleep(0.3)
        await runner.pause_until(in_seconds(0.5))
        await asyncio.wait_for(task, timeout=5)

    asyncio.run(scenario())
    assert ha.opened() == ["switch.front"], "the second zone must not open"
    assert statuses(program["id"]) == ["paused_expired"]


def test_resume_carries_the_program_on(ha):
    """The other side of the above: pressing resume picks up where it left off."""
    front = add_zone("switch.front", "Front")
    back = add_zone("switch.back", "Back")
    program = add_program([front, back], seconds=0.6)

    async def scenario():
        task = asyncio.create_task(runner.run_program(program["id"], "scheduled"))
        await asyncio.sleep(0.2)
        await runner.pause_until(in_seconds(60))
        await asyncio.sleep(0.3)
        await runner.pause_until(None)
        await asyncio.wait_for(task, timeout=5)

    asyncio.run(scenario())
    assert ha.opened() == ["switch.front", "switch.front", "switch.back"]
    assert statuses(program["id"]) == ["completed", "completed"]


def test_shutdown_does_not_open_the_next_zone(ha):
    front = add_zone("switch.front", "Front")
    back = add_zone("switch.back", "Back")
    program = add_program([front, back], seconds=3)

    async def scenario():
        task = asyncio.create_task(runner.run_program(program["id"], "scheduled"))
        await asyncio.sleep(0.3)
        await runner.stop_all("test shutdown")
        # Stand in for the valve-closed event that used to let the run move on.
        runner._stop_events.get("switch.front", asyncio.Event()).set()
        await asyncio.wait_for(task, timeout=5)

    asyncio.run(scenario())
    assert ha.opened() == ["switch.front"]
    assert ha.states["switch.front"] == "off"
    assert statuses(program["id"]) == ["interrupted"]


def test_deleting_a_program_stops_it(ha):
    front = add_zone("switch.front", "Front")
    back = add_zone("switch.back", "Back")
    program = add_program([front, back], seconds=3)

    async def scenario():
        task = asyncio.create_task(runner.run_program(program["id"], "scheduled"))
        await asyncio.sleep(0.3)
        assert runner.stop_program(program["id"]) == 1
        await asyncio.wait_for(task, timeout=5)

    asyncio.run(scenario())
    assert ha.opened() == ["switch.front"]
    assert ha.states["switch.front"] == "off"
    assert statuses(program["id"]) == ["stopped"]


def test_a_valve_being_closed_by_the_add_on_reads_as_closing(ha, monkeypatch):
    """Between a run ending and Home Assistant confirming, the valve still
    reads as on; the add-on says it's closing it rather than leave the page to
    call it "opened elsewhere"."""
    seen = []

    async def slow_turn_off(entity_id):
        seen.append(runner.closing_now(entity_id))
        await asyncio.sleep(0.1)
        ha.states[entity_id] = "off"

    monkeypatch.setattr(runner.ha_client, "turn_off", slow_turn_off)
    asyncio.run(runner.turn_zone_off("valve.garden", "Garden"))

    assert seen == [True]
    assert runner.closing_now("valve.garden") is False
