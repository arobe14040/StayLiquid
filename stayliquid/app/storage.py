"""
Thin sqlite3 wrapper. No ORM on purpose - this app is small enough that
plain SQL is easier to reason about than fighting an ORM around FastAPI's
async model. All functions here are synchronous; callers from async routes
run them in a thread via `run_in_threadpool` (see app/db.py helper) so we
never block the event loop on disk I/O.
"""
import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

DB_PATH = Path("/data/stayliquid.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS zones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS programs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    stage TEXT,                                  -- preset id this was created from, or 'custom'
    schedule_type TEXT NOT NULL DEFAULT 'weekdays', -- 'weekdays' | 'interval'
    weekdays TEXT,                                -- comma list: mon,tue,wed,thu,fri,sat,sun
    interval_days INTEGER,                         -- used when schedule_type = 'interval'
    anchor_date TEXT,                              -- ISO date the interval counts from
    start_time TEXT NOT NULL,                      -- "HH:MM", 24h
    run_mode TEXT NOT NULL DEFAULT 'sequential',    -- 'sequential' | 'simultaneous'
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS program_zones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    program_id INTEGER NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
    zone_id INTEGER NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
    duration_minutes REAL NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS rain_delay (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    until TEXT
);

CREATE TABLE IF NOT EXISTS run_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    program_id INTEGER,
    program_name TEXT,
    zone_id INTEGER,
    zone_name TEXT,
    trigger_source TEXT,     -- 'scheduled' | 'manual'
    started_at TEXT,
    ended_at TEXT,
    status TEXT               -- 'running' | 'completed' | 'skipped_rain_delay' | 'error'
);
"""


def _connect():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


_conn = None


def get_conn():
    global _conn
    if _conn is None:
        _conn = _connect()
    return _conn


def init_db():
    conn = get_conn()
    conn.executescript(SCHEMA)
    conn.execute(
        "INSERT OR IGNORE INTO rain_delay (id, until) VALUES (1, NULL)"
    )
    conn.commit()


@contextmanager
def tx():
    conn = get_conn()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def row_to_dict(row: sqlite3.Row) -> dict:
    return dict(row) if row is not None else None


# ---- zones ----------------------------------------------------------------

def list_zones() -> list[dict]:
    conn = get_conn()
    rows = conn.execute("SELECT * FROM zones ORDER BY name").fetchall()
    return [row_to_dict(r) for r in rows]


def create_zone(entity_id: str, name: str) -> dict:
    with tx() as conn:
        cur = conn.execute(
            "INSERT INTO zones (entity_id, name, enabled) VALUES (?, ?, 1)",
            (entity_id, name),
        )
        return row_to_dict(
            conn.execute("SELECT * FROM zones WHERE id = ?", (cur.lastrowid,)).fetchone()
        )


def update_zone(zone_id: int, name: str | None, enabled: bool | None) -> dict | None:
    conn = get_conn()
    existing = conn.execute("SELECT * FROM zones WHERE id = ?", (zone_id,)).fetchone()
    if not existing:
        return None
    new_name = name if name is not None else existing["name"]
    new_enabled = int(enabled) if enabled is not None else existing["enabled"]
    with tx() as c:
        c.execute(
            "UPDATE zones SET name = ?, enabled = ? WHERE id = ?",
            (new_name, new_enabled, zone_id),
        )
        return row_to_dict(c.execute("SELECT * FROM zones WHERE id = ?", (zone_id,)).fetchone())


def delete_zone(zone_id: int) -> None:
    with tx() as conn:
        conn.execute("DELETE FROM zones WHERE id = ?", (zone_id,))


# ---- programs ---------------------------------------------------------------

def list_programs() -> list[dict]:
    conn = get_conn()
    programs = [row_to_dict(r) for r in conn.execute("SELECT * FROM programs ORDER BY name").fetchall()]
    for p in programs:
        p["zones"] = list_program_zones(p["id"])
    return programs


def get_program(program_id: int) -> dict | None:
    conn = get_conn()
    row = conn.execute("SELECT * FROM programs WHERE id = ?", (program_id,)).fetchone()
    if not row:
        return None
    program = row_to_dict(row)
    program["zones"] = list_program_zones(program_id)
    return program


def list_program_zones(program_id: int) -> list[dict]:
    conn = get_conn()
    rows = conn.execute(
        """
        SELECT pz.id, pz.zone_id, pz.duration_minutes, pz.sort_order,
               z.entity_id, z.name AS zone_name
        FROM program_zones pz
        JOIN zones z ON z.id = pz.zone_id
        WHERE pz.program_id = ?
        ORDER BY pz.sort_order
        """,
        (program_id,),
    ).fetchall()
    return [row_to_dict(r) for r in rows]


def create_program(data: dict) -> dict:
    ts = now_iso()
    with tx() as conn:
        cur = conn.execute(
            """
            INSERT INTO programs
                (name, stage, schedule_type, weekdays, interval_days, anchor_date,
                 start_time, run_mode, enabled, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                data["name"], data.get("stage", "custom"), data["schedule_type"],
                data.get("weekdays"), data.get("interval_days"),
                data.get("anchor_date", ts[:10]), data["start_time"],
                data.get("run_mode", "sequential"), int(data.get("enabled", True)),
                ts, ts,
            ),
        )
        program_id = cur.lastrowid
        _replace_program_zones(conn, program_id, data.get("zones", []))
        return get_program(program_id)


