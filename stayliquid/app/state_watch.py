"""
Live zone states, pushed from Home Assistant over its WebSocket API.

The add-on needs to know when a valve is switched off by something other than
itself - in Home Assistant, from a dashboard, or by hand at the box. Asking over
REST on a timer worked but meant up to half a minute of watering a valve that
was already closed. Home Assistant will push the change instead, so this keeps
one long-lived connection and lets consumers react the moment it arrives.

Two rules shape everything here:

* A dropped connection must never look like "the valve is off". Callers check
  `is_live()` and fall back to polling when it is False, because stopping a run
  on missing information is worse than running a little longer than intended.
* The connection is the add-on's, not a request's. It survives Home Assistant
  restarting, reconnects with backoff, and re-subscribes each time.
"""
import asyncio
import json
import logging
import os
import random
import time
from collections.abc import Callable

import websockets

from .ha_client import normalize_state, transition_of

log = logging.getLogger("stayliquid.state_watch")

WS_URL = "ws://supervisor/core/websocket"

# Home Assistant restarts are routine, so reconnecting has to be patient rather
# than give up, but not so eager that a Core outage becomes a tight loop.
BACKOFF_START_SECONDS = 1
BACKOFF_MAX_SECONDS = 60

# The library's own keepalive; a silently dead socket surfaces as a close.
PING_INTERVAL_SECONDS = 20
PING_TIMEOUT_SECONDS = 20

# get_states returns every entity Home Assistant has, not just the zones, and on
# a large install that is well past the library's 1 MiB default - which closes
# the connection on every attempt. Bounded, but with plenty of room.
MAX_MESSAGE_BYTES = 64 * 1024 * 1024

StateListener = Callable[[str, str], None]


class ZoneStateWatcher:
    """Tracks the current state of the zone entities, live where possible."""

    def __init__(self) -> None:
        self._entities: set[str] = set()
        self._states: dict[str, str] = {}
        # As Home Assistant sent it, before the on/off mapping - the only place
        # a valve's opening/closing survives.
        self._raw: dict[str, str] = {}
        self._listeners: list[StateListener] = []
        self._connection: websockets.ClientConnection | None = None
        self._task: asyncio.Task | None = None
        self._message_id = 0
        self._trigger_subscription: int | None = None
        self._resubscribe = asyncio.Event()

    # -- lifecycle ---------------------------------------------------------

    def start(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run_forever(), name="ha-state-watch")

    async def stop(self) -> None:
        if self._task is None:
            return
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass
        self._task = None
        self._connection = None

    # -- what callers use --------------------------------------------------

    def is_live(self) -> bool:
        """True when the cache is being kept current by an open connection."""
        return self._connection is not None

    def state_of(self, entity_id: str) -> str | None:
        return self._states.get(entity_id)

    def known_states(self) -> dict[str, str]:
        return dict(self._states)

    def known_raw(self) -> dict[str, str]:
        return dict(self._raw)

    def add_listener(self, listener: StateListener) -> None:
        self._listeners.append(listener)

    def remove_listener(self, listener: StateListener) -> None:
        if listener in self._listeners:
            self._listeners.remove(listener)

    def watch(self, entity_ids: set[str]) -> None:
        """Set the entities to follow. Safe to call whenever zones change; it
        only re-subscribes if the set actually differs."""
        if entity_ids == self._entities:
            return
        self._entities = set(entity_ids)
        self._states = {k: v for k, v in self._states.items() if k in self._entities}
        self._raw = {k: v for k, v in self._raw.items() if k in self._entities}
        self._resubscribe.set()

    # -- connection --------------------------------------------------------

    async def _run_forever(self) -> None:
        backoff = BACKOFF_START_SECONDS
        while True:
            try:
                await self._connect_and_listen()
                backoff = BACKOFF_START_SECONDS  # a clean session resets the wait
            except asyncio.CancelledError:
                raise
            except Exception as err:
                log.warning("Home Assistant event stream dropped (%s); retrying.", err)
            finally:
                self._connection = None

            # Jitter keeps several add-ons from retrying in lockstep after a
            # Home Assistant restart.
            await asyncio.sleep(backoff + random.uniform(0, backoff * 0.25))
            backoff = min(backoff * 2, BACKOFF_MAX_SECONDS)

    async def _connect_and_listen(self) -> None:
        token = os.environ.get("SUPERVISOR_TOKEN", "")
        if not token:
            raise RuntimeError("no SUPERVISOR_TOKEN; cannot reach Home Assistant")

        async with websockets.connect(
            WS_URL,
            ping_interval=PING_INTERVAL_SECONDS,
            ping_timeout=PING_TIMEOUT_SECONDS,
            max_queue=64,
            max_size=MAX_MESSAGE_BYTES,
        ) as connection:
            await self._authenticate(connection, token)
            self._connection = connection
            log.info("Watching zone states over the Home Assistant event stream.")

            # Subscribe before reading current values, so a change landing
            # between the two is delivered rather than lost.
            await self._subscribe(connection)
            await self._prime_states(connection)

            await self._consume(connection)

    async def _authenticate(self, connection, token: str) -> None:
        greeting = json.loads(await connection.recv())
        if greeting.get("type") != "auth_required":
            raise RuntimeError(f"unexpected greeting: {greeting.get('type')}")

        await connection.send(json.dumps({"type": "auth", "access_token": token}))
        reply = json.loads(await connection.recv())
        if reply.get("type") != "auth_ok":
            # Retrying won't fix a rejected token, but the supervisor rotates it
            # across restarts, so the backoff loop is still the right home.
            raise RuntimeError(f"Home Assistant rejected the add-on token: {reply}")

    def _next_id(self) -> int:
        self._message_id += 1
        return self._message_id

    async def _subscribe(self, connection) -> None:
        if not self._entities:
            self._trigger_subscription = None
            return

        self._trigger_subscription = self._next_id()
        await connection.send(json.dumps({
            "id": self._trigger_subscription,
            "type": "subscribe_trigger",
            "trigger": {"platform": "state", "entity_id": sorted(self._entities)},
        }))

    async def _prime_states(self, connection) -> None:
        await connection.send(json.dumps({"id": self._next_id(), "type": "get_states"}))

    async def _consume(self, connection) -> None:
        """Read messages until the socket closes, re-subscribing on the way if
        the zone list changed."""
        resubscribe_wait = asyncio.create_task(self._resubscribe.wait())
        receive: asyncio.Task | None = None
        try:
            while True:
                # Carried across iterations rather than recreated, so a
                # re-subscribe in the middle doesn't drop a message in flight.
                if receive is None:
                    receive = asyncio.create_task(connection.recv())

                done, _ = await asyncio.wait(
                    {receive, resubscribe_wait}, return_when=asyncio.FIRST_COMPLETED
                )

                if resubscribe_wait in done:
                    self._resubscribe.clear()
                    resubscribe_wait = asyncio.create_task(self._resubscribe.wait())
                    await self._unsubscribe(connection)
                    await self._subscribe(connection)
                    # Newly watched entities have no cached state yet, and a
                    # trigger only fires on change - so ask for the current
                    # values too, or they stay unknown until one happens to move.
                    await self._prime_states(connection)

                if receive in done:
                    message = receive.result()
                    receive = None
                    self._handle(json.loads(message))
        finally:
            # Both are cancelled and awaited: a task left pending on shutdown,
            # or one that failed as the socket closed, would otherwise surface
            # as "Task exception was never retrieved".
            pending = [task for task in (receive, resubscribe_wait) if task is not None]
            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)

    async def _unsubscribe(self, connection) -> None:
        if self._trigger_subscription is None:
            return
        await connection.send(json.dumps({
            "id": self._next_id(),
            "type": "unsubscribe_events",
            "subscription": self._trigger_subscription,
        }))
        self._trigger_subscription = None

    # -- messages ----------------------------------------------------------

    def _handle(self, message: dict) -> None:
        kind = message.get("type")

        if kind == "event":
            trigger = (message.get("event") or {}).get("variables", {}).get("trigger", {})
            to_state = trigger.get("to_state") or {}
            entity_id, state = trigger.get("entity_id"), to_state.get("state")
            if entity_id and state is not None:
                self._record(entity_id, state)

        elif kind == "result":
            if not message.get("success", True):
                log.warning("Home Assistant refused a request: %s", message.get("error"))
                return
            # The only request expecting a payload back is get_states.
            for entity in message.get("result") or []:
                if isinstance(entity, dict) and entity.get("entity_id") in self._entities:
                    self._record(entity["entity_id"], entity.get("state"))

    def _record(self, entity_id: str, raw: str | None) -> None:
        if entity_id not in self._entities or raw is None:
            return
        self._raw[entity_id] = raw
        # Listeners hear on/off changes only: open -> closing is still on.
        state = normalize_state(raw)
        if self._states.get(entity_id) == state:
            return
        self._states[entity_id] = state

        for listener in list(self._listeners):
            try:
                listener(entity_id, state)
            except Exception:
                log.exception("A zone state listener failed for %s", entity_id)


