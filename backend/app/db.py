"""The single local SQLite database shared by every module (gate log, service journey).

Modules register their DDL with `register_schema`; `connect()` applies all of it and
then runs registered seeders once, so any entry point sees a complete database.
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
from contextlib import contextmanager
from datetime import date
from typing import Any, Callable, Iterator

from app.paths import DATA_DIR, DB_PATH

_lock = threading.RLock()
_schemas: list[str] = []
_seeders: list[Callable[[sqlite3.Connection], None]] = []
_json_columns: set[str] = set()


def register_schema(ddl: str, json_columns: set[str] | None = None) -> None:
    _schemas.append(ddl)
    _json_columns.update(json_columns or set())


def register_seeder(fn: Callable[[sqlite3.Connection], None]) -> None:
    _seeders.append(fn)


def _stale() -> bool:
    """Optional daily reset, disabled by default so bookings survive across demo days."""
    if os.environ.get("DEMO_AUTO_RESET", "0") == "0" or not DB_PATH.exists():
        return False
    conn = sqlite3.connect(DB_PATH)
    try:
        row = conn.execute("SELECT value FROM meta WHERE key = 'seeded'").fetchone()
    except sqlite3.Error:
        return False
    finally:
        conn.close()
    return bool(row) and row[0][:10] != date.today().isoformat()


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with _lock:
        if _stale():
            DB_PATH.unlink(missing_ok=True)
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        try:
            for ddl in _schemas:
                conn.executescript(ddl)
            conn.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)")
            if conn.execute("SELECT 1 FROM meta WHERE key = 'seeded'").fetchone() is None:
                for seed in _seeders:
                    seed(conn)
            yield conn
            conn.commit()
        finally:
            conn.close()


def reset() -> None:
    with _lock:
        DB_PATH.unlink(missing_ok=True)
    with connect():
        pass


def row(r: sqlite3.Row | None) -> dict[str, Any] | None:
    if r is None:
        return None
    out = dict(r)
    for key in _json_columns & out.keys():
        if isinstance(out[key], str):
            out[key] = json.loads(out[key])
    return out


def one(conn: sqlite3.Connection, sql: str, *args: Any) -> dict[str, Any] | None:
    return row(conn.execute(sql, args).fetchone())


def many(conn: sqlite3.Connection, sql: str, *args: Any) -> list[dict[str, Any]]:
    return [row(r) for r in conn.execute(sql, args).fetchall()]  # type: ignore[misc]


def dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)
