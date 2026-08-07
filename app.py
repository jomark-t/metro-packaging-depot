"""
Staff Scheduler - a small local web app that auto-generates a monthly
duty schedule for a 6-person retail/café team and stores it in Postgres.

Run with:  python app.py
Then open: http://127.0.0.1:5000
"""

import calendar
import os
import re
import secrets
from datetime import date, datetime, timedelta
from functools import wraps

import psycopg2
from dotenv import load_dotenv
from flask import Flask, g, jsonify, redirect, render_template, request, session, url_for
from psycopg2.extras import Json, RealDictCursor
from werkzeug.security import check_password_hash, generate_password_hash

load_dotenv()

DATABASE_URL = os.environ.get("DATABASE_URL")
if not DATABASE_URL:
    raise RuntimeError(
        "DATABASE_URL is not set. Copy .env.example to .env and fill in your "
        "Postgres connection string (see README's Deploying section)."
    )
BUSINESS_NAME = "Metro Packaging Depot"
UPLOAD_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static", "uploads")
ALLOWED_PHOTO_EXTENSIONS = {"png", "jpg", "jpeg", "webp"}
os.makedirs(UPLOAD_DIR, exist_ok=True)

SECRET_KEY = os.environ.get("SECRET_KEY")
if not SECRET_KEY:
    raise RuntimeError(
        "SECRET_KEY is not set. Add one to .env (a long random string - "
        "python -c \"import secrets; print(secrets.token_hex(32))\") and as a Fly secret."
    )

# Login lockout: how many wrong PINs before an account is locked, and for
# how long - basic brute-force protection since PINs are short.
LOGIN_MAX_ATTEMPTS = 5
LOGIN_LOCKOUT_MINUTES = 15

# Sessions are deliberately short-lived: the cookie is a browser-session
# cookie (gone when the browser closes, never written to disk) and any
# session idle for this long is dropped, so the PIN is always re-entered
# rather than a logged-in tab being left open on the shop floor.
SESSION_IDLE_MINUTES = 30

app = Flask(__name__)
app.secret_key = SECRET_KEY
app.config["MAX_CONTENT_LENGTH"] = 5 * 1024 * 1024  # 5MB upload cap
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
app.config["SESSION_COOKIE_SECURE"] = not app.debug  # HTTPS-only in production (Fly), plain HTTP ok for local dev


@app.after_request
def add_no_store_headers(response):
    """Never let a logged-in page sit in the browser (or an intermediate)
    cache - without this the back button after logging out happily
    re-renders the schedule from cache, PIN or no PIN."""
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response

# ---------------------------------------------------------------------------
# Staff roster & business rules (edit here if your team or rules change)
# ---------------------------------------------------------------------------
STAFF = [
    {"name": "Clare", "full_name": "Clare Paulite", "role": "Branch Manager", "category": "manager", "employment": "Permanent", "target": None, "daily_rate": None, "monthly_salary": 18000, "pto_entitlement": 10},
    {"name": "Jem", "full_name": "Jeremy Padayao", "role": "Sales Staff", "category": "sales", "employment": "Permanent", "target": 21, "daily_rate": 460, "pto_entitlement": 5},
    {"name": "Von", "full_name": "Yvony Nantes", "role": "Sales Staff", "category": "sales", "employment": "Permanent", "target": 21, "daily_rate": 460, "pto_entitlement": 5},
    {"name": "Jha", "full_name": "Jhannelha Opena", "role": "Sales Staff", "category": "sales_pt", "employment": "Part-time", "target": None, "daily_rate": 460, "pto_entitlement": 5},
    {"name": "Macky", "full_name": "Mark Jay Siruma", "role": "Machine Operator", "category": "machine", "employment": "Permanent", "target": None, "daily_rate": 400, "pto_entitlement": 5},
    {"name": "Joshua", "full_name": "Joshua Hermida", "role": "Machine Operator", "category": "machine", "employment": "Permanent", "target": None, "daily_rate": 350, "pto_entitlement": 5},
]

# Categories the app understands. The scheduling algorithm has behaviour
# keyed to these, so a new employee has to be one of them.
STAFF_CATEGORIES = {
    "manager": "Manager",
    "sales": "Sales Staff",
    "sales_pt": "Sales Staff (part-time)",
    "machine": "Machine Operator",
}

# Payroll constants: cup-based performance bonus (per cup, by machine role)
# and the flat overtime hourly rate. Semi-monthly pay dates are the 10th
# (covers the 25th of the prior month through the 9th) and the 25th
# (covers the 10th through the 24th of the same month).
CUP_BONUS_RATE = {"Printer": 0.15, "Checker": 0.10}
OT_HOURLY_RATE = 50

# Only cups printed above this daily quota count toward the bonus - e.g.
# a 3500-cup day only has 2500 bonus-qualified cups.
DAILY_CUP_QUOTA = 1000

# Fraction of a full day's rate a shift counts for in payroll. Assist is
# Jha's 8AM-12NN Friday helper shift - a half day. Everything else not
# listed here counts as a full day.
SHIFT_DAY_FRACTION = {"Assist": 0.5}

# Single source of truth for each shift's time range, shared by the
# generator and the manual-edit API below.
SHIFT_TIME_RANGES = {
    "Opening": "8:00 AM - 5:00 PM",
    "Closing": "11:00 AM - 8:00 PM",
    "Assist": "8:00 AM - 12:00 PM",
    "Inventory": "8:00 AM - 5:00 PM",
    "Printer": "9:00 AM - 6:00 PM",
    "Checker": "9:00 AM - 6:00 PM",
    "Paid Time Off": "Full day",
}

# Tailwind utility classes per shift label, shared with the print/PDF
# template so it renders pixel-identical chips to the on-screen table.
# Mirrors CHIP_CLASSES in static/script.js.
CHIP_CLASSES = {
    "Opening": "bg-blue-50 text-brand-blue border-l-2 border-brand-blue",
    "Closing": "bg-gray-100 text-black border-l-2 border-black",
    "Assist": "bg-[#F4EBDF] text-brand-tan border-l-2 border-brand-tan",
    "Inventory": "bg-green-50 text-brand-green border-l-2 border-brand-green",
    "Printer": "bg-[#e3d1ba] text-[#8a6a3e] border-l-2 border-[#8a6a3e]",
    "Checker": "bg-gray-300 text-black border-l-2 border-black",
    "Paid Time Off": "bg-purple-50 text-purple-700 border-l-2 border-purple-700",
}

# How many days the printable schedule PDF shows per page, and the
# render viewport/scale that fits a 16-row page (headers, chips and all)
# onto one landscape A4 sheet without changing the on-screen proportions
# (a wider viewport rendered smaller via `scale`, like a browser's print
# "fit to page" - not a redesign, just a uniform shrink).
#
# PDF_MAX_DAYS_PER_PAGE is the ceiling a trailing short chunk can grow to
# rather than spilling onto its own near-empty page - e.g. a 31-day month
# would otherwise split 15+15+1; this merges the last day into page 2
# (15+16) instead. Every real month is 28-31 days, so with a 15/16 split
# this always lands on exactly 2 pages.
PDF_DAYS_PER_PAGE = 15
PDF_MAX_DAYS_PER_PAGE = 16
PDF_VIEWPORT_WIDTH = 1700
PDF_VIEWPORT_HEIGHT = 900
PDF_SCALE = 0.64

# Shifts a person can be manually reassigned to via the edit dropdown,
# keyed by staff category.
EDITABLE_OPTIONS = {
    "manager": ["Opening", "Closing", "Inventory", "Paid Time Off", "Off"],
    "sales": ["Opening", "Closing", "Inventory", "Paid Time Off", "Off"],
    "sales_pt": ["Opening", "Closing", "Assist", "Inventory", "Paid Time Off", "Off"],
    "machine": ["Printer", "Checker", "Inventory", "Paid Time Off", "Off"],
}


# ---------------------------------------------------------------------------
# Database helpers
# ---------------------------------------------------------------------------
def get_db():
    db = getattr(g, "_database", None)
    if db is None:
        db = g._database = psycopg2.connect(DATABASE_URL, cursor_factory=RealDictCursor)
    return db


@app.teardown_appcontext
def close_connection(exception):
    db = getattr(g, "_database", None)
    if db is not None:
        db.close()


def init_db():
    db = psycopg2.connect(DATABASE_URL, cursor_factory=RealDictCursor)
    cur = db.cursor()
    cur.execute(
        """CREATE TABLE IF NOT EXISTS staff (
            id SERIAL PRIMARY KEY,
            name TEXT UNIQUE,
            full_name TEXT,
            role TEXT,
            category TEXT,
            employment TEXT,
            target INTEGER,
            daily_rate REAL,
            address TEXT,
            phone TEXT,
            email TEXT,
            photo_filename TEXT,
            birthday TEXT,
            default_sss REAL,
            default_pagibig REAL,
            default_philhealth REAL,
            default_hmo REAL,
            sss_id TEXT,
            pagibig_id TEXT,
            philhealth_id TEXT,
            hmo_id TEXT,
            bank_name TEXT,
            bank_account_name TEXT,
            bank_account_number TEXT,
            monthly_salary REAL,
            pto_entitlement INTEGER
        )"""
    )
    # already-existing databases (from before fixed-salary staff/PTO
    # entitlements existed) won't get new columns from CREATE TABLE IF NOT
    # EXISTS above, since that's a no-op once the table exists - add them
    # explicitly, idempotently
    cur.execute("ALTER TABLE staff ADD COLUMN IF NOT EXISTS monthly_salary REAL")
    cur.execute("ALTER TABLE staff ADD COLUMN IF NOT EXISTS pto_entitlement INTEGER")
    # employees are archived, never deleted - payroll history, past
    # schedules and 13th month all reference these rows
    cur.execute("ALTER TABLE staff ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE")
    cur.execute("ALTER TABLE staff ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ")
    cur.execute(
        """CREATE TABLE IF NOT EXISTS schedule (
            id SERIAL PRIMARY KEY,
            staff_id INTEGER REFERENCES staff(id),
            date TEXT,
            shift_label TEXT,
            time_range TEXT,
            detail TEXT
        )"""
    )
    # point-in-time backups of a month's schedule, so a bad regenerate or
    # edit can be undone. data is the staff-name-keyed row list (not
    # staff_id) so a restore doesn't depend on ids staying stable.
    cur.execute(
        """CREATE TABLE IF NOT EXISTS schedule_snapshots (
            id SERIAL PRIMARY KEY,
            year INTEGER NOT NULL,
            month INTEGER NOT NULL,
            label TEXT NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT NOW(),
            data JSONB NOT NULL
        )"""
    )
    # who last touched a given month's schedule, and how - one row per
    # month, overwritten on each edit (the full history lives in the
    # snapshots table, this is just the "last edited by" line in the UI)
    cur.execute(
        """CREATE TABLE IF NOT EXISTS schedule_edits (
            year INTEGER NOT NULL,
            month INTEGER NOT NULL,
            edited_by TEXT NOT NULL,
            action TEXT NOT NULL,
            -- timestamptz, not timestamp: the server runs UTC on Fly but
            -- the browser formats in the viewer's local time, so the
            -- offset has to survive the round trip
            edited_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (year, month)
        )"""
    )
    # who changed what, across the whole app. Append-only: rows are never
    # updated or deleted, which is the point of an audit trail.
    cur.execute(
        """CREATE TABLE IF NOT EXISTS audit_log (
            id SERIAL PRIMARY KEY,
            at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            actor TEXT NOT NULL,
            action TEXT NOT NULL,
            target TEXT,
            details JSONB
        )"""
    )
    cur.execute("CREATE INDEX IF NOT EXISTS audit_log_at_idx ON audit_log (at DESC)")

    # cash advances granted to staff. Repayments aren't stored here -
    # they're the per-cutoff cash_advance deductions on payroll_extras,
    # so the outstanding balance always matches what payroll actually
    # withheld rather than drifting from it.
    cur.execute(
        """CREATE TABLE IF NOT EXISTS cash_advances (
            id SERIAL PRIMARY KEY,
            staff_id INTEGER NOT NULL REFERENCES staff(id),
            amount REAL NOT NULL,
            date_granted TEXT NOT NULL,
            installment REAL,
            note TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            created_by TEXT
        )"""
    )
    cur.execute("CREATE INDEX IF NOT EXISTS cash_advances_staff_idx ON cash_advances (staff_id)")

    # leave requests: one row per requested day (a multi-day request is
    # just several rows created together). Approving a Paid Time Off row
    # writes the matching 'Paid Time Off' entry into the schedule, which
    # is what the PTO balance counts - this table is the paper trail of
    # who asked, who decided, and when.
    cur.execute(
        """CREATE TABLE IF NOT EXISTS leave_requests (
            id SERIAL PRIMARY KEY,
            staff_id INTEGER NOT NULL REFERENCES staff(id),
            date TEXT NOT NULL,
            leave_type TEXT NOT NULL,
            reason TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            decided_by TEXT,
            decided_at TIMESTAMPTZ,
            decision_note TEXT
        )"""
    )
    cur.execute(
        "CREATE INDEX IF NOT EXISTS leave_requests_staff_date_idx ON leave_requests (staff_id, date)"
    )
    # cup counts: store-wide printed-cup quantity for a given work day,
    # used to compute Macky/Joshua's performance bonus
    cur.execute(
        """CREATE TABLE IF NOT EXISTS cup_counts (
            date TEXT PRIMARY KEY,
            quantity INTEGER NOT NULL DEFAULT 0
        )"""
    )
    # per-staff, per-payday manual payroll inputs (OT hours + benefit
    # deductions). pay_date is the ISO date of the 10th or 25th payout.
    cur.execute(
        """CREATE TABLE IF NOT EXISTS payroll_extras (
            id SERIAL PRIMARY KEY,
            staff_id INTEGER REFERENCES staff(id),
            pay_date TEXT,
            ot_hours REAL NOT NULL DEFAULT 0,
            sss REAL NOT NULL DEFAULT 0,
            pagibig REAL NOT NULL DEFAULT 0,
            philhealth REAL NOT NULL DEFAULT 0,
            hmo REAL NOT NULL DEFAULT 0,
            error_deduction REAL NOT NULL DEFAULT 0,
            cash_advance REAL NOT NULL DEFAULT 0,
            manual_bonus REAL NOT NULL DEFAULT 0,
            UNIQUE(staff_id, pay_date)
        )"""
    )
    cur.execute("ALTER TABLE payroll_extras ADD COLUMN IF NOT EXISTS cash_advance REAL NOT NULL DEFAULT 0")
    # discretionary bonus, entered per cutoff for anyone - distinct from
    # the cup bonus, which only machine operators earn and which is
    # computed from cup counts rather than typed in
    cur.execute("ALTER TABLE payroll_extras ADD COLUMN IF NOT EXISTS manual_bonus REAL NOT NULL DEFAULT 0")
    # login accounts. staff_name is NULL for the superuser (not a staff
    # member with a schedule/payroll record - just the app owner). Staff
    # logins are managed from their Employees card (login-eligible tick +
    # PIN box), which upserts a row here keyed by staff_name.
    cur.execute(
        """CREATE TABLE IF NOT EXISTS app_users (
            id SERIAL PRIMARY KEY,
            staff_name TEXT UNIQUE REFERENCES staff(name),
            display_name TEXT NOT NULL,
            is_superuser BOOLEAN NOT NULL DEFAULT FALSE,
            login_enabled BOOLEAN NOT NULL DEFAULT TRUE,
            pin_hash TEXT,
            failed_attempts INTEGER NOT NULL DEFAULT 0,
            locked_until TIMESTAMP
        )"""
    )
    # accounts for people who aren't on the payroll - co-owners and the
    # like. They're app_users rows with staff_name NULL and is_superuser
    # FALSE: read-only everywhere, Dashboard and Schedule by default, and
    # the Payroll tab only if this flag is switched on for them.
    cur.execute("ALTER TABLE app_users ADD COLUMN IF NOT EXISTS can_view_payroll BOOLEAN NOT NULL DEFAULT FALSE")
    cur.execute("ALTER TABLE app_users ADD COLUMN IF NOT EXISTS note TEXT")
    cur.execute("ALTER TABLE app_users ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()")

    for s in STAFF:
        cur.execute("SELECT id FROM staff WHERE name=%s", (s["name"],))
        row = cur.fetchone()
        if row is None:
            # first-run seed only - full_name/role/employment/target/daily_rate
            # and everything else become user-editable via the Employees tab
            # after this, so they're never touched again below
            cur.execute(
                "INSERT INTO staff (name, full_name, role, category, employment, target, daily_rate, monthly_salary, pto_entitlement) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                (
                    s["name"], s["full_name"], s["role"], s["category"], s["employment"],
                    s["target"], s["daily_rate"], s.get("monthly_salary"), s.get("pto_entitlement"),
                ),
            )
        else:
            # category is structural - the scheduling algorithm has logic
            # keyed to it, so it must always match the code, but every other
            # field is user-editable now and must survive app restarts
            cur.execute("UPDATE staff SET category=%s WHERE id=%s", (s["category"], row["id"]))

    # one-time login bootstrap - only runs if no superuser exists yet, so
    # it never re-fires (and never resets anyone's PIN) on later restarts
    cur.execute("SELECT id FROM app_users WHERE is_superuser = TRUE LIMIT 1")
    if cur.fetchone() is None:
        bootstrap_pin = secrets.token_hex(4)  # random 8-char hex PIN
        cur.execute(
            "INSERT INTO app_users (staff_name, display_name, is_superuser, login_enabled, pin_hash) "
            "VALUES (NULL, %s, TRUE, TRUE, %s)",
            ("Jomark", generate_password_hash(bootstrap_pin)),
        )
        print(
            f"\n{'=' * 60}\n"
            f"Superuser account created: Jomark\n"
            f"Initial PIN: {bootstrap_pin}\n"
            f"Log in with this once, then change it from the Employees tab.\n"
            f"{'=' * 60}\n",
            flush=True,
        )
        # Clare logs in by default too, per the original setup - no PIN
        # yet, set on her Employees card (Jomark or Clare herself once
        # she's logged in with a PIN someone gave her out of band)
        cur.execute(
            "INSERT INTO app_users (staff_name, display_name, is_superuser, login_enabled, pin_hash) "
            "VALUES ('Clare', 'Clare', FALSE, TRUE, NULL) ON CONFLICT (staff_name) DO NOTHING"
        )

    db.commit()
    db.close()