def update_program(program_id: int, data: dict) -> dict | None:
    conn = get_conn()
    existing = conn.execute("SELECT * FROM programs WHERE id = ?", (program_id,)).fetchone()
    if not existing:
        return None
    merged = {**row_to_dict(existing), **{k: v for k, v in data.items() if v is not None}}
    with tx() as c:
        c.execute(
            """
            UPDATE programs SET
                name = ?, stage = ?, schedule_type = ?, weekdays = ?, interval_days = ?,
                anchor_date = ?, start_time = ?, run_mode = ?, enabled = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                merged["name"], merged["stage"], merged["schedule_type"], merged["weekdays"],
                merged["interval_days"], merged["anchor_date"], merged["start_time"],
                merged["run_mode"], int(merged["enabled"]), now_iso(), program_id,
            ),
        )
        if "zones" in data and data["zones"] is not None:
            _replace_program_zones(c, program_id, data["zones"])
    return get_program(program_id)


def _replace_program_zones(conn, program_id: int, zones: list[dict]) -> None:
    conn.execute("DELETE FROM program_zones WHERE program_id = ?", (program_id,))
    for i, z in enumerate(zones):
        conn.execute(
            """
            INSERT INTO program_zones (program_id, zone_id, duration_minutes, sort_order)
            VALUES (?, ?, ?, ?)
            """,
            (program_id, z["zone_id"], z["duration_minutes"], z.get("sort_order", i)),
        )


def delete_program(program_id: int) -> None:
    with tx() as conn:
        conn.execute("DELETE FROM programs WHERE id = ?", (program_id,))


# ---- rain delay -------------------------------------------------------------

def get_rain_delay() -> dict:
    conn = get_conn()
    row = conn.execute("SELECT * FROM rain_delay WHERE id = 1").fetchone()
    return row_to_dict(row)


def set_rain_delay(until_iso: str | None) -> dict:
    with tx() as conn:
        conn.execute("UPDATE rain_delay SET until = ? WHERE id = 1", (until_iso,))
    return get_rain_delay()


# ---- run log ------------------------------------------------------------

def start_run(program_id: int, program_name: str, zone_id: int, zone_name: str, trigger_source: str) -> int:
    with tx() as conn:
        cur = conn.execute(
            """
            INSERT INTO run_log (program_id, program_name, zone_id, zone_name,
                                  trigger_source, started_at, status)
            VALUES (?, ?, ?, ?, ?, ?, 'running')
            """,
            (program_id, program_name, zone_id, zone_name, trigger_source, now_iso()),
        )
        return cur.lastrowid


def finish_run(run_id: int, status: str) -> None:
    with tx() as conn:
        conn.execute(
            "UPDATE run_log SET ended_at = ?, status = ? WHERE id = ?",
            (now_iso(), status, run_id),
        )


def log_skip(program_id: int, program_name: str, reason: str) -> None:
    ts = now_iso()
    with tx() as conn:
        conn.execute(
            """
            INSERT INTO run_log (program_id, program_name, zone_id, zone_name,
                                  trigger_source, started_at, ended_at, status)
            VALUES (?, ?, NULL, NULL, 'scheduled', ?, ?, ?)
            """,
            (program_id, program_name, ts, ts, reason),
        )


def list_history(limit: int = 50) -> list[dict]:
    conn = get_conn()
    rows = conn.execute(
        "SELECT * FROM run_log ORDER BY id DESC LIMIT ?", (limit,)
    ).fetchall()
    return [row_to_dict(r) for r in rows]
