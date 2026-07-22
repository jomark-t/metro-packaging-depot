"""
One-off migration: copies data from the local SQLite schedule.db into
Postgres (DATABASE_URL), run once when cutting over from SQLite. Safe
to re-run - it clears the destination tables before repopulating.

Usage:
    python migrate_to_postgres.py [path/to/schedule.db]
"""
import os
import sqlite3
import sys

import psycopg2
from dotenv import load_dotenv

load_dotenv()

DATABASE_URL = os.environ.get("DATABASE_URL")
if not DATABASE_URL:
    raise SystemExit("DATABASE_URL is not set - copy .env.example to .env and fill it in first.")

SQLITE_PATH = sys.argv[1] if len(sys.argv) > 1 else "schedule.db"

STAFF_COLS = [
    "id", "name", "full_name", "role", "category", "employment", "target",
    "daily_rate", "address", "phone", "email", "photo_filename", "birthday",
    "default_sss", "default_pagibig", "default_philhealth", "default_hmo",
    "sss_id", "pagibig_id", "philhealth_id", "hmo_id",
    "bank_name", "bank_account_name", "bank_account_number",
]
SCHEDULE_COLS = ["id", "staff_id", "date", "shift_label", "time_range", "detail"]
CUP_COUNTS_COLS = ["date", "quantity"]
PAYROLL_EXTRAS_COLS = [
    "id", "staff_id", "pay_date", "ot_hours", "sss", "pagibig",
    "philhealth", "hmo", "error_deduction",
]


def main():
    from app import init_db  # ensures the Postgres schema exists first

    init_db()

    sconn = sqlite3.connect(SQLITE_PATH)
    sconn.row_factory = sqlite3.Row
    scur = sconn.cursor()

    pconn = psycopg2.connect(DATABASE_URL)
    pcur = pconn.cursor()

    # children first, so the FK-referencing DELETEs don't fail
    for table in ("schedule", "payroll_extras", "cup_counts", "staff"):
        pcur.execute(f"DELETE FROM {table}")

    for table, cols in [
        ("staff", STAFF_COLS),
        ("schedule", SCHEDULE_COLS),
        ("cup_counts", CUP_COUNTS_COLS),
        ("payroll_extras", PAYROLL_EXTRAS_COLS),
    ]:
        rows = scur.execute(f"SELECT {', '.join(cols)} FROM {table}").fetchall()
        col_list = ", ".join(cols)
        placeholders = ", ".join(["%s"] * len(cols))
        for row in rows:
            pcur.execute(
                f"INSERT INTO {table} ({col_list}) VALUES ({placeholders})",
                tuple(row[c] for c in cols),
            )
        print(f"{table}: migrated {len(rows)} rows")

    # tables with an explicit id column need their SERIAL sequence bumped
    # past the highest id we just inserted, or the next INSERT collides
    for table in ("staff", "schedule", "payroll_extras"):
        pcur.execute(
            f"SELECT setval(pg_get_serial_sequence('{table}', 'id'), "
            f"COALESCE((SELECT MAX(id) FROM {table}), 1), true)"
        )

    pconn.commit()
    pcur.close()
    pconn.close()
    scur.close()
    sconn.close()
    print("Migration complete.")


if __name__ == "__main__":
    main()