# ---------------------------------------------------------------------------
# Roster
# ---------------------------------------------------------------------------
# The STAFF list above is first-run seed data only. Once the app has run,
# the `staff` table is the source of truth: people can be hired and
# archived from the Employees tab, so anything that needs "who works
# here" has to ask the database rather than the constant.
ROSTER_FIELDS = (
    "id, name, full_name, role, category, employment, target, daily_rate, "
    "monthly_salary, pto_entitlement, active"
)


def fetch_roster(cur, include_archived=False):
    """Everyone currently on the books, in the order the schedule table
    shows them (insertion order - new hires append to the right)."""
    sql = f"SELECT {ROSTER_FIELDS} FROM staff"
    if not include_archived:
        sql += " WHERE active"
    cur.execute(sql + " ORDER BY id")
    return [dict(r) for r in cur.fetchall()]


def roster(include_archived=False):
    """fetch_roster against the current request's connection."""
    return fetch_roster(get_db().cursor(), include_archived)


def roster_by_name(include_archived=True):
    """Lookup used to validate a :name route segment. Defaults to
    including archived staff - you still need to read a leaver's payroll
    and past schedule; the individual routes decide whether an archived
    person may be *changed*."""
    return {s["name"]: s for s in roster(include_archived)}


def hide_targets(rows):
    """Monthly day targets are management information - they invite
    comparison between staff and they're really a scheduling input, not
    something the team needs on their screens. Blank them out of any
    payload going to someone who isn't a manager, rather than merely
    hiding them in the page: the numbers shouldn't leave the server at
    all. Callers pass a list of roster dicts and get copies back."""
    if is_manager():
        return rows
    return [{**r, "target": None} for r in rows]


def roster_for_month(db, year, month):
    """Active staff, plus anyone archived who still has shifts that month
    so their history keeps its column in the table and the PDF."""
    cur = db.cursor()
    active = fetch_roster(cur, include_archived=False)
    first_day = date(year, month, 1)
    last_day = date(year, month, calendar.monthrange(year, month)[1])
    cur.execute(
        f"""SELECT {ROSTER_FIELDS} FROM staff
            WHERE NOT active AND id IN (
                SELECT DISTINCT staff_id FROM schedule WHERE date BETWEEN %s AND %s
            ) ORDER BY id""",
        (first_day.isoformat(), last_day.isoformat()),
    )
    return active + [dict(r) for r in cur.fetchall()]


# ---------------------------------------------------------------------------
# Scheduling algorithm
# ---------------------------------------------------------------------------
# Weekday numbers used throughout (Python's date.weekday()):
#   Mon=0, Tue=1, Wed=2, Thu=3, Fri=4, Sat=5, Sun=6
#
# Store hours:  Mon-Sat 8:00am-8:00pm | Sun 8:00am-5:00pm
# Sales shifts: Opening 8:00am-5:00pm | Closing 11:00am-8:00pm
# Machine ops:  fixed 9:00am-6:00pm, Mon-Fri only
#
# Part-timers are permanent Wednesday + Friday assist helpers, plus a
# share of the Sundays:
#   Wed  8:00am-5:00pm  covers the Opening slot
#   Fri  8:00am-12:00pm assist only - doesn't replace a full shift
#   Sun  8:00am-5:00pm  one of the two Sunday Opening slots
# A lone part-timer keeps at least 2 Sundays a month to rest; several
# take turns instead.
#
# Sundays always run 2 people on Opening (8-5). The 1st Sunday of the
# month is inventory day - the whole roster works.
#
# Nothing below is keyed to a person's name: staff are picked up by
# category from the database, so hiring and archiving just work.
def compute_machine_roles(days, operators):
    """Weekly (Mon-Fri) Printer/Checker split across the machine
    operators. Exactly one Printer works each day and everyone else that
    day is a Checker, so coverage never depends on how many operators
    are on the roster.

    Printer days are shared out a week at a time: the week's days are
    divided as evenly as possible, with any remainder going to whoever
    has printed least so far, and each operator's days laid out as one
    block. With the usual two operators that reproduces the original
    behaviour exactly - one of them is "heavy" with 3 printer days and 2
    checker days, the other the reverse, alternating week to week."""
    if not operators:
        return {}

    weeks = {}
    for d in days:
        if d.weekday() <= 4:
            weeks.setdefault(d.isocalendar()[:2], []).append(d)  # (iso_year, iso_week)

    role_map = {}
    cumulative_printer = {n: 0 for n in operators}
    previous_heavy = None
    for key in sorted(weeks.keys()):
        week_days = sorted(weeks[key])
        n_days = len(week_days)
        # fewest printer days so far goes first; on a tie it's whoever
        # wasn't heavy last week, so an all-square roster alternates
        # rather than always favouring the same person
        order = sorted(
            operators,
            key=lambda nm: (cumulative_printer[nm], nm == previous_heavy, operators.index(nm)),
        )

        base, remainder = divmod(n_days, len(operators))
        printer_sequence = []
        for i, nm in enumerate(order):
            printer_sequence.extend([nm] * (base + (1 if i < remainder else 0)))

        for d, printer in zip(week_days, printer_sequence):
            role_map[d] = {nm: ("Printer" if nm == printer else "Checker") for nm in operators}
            cumulative_printer[printer] += 1
        previous_heavy = order[0]
    return role_map


def _part_timer_sunday_cover(part_timers, other_sundays):
    """Which part-timer (if any) takes each non-inventory Sunday.

    One part-timer keeps the original rule - they work most Sundays but
    always keep at least two a month to rest. Two or more simply take
    turns, which gives everyone plenty of Sundays off on its own and
    keeps the Sunday cap free for a full-timer."""
    cover = {}
    if not part_timers or not other_sundays:
        return cover

    if len(part_timers) == 1:
        if len(other_sundays) >= 4:
            resting = {other_sundays[1], other_sundays[3]}
        elif len(other_sundays) == 3:
            resting = {other_sundays[1], other_sundays[2]}
        else:
            resting = set(other_sundays)  # 0-2 Sundays: rest all of them
        for s in other_sundays:
            if s not in resting:
                cover[s] = part_timers[0]
        return cover

    for i, s in enumerate(other_sundays):
        cover[s] = part_timers[i % len(part_timers)]
    return cover


class ScheduleGenerationError(Exception):
    """The roster can't drive the generator (see generate_schedule)."""


