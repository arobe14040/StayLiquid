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
    start_times TEXT NOT NULL,                     -- comma list of "HH:MM", one per daily cycle
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
    _migrate_to_start_times(conn)
    conn.execute(
        "INSERT OR IGNORE INTO rain_delay (id, until) VALUES (1, NULL)"
    )
    conn.commit()


def _migrate_to_start_times(conn) -> None:
    """Programs used to hold a single start_time; they now hold a comma list of
    cycle times. Rebuild the table (the standard SQLite dance, since you can't
    rename or re-constrain a column in place) and fold the old value in as the
    program's first cycle."""
    columns = {r[1] for r in conn.execute("PRAGMA table_info(programs)").fetchall()}
    if "start_time" not in columns or "start_times" in columns:
        return

    conn.execute("PRAGMA foreign_keys = OFF")
    conn.executescript(
        """
        CREATE TABLE programs_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            stage TEXT,
            schedule_type TEXT NOT NULL DEFAULT 'weekdays',
            weekdays TEXT,
            interval_days INTEGER,
            anchor_date TEXT,
            start_times TEXT NOT NULL,
            run_mode TEXT NOT NULL DEFAULT 'sequential',
            enabled INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        INSERT INTO programs_new
            (id, name, stage, schedule_type, weekdays, interval_days, anchor_date,
             start_times, run_mode, enabled, created_at, updated_at)
        SELECT id, name, stage, schedule_type, weekdays, interval_days, anchor_date,
               start_time, run_mode, enabled, created_at, updated_at
        FROM programs;
        DROP TABLE programs;
        """
    )
    conn.execute("ALTER TABLE programs_new RENAME TO programs")
    conn.commit()
    conn.execute("PRAGMA foreign_keys = ON")


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

def join_times(value) -> str:
    """Cycle times live in one column as "08:00,11:30,15:00". Callers hand us
    either that string or a list, so normalise and keep them in order."""
    times = value.split(",") if isinstance(value, str) else list(value or [])
    return ",".join(sorted(t.strip() for t in times if t and t.strip()))


def _hydrate_program(row: sqlite3.Row) -> dict:
    program = row_to_dict(row)
    program["start_times"] = [t for t in (program.get("start_times") or "").split(",") if t]
    program["zones"] = list_program_zones(program["id"])
    return program


def list_programs() -> list[dict]:
    conn = get_conn()
    rows = conn.execute("SELECT * FROM programs ORDER BY name").fetchall()
    return [_hydrate_program(r) for r in rows]


def get_program(program_id: int) -> dict | None:
    conn = get_conn()
    row = conn.execute("SELECT * FROM programs WHERE id = ?", (program_id,)).fetchone()
    return _hydrate_program(row) if row else None


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
                 start_times, run_mode, enabled, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                data["name"], data.get("stage", "custom"), data["schedule_type"],
                data.get("weekdays"), data.get("interval_days"),
                data.get("anchor_date") or ts[:10], join_times(data["start_times"]),
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
                anchor_date = ?, start_times = ?, run_mode = ?, enabled = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                merged["name"], merged["stage"], merged["schedule_type"], merged["weekdays"],
                merged["interval_days"], merged["anchor_date"], join_times(merged["start_times"]),
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


def log_skip(
    program_id: int | None,
    program_name: str,
    reason: str,
    zone_id: int | None = None,
    zone_name: str | None = None,
    trigger_source: str = "scheduled",
) -> None:
    """Record a run that never started. Zone details are omitted for a
    whole-program skip (rain delay) and filled in for a single-zone one."""
    ts = now_iso()
    with tx() as conn:
        conn.execute(
            """
            INSERT INTO run_log (program_id, program_name, zone_id, zone_name,
                                  trigger_source, started_at, ended_at, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (program_id, program_name, zone_id, zone_name, trigger_source, ts, ts, reason),
        )


def list_orphaned_runs() -> list[dict]:
    """Runs still marked 'running' - only possible at startup, when they belong
    to a process that died without finishing them. The valve may well still be
    open, so the entity_id comes along (NULL if the zone was since deleted)."""
    conn = get_conn()
    rows = conn.execute(
        """
        SELECT r.id, r.zone_id, r.zone_name, z.entity_id
        FROM run_log r
        LEFT JOIN zones z ON z.id = r.zone_id
        WHERE r.status = 'running'
        """
    ).fetchall()
    return [row_to_dict(r) for r in rows]


def close_orphaned_runs() -> int:
    with tx() as conn:
        cur = conn.execute(
            "UPDATE run_log SET status = 'interrupted', ended_at = ? WHERE status = 'running'",
            (now_iso(),),
        )
        return cur.rowcount


def list_history(limit: int = 50) -> list[dict]:
    conn = get_conn()
    rows = conn.execute(
        "SELECT * FROM run_log ORDER BY id DESC LIMIT ?", (limit,)
    ).fetchall()
    return [row_to_dict(r) for r in rows]