watcher = ZoneStateWatcher()


# When the event stream is down, state has to be asked for - but the dashboard
# polls every few seconds, and turning that into a request to Home Assistant
# each time would be worse than the problem. One fetch is shared until it ages
# out.
_FALLBACK_TTL_SECONDS = 20
_fallback = {"fetched_at": 0.0, "states": {}, "raw": {}}


async def zone_states(entity_ids: set[str]) -> tuple[dict[str, str | None], bool]:
    """Current state of the given entities, and whether it came from the live
    stream. Unknown entities come back as None rather than being left out, so
    callers can tell "off" from "no idea"."""
    if not entity_ids:
        return {}, watcher.is_live()

    if watcher.is_live():
        known = watcher.known_states()
        if entity_ids <= known.keys():
            return {k: known[k] for k in entity_ids}, True

    now = time.monotonic()
    if now - _fallback["fetched_at"] > _FALLBACK_TTL_SECONDS:
        from . import ha_client

        try:
            entities = await ha_client.get_zone_candidate_entities()
            _fallback["states"] = {e["entity_id"]: e["state"] for e in entities}
            _fallback["raw"] = {e["entity_id"]: e["raw_state"] for e in entities}
            _fallback["fetched_at"] = now
        except Exception:
            log.debug("Could not refresh zone states from Home Assistant.")

    return {k: _fallback["states"].get(k) for k in entity_ids}, False


def zone_transitions(entity_ids: set[str]) -> dict[str, str | None]:
    """Which zones Home Assistant says are opening or closing. Read after
    zone_states(), which keeps the fallback current when the stream is down."""
    raw = dict(_fallback["raw"])
    if watcher.is_live():
        raw.update(watcher.known_raw())
    return {k: transition_of(raw.get(k)) for k in entity_ids}


async def sync_watched_zones() -> None:
    """Point the watcher at the zones currently configured. Call after anything
    that changes which entities are zones."""
    from starlette.concurrency import run_in_threadpool

    from . import storage

    zones = await run_in_threadpool(storage.list_zones)
    watcher.watch({z["entity_id"] for z in zones})