def generate_schedule(year, month):
    """Builds and saves a month's schedule from whoever is on the roster.

    Staff are handled by category, not by name, so hiring or archiving
    someone is picked up automatically:

      machine   fixed Mon-Fri, one Printer + everyone else Checker
      sales_pt  fixed Wed Opening and Fri assist, plus a share of Sundays
      manager   fixed Mon-Sat, alternating Opening/Closing a week at a
                time; several managers are staggered so they don't all
                open the same week
      sales     the flexible pool - fills whatever Opening/Closing slots
                the fixed staff above haven't already covered, honouring
                monthly targets, the 6-day cap and 2-day off blocks
    """
    db = psycopg2.connect(DATABASE_URL, cursor_factory=RealDictCursor)
    cur = db.cursor()

    cur.execute("SELECT id, name, target, category FROM staff WHERE active ORDER BY id")
    staff_rows = {r["name"]: dict(r) for r in cur.fetchall()}

    def names_in(category):
        return [n for n, r in staff_rows.items() if r["category"] == category]

    managers = names_in("manager")
    sales_pool = names_in("sales")
    part_timers = names_in("sales_pt")
    operators = names_in("machine")

    if not (managers or sales_pool or part_timers):
        raise ScheduleGenerationError(
            "There's nobody on the roster who can cover Opening or Closing shifts - "
            "add at least one manager or sales staff member first."
        )

    first_day = date(year, month, 1)
    last_day_num = calendar.monthrange(year, month)[1]
    last_day = date(year, month, last_day_num)

    # wipe any previous schedule for this month before regenerating
    cur.execute(
        "DELETE FROM schedule WHERE date BETWEEN %s AND %s",
        (first_day.isoformat(), last_day.isoformat()),
    )
    db.commit()

    days = [first_day + timedelta(days=i) for i in range(last_day_num)]
    assignments = {d: [] for d in days}

    def add(d, name, label, time_range, detail=None):
        assignments[d].append({"name": name, "label": label, "time_range": time_range, "detail": detail})

    sundays = [d for d in days if d.weekday() == 6]
    first_sunday = sundays[0] if sundays else None
    other_sundays = sundays[1:]

    pt_sunday_cover = _part_timer_sunday_cover(part_timers, other_sundays)
    machine_role_map = compute_machine_roles(days, operators)

    # 2nd Wednesday of the month is a guaranteed all-hands day (operators
    # and part-timers already work every Wednesday, so this just pulls the
    # manager and the sales pool in too)
    wednesdays = [d for d in days if d.weekday() == 2]
    second_wednesday = wednesdays[1] if len(wednesdays) >= 2 else None

    # spread extra coverage days evenly across the month (one per week,
    # Thursdays) instead of letting them fall wherever quota exhaustion
    # happens to land - which was clustering them at month-end
    spread_overlap_days = {d for d in days if d.weekday() == 3}  # every Thursday
    if second_wednesday is not None:
        spread_overlap_days.add(second_wednesday)

    # --- Inventory day: everyone works -------------------------------
    if first_sunday is not None:
        for name in staff_rows:
            add(first_sunday, name, "Inventory", SHIFT_TIME_RANGES["Inventory"])

    # --- Pass A: fixed assignments (machine operators + part-timers) ---
    for d in days:
        if d == first_sunday:
            continue
        wd = d.weekday()

        if wd <= 4 and operators:  # Mon-Fri
            roles = machine_role_map[d]
            for name in operators:
                add(d, name, roles[name], SHIFT_TIME_RANGES[roles[name]])

        for name in part_timers:
            if wd == 2:  # Wednesday - covers the Opening slot
                add(d, name, "Opening", SHIFT_TIME_RANGES["Opening"])
            elif wd == 4:  # Friday - assist only, doesn't cover a slot
                add(d, name, "Assist", SHIFT_TIME_RANGES["Assist"])
            elif wd == 6 and pt_sunday_cover.get(d) == name:
                add(d, name, "Opening", SHIFT_TIME_RANGES["Opening"])

    # --- Pass A2: managers - fixed Mon-Sat, Sunday off -----------------
    # A manager alternates Opening/Closing a full week at a time rather
    # than day-to-day, and the alternation continues seamlessly across
    # month boundaries (whichever phase their last Opening/Closing day was
    # in carries forward) instead of resetting every time a month is
    # (re)generated. Managers with no history yet are staggered against
    # each other so two of them don't both open the same week. The day
    # after each month's inventory Sunday (which they work, like everyone
    # else) is an automatic rest day in lieu of the usual Sunday off.
    def _week_monday(d):
        return d - timedelta(days=d.weekday())

    manager_reference = {}
    for i, name in enumerate(managers):
        cur.execute(
            """SELECT schedule.date, schedule.shift_label FROM schedule
               JOIN staff ON schedule.staff_id = staff.id
               WHERE staff.name = %s AND schedule.shift_label IN ('Opening', 'Closing') AND schedule.date < %s
               ORDER BY schedule.date DESC LIMIT 1""",
            (name, first_day.isoformat()),
        )
        ref_row = cur.fetchone()
        if ref_row is not None:
            manager_reference[name] = (_week_monday(date.fromisoformat(ref_row["date"])), ref_row["shift_label"])
        else:
            manager_reference[name] = (_week_monday(first_day), "Opening" if i % 2 == 0 else "Closing")

    def manager_phase_for(name, d):
        ref_monday, ref_phase = manager_reference[name]
        weeks_diff = (_week_monday(d) - ref_monday).days // 7
        if weeks_diff % 2 == 0:
            return ref_phase
        return "Closing" if ref_phase == "Opening" else "Opening"

    comp_off = set()
    if first_sunday is not None:
        comp_monday = first_sunday + timedelta(days=1)
        if comp_monday in assignments:
            comp_off.add(comp_monday)

    for d in days:
        if d.weekday() == 6 or d in comp_off:
            continue
        for name in managers:
            phase = manager_phase_for(name, d)
            add(d, name, phase, SHIFT_TIME_RANGES[phase])

    # --- Pass B: fill the sales pool, biasing toward 2-day-off blocks,
    #             capping consecutive work days at 6, spreading overlap
    #             days across the month, and keeping each person on
    #             blocks of the same shift type (max 4 days) instead of
    #             flipping Opening/Closing day to day ------------------
    OPEN = ("Opening", SHIFT_TIME_RANGES["Opening"])
    CLOSE = ("Closing", SHIFT_TIME_RANGES["Closing"])
    MAX_CONSECUTIVE_DAYS = 6
    MAX_SAME_TYPE_STREAK = 4
    SUNDAY_MAX_WORKERS = 2

    def day_requirement(d):
        """Shift labels the sales pool still has to fill that day, after
        the fixed-schedule staff above are accounted for. Reading the
        coverage back off the assignments made so far means this doesn't
        care who provided it - a manager's weekly phase, a part-timer's
        Wednesday, or nobody at all."""
        covered = {"Opening": 0, "Closing": 0}
        for entry in assignments[d]:
            if entry["label"] in covered:
                covered[entry["label"]] += 1

        if d.weekday() == 6:  # Sunday: whole store capped at 2, all on Opening
            return [OPEN] * max(0, SUNDAY_MAX_WORKERS - covered["Opening"])

        remaining = []
        for slot in (OPEN, CLOSE):
            if covered[slot[0]] > 0:
                covered[slot[0]] -= 1
            else:
                remaining.append(slot)
        return remaining

    # A sales person with no monthly target set is treated as full-time
    # (Mon-Sat); the 6-day cap and off-pairing below still apply.
    default_target = last_day_num - len(sundays)
    targets = {n: (staff_rows[n]["target"] or default_target) for n in sales_pool}
    off_needed = {n: max(0, last_day_num - targets[n]) for n in sales_pool}
    consecutive_worked = {n: 0 for n in sales_pool}
    shift_state = {n: {"type": None, "streak": 0} for n in sales_pool}

    def assign_day_labels(working_today, labels_needed):
        """Keep each person on their current Opening/Closing streak (up to
        MAX_SAME_TYPE_STREAK days) where possible. People who've hit the
        cap MUST switch - they get priority pick of a different label so
        a continuer's preference never bumps them back onto their maxed
        type. Returns list of (name, label, time_range)."""
        remaining_labels = list(labels_needed)
        people = list(working_today)
        assigned = []

        forced_switch = [
            p for p in people
            if shift_state[p]["type"] is not None and shift_state[p]["streak"] >= MAX_SAME_TYPE_STREAK
        ]
        continuers = [
            p for p in people
            if p not in forced_switch
            and shift_state[p]["type"] is not None
            and shift_state[p]["streak"] < MAX_SAME_TYPE_STREAK
        ]

        # forced switchers go first - they must NOT get their maxed-out type
        for p in forced_switch:
            maxed_type = shift_state[p]["type"]
            idx = next((i for i, (lbl, _tr) in enumerate(remaining_labels) if lbl != maxed_type), None)
            if idx is not None:
                lbl, tr = remaining_labels.pop(idx)
                assigned.append((p, lbl, tr))
                people.remove(p)

        # continuers get their matching label if one's still available
        for p in continuers:
            if p not in people:
                continue
            want = shift_state[p]["type"]
            idx = next((i for i, (lbl, _tr) in enumerate(remaining_labels) if lbl == want), None)
            if idx is not None:
                lbl, tr = remaining_labels.pop(idx)
                assigned.append((p, lbl, tr))
                people.remove(p)

        # everyone left (fresh starts, unmatched continuers, or a forced
        # switcher with no alternative available) takes what's left
        for p in list(people):
            if not remaining_labels:
                break
            lbl, tr = remaining_labels.pop(0)
            assigned.append((p, lbl, tr))
            people.remove(p)

        for person, lbl, _tr in assigned:
            state = shift_state[person]
            if state["type"] == lbl:
                state["streak"] += 1
            else:
                state["type"] = lbl
                state["streak"] = 1
        return assigned

    off_streak_person = None
    off_streak_remaining = 0
    extra_toggle = 0

    for d in days:
        if d == first_sunday:
            # inventory day: everyone works it, but it's a distinct task -
            # counts toward the 6-day work cap, but breaks any
            # Opening/Closing streak (like a day off would)
            for n in sales_pool:
                consecutive_worked[n] += 1
                shift_state[n] = {"type": None, "streak": 0}
            continue
        required = day_requirement(d)
        allowed_off = max(0, len(sales_pool) - len(required))
        if d in spread_overlap_days:
            allowed_off = 0  # designated all-hands / spread coverage day

        offs_today = []

        # mandatory rest: nobody works more than MAX_CONSECUTIVE_DAYS in a row.
        # The day before inventory day uses a tighter threshold, since
        # inventory day unconditionally forces everyone to work - without
        # this, someone could hit the cap right as inventory day forces
        # a 7th straight day on them.
        cap_today = MAX_CONSECUTIVE_DAYS
        if first_sunday is not None and d == first_sunday - timedelta(days=1):
            cap_today = MAX_CONSECUTIVE_DAYS - 1
        mandatory = [n for n in sales_pool if consecutive_worked[n] >= cap_today]
        mandatory.sort(key=lambda n: consecutive_worked[n], reverse=True)

        # rare edge case: more people hit the cap than the day can spare on
        # a Sunday a part-timer was due to rest - pull one in as backup so
        # they can actually rest
        if len(mandatory) > allowed_off and d.weekday() == 6:
            resting_pt = next(
                (n for n in part_timers if not any(a["name"] == n for a in assignments[d])), None
            )
            if resting_pt is not None:
                add(d, resting_pt, "Opening", SHIFT_TIME_RANGES["Opening"])
                required = required[1:]  # the part-timer now covers one Opening slot
                allowed_off = max(0, len(sales_pool) - len(required))

        for n in mandatory:
            if n in offs_today:
                continue
            if len(offs_today) >= allowed_off:
                # last resort: rest still wins over the minimum-coverage target
                # on the very rare day this can't be avoided otherwise
                pass
            offs_today.append(n)
            off_needed[n] -= 1

        if (
            off_streak_person
            and off_streak_person not in offs_today
            and off_streak_remaining > 0
            and len(offs_today) < allowed_off
            and off_needed[off_streak_person] > 0
        ):
            offs_today.append(off_streak_person)
            off_needed[off_streak_person] -= 1
            off_streak_remaining -= 1
            if off_streak_remaining == 0 or off_needed[off_streak_person] == 0:
                off_streak_person = None

        while len(offs_today) < allowed_off:
            candidates = [n for n in sales_pool if n not in offs_today and off_needed[n] > 0]
            if not candidates:
                break
            candidates.sort(key=lambda n: off_needed[n], reverse=True)
            chosen = candidates[0]
            offs_today.append(chosen)
            off_needed[chosen] -= 1
            if off_streak_person is None and off_needed[chosen] > 0:
                off_streak_person = chosen
                off_streak_remaining = 1  # try to pair with tomorrow too

        # Sunday is hard-capped at 2 total workers - if quota exhaustion left
        # nobody "needing" an off day, still force enough rest to hit the cap
        if d.weekday() == 6:
            while len(offs_today) < allowed_off:
                candidates = [n for n in sales_pool if n not in offs_today]
                if not candidates:
                    break
                candidates.sort(key=lambda n: off_needed[n], reverse=True)
                chosen = candidates[0]
                offs_today.append(chosen)
                off_needed[chosen] -= 1

        working_today = [n for n in sales_pool if n not in offs_today]

        # more workers than required labels (nobody needed an off day) ->
        # natural busy-day overlap; double up on Opening/Closing (not Support).
        # Sunday never gets this - it's capped at 2 workers total.
        labels_needed = list(required)
        if d.weekday() != 6:
            extra = len(working_today) - len(labels_needed)
            for _ in range(extra):
                labels_needed.append(OPEN if extra_toggle % 2 == 0 else CLOSE)
                extra_toggle += 1

        for name, label, time_range in assign_day_labels(working_today, labels_needed):
            add(d, name, label, time_range)

        for n in offs_today:
            consecutive_worked[n] = 0
            shift_state[n] = {"type": None, "streak": 0}  # fresh start after a break
        for n in working_today:
            consecutive_worked[n] += 1

    # --- Pass C: smooth out isolated single-work-day "sandwiches" ------
    # (Off, Work, Off) within the sales pool. Best-effort, single forward
    # pass, checked per-person (a lone work day can be isolated even on a
    # day someone else also works - an overlap day): an isolated day that's
    # part of an overlap just gets dropped, otherwise it's handed to a
    # colleague who's already working either side of it. Either way, only
    # applied while the person losing the day is still within
    # SANDWICH_FIX_TOLERANCE days of their monthly target - fixing
    # sandwiches shouldn't come at the cost of meaningfully undershooting
    # someone's quota (and pay).
    SANDWICH_FIX_TOLERANCE = 1
    if len(sales_pool) >= 2:

        def _entry_for(d, name):
            return next((e for e in assignments[d] if e["name"] == name), None)

        def _works(d, name):
            # Inventory counts as worked here: it's a full day on duty, so
            # the day after inventory Sunday isn't an "isolated" work day
            e = _entry_for(d, name)
            return e is not None and e["label"] in ("Opening", "Closing", "Inventory")

        def _consecutive_run(name, idx, direction):
            count = 0
            i = idx + direction
            while 0 <= i < len(days) and _works(days[i], name):
                count += 1
                i += direction
            return count

        for i, d in enumerate(days):
            if d == first_sunday:
                continue
            prev_d = days[i - 1] if i > 0 else None
            next_d = days[i + 1] if i < len(days) - 1 else None

            def _isolated(name, day=d, previous=prev_d, following=next_d):
                return (
                    _works(day, name)
                    and (previous is None or not _works(previous, name))
                    and (following is None or not _works(following, name))
                )

            isolated_people = [n for n in sales_pool if _isolated(n)]
            if len(isolated_people) != 1:
                continue  # nobody to fix, or everyone here is isolated - no clean fix

            worker = isolated_people[0]
            if off_needed[worker] < -SANDWICH_FIX_TOLERANCE:
                continue  # no target slack left to give this day up

            # A lone day may only be dropped outright if it really was
            # spare coverage - that is, somebody else on duty holds the
            # SAME shift. Dropping a person whose label nobody else has
            # would leave the store with no Opening (or no Closing) that
            # day, which is how Mondays after inventory Sunday used to end
            # up with nobody opening.
            worker_entry = _entry_for(d, worker)
            duplicated = any(
                e["name"] != worker and e["label"] == worker_entry["label"] for e in assignments[d]
            )
            if duplicated:
                assignments[d] = [e for e in assignments[d] if e["name"] != worker]
                off_needed[worker] -= 1
                continue
            if any(_works(d, n) for n in sales_pool if n != worker):
                continue  # colleague on duty but on the other shift - worker's slot is needed

            # hand it to a colleague who is already working either side of
            # it, and whose run can absorb one more day
            replacement = next(
                (
                    n
                    for n in sales_pool
                    if n != worker
                    and not _works(d, n)
                    and not _isolated(n)
                    and ((prev_d is not None and _works(prev_d, n)) or (next_d is not None and _works(next_d, n)))
                    and _consecutive_run(n, i, -1) + 1 + _consecutive_run(n, i, 1) <= MAX_CONSECUTIVE_DAYS
                ),
                None,
            )
            if replacement is None:
                continue

            _entry_for(d, worker)["name"] = replacement
            off_needed[worker] -= 1

    # --- persist -------------------------------------------------------
    counts = {n: 0 for n in staff_rows}
    for d in days:
        for a in assignments[d]:
            staff_id = staff_rows[a["name"]]["id"]
            cur.execute(
                "INSERT INTO schedule (staff_id, date, shift_label, time_range, detail) VALUES (%s,%s,%s,%s,%s)",
                (staff_id, d.isoformat(), a["label"], a["time_range"], a["detail"]),
            )
            counts[a["name"]] += 1
    db.commit()
    db.close()
    return counts


def fetch_schedule_days(db, year, month, roster_names=None):
    """Returns the list of per-day schedule dicts for a given month.
    roster_names drives the "Off Today" column - pass the same roster the
    table renders columns for, so a leaver isn't listed as off forever."""
    if roster_names is None:
        roster_names = [s["name"] for s in roster_for_month(db, year, month)]
    cur = db.cursor()
    first_day = date(year, month, 1)
    last_day_num = calendar.monthrange(year, month)[1]
    last_day = date(year, month, last_day_num)

    cur.execute(
        """SELECT schedule.date, staff.name, staff.category, schedule.shift_label,
                  schedule.time_range, schedule.detail
           FROM schedule
           JOIN staff ON schedule.staff_id = staff.id
           WHERE date BETWEEN %s AND %s
           ORDER BY date""",
        (first_day.isoformat(), last_day.isoformat()),
    )
    rows = [dict(r) for r in cur.fetchall()]

    by_date = {}
    for r in rows:
        by_date.setdefault(r["date"], []).append(r)

    days = []
    for i in range(last_day_num):
        d = first_day + timedelta(days=i)
        diso = d.isoformat()
        entries = by_date.get(diso, [])
        working_names = set(e["name"] for e in entries)
        off_names = [n for n in roster_names if n not in working_names]
        days.append(
            {
                "date": diso,
                "day_num": d.day,
                "weekday": d.strftime("%A"),
                "weekday_short": d.strftime("%a"),
                "entries": entries,
                "off": off_names,
            }
        )
    return days


# ---------------------------------------------------------------------------
# Payroll
# ---------------------------------------------------------------------------
def payroll_period_range(year, month, payday):
    """payday is 10 or 25. The 10th payout covers the 25th of the prior
    month through the 9th of this month; the 25th payout covers the 10th
    through the 24th of this month. Returns (start_date, end_date, pay_date)."""
    pay_date = date(year, month, payday)
    if payday == 10:
        prev_month = 12 if month == 1 else month - 1
        prev_year = year - 1 if month == 1 else year
        start = date(prev_year, prev_month, 25)
        end = date(year, month, 9)
    else:
        start = date(year, month, 10)
        end = date(year, month, 24)
    return start, end, pay_date


def _manager_comp_off_dates(start, end):
    """Dates in [start, end] that are automatic compensatory rest days for
    a fixed-schedule manager: the day after each month's 1st Sunday
    (mandatory inventory day) that falls in range. Mirrors the same rule
    applied when the schedule is generated (see generate_schedule)."""
    comp_dates = set()
    y, m = start.year, start.month
    while (y, m) <= (end.year, end.month):
        for day_num in range(1, 8):  # the 1st Sunday always falls within days 1-7
            d = date(y, m, day_num)
            if d.weekday() == 6:
                comp = d + timedelta(days=1)
                if start <= comp <= end:
                    comp_dates.add(comp)
                break
        m += 1
        if m == 13:
            m = 1
            y += 1
    return comp_dates


def _manager_absence_deduction(dates_worked, start, end, per_day_rate):
    """Mon-Sat is the expected work pattern for a fixed-salary manager
    (Sunday is her standing day off, aside from the mandatory inventory
    Sunday); the day after that inventory Sunday is an automatic
    compensatory rest day, not an absence. Each other unreported Mon-Sat
    day deducts per_day_rate, offset 1-for-1 by any additional
    (non-inventory) Sunday actually worked in the same cutoff."""
    comp_off = _manager_comp_off_dates(start, end)
    absences = 0
    sundays_worked = 0
    d = start
    while d <= end:
        if d.weekday() == 6:
            is_inventory_sunday = d.day <= 7
            if not is_inventory_sunday and d in dates_worked:
                sundays_worked += 1
        elif d not in comp_off and d not in dates_worked:
            absences += 1
        d += timedelta(days=1)
    deductible_days = max(0, absences - sundays_worked)
    return round(deductible_days * per_day_rate, 2)


def cash_advance_balances(cur, staff_ids=None):
    """Outstanding cash advance per staff id.

    Advances are the ledger; repayments are the per-cutoff `cash_advance`
    deductions already recorded on payroll_extras, so the balance can
    never drift from what payroll actually withheld. Only repayments from
    the first advance onward are counted - deductions saved before this
    ledger existed have no advance to pay off and would otherwise show up
    as a credit."""
    where = ""
    params = []
    if staff_ids is not None:
        if not staff_ids:
            return {}
        where = " WHERE staff_id = ANY(%s)"
        params = [list(staff_ids)]

    cur.execute(
        f"SELECT staff_id, SUM(amount) AS granted, MIN(date_granted) AS first_date "
        f"FROM cash_advances{where} GROUP BY staff_id",
        params,
    )
    granted = {r["staff_id"]: (float(r["granted"] or 0), r["first_date"]) for r in cur.fetchall()}
    if not granted:
        return {}

    balances = {}
    for staff_id, (total_granted, first_date) in granted.items():
        cur.execute(
            "SELECT COALESCE(SUM(cash_advance), 0) AS repaid FROM payroll_extras "
            "WHERE staff_id=%s AND pay_date >= %s",
            (staff_id, first_date),
        )
        repaid = float(cur.fetchone()["repaid"] or 0)
        balances[staff_id] = {
            "granted": round(total_granted, 2),
            "repaid": round(repaid, 2),
            "outstanding": round(max(0.0, total_granted - repaid), 2),
        }
    return balances


def compute_payroll(db, start, end, pay_date):
    """Days worked and cup-bonus come from the generated schedule + saved
    cup counts; OT hours and benefit deductions are manually entered per
    staff per pay date via /api/payroll/save."""
    cur = db.cursor()
    cur.execute(
        """SELECT id, name, full_name, role, category, daily_rate, monthly_salary,
                  default_sss, default_pagibig, default_philhealth, default_hmo
           FROM staff"""
    )
    staff_rows = [dict(r) for r in cur.fetchall()]

    cur.execute(
        "SELECT staff_id, date, shift_label FROM schedule WHERE date BETWEEN %s AND %s",
        (start.isoformat(), end.isoformat()),
    )
    schedule_rows = cur.fetchall()

    days_worked = {s["id"]: 0.0 for s in staff_rows}
    dates_worked = {s["id"]: set() for s in staff_rows}
    cup_shifts = {s["id"]: [] for s in staff_rows}  # (date, label) for Printer/Checker days
    for r in schedule_rows:
        days_worked[r["staff_id"]] += SHIFT_DAY_FRACTION.get(r["shift_label"], 1.0)
        dates_worked[r["staff_id"]].add(date.fromisoformat(r["date"]))
        if r["shift_label"] in CUP_BONUS_RATE:
            cup_shifts[r["staff_id"]].append((r["date"], r["shift_label"]))

    cur.execute(
        "SELECT date, quantity FROM cup_counts WHERE date BETWEEN %s AND %s",
        (start.isoformat(), end.isoformat()),
    )
    cup_counts = {r["date"]: r["quantity"] for r in cur.fetchall()}

    cur.execute(
        "SELECT staff_id, ot_hours, sss, pagibig, philhealth, hmo, error_deduction, cash_advance, manual_bonus "
        "FROM payroll_extras WHERE pay_date=%s",
        (pay_date.isoformat(),),
    )
    extras_by_staff = {r["staff_id"]: dict(r) for r in cur.fetchall()}

    # outstanding advances, plus the per-cutoff installment each person
    # agreed to - used to prefill the deduction on an unsaved cutoff
    balances = cash_advance_balances(cur, [s["id"] for s in staff_rows])
    cur.execute(
        "SELECT staff_id, SUM(COALESCE(installment, 0)) AS installment FROM cash_advances GROUP BY staff_id"
    )
    installments = {r["staff_id"]: float(r["installment"] or 0) for r in cur.fetchall()}

    results = []
    for s in staff_rows:
        sid = s["id"]
        worked = days_worked[sid]
        worked_display = int(worked) if worked == int(worked) else worked

        if s.get("monthly_salary"):
            # Fixed monthly salary, split evenly across the two semi-monthly
            # cutoffs; absences deduct a 26-day-divisor day-rate, offset by
            # any Sunday worked in lieu of a missed weekday (see helper).
            base_pay = s["monthly_salary"] / 2
            per_day_rate = s["monthly_salary"] / 26
            absence_deduction = _manager_absence_deduction(dates_worked[sid], start, end, per_day_rate)
        else:
            base_pay = worked * (s["daily_rate"] or 0)
            absence_deduction = 0

        bonus = sum(
            max(0, cup_counts.get(d_iso, 0) - DAILY_CUP_QUOTA) * CUP_BONUS_RATE[label]
            for d_iso, label in cup_shifts[sid]
        )

        # once a cutoff has been saved (a payroll_extras row exists), its
        # values are the source of truth; before that, prefill deductions
        # from the staff member's standing default contribution amounts
        # what's still owed *before* this cutoff's deduction. If the
        # cutoff is already saved its own deduction is part of `repaid`,
        # so add it back to show the balance this cutoff started from.
        balance = balances.get(sid, {"granted": 0, "repaid": 0, "outstanding": 0})
        saved_repayment = float((extras_by_staff.get(sid) or {}).get("cash_advance") or 0)
        outstanding_before = round(balance["outstanding"] + saved_repayment, 2)

        extras = extras_by_staff.get(sid)
        if extras is not None:
            ot_hours = extras.get("ot_hours") or 0
            sss = extras.get("sss") or 0
            pagibig = extras.get("pagibig") or 0
            philhealth = extras.get("philhealth") or 0
            hmo = extras.get("hmo") or 0
            error_deduction = extras.get("error_deduction") or 0
            cash_advance = extras.get("cash_advance") or 0
            manual_bonus = extras.get("manual_bonus") or 0
        else:
            ot_hours = 0
            sss = s.get("default_sss") or 0
            pagibig = s.get("default_pagibig") or 0
            philhealth = s.get("default_philhealth") or 0
            hmo = s.get("default_hmo") or 0
            error_deduction = 0
            # unsaved cutoff: suggest this person's agreed installment,
            # capped at what's actually left to repay (so the final
            # instalment is the remainder, not an overpayment)
            cash_advance = round(min(installments.get(sid, 0) or outstanding_before, outstanding_before), 2)
            manual_bonus = 0
        ot_pay = ot_hours * OT_HOURLY_RATE
        total_deductions = sss + pagibig + philhealth + hmo + error_deduction + cash_advance + absence_deduction
        net_pay = base_pay + ot_pay + bonus + manual_bonus - total_deductions

        results.append(
            {
                "name": s["name"],
                "full_name": s["full_name"],
                "role": s["role"],
                "category": s["category"],
                "daily_rate": s["daily_rate"],
                "monthly_salary": s.get("monthly_salary"),
                "days_worked": worked_display,
                "base_pay": round(base_pay, 2),
                "has_bonus": s["category"] == "machine",  # cup bonus - machine operators only
                "bonus": round(bonus, 2),
                "manual_bonus": manual_bonus,
                "ot_hours": ot_hours,
                "ot_pay": round(ot_pay, 2),
                "sss": sss,
                "pagibig": pagibig,
                "philhealth": philhealth,
                "hmo": hmo,
                "error_deduction": error_deduction,
                "cash_advance": cash_advance,
                "advance_outstanding_before": outstanding_before,
                "advance_outstanding_after": round(max(0.0, outstanding_before - cash_advance), 2),
                "absence_deduction": round(absence_deduction, 2),
                "total_deductions": round(total_deductions, 2),
                "net_pay": round(net_pay, 2),
            }
        )

    # cup-count entry rows: every date in the cutoff (not just weekdays -
    # operations sometimes run weekends too, e.g. inventory day or a
    # manually-added Saturday/Sunday shift)
    cup_rows = []
    d = start
    while d <= end:
        d_iso = d.isoformat()
        cup_rows.append(
            {
                "date": d_iso,
                "quantity": cup_counts.get(d_iso, 0),
                "weekday_short": d.strftime("%a"),
                "is_weekend": d.weekday() >= 5,
            }
        )
        d += timedelta(days=1)

    return {
        "period_start": start.isoformat(),
        "period_end": end.isoformat(),
        "pay_date": pay_date.isoformat(),
        "staff": results,
        "cup_counts": cup_rows,
        "ot_rate": OT_HOURLY_RATE,
        "cup_bonus_rate": CUP_BONUS_RATE,
        "cup_daily_quota": DAILY_CUP_QUOTA,
    }


def compute_thirteenth_month(db, year):
    """13th month pay = total *basic* salary earned in the calendar year
    divided by 12 (PD 851). Basic salary only - overtime, cup bonus,
    discretionary bonus and allowances are all excluded by law, and
    deductions for absences reduce it.

    Daily-rate staff: days actually worked that year x their daily rate,
    read straight off the schedule (an Assist half-day counts as 0.5,
    same as in the semi-monthly payroll).

    Fixed-salary staff (the manager): her monthly salary for each month
    the schedule covers, less the same unreported-day absence deduction
    the cutoffs apply - computed calendar month by calendar month here,
    rather than per cutoff, since the year is the unit that matters.

    Months with no schedule at all are skipped rather than counted as
    zero-earning, so running this mid-year reports what's been earned so
    far instead of understating it."""
    cur = db.cursor()
    cur.execute(
        "SELECT id, name, full_name, role, category, daily_rate, monthly_salary FROM staff ORDER BY id"
    )
    staff_rows = [dict(r) for r in cur.fetchall()]

    year_start = date(year, 1, 1)
    year_end = date(year, 12, 31)
    cur.execute(
        "SELECT staff_id, date, shift_label FROM schedule WHERE date BETWEEN %s AND %s",
        (year_start.isoformat(), year_end.isoformat()),
    )
    schedule_rows = cur.fetchall()

    days_worked = {s["id"]: 0.0 for s in staff_rows}
    dates_worked = {s["id"]: set() for s in staff_rows}
    months_with_data = set()
    for r in schedule_rows:
        d = date.fromisoformat(r["date"])
        days_worked[r["staff_id"]] += SHIFT_DAY_FRACTION.get(r["shift_label"], 1.0)
        dates_worked[r["staff_id"]].add(d)
        months_with_data.add(d.month)

    results = []
    for s in staff_rows:
        sid = s["id"]
        worked = days_worked[sid]
        months_counted = len(months_with_data)

        if s.get("monthly_salary"):
            per_day_rate = s["monthly_salary"] / 26
            absence_deduction = 0.0
            for m in sorted(months_with_data):
                last_day = calendar.monthrange(year, m)[1]
                absence_deduction += _manager_absence_deduction(
                    dates_worked[sid], date(year, m, 1), date(year, m, last_day), per_day_rate
                )
            basic_earned = s["monthly_salary"] * months_counted - absence_deduction
        else:
            absence_deduction = 0.0
            basic_earned = worked * (s["daily_rate"] or 0)

        results.append(
            {
                "name": s["name"],
                "full_name": s["full_name"],
                "role": s["role"],
                "daily_rate": s["daily_rate"],
                "monthly_salary": s.get("monthly_salary"),
                "days_worked": int(worked) if worked == int(worked) else worked,
                "months_counted": months_counted,
                "absence_deduction": round(absence_deduction, 2),
                "basic_earned": round(basic_earned, 2),
                "thirteenth_month": round(basic_earned / 12, 2),
            }
        )

    return {
        "year": year,
        "months_counted": len(months_with_data),
        "months_with_data": sorted(months_with_data),
        "staff": results,
    }


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------
def _session_expired():
    """True if the session has been idle past SESSION_IDLE_MINUTES. Each
    authenticated request refreshes the stamp, so this only fires on a
    genuinely abandoned session."""
    last_seen = session.get("last_seen")
    if not last_seen:
        return True
    try:
        idle = datetime.now() - datetime.fromisoformat(last_seen)
    except (TypeError, ValueError):
        return True
    return idle > timedelta(minutes=SESSION_IDLE_MINUTES)


def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if "user_id" not in session:
            if request.path.startswith("/api/"):
                return jsonify({"status": "error", "message": "Login required"}), 401
            return redirect(url_for("login_page"))
        if _session_expired():
            session.clear()
            if request.path.startswith("/api/"):
                return jsonify({"status": "error", "message": "Session expired - please log in again"}), 401
            return redirect(url_for("login_page"))
        session["last_seen"] = datetime.now().isoformat()
        return view(*args, **kwargs)

    return wrapped


def is_manager():
    """Superuser (Jomark) or an active manager-category staff member
    (Clare) - the only people who may see payroll figures and employee
    records. Read live rather than cached in the session so promoting or
    archiving someone takes effect on their next request, not their next
    login."""
    if session.get("is_superuser"):
        return True
    staff_name = session.get("staff_name")
    if not staff_name:
        return False
    cur = get_db().cursor()
    cur.execute("SELECT 1 FROM staff WHERE name=%s AND category='manager' AND active", (staff_name,))
    return cur.fetchone() is not None


def manager_required(view):
    @wraps(view)
    @login_required
    def wrapped(*args, **kwargs):
        if not is_manager():
            return jsonify({"status": "error", "message": "Not allowed"}), 403
        return view(*args, **kwargs)

    return wrapped


def is_outside_viewer():
    """A logged-in account that isn't a staff member and isn't the
    superuser - a co-owner or similar. Read-only everywhere: they're
    neither manager nor superuser, so every write route already refuses
    them. They see the branch at a glance, not the payroll, unless
    can_view_payroll is switched on for them."""
    return not session.get("is_superuser") and not session.get("staff_name")


def can_view_payroll():
    if is_manager():
        return True
    if not is_outside_viewer():
        return False
    cur = get_db().cursor()
    cur.execute("SELECT can_view_payroll FROM app_users WHERE id=%s", (session.get("user_id"),))
    row = cur.fetchone()
    return bool(row and row["can_view_payroll"])


def payroll_view_required(view):
    """Reading payroll figures. Saving them stays superuser-only."""

    @wraps(view)
    @login_required
    def wrapped(*args, **kwargs):
        if not can_view_payroll():
            return jsonify({"status": "error", "message": "Not allowed"}), 403
        return view(*args, **kwargs)

    return wrapped


def superuser_required(view):
    @wraps(view)
    @login_required
    def wrapped(*args, **kwargs):
        if not session.get("is_superuser"):
            return jsonify({"status": "error", "message": "Superuser access required"}), 403
        return view(*args, **kwargs)

    return wrapped


@app.route("/login", methods=["GET", "POST"])
def login_page():
    if "user_id" in session and not _session_expired():
        return redirect(url_for("index"))
    session.clear()

    db = get_db()
    cur = db.cursor()
    cur.execute(
        """SELECT id, staff_name, display_name FROM app_users
           WHERE login_enabled = TRUE AND pin_hash IS NOT NULL
           ORDER BY is_superuser DESC, display_name"""
    )
    candidates = cur.fetchall()

    error = None
    if request.method == "POST":
        user_id = request.form.get("user_id")
        pin = request.form.get("pin", "")
        cur.execute("SELECT * FROM app_users WHERE id=%s", (user_id,))
        user = cur.fetchone()

        if user is None or not user["login_enabled"] or not user["pin_hash"]:
            error = "Invalid login."
        elif user["locked_until"] and user["locked_until"] > datetime.now():
            minutes = int((user["locked_until"] - datetime.now()).total_seconds() // 60) + 1
            error = f"Too many failed attempts. Try again in {minutes} minute(s)."
        elif check_password_hash(user["pin_hash"], pin):
            cur.execute(
                "UPDATE app_users SET failed_attempts=0, locked_until=NULL WHERE id=%s", (user["id"],)
            )
            db.commit()
            session.clear()
            session["user_id"] = user["id"]
            session["display_name"] = user["display_name"]
            session["is_superuser"] = user["is_superuser"]
            session["staff_name"] = user["staff_name"]
            session["last_seen"] = datetime.now().isoformat()
            # a browser-session cookie, not a persistent one - closing the
            # browser ends the session and the PIN is required again
            session.permanent = False
            return redirect(url_for("index"))
        else:
            attempts = user["failed_attempts"] + 1
            locked_until = None
            if attempts >= LOGIN_MAX_ATTEMPTS:
                locked_until = datetime.now() + timedelta(minutes=LOGIN_LOCKOUT_MINUTES)
                error = f"Too many failed attempts. Locked for {LOGIN_LOCKOUT_MINUTES} minutes."
            else:
                error = "Incorrect PIN."
            cur.execute(
                "UPDATE app_users SET failed_attempts=%s, locked_until=%s WHERE id=%s",
                (attempts, locked_until, user["id"]),
            )
            db.commit()

    return render_template("login.html", business_name=BUSINESS_NAME, candidates=candidates, error=error)


@app.route("/logout", methods=["POST"])
def logout():
    session.clear()
    return redirect(url_for("login_page"))


@app.route("/api/staff/<name>/login", methods=["POST"])
@login_required
def api_set_staff_login(name):
    """Sets a staff member's login eligibility and/or PIN. Granting/revoking
    login access (and resetting someone else's PIN) is superuser-only; a
    logged-in staff member may only change their own PIN."""
    is_superuser = session.get("is_superuser")
    is_self = session.get("staff_name") == name
    if not is_superuser and not is_self:
        return jsonify({"status": "error", "message": "Not allowed"}), 403

    data = request.get_json(force=True)
    db = get_db()
    cur = db.cursor()
    cur.execute("SELECT id FROM staff WHERE name=%s", (name,))
    if cur.fetchone() is None:
        return jsonify({"status": "error", "message": "Unknown staff member"}), 400

    cur.execute("SELECT id FROM app_users WHERE staff_name=%s", (name,))
    existing = cur.fetchone()

    pin = data.get("pin") or None
    if pin is not None and len(pin) < 4:
        return jsonify({"status": "error", "message": "PIN must be at least 4 characters"}), 400

    if not is_superuser:
        # self-service: PIN only, can't touch login_enabled
        if pin is None:
            return jsonify({"status": "error", "message": "No PIN provided"}), 400
        if existing is None:
            return jsonify({"status": "error", "message": "Login isn't enabled for this account"}), 400
        cur.execute("UPDATE app_users SET pin_hash=%s WHERE staff_name=%s", (generate_password_hash(pin), name))
    else:
        login_enabled = bool(data.get("login_enabled"))
        if existing is None:
            cur.execute(
                "INSERT INTO app_users (staff_name, display_name, login_enabled, pin_hash) VALUES (%s,%s,%s,%s)",
                (name, name, login_enabled, generate_password_hash(pin) if pin else None),
            )
        else:
            if pin is not None:
                cur.execute(
                    "UPDATE app_users SET login_enabled=%s, pin_hash=%s, failed_attempts=0, locked_until=NULL WHERE staff_name=%s",
                    (login_enabled, generate_password_hash(pin), name),
                )
            else:
                cur.execute("UPDATE app_users SET login_enabled=%s WHERE staff_name=%s", (login_enabled, name))
    # never record the PIN itself, only that one was set
    record_audit(
        cur,
        "Changed login access" if is_superuser else "Changed own PIN",
        name,
        {"pin_changed": pin is not None, "login_enabled": bool(data.get("login_enabled")) if is_superuser else None},
    )
    db.commit()
    return jsonify({"status": "ok"})


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
def compute_staff_counts(days, roster_names):
    counts = {n: 0 for n in roster_names}
    for day in days:
        for e in day["entries"]:
            if e["name"] in counts:
                counts[e["name"]] += 1
    return counts


@app.route("/")
@login_required
def index():
    current_user = {
        "display_name": session.get("display_name"),
        "is_superuser": session.get("is_superuser"),
        "is_manager": is_manager(),
        "is_outside_viewer": is_outside_viewer(),
        "can_view_payroll": can_view_payroll(),
        # branch-wide figures (per-person day totals) - the people running
        # the place and the owners, not the team
        "sees_branch": is_manager() or is_outside_viewer(),
        "staff_name": session.get("staff_name"),
    }
    return render_template(
        "index.html", staff=roster(), business_name=BUSINESS_NAME, current_user=current_user
    )


STAFF_EDITABLE_FIELDS = {
    "full_name", "role", "employment", "target", "daily_rate", "monthly_salary", "pto_entitlement",
    "address", "phone", "email", "birthday",
    "default_sss", "default_pagibig", "default_philhealth", "default_hmo",
    "sss_id", "pagibig_id", "philhealth_id", "hmo_id",
    "bank_name", "bank_account_name", "bank_account_number",
}
STAFF_NUMERIC_FIELDS = {
    "daily_rate", "monthly_salary", "default_sss", "default_pagibig", "default_philhealth", "default_hmo",
}
STAFF_INTEGER_FIELDS = {"target", "pto_entitlement"}


@app.route("/api/staff")
@manager_required
def api_staff_list():
    db = get_db()
    cur = db.cursor()
    cur.execute(
        """SELECT staff.name, full_name, role, category, employment, target, daily_rate, monthly_salary, pto_entitlement,
                  address, phone, email, photo_filename, birthday,
                  default_sss, default_pagibig, default_philhealth, default_hmo,
                  sss_id, pagibig_id, philhealth_id, hmo_id,
                  bank_name, bank_account_name, bank_account_number,
                  staff.active, staff.archived_at,
                  COALESCE(app_users.login_enabled, FALSE) AS login_enabled,
                  (app_users.pin_hash IS NOT NULL) AS has_pin
           FROM staff
           LEFT JOIN app_users ON app_users.staff_name = staff.name
           ORDER BY staff.active DESC, staff.id"""
    )
    rows = []
    for r in cur.fetchall():
        row = dict(r)
        row["archived_at"] = row["archived_at"].isoformat() if row["archived_at"] else None
        rows.append(row)
    # a list, not the dict - jsonify sorts object keys, which would put
    # "machine" first and make Machine Operator the default choice
    categories = [{"value": value, "label": label} for value, label in STAFF_CATEGORIES.items()]
    return jsonify({"staff": rows, "categories": categories})


@app.route("/api/staff/new", methods=["POST"])
@manager_required
def api_staff_create():
    """Hire someone. `name` is the short label used as the schedule
    column header and in URLs, so it's constrained to letters, digits,
    spaces, hyphens and apostrophes, and has to be unique."""
    data = request.get_json(force=True)
    name = (data.get("name") or "").strip()
    full_name = (data.get("full_name") or "").strip()
    category = data.get("category")

    if not name:
        return jsonify({"status": "error", "message": "Short name is required"}), 400
    if len(name) > 20:
        return jsonify({"status": "error", "message": "Short name must be 20 characters or fewer"}), 400
    if not re.fullmatch(r"[A-Za-z0-9 '\-]+", name):
        return jsonify({"status": "error", "message": "Short name can only use letters, numbers, spaces, - and '"}), 400
    # /api/staff/new is this very route - a person called "new" would be
    # unreachable at /api/staff/<name>
    if name.lower() == "new":
        return jsonify({"status": "error", "message": "'new' is reserved - pick a different short name"}), 400
    if category not in STAFF_CATEGORIES:
        return jsonify({"status": "error", "message": "Pick a valid category"}), 400
    if not full_name:
        return jsonify({"status": "error", "message": "Full name is required"}), 400

    db = get_db()
    cur = db.cursor()
    # case-insensitive uniqueness, and archived names still count - the
    # old row is what payroll history points at
    cur.execute("SELECT name, active FROM staff WHERE LOWER(name)=LOWER(%s)", (name,))
    existing = cur.fetchone()
    if existing:
        hint = " (archived - restore them instead)" if not existing["active"] else ""
        return jsonify({"status": "error", "message": f"'{existing['name']}' already exists{hint}"}), 400

    def _num(field):
        value = data.get(field)
        return float(value) if value not in (None, "") else None

    def _int(field):
        value = data.get(field)
        return int(value) if value not in (None, "") else None

    cur.execute(
        """INSERT INTO staff (name, full_name, role, category, employment, target, daily_rate,
                              monthly_salary, pto_entitlement, active)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,TRUE)""",
        (
            name,
            full_name,
            (data.get("role") or STAFF_CATEGORIES[category]).strip(),
            category,
            (data.get("employment") or "Permanent").strip(),
            _int("target"),
            _num("daily_rate"),
            _num("monthly_salary"),
            _int("pto_entitlement"),
        ),
    )
    record_audit(
        cur,
        "Added employee",
        name,
        {"full_name": full_name, "category": category, "daily_rate": _num("daily_rate"),
         "monthly_salary": _num("monthly_salary"), "target": _int("target")},
    )
    db.commit()
    return jsonify({"status": "ok", "name": name})


@app.route("/api/staff/<name>/archive", methods=["POST"])
@manager_required
def api_staff_archive(name):
    """Off-board someone: they stop being scheduled and disappear from
    the roster, but the row itself is never deleted - past schedules,
    payroll cutoffs and 13th month all still reference it. Shifts already
    generated for future dates are cleared, along with any leave request
    still awaiting a decision."""
    db = get_db()
    cur = db.cursor()
    cur.execute("SELECT id, active, category FROM staff WHERE name=%s", (name,))
    row = cur.fetchone()
    if row is None:
        return jsonify({"status": "error", "message": "Unknown staff member"}), 400
    if not row["active"]:
        return jsonify({"status": "error", "message": f"{name} is already archived"}), 400
    if session.get("staff_name") == name:
        return jsonify({"status": "error", "message": "You can't archive your own account"}), 400
    # the last manager leaving would lock everyone but the superuser out
    # of payroll and this very page
    if row["category"] == "manager":
        cur.execute("SELECT COUNT(*) AS c FROM staff WHERE category='manager' AND active AND name <> %s", (name,))
        if cur.fetchone()["c"] == 0:
            return jsonify(
                {"status": "error", "message": "That's the only active manager - promote someone else first"}
            ), 400

    today = date.today().isoformat()
    cur.execute("DELETE FROM schedule WHERE staff_id=%s AND date > %s", (row["id"], today))
    cleared_shifts = cur.rowcount
    cur.execute("DELETE FROM leave_requests WHERE staff_id=%s AND status='pending'", (row["id"],))
    cleared_requests = cur.rowcount
    cur.execute("UPDATE staff SET active=FALSE, archived_at=NOW() WHERE id=%s", (row["id"],))
    # revoke the login too - an archived employee shouldn't be able to
    # sign in while their records are being kept for history
    cur.execute("UPDATE app_users SET login_enabled=FALSE WHERE staff_name=%s", (name,))
    record_audit(
        cur,
        "Archived employee",
        name,
        {"cleared_future_shifts": cleared_shifts, "cancelled_leave_requests": cleared_requests},
    )
    db.commit()
    return jsonify({"status": "ok", "cleared_shifts": cleared_shifts, "cleared_requests": cleared_requests})


@app.route("/api/staff/<name>/restore", methods=["POST"])
@manager_required
def api_staff_restore(name):
    """Un-archive someone (a rehire, or an archive done by mistake).
    Their login stays disabled until it's switched back on deliberately."""
    db = get_db()
    cur = db.cursor()
    cur.execute("SELECT id, active FROM staff WHERE name=%s", (name,))
    row = cur.fetchone()
    if row is None:
        return jsonify({"status": "error", "message": "Unknown staff member"}), 400
    if row["active"]:
        return jsonify({"status": "error", "message": f"{name} is already active"}), 400
    cur.execute("UPDATE staff SET active=TRUE, archived_at=NULL WHERE id=%s", (row["id"],))
    record_audit(cur, "Restored employee", name)
    db.commit()
    return jsonify({"status": "ok"})


@app.route("/api/staff/<name>", methods=["POST"])
@manager_required
def api_staff_update(name):
    staff_by_name = roster_by_name()
    if name not in staff_by_name:
        return jsonify({"status": "error", "message": "Unknown staff member"}), 400

    data = request.get_json(force=True)
    db = get_db()
    cur = db.cursor()
    cur.execute("SELECT id FROM staff WHERE name=%s", (name,))
    row = cur.fetchone()
    staff_id = row["id"]

    updates = {}
    for field in STAFF_EDITABLE_FIELDS:
        if field not in data:
            continue
        value = data[field]
        if field in STAFF_INTEGER_FIELDS:
            updates[field] = int(value) if value not in (None, "") else None
        elif field in STAFF_NUMERIC_FIELDS:
            updates[field] = float(value) if value not in (None, "") else 0
        else:
            updates[field] = (value or "").strip()

    if updates:
        # capture the old values first so the audit entry can show what
        # actually changed rather than just "someone saved this card"
        columns = ", ".join(updates)
        cur.execute(f"SELECT {columns} FROM staff WHERE id=%s", (staff_id,))
        before = dict(cur.fetchone())
        changed = {f: {"from": before[f], "to": v} for f, v in updates.items() if before[f] != v}

        set_clause = ", ".join(f"{field}=%s" for field in updates)
        cur.execute(f"UPDATE staff SET {set_clause} WHERE id=%s", (*updates.values(), staff_id))
        if changed:
            record_audit(cur, "Updated employee", name, changed)
        db.commit()
    return jsonify({"status": "ok"})


@app.route("/api/staff/<name>/advances")
@manager_required
def api_staff_advances(name):
    """This person's cash advance ledger and what's still outstanding."""
    if name not in roster_by_name():
        return jsonify({"status": "error", "message": "Unknown staff member"}), 400

    db = get_db()
    cur = db.cursor()
    cur.execute("SELECT id FROM staff WHERE name=%s", (name,))
    staff_id = cur.fetchone()["id"]

    cur.execute(
        "SELECT id, amount, date_granted, installment, note, created_by, created_at "
        "FROM cash_advances WHERE staff_id=%s ORDER BY date_granted DESC, id DESC",
        (staff_id,),
    )
    advances = [
        {
            "id": r["id"],
            "amount": round(float(r["amount"]), 2),
            "date_granted": r["date_granted"],
            "installment": round(float(r["installment"]), 2) if r["installment"] is not None else None,
            "note": r["note"],
            "created_by": r["created_by"],
            "created_at": r["created_at"].isoformat(),
        }
        for r in cur.fetchall()
    ]
    balance = cash_advance_balances(cur, [staff_id]).get(
        staff_id, {"granted": 0, "repaid": 0, "outstanding": 0}
    )
    return jsonify({"advances": advances, **balance})


@app.route("/api/staff/<name>/advances", methods=["POST"])
@manager_required
def api_create_advance(name):
    if name not in roster_by_name(include_archived=False):
        return jsonify({"status": "error", "message": "Unknown or archived staff member"}), 400

    data = request.get_json(force=True)
    try:
        amount = float(data.get("amount"))
    except (TypeError, ValueError):
        return jsonify({"status": "error", "message": "Enter an amount"}), 400
    if amount <= 0:
        return jsonify({"status": "error", "message": "Amount must be more than zero"}), 400

    date_granted = data.get("date_granted") or date.today().isoformat()
    try:
        date.fromisoformat(date_granted)
    except (TypeError, ValueError):
        return jsonify({"status": "error", "message": "Invalid date"}), 400

    installment = data.get("installment")
    if installment in (None, ""):
        installment = None
    else:
        try:
            installment = float(installment)
        except (TypeError, ValueError):
            return jsonify({"status": "error", "message": "Invalid per-cutoff amount"}), 400
        if installment <= 0:
            return jsonify({"status": "error", "message": "Per-cutoff amount must be more than zero"}), 400
        if installment > amount:
            return jsonify({"status": "error", "message": "Per-cutoff amount can't exceed the advance itself"}), 400

    db = get_db()
    cur = db.cursor()
    cur.execute("SELECT id FROM staff WHERE name=%s", (name,))
    staff_id = cur.fetchone()["id"]
    cur.execute(
        "INSERT INTO cash_advances (staff_id, amount, date_granted, installment, note, created_by) "
        "VALUES (%s,%s,%s,%s,%s,%s)",
        (staff_id, amount, date_granted, installment, (data.get("note") or "").strip() or None,
         session.get("display_name") or "Unknown"),
    )
    record_audit(
        cur, "Recorded cash advance", name,
        {"amount": amount, "date_granted": date_granted, "per_cutoff": installment},
    )
    db.commit()
    return jsonify({"status": "ok"})


@app.route("/api/advances/<int:advance_id>", methods=["DELETE"])
@manager_required
def api_delete_advance(advance_id):
    """Removes an advance recorded by mistake. Repayments already withheld
    in payroll aren't touched - correct those on the cutoff itself."""
    db = get_db()
    cur = db.cursor()
    cur.execute(
        """SELECT cash_advances.id, staff.name, amount, date_granted
           FROM cash_advances JOIN staff ON staff.id = cash_advances.staff_id
           WHERE cash_advances.id=%s""",
        (advance_id,),
    )
    row = cur.fetchone()
    if row is None:
        return jsonify({"status": "error", "message": "Advance not found"}), 404

    cur.execute("DELETE FROM cash_advances WHERE id=%s", (advance_id,))
    record_audit(
        cur, "Deleted cash advance", row["name"],
        {"amount": round(float(row["amount"]), 2), "date_granted": row["date_granted"]},
    )
    db.commit()
    return jsonify({"status": "ok"})


@app.route("/api/staff/<name>/pto")
@login_required
def api_staff_pto(name):
    """Paid Time Off balance for one calendar year. Used dates aren't a
    separate record - they're just this person's existing schedule rows
    with shift_label='Paid Time Off', so the balance always matches
    whatever's actually on the schedule."""
    staff_by_name = roster_by_name()
    if name not in staff_by_name:
        return jsonify({"status": "error", "message": "Unknown staff member"}), 400
    # a staff member may see their own balance (they need it to request
    # leave); everyone else's is manager-only
    if not is_manager() and session.get("staff_name") != name:
        return jsonify({"status": "error", "message": "Not allowed"}), 403

    year = int(request.args.get("year") or date.today().year)

    db = get_db()
    cur = db.cursor()
    cur.execute("SELECT id, pto_entitlement FROM staff WHERE name=%s", (name,))
    row = cur.fetchone()
    entitlement = row["pto_entitlement"] if row["pto_entitlement"] is not None else 0

    cur.execute(
        """SELECT date FROM schedule
           WHERE staff_id=%s AND shift_label='Paid Time Off' AND date LIKE %s
           ORDER BY date""",
        (row["id"], f"{year}-%"),
    )
    used_dates = [r["date"] for r in cur.fetchall()]

    return jsonify(
        {
            "year": year,
            "entitlement": entitlement,
            "used_count": len(used_dates),
            "available": entitlement - len(used_dates),
            "used_dates": used_dates,
        }
    )


# ---------------------------------------------------------------------------
# Leave requests
# ---------------------------------------------------------------------------
# Leave types a staff member can request. Paid Time Off draws down the
# yearly entitlement and lands on the schedule as a paid day; the other
# two just clear the shift (an unpaid day simply isn't a worked day, and
# sick days aren't a separate paid category here).
LEAVE_TYPES = {"Paid Time Off", "Unpaid Leave", "Sick Leave"}


def _leave_rows(cur, staff_name=None, status=None, limit=200):
    sql = """SELECT leave_requests.id, staff.name, staff.full_name, leave_requests.date,
                    leave_type, reason, status, requested_at, decided_by, decided_at, decision_note
             FROM leave_requests JOIN staff ON staff.id = leave_requests.staff_id"""
    clauses, params = [], []
    if staff_name:
        clauses.append("staff.name = %s")
        params.append(staff_name)
    if status:
        clauses.append("leave_requests.status = %s")
        params.append(status)
    if clauses:
        sql += " WHERE " + " AND ".join(clauses)
    # pending first (that's the queue people act on), then most recent
    sql += " ORDER BY (leave_requests.status = 'pending') DESC, leave_requests.date DESC LIMIT %s"
    params.append(limit)

    cur.execute(sql, params)
    return [
        {
            "id": r["id"],
            "name": r["name"],
            "full_name": r["full_name"],
            "date": r["date"],
            "leave_type": r["leave_type"],
            "reason": r["reason"],
            "status": r["status"],
            "requested_at": r["requested_at"].isoformat(),
            "decided_by": r["decided_by"],
            "decided_at": r["decided_at"].isoformat() if r["decided_at"] else None,
            "decision_note": r["decision_note"],
        }
        for r in cur.fetchall()
    ]


@app.route("/api/leave/requests")
@login_required
def api_leave_requests():
    """Managers see everyone's; a staff member sees only their own."""
    db = get_db()
    cur = db.cursor()
    if is_manager():
        staff_name = request.args.get("name") or None
    else:
        staff_name = session.get("staff_name")
        if not staff_name:
            return jsonify({"requests": [], "can_decide": False})
    return jsonify(
        {
            "requests": _leave_rows(cur, staff_name=staff_name, status=request.args.get("status") or None),
            "can_decide": is_manager(),
        }
    )


@app.route("/api/leave/request", methods=["POST"])
@login_required
def api_create_leave_request():
    data = request.get_json(force=True)
    staff_by_name = roster_by_name(include_archived=False)

    # a manager may file on someone's behalf (people do ask in person);
    # everyone else can only file for themselves
    name = (data.get("name") or session.get("staff_name") or "").strip()
    if not name:
        return jsonify({"status": "error", "message": "No staff member to file this for"}), 400
    if name not in staff_by_name:
        return jsonify({"status": "error", "message": "Unknown or archived staff member"}), 400
    if not is_manager() and session.get("staff_name") != name:
        return jsonify({"status": "error", "message": "You can only request leave for yourself"}), 403

    leave_type = data.get("leave_type")
    if leave_type not in LEAVE_TYPES:
        return jsonify({"status": "error", "message": "Pick a valid leave type"}), 400

    reason = (data.get("reason") or "").strip()

    raw_dates = data.get("dates") or []
    if not isinstance(raw_dates, list) or not raw_dates:
        return jsonify({"status": "error", "message": "Pick at least one date"}), 400
    try:
        dates = sorted({date.fromisoformat(d) for d in raw_dates})
    except (TypeError, ValueError):
        return jsonify({"status": "error", "message": "Invalid date"}), 400
    if len(dates) > 31:
        return jsonify({"status": "error", "message": "That's more than a month of leave in one request"}), 400

    today = date.today()
    past = [d for d in dates if d < today]
    if past:
        return jsonify({"status": "error", "message": f"{past[0].isoformat()} is in the past"}), 400

    db = get_db()
    cur = db.cursor()
    cur.execute("SELECT id, pto_entitlement FROM staff WHERE name=%s", (name,))
    staff_row = cur.fetchone()
    staff_id = staff_row["id"]

    # don't let the same day be requested twice while one is still open
    iso_dates = [d.isoformat() for d in dates]
    cur.execute(
        "SELECT date FROM leave_requests WHERE staff_id=%s AND date = ANY(%s) AND status IN ('pending','approved')",
        (staff_id, iso_dates),
    )
    clash = cur.fetchone()
    if clash:
        return jsonify(
            {"status": "error", "message": f"There's already a request for {clash['date']}"}
        ), 400

    if leave_type == "Paid Time Off":
        # entitlement is per calendar year, so check each year the request
        # touches separately; already-approved days are on the schedule
        # already, pending ones are not, so both are counted here
        entitlement = staff_row["pto_entitlement"] or 0
        for year in sorted({d.year for d in dates}):
            requested_this_year = len([d for d in dates if d.year == year])
            cur.execute(
                "SELECT COUNT(*) AS c FROM schedule WHERE staff_id=%s AND shift_label='Paid Time Off' AND date LIKE %s",
                (staff_id, f"{year}-%"),
            )
            used = cur.fetchone()["c"]
            cur.execute(
                "SELECT COUNT(*) AS c FROM leave_requests WHERE staff_id=%s AND status='pending' "
                "AND leave_type='Paid Time Off' AND date LIKE %s",
                (staff_id, f"{year}-%"),
            )
            pending = cur.fetchone()["c"]
            if used + pending + requested_this_year > entitlement:
                available = entitlement - used - pending
                return jsonify(
                    {
                        "status": "error",
                        "message": f"Only {max(0, available)} Paid Time Off day(s) left for {year} "
                        f"(entitlement {entitlement}, {used} used, {pending} already pending).",
                    }
                ), 400

    for d in dates:
        cur.execute(
            "INSERT INTO leave_requests (staff_id, date, leave_type, reason) VALUES (%s,%s,%s,%s)",
            (staff_id, d.isoformat(), leave_type, reason or None),
        )
    record_audit(
        cur,
        "Filed leave request",
        name,
        {"leave_type": leave_type, "dates": [d.isoformat() for d in dates]},
    )
    db.commit()
    return jsonify({"status": "ok", "created": len(dates)})


@app.route("/api/leave/request/<int:request_id>/decision", methods=["POST"])
@manager_required
def api_decide_leave_request(request_id):
    """Approve or deny a pending request. Approving is what actually
    changes the schedule: a Paid Time Off day is written in as a paid
    day, unpaid/sick days just clear whatever shift was there."""
    data = request.get_json(force=True)
    decision = data.get("status")
    if decision not in ("approved", "denied"):
        return jsonify({"status": "error", "message": "Decision must be approved or denied"}), 400
    note = (data.get("note") or "").strip() or None

    db = get_db()
    cur = db.cursor()
    cur.execute(
        """SELECT leave_requests.id, staff_id, staff.name, leave_requests.date, leave_type, leave_requests.status
           FROM leave_requests JOIN staff ON staff.id = leave_requests.staff_id
           WHERE leave_requests.id=%s""",
        (request_id,),
    )
    req = cur.fetchone()
    if req is None:
        return jsonify({"status": "error", "message": "Request not found"}), 404
    if req["status"] != "pending":
        return jsonify({"status": "error", "message": f"That request was already {req['status']}"}), 400

    cur.execute(
        "UPDATE leave_requests SET status=%s, decided_by=%s, decided_at=NOW(), decision_note=%s WHERE id=%s",
        (decision, session.get("display_name") or "Unknown", note, request_id),
    )

    if decision == "approved":
        d = date.fromisoformat(req["date"])
        cur.execute("DELETE FROM schedule WHERE staff_id=%s AND date=%s", (req["staff_id"], req["date"]))
        if req["leave_type"] == "Paid Time Off":
            cur.execute(
                "INSERT INTO schedule (staff_id, date, shift_label, time_range, detail) VALUES (%s,%s,%s,%s,%s)",
                (req["staff_id"], req["date"], "Paid Time Off", SHIFT_TIME_RANGES["Paid Time Off"], None),
            )
        record_schedule_edit(
            cur, d.year, d.month, f"Approved {req['name']}'s {req['leave_type'].lower()} on {d.strftime('%b')} {d.day}"
        )

    record_audit(
        cur,
        f"{decision.capitalize()} leave request",
        f"{req['name']} · {req['date']}",
        {"leave_type": req["leave_type"], "note": note},
    )
    db.commit()
    return jsonify({"status": "ok"})


@app.route("/api/leave/request/<int:request_id>", methods=["DELETE"])
@login_required
def api_cancel_leave_request(request_id):
    """Withdraw a request that hasn't been decided yet. Own requests
    only, unless you're a manager."""
    db = get_db()
    cur = db.cursor()
    cur.execute(
        """SELECT leave_requests.id, staff.name, leave_requests.status
           FROM leave_requests JOIN staff ON staff.id = leave_requests.staff_id
           WHERE leave_requests.id=%s""",
        (request_id,),
    )
    req = cur.fetchone()
    if req is None:
        return jsonify({"status": "error", "message": "Request not found"}), 404
    if not is_manager() and session.get("staff_name") != req["name"]:
        return jsonify({"status": "error", "message": "Not allowed"}), 403
    if req["status"] != "pending":
        return jsonify({"status": "error", "message": "Only pending requests can be withdrawn"}), 400

    cur.execute("DELETE FROM leave_requests WHERE id=%s", (request_id,))
    record_audit(cur, "Withdrew leave request", req["name"], {"request_id": request_id})
    db.commit()
    return jsonify({"status": "ok"})


@app.route("/api/staff/<name>/photo", methods=["POST"])
@manager_required
def api_staff_photo(name):
    staff_by_name = roster_by_name()
    if name not in staff_by_name:
        return jsonify({"status": "error", "message": "Unknown staff member"}), 400

    file = request.files.get("photo")
    if not file or not file.filename:
        return jsonify({"status": "error", "message": "No photo uploaded"}), 400

    ext = file.filename.rsplit(".", 1)[-1].lower() if "." in file.filename else ""
    if ext not in ALLOWED_PHOTO_EXTENSIONS:
        return jsonify({"status": "error", "message": "Photo must be a PNG, JPG, or WEBP image"}), 400

    db = get_db()
    cur = db.cursor()
    cur.execute("SELECT id, photo_filename FROM staff WHERE name=%s", (name,))
    row = cur.fetchone()

    filename = f"{name.lower()}.{ext}"
    filepath = os.path.join(UPLOAD_DIR, filename)

    # clean up an old photo saved under a different extension
    old_filename = row["photo_filename"]
    if old_filename and old_filename != filename:
        old_path = os.path.join(UPLOAD_DIR, old_filename)
        if os.path.exists(old_path):
            os.remove(old_path)

    file.save(filepath)
    cur.execute("UPDATE staff SET photo_filename=%s WHERE id=%s", (filename, row["id"]))
    record_audit(cur, "Updated photo", name)
    db.commit()
    return jsonify({"status": "ok", "photo_filename": filename})


@app.route("/api/generate", methods=["POST"])
@superuser_required
def api_generate():
    data = request.get_json(force=True)
    year = int(data.get("year"))
    month = int(data.get("month"))
    try:
        counts = generate_schedule(year, month)
    except ScheduleGenerationError as exc:
        return jsonify({"status": "error", "message": str(exc)}), 400
    db = get_db()
    cur = db.cursor()
    record_schedule_edit(cur, year, month, "Generated")
    record_audit(cur, "Generated schedule", f"{year}-{month:02d}", {"days_per_person": counts})
    db.commit()
    return jsonify({"status": "ok", "counts": counts})


def record_audit(cur, action, target=None, details=None):
    """Append one line to the audit trail. Caller commits, so the entry
    lives or dies with the change it describes.

    `action` is a short verb phrase ("Updated employee", "Saved payroll"),
    `target` is what it happened to (a staff name, a month, a pay date),
    and `details` is free-form JSON - typically {"before": ..., "after": ...}
    for edits, so a wrong number can be traced back to what it was."""
    cur.execute(
        "INSERT INTO audit_log (actor, action, target, details) VALUES (%s,%s,%s,%s)",
        (
            session.get("display_name") or "Unknown",
            action,
            target,
            Json(details) if details is not None else None,
        ),
    )


def record_schedule_edit(cur, year, month, action):
    """Stamp who last changed this month's schedule and how. Caller
    commits - this always runs inside the same transaction as the edit
    itself, so the stamp can't outlive a rolled-back change."""
    cur.execute(
        """INSERT INTO schedule_edits (year, month, edited_by, action, edited_at)
           VALUES (%s,%s,%s,%s,NOW())
           ON CONFLICT (year, month) DO UPDATE SET
             edited_by=excluded.edited_by, action=excluded.action, edited_at=excluded.edited_at""",
        (year, month, session.get("display_name") or "Unknown", action),
    )


def fetch_schedule_edit(cur, year, month):
    cur.execute("SELECT edited_by, action, edited_at FROM schedule_edits WHERE year=%s AND month=%s", (year, month))
    row = cur.fetchone()
    if row is None:
        return None
    return {"by": row["edited_by"], "action": row["action"], "at": row["edited_at"].isoformat()}


# ---------------------------------------------------------------------------
# Dashboard
# ---------------------------------------------------------------------------
def current_cutoff(today):
    """The pay period today falls in, matching the Payroll tab's default:
    the 10th payout covers the 25th to the 9th, the 25th covers the 10th
    to the 24th. Returns (start, end, pay_date)."""
    year, month = today.year, today.month
    if today.day <= 9:
        payday = 10
    elif today.day <= 24:
        payday = 25
    else:
        payday = 10
        month += 1
        if month > 12:
            month, year = 1, year + 1
    return payroll_period_range(year, month, payday)


def _dashboard_manager(db, today, include_money=True, can_decide=True):
    """Everything the branch view needs: who's in today, what's waiting on
    a decision, where the cutoff stands, and anything worth a second look.

    include_money=False drops the cutoff figures and the cash-advance
    lines, so an outside viewer without payroll access still gets the
    at-a-glance branch view with no salary data in the payload at all."""
    cur = db.cursor()

    cur.execute(
        """SELECT staff.name, staff.category, schedule.shift_label, schedule.time_range
           FROM schedule JOIN staff ON staff.id = schedule.staff_id
           WHERE schedule.date = %s ORDER BY staff.id""",
        (today.isoformat(),),
    )
    on_duty = [
        {"name": r["name"], "category": r["category"], "label": r["shift_label"], "time_range": r["time_range"]}
        for r in cur.fetchall()
    ]
    working = {e["name"] for e in on_duty}
    roster = fetch_roster(cur)
    off_today = [s["name"] for s in roster if s["name"] not in working]

    pending = _leave_rows(cur, status="pending", limit=5)

    cutoff = None
    if include_money:
        start, end, pay_date = current_cutoff(today)
        payroll = compute_payroll(db, start, end, pay_date)
        cur.execute("SELECT COUNT(*) AS c FROM payroll_extras WHERE pay_date=%s", (pay_date.isoformat(),))
        cutoff = {
            "start": start.isoformat(),
            "end": end.isoformat(),
            "pay_date": pay_date.isoformat(),
            "net_total": round(sum(p["net_pay"] for p in payroll["staff"]), 2),
            "saved": cur.fetchone()["c"] > 0,
            "days_left": max(0, (end - today).days),
        }

    # --- anything worth a second look -------------------------------
    # The over/under-target lines quote the targets themselves, so they're
    # manager-only for the same reason the numbers are.
    attention = []
    show_targets = is_manager()
    month_start = today.replace(day=1)
    month_end = date(today.year, today.month, calendar.monthrange(today.year, today.month)[1])
    cur.execute(
        """SELECT staff.name, COUNT(*) AS days FROM schedule JOIN staff ON staff.id = schedule.staff_id
           WHERE schedule.date BETWEEN %s AND %s GROUP BY staff.name""",
        (month_start.isoformat(), month_end.isoformat()),
    )
    days_by_name = {r["name"]: r["days"] for r in cur.fetchall()}
    for s in roster if show_targets else []:
        target = s["target"]
        if not target:
            continue
        worked = days_by_name.get(s["name"], 0)
        # only flag a real gap, not the day-either-way the generator
        # openly trades away against the 6-day rest cap
        if worked > target + 1:
            attention.append({"tone": "warn", "text": f"{s['name']} is {worked - target} days over their {target}-day target"})
        elif worked < target - 1:
            attention.append({"tone": "warn", "text": f"{s['name']} is {target - worked} days under their {target}-day target"})

    balances = cash_advance_balances(cur) if include_money else {}
    if balances:
        cur.execute("SELECT id, name FROM staff")
        name_by_id = {r["id"]: r["name"] for r in cur.fetchall()}
        for staff_id, bal in balances.items():
            if bal["outstanding"] > 0:
                attention.append(
                    {"tone": "money", "text": f"{name_by_id.get(staff_id, '?')} has ₱{bal['outstanding']:,.2f} cash advance outstanding"}
                )

    next_month = month_end + timedelta(days=1)
    next_month_end = date(next_month.year, next_month.month, calendar.monthrange(next_month.year, next_month.month)[1])
    cur.execute(
        "SELECT COUNT(*) AS c FROM schedule WHERE date BETWEEN %s AND %s",
        (next_month.isoformat(), next_month_end.isoformat()),
    )
    if cur.fetchone()["c"] == 0:
        attention.append({"tone": "info", "text": f"{next_month.strftime('%B')} schedule not generated yet"})

    return {
        "on_duty": on_duty,
        "off_today": off_today,
        "pending_leave": pending,
        "can_decide": can_decide,
        "cutoff": cutoff,
        "attention": attention,
        "roster": hide_targets(roster),
        "days_by_name": days_by_name,
    }


def _dashboard_staff(db, staff_name, today):
    """The one question a staff member opens the app to answer - when am I
    next in - plus how the month is tracking."""
    cur = db.cursor()
    cur.execute("SELECT id, full_name, target, pto_entitlement FROM staff WHERE name=%s", (staff_name,))
    row = cur.fetchone()
    if row is None:
        return None
    staff_id = row["id"]

    week_end = today + timedelta(days=6)
    cur.execute(
        "SELECT date, shift_label, time_range FROM schedule WHERE staff_id=%s AND date BETWEEN %s AND %s ORDER BY date",
        (staff_id, today.isoformat(), week_end.isoformat()),
    )
    shifts = {r["date"]: r for r in cur.fetchall()}

    upcoming = []
    for i in range(7):
        d = today + timedelta(days=i)
        entry = shifts.get(d.isoformat())
        upcoming.append(
            {
                "date": d.isoformat(),
                "weekday_short": d.strftime("%a").upper(),
                "day_num": d.day,
                "month_short": d.strftime("%b").upper(),
                "label": entry["shift_label"] if entry else "Off",
                "time_range": entry["time_range"] if entry else None,
            }
        )

    next_shift = next((u for u in upcoming if u["label"] != "Off"), None)
    if next_shift:
        days_away = (date.fromisoformat(next_shift["date"]) - today).days
        next_shift = {
            **next_shift,
            "when": "Today" if days_away == 0 else "Tomorrow" if days_away == 1
            else date.fromisoformat(next_shift["date"]).strftime("%A"),
        }

    month_start = today.replace(day=1)
    month_end = date(today.year, today.month, calendar.monthrange(today.year, today.month)[1])
    cur.execute(
        "SELECT COUNT(*) AS c FROM schedule WHERE staff_id=%s AND date BETWEEN %s AND %s",
        (staff_id, month_start.isoformat(), month_end.isoformat()),
    )
    days_worked = cur.fetchone()["c"]

    entitlement = row["pto_entitlement"] or 0
    cur.execute(
        "SELECT COUNT(*) AS c FROM schedule WHERE staff_id=%s AND shift_label='Paid Time Off' AND date LIKE %s",
        (staff_id, f"{today.year}-%"),
    )
    pto_used = cur.fetchone()["c"]

    return {
        "full_name": row["full_name"],
        "next_shift": next_shift,
        "upcoming": upcoming,
        "days_worked": days_worked,
        # even their own target is management information - the card just
        # reads "21 days" for staff
        "target": row["target"] if is_manager() else None,
        "pto_entitlement": entitlement,
        "pto_available": entitlement - pto_used,
    }


@app.route("/api/dashboard")
@login_required
def api_dashboard():
    today = date.today()
    db = get_db()
    # managers run the branch; outside viewers (co-owners) get the same
    # at-a-glance view read-only, with money gated separately
    show_branch = is_manager() or is_outside_viewer()
    payload = {
        "today": today.isoformat(),
        # built by hand rather than strftime("%-d") - that's a glibc
        # extension and this runs on Windows locally, Linux on Fly
        "today_label": f"{today.strftime('%A')}, {today.day} {today.strftime('%B %Y')}",
        "is_manager": is_manager(),
        "manager": _dashboard_manager(
            db, today, include_money=can_view_payroll(), can_decide=is_manager()
        ) if show_branch else None,
        "staff": _dashboard_staff(db, session["staff_name"], today) if session.get("staff_name") else None,
    }
    return jsonify(payload)


# ---------------------------------------------------------------------------
# Admin - login accounts for people who aren't staff
# ---------------------------------------------------------------------------
def _outside_account_rows(cur):
    cur.execute(
        """SELECT id, display_name, login_enabled, can_view_payroll, note, created_at,
                  (pin_hash IS NOT NULL) AS has_pin, locked_until
           FROM app_users
           WHERE staff_name IS NULL AND NOT is_superuser
           ORDER BY display_name"""
    )
    return [
        {
            "id": r["id"],
            "display_name": r["display_name"],
            "login_enabled": r["login_enabled"],
            "can_view_payroll": r["can_view_payroll"],
            "note": r["note"],
            "has_pin": r["has_pin"],
            "locked": bool(r["locked_until"] and r["locked_until"] > datetime.now()),
            "created_at": r["created_at"].isoformat(),
        }
        for r in cur.fetchall()
    ]


@app.route("/api/admin/users")
@superuser_required
def api_admin_users():
    return jsonify({"users": _outside_account_rows(get_db().cursor())})


@app.route("/api/admin/users", methods=["POST"])
@superuser_required
def api_admin_create_user():
    """Creates a read-only account for someone who isn't on the payroll.
    Deliberately cannot create another superuser or link to a staff
    record - staff logins are managed from their Employees card."""
    data = request.get_json(force=True)
    display_name = (data.get("display_name") or "").strip()
    pin = data.get("pin") or ""

    if not display_name:
        return jsonify({"status": "error", "message": "Name is required"}), 400
    if len(display_name) > 40:
        return jsonify({"status": "error", "message": "Name must be 40 characters or fewer"}), 400
    if len(pin) < 4:
        return jsonify({"status": "error", "message": "PIN must be at least 4 characters"}), 400

    db = get_db()
    cur = db.cursor()
    # the login page lists people by display name, so two accounts sharing
    # one would be indistinguishable at the point of signing in
    cur.execute("SELECT 1 FROM app_users WHERE LOWER(display_name)=LOWER(%s)", (display_name,))
    if cur.fetchone():
        return jsonify({"status": "error", "message": f"There's already an account named '{display_name}'"}), 400

    can_view_payroll_flag = bool(data.get("can_view_payroll"))
    cur.execute(
        """INSERT INTO app_users (staff_name, display_name, is_superuser, login_enabled, pin_hash,
                                  can_view_payroll, note)
           VALUES (NULL, %s, FALSE, TRUE, %s, %s, %s)""",
        (display_name, generate_password_hash(pin), can_view_payroll_flag, (data.get("note") or "").strip() or None),
    )
    record_audit(cur, "Added outside account", display_name, {"can_view_payroll": can_view_payroll_flag})
    db.commit()
    return jsonify({"status": "ok"})


@app.route("/api/admin/users/<int:user_id>", methods=["POST"])
@superuser_required
def api_admin_update_user(user_id):
    data = request.get_json(force=True)
    db = get_db()
    cur = db.cursor()
    cur.execute(
        "SELECT id, display_name, login_enabled, can_view_payroll FROM app_users "
        "WHERE id=%s AND staff_name IS NULL AND NOT is_superuser",
        (user_id,),
    )
    row = cur.fetchone()
    if row is None:
        return jsonify({"status": "error", "message": "Account not found"}), 404

    changes = {}
    if "login_enabled" in data:
        value = bool(data["login_enabled"])
        if value != row["login_enabled"]:
            changes["login_enabled"] = {"from": row["login_enabled"], "to": value}
        cur.execute("UPDATE app_users SET login_enabled=%s WHERE id=%s", (value, user_id))
    if "can_view_payroll" in data:
        value = bool(data["can_view_payroll"])
        if value != row["can_view_payroll"]:
            changes["can_view_payroll"] = {"from": row["can_view_payroll"], "to": value}
        cur.execute("UPDATE app_users SET can_view_payroll=%s WHERE id=%s", (value, user_id))
    if "note" in data:
        cur.execute("UPDATE app_users SET note=%s WHERE id=%s", ((data.get("note") or "").strip() or None, user_id))

    pin = data.get("pin")
    if pin:
        if len(pin) < 4:
            return jsonify({"status": "error", "message": "PIN must be at least 4 characters"}), 400
        # resetting the PIN also clears a lockout - that's usually why
        # you're resetting it
        cur.execute(
            "UPDATE app_users SET pin_hash=%s, failed_attempts=0, locked_until=NULL WHERE id=%s",
            (generate_password_hash(pin), user_id),
        )
        changes["pin_changed"] = True

    if changes:
        record_audit(cur, "Updated outside account", row["display_name"], changes)
    db.commit()
    return jsonify({"status": "ok"})


@app.route("/api/admin/users/<int:user_id>", methods=["DELETE"])
@superuser_required
def api_admin_delete_user(user_id):
    db = get_db()
    cur = db.cursor()
    cur.execute(
        "SELECT display_name FROM app_users WHERE id=%s AND staff_name IS NULL AND NOT is_superuser",
        (user_id,),
    )
    row = cur.fetchone()
    if row is None:
        return jsonify({"status": "error", "message": "Account not found"}), 404
    cur.execute("DELETE FROM app_users WHERE id=%s", (user_id,))
    record_audit(cur, "Deleted outside account", row["display_name"])
    db.commit()
    return jsonify({"status": "ok"})


@app.route("/api/audit-log")
@superuser_required
def api_audit_log():
    """Reverse-chronological change history. Superuser only: it spans
    everyone's pay figures and login changes, including the managers'."""
    limit = min(int(request.args.get("limit") or 100), 500)
    actor = request.args.get("actor") or None
    search = request.args.get("q") or None

    sql = "SELECT id, at, actor, action, target, details FROM audit_log"
    clauses, params = [], []
    if actor:
        clauses.append("actor = %s")
        params.append(actor)
    if search:
        clauses.append("(action ILIKE %s OR target ILIKE %s)")
        params.extend([f"%{search}%", f"%{search}%"])
    if clauses:
        sql += " WHERE " + " AND ".join(clauses)
    sql += " ORDER BY at DESC, id DESC LIMIT %s"
    params.append(limit)

    db = get_db()
    cur = db.cursor()
    cur.execute(sql, params)
    entries = [
        {
            "id": r["id"],
            "at": r["at"].isoformat(),
            "actor": r["actor"],
            "action": r["action"],
            "target": r["target"],
            "details": r["details"],
        }
        for r in cur.fetchall()
    ]
    cur.execute("SELECT DISTINCT actor FROM audit_log ORDER BY actor")
    return jsonify({"entries": entries, "actors": [r["actor"] for r in cur.fetchall()]})


@app.route("/api/schedule/snapshots")
@login_required
def api_list_snapshots():
    year = int(request.args.get("year"))
    month = int(request.args.get("month"))
    db = get_db()
    cur = db.cursor()
    cur.execute(
        "SELECT id, label, created_at FROM schedule_snapshots WHERE year=%s AND month=%s ORDER BY created_at DESC",
        (year, month),
    )
    snapshots = [{"id": r["id"], "label": r["label"], "created_at": r["created_at"].isoformat()} for r in cur.fetchall()]
    return jsonify({"snapshots": snapshots})


@app.route("/api/schedule/snapshot", methods=["POST"])
@superuser_required
def api_create_snapshot():
    data = request.get_json(force=True)
    year = int(data.get("year"))
    month = int(data.get("month"))
    first_day = date(year, month, 1)
    last_day = date(year, month, calendar.monthrange(year, month)[1])

    db = get_db()
    cur = db.cursor()
    cur.execute(
        """SELECT staff.name, schedule.date, schedule.shift_label, schedule.time_range, schedule.detail
           FROM schedule JOIN staff ON schedule.staff_id = staff.id
           WHERE schedule.date BETWEEN %s AND %s
           ORDER BY schedule.date""",
        (first_day.isoformat(), last_day.isoformat()),
    )
    rows = [dict(r) for r in cur.fetchall()]
    if not rows:
        return jsonify({"status": "error", "message": "Nothing to snapshot - that month has no saved schedule yet"}), 400

    label = datetime.now().strftime("snapshot-%m-%d-%Y-%H-%M-%S")
    cur.execute(
        "INSERT INTO schedule_snapshots (year, month, label, data) VALUES (%s,%s,%s,%s) RETURNING id, label, created_at",
        (year, month, label, Json(rows)),
    )
    result = cur.fetchone()
    record_audit(cur, "Saved snapshot", f"{year}-{month:02d}", {"label": result["label"]})
    db.commit()
    return jsonify({"status": "ok", "id": result["id"], "label": result["label"]})


@app.route("/api/schedule/snapshot/<int:snapshot_id>/restore", methods=["POST"])
@superuser_required
def api_restore_snapshot(snapshot_id):
    db = get_db()
    cur = db.cursor()
    cur.execute("SELECT year, month, data FROM schedule_snapshots WHERE id=%s", (snapshot_id,))
    snap = cur.fetchone()
    if snap is None:
        return jsonify({"status": "error", "message": "Snapshot not found"}), 404

    year, month, rows = snap["year"], snap["month"], snap["data"]
    first_day = date(year, month, 1)
    last_day = date(year, month, calendar.monthrange(year, month)[1])

    cur.execute("SELECT id, name FROM staff")
    staff_id_by_name = {r["name"]: r["id"] for r in cur.fetchall()}

    cur.execute("DELETE FROM schedule WHERE date BETWEEN %s AND %s", (first_day.isoformat(), last_day.isoformat()))
    for row in rows:
        staff_id = staff_id_by_name.get(row["name"])
        if staff_id is None:
            continue  # staff member no longer exists - skip their entry
        cur.execute(
            "INSERT INTO schedule (staff_id, date, shift_label, time_range, detail) VALUES (%s,%s,%s,%s,%s)",
            (staff_id, row["date"], row["shift_label"], row["time_range"], row["detail"]),
        )
    record_schedule_edit(cur, year, month, "Restored a snapshot")
    record_audit(cur, "Restored snapshot", f"{year}-{month:02d}", {"snapshot_id": snapshot_id})
    db.commit()
    return jsonify({"status": "ok", "year": year, "month": month})


@app.route("/api/schedule/entry", methods=["POST"])
@manager_required
def api_update_entry():
    """Manually reassign a single person's shift on a single day (e.g. via
    the edit dropdown in the table). label="Off" clears the assignment."""
    data = request.get_json(force=True)
    name = data.get("name")
    date_str = data.get("date")
    label = data.get("label")

    staff_by_name = roster_by_name(include_archived=False)
    if name not in staff_by_name:
        return jsonify({"status": "error", "message": "Unknown or archived staff member"}), 400

    try:
        entry_date = date.fromisoformat(date_str)
    except (TypeError, ValueError):
        return jsonify({"status": "error", "message": "Invalid date"}), 400

    category = staff_by_name[name]["category"]
    valid_labels = EDITABLE_OPTIONS.get(category, ["Off"])
    if label not in valid_labels:
        return jsonify({"status": "error", "message": f"'{label}' isn't valid for {name}"}), 400

    db = get_db()
    cur = db.cursor()
    cur.execute("SELECT id FROM staff WHERE name=%s", (name,))
    staff_id = cur.fetchone()["id"]

    cur.execute("SELECT shift_label FROM schedule WHERE staff_id=%s AND date=%s", (staff_id, date_str))
    prev_row = cur.fetchone()
    previous_label = prev_row["shift_label"] if prev_row else "Off"

    cur.execute("DELETE FROM schedule WHERE staff_id=%s AND date=%s", (staff_id, date_str))
    time_range = None
    if label != "Off":
        time_range = SHIFT_TIME_RANGES[label]
        cur.execute(
            "INSERT INTO schedule (staff_id, date, shift_label, time_range, detail) VALUES (%s,%s,%s,%s,%s)",
            (staff_id, date_str, label, time_range, None),
        )
    action = f"Edited {name}'s {entry_date.strftime('%b')} {entry_date.day} shift"
    record_schedule_edit(cur, entry_date.year, entry_date.month, action)
    record_audit(cur, "Edited shift", f"{name} · {date_str}", {"from": previous_label, "to": label})
    db.commit()
    return jsonify({"status": "ok", "label": label, "time_range": time_range})


@app.route("/api/schedule")
@login_required
def api_schedule():
    year = int(request.args.get("year"))
    month = int(request.args.get("month"))
    db = get_db()
    month_roster = roster_for_month(db, year, month)
    names = [s["name"] for s in month_roster]
    days = fetch_schedule_days(db, year, month, names)
    staff_counts = compute_staff_counts(days, names)
    return jsonify(
        {
            "days": days,
            "staff_counts": staff_counts,
            "staff": hide_targets(month_roster),
            "last_edited": fetch_schedule_edit(db.cursor(), year, month),
        }
    )


@app.route("/api/has-schedule")
@login_required
def api_has_schedule():
    year = int(request.args.get("year"))
    month = int(request.args.get("month"))
    first_day = date(year, month, 1)
    last_day_num = calendar.monthrange(year, month)[1]
    last_day = date(year, month, last_day_num)
    db = get_db()
    cur = db.cursor()
    cur.execute(
        "SELECT COUNT(*) as c FROM schedule WHERE date BETWEEN %s AND %s",
        (first_day.isoformat(), last_day.isoformat()),
    )
    exists = cur.fetchone()["c"] > 0
    return jsonify({"exists": exists})


@app.route("/api/payroll")
@payroll_view_required
def api_payroll():
    year = int(request.args.get("year"))
    month = int(request.args.get("month"))
    payday = int(request.args.get("payday"))
    if payday not in (10, 25):
        return jsonify({"status": "error", "message": "payday must be 10 or 25"}), 400
    start, end, pay_date = payroll_period_range(year, month, payday)
    db = get_db()
    return jsonify(compute_payroll(db, start, end, pay_date))


@app.route("/api/payroll/13th-month")
@payroll_view_required
def api_thirteenth_month():
    year = int(request.args.get("year") or date.today().year)
    db = get_db()
    return jsonify(compute_thirteenth_month(db, year))


@app.route("/api/payroll/save", methods=["POST"])
@superuser_required
def api_payroll_save():
    data = request.get_json(force=True)
    pay_date = data.get("pay_date")
    try:
        date.fromisoformat(pay_date)
    except (TypeError, ValueError):
        return jsonify({"status": "error", "message": "Invalid pay_date"}), 400

    db = get_db()
    cur = db.cursor()

    # snapshot the figures already saved for this cutoff so the audit
    # entry can show which numbers moved - payroll is the place where
    # "who changed this and what was it before?" actually matters
    cur.execute(
        """SELECT staff.name, ot_hours, sss, pagibig, philhealth, hmo, error_deduction,
                  cash_advance, manual_bonus
           FROM payroll_extras JOIN staff ON staff.id = payroll_extras.staff_id
           WHERE pay_date=%s""",
        (pay_date,),
    )
    before_by_name = {r["name"]: {k: v for k, v in dict(r).items() if k != "name"} for r in cur.fetchall()}

    for row in data.get("cup_counts", []):
        cur.execute(
            "INSERT INTO cup_counts (date, quantity) VALUES (%s, %s) "
            "ON CONFLICT(date) DO UPDATE SET quantity=excluded.quantity",
            (row.get("date"), int(row.get("quantity") or 0)),
        )

    PAYROLL_FIELDS = (
        "ot_hours", "sss", "pagibig", "philhealth", "hmo",
        "error_deduction", "cash_advance", "manual_bonus",
    )
    changes = {}

    staff_by_name = roster_by_name()
    for row in data.get("staff", []):
        name = row.get("name")
        if name not in staff_by_name:
            continue

        before = before_by_name.get(name, {f: 0 for f in PAYROLL_FIELDS})
        person_changes = {}
        for field in PAYROLL_FIELDS:
            was, now = float(before.get(field) or 0), float(row.get(field) or 0)
            if was != now:
                person_changes[field] = {"from": was, "to": now}
        if person_changes:
            changes[name] = person_changes

        cur.execute("SELECT id FROM staff WHERE name=%s", (name,))
        staff_id = cur.fetchone()["id"]
        cur.execute(
            """INSERT INTO payroll_extras (staff_id, pay_date, ot_hours, sss, pagibig, philhealth, hmo, error_deduction, cash_advance, manual_bonus)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
               ON CONFLICT(staff_id, pay_date) DO UPDATE SET
                 ot_hours=excluded.ot_hours, sss=excluded.sss, pagibig=excluded.pagibig,
                 philhealth=excluded.philhealth, hmo=excluded.hmo, error_deduction=excluded.error_deduction,
                 cash_advance=excluded.cash_advance, manual_bonus=excluded.manual_bonus""",
            (
                staff_id,
                pay_date,
                float(row.get("ot_hours") or 0),
                float(row.get("sss") or 0),
                float(row.get("pagibig") or 0),
                float(row.get("philhealth") or 0),
                float(row.get("hmo") or 0),
                float(row.get("error_deduction") or 0),
                float(row.get("cash_advance") or 0),
                float(row.get("manual_bonus") or 0),
            ),
        )

    record_audit(
        cur,
        "Saved payroll",
        f"pay date {pay_date}",
        changes or {"note": "no figures changed"},
    )
    db.commit()
    return jsonify({"status": "ok"})


@app.route("/api/payroll/pdf")
@superuser_required
def api_payroll_pdf():
    year = int(request.args.get("year"))
    month = int(request.args.get("month"))
    payday = int(request.args.get("payday"))
    if payday not in (10, 25):
        return jsonify({"status": "error", "message": "payday must be 10 or 25"}), 400
    start, end, pay_date = payroll_period_range(year, month, payday)
    db = get_db()
    payroll = compute_payroll(db, start, end, pay_date)

    from payroll_pdf import build_payroll_pdf

    period_label = f"{start.strftime('%b %d')} - {end.strftime('%b %d, %Y')}"
    pay_date_label = pay_date.strftime("%B %d, %Y")
    pdf_bytes = build_payroll_pdf(BUSINESS_NAME, period_label, pay_date_label, payroll["staff"], OT_HOURLY_RATE)

    from flask import Response

    filename = f"payslips-{pay_date.isoformat()}.pdf"
    return Response(
        pdf_bytes,
        mimetype="application/pdf",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


def _chunk_days_for_pdf(days, year, month, chunk_size=PDF_DAYS_PER_PAGE, max_chunk_size=PDF_MAX_DAYS_PER_PAGE):
    """Split days into print-page chunks. Precomputes each day's
    entries_by_name (so the template can do a plain dict lookup per
    staff member) and a human-readable date-range label per chunk.

    A trailing chunk that would otherwise be tiny (e.g. day 31 alone)
    is merged into the previous page instead, up to max_chunk_size."""
    chunks = []
    i, n = 0, len(days)
    while i < n:
        size = n - i if n - i <= max_chunk_size else chunk_size
        chunk_days = days[i : i + size]
        i += size
        for d in chunk_days:
            d["entries_by_name"] = {e["name"]: e for e in d["entries"]}
        first_date = date(year, month, chunk_days[0]["day_num"])
        last_date = date(year, month, chunk_days[-1]["day_num"])
        if first_date == last_date:
            range_label = first_date.strftime("%b %d, %Y")
        else:
            range_label = f"{first_date.strftime('%b %d')} - {last_date.strftime('%b %d, %Y')}"
        chunks.append({"days": chunk_days, "range_label": range_label})
    return chunks


@app.route("/api/schedule/pdf")
@login_required
def api_schedule_pdf():
    year = int(request.args.get("year"))
    month = int(request.args.get("month"))
    db = get_db()
    month_roster = roster_for_month(db, year, month)
    days = fetch_schedule_days(db, year, month, [s["name"] for s in month_roster])

    month_name = date(year, month, 1).strftime("%B %Y")
    day_chunks = _chunk_days_for_pdf(days, year, month)

    html = render_template(
        "print_schedule.html",
        business_name=BUSINESS_NAME,
        month_name=month_name,
        staff=month_roster,
        day_chunks=day_chunks,
        chip_classes=CHIP_CLASSES,
    )

    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": PDF_VIEWPORT_WIDTH, "height": PDF_VIEWPORT_HEIGHT})
        page.set_content(html, wait_until="networkidle")
        page.emulate_media(media="screen")  # sidesteps print stylesheet quirks (e.g. background suppression)
        page.wait_for_timeout(200)
        pdf_bytes = page.pdf(
            format="A4",
            landscape=True,
            print_background=True,
            scale=PDF_SCALE,
            margin={"top": "0mm", "bottom": "0mm", "left": "0mm", "right": "0mm"},
        )
        browser.close()

    from flask import Response

    filename = f"duty-roster-{year}-{month:02d}.pdf"
    return Response(
        pdf_bytes,
        mimetype="application/pdf",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


init_db()

if __name__ == "__main__":
    app.run(debug=True, port=int(os.environ.get("PORT", 5000)))
