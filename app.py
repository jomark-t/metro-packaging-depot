"""
Staff Scheduler - a small local web app that auto-generates a monthly
duty schedule for a 6-person retail/café team and stores it in Postgres.

Run with:  python app.py
Then open: http://127.0.0.1:5000
"""

import calendar
import os
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

app = Flask(__name__)
app.secret_key = SECRET_KEY
app.config["MAX_CONTENT_LENGTH"] = 5 * 1024 * 1024  # 5MB upload cap
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
app.config["SESSION_COOKIE_SECURE"] = not app.debug  # HTTPS-only in production (Fly), plain HTTP ok for local dev

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

STAFF_ORDER = [s["name"] for s in STAFF]

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
            UNIQUE(staff_id, pay_date)
        )"""
    )
    cur.execute("ALTER TABLE payroll_extras ADD COLUMN IF NOT EXISTS cash_advance REAL NOT NULL DEFAULT 0")
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
# Scheduling algorithm
# ---------------------------------------------------------------------------
# Weekday numbers used throughout (Python's date.weekday()):
#   Mon=0, Tue=1, Wed=2, Thu=3, Fri=4, Sat=5, Sun=6
#
# Store hours:  Mon-Sat 8:00am-8:00pm | Sun 8:00am-5:00pm
# Sales shifts: Opening 8:00am-5:00pm | Closing 11:00am-8:00pm
# Machine ops:  fixed 9:00am-6:00pm, Mon-Fri only
#
# Jha (part-time) is a permanent Wednesday + Friday assist helper, plus
# most Sundays (she keeps at least 2 Sundays off a month to rest):
#   Wed  8:00am-5:00pm  assist only - doesn't replace the Opening/Closing shift
#   Fri  8:00am-12:00pm assist only - doesn't replace a full shift
#   Sun  8:00am-5:00pm  one of the two guaranteed Sunday Opening slots
#
# Sundays always run 2 people on Opening (8-5). The 1st Sunday of the
# month is inventory day - all 6 staff work.
def compute_machine_roles(days):
    """Weekly (Mon-Fri) printer/checker split: whoever is 'heavy' that
    week gets 3 printer days + 2 checker days, the other gets the
    reverse. The heavy role alternates between Macky/Joshua week to
    week, biased toward whoever has fewer cumulative printer days so
    far, so it balances out over the month."""
    weeks = {}
    for d in days:
        if d.weekday() <= 4:
            key = d.isocalendar()[:2]  # (iso_year, iso_week)
            weeks.setdefault(key, []).append(d)

    role_map = {}
    cumulative_printer = {"Macky": 0, "Joshua": 0}
    prev_heavy = None
    for key in sorted(weeks.keys()):
        week_days = sorted(weeks[key])
        n = len(week_days)
        if cumulative_printer["Macky"] < cumulative_printer["Joshua"]:
            heavy = "Macky"
        elif cumulative_printer["Joshua"] < cumulative_printer["Macky"]:
            heavy = "Joshua"
        else:
            heavy = "Joshua" if prev_heavy == "Macky" else "Macky"
        light = "Joshua" if heavy == "Macky" else "Macky"
        prev_heavy = heavy

        printer_days = 3 if n >= 5 else max(1, round(n * 3 / 5))
        printer_days = min(printer_days, n)

        for i, d in enumerate(week_days):
            if i < printer_days:
                role_map[d] = {heavy: "Printer", light: "Checker"}
            else:
                role_map[d] = {heavy: "Checker", light: "Printer"}
        cumulative_printer[heavy] += printer_days
        cumulative_printer[light] += n - printer_days
    return role_map


def generate_schedule(year, month):
    db = psycopg2.connect(DATABASE_URL, cursor_factory=RealDictCursor)
    cur = db.cursor()

    cur.execute("SELECT id, name, target FROM staff")
    staff_rows = {r["name"]: {"id": r["id"], "target": r["target"]} for r in cur.fetchall()}

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

    # Jha rests at least 2 Sundays a month (spread out, excludes inventory Sunday)
    if len(other_sundays) >= 4:
        jha_off_sundays = {other_sundays[1], other_sundays[3]}
    elif len(other_sundays) == 3:
        jha_off_sundays = {other_sundays[1], other_sundays[2]}
    else:
        jha_off_sundays = set(other_sundays)  # 0-2 sundays: off all of them

    machine_role_map = compute_machine_roles(days)

    # 2nd Wednesday of the month is a guaranteed all-hands day (Macky, Joshua
    # and Jha already work every Wednesday, so forcing Clare/Jem/Von in too
    # means literally everyone is on duty that day)
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
        for name in STAFF_ORDER:
            add(first_sunday, name, "Inventory", SHIFT_TIME_RANGES["Inventory"])

    # --- Pass A: fixed assignments (machine operators + Jha) ---------
    for d in days:
        if d == first_sunday:
            continue
        wd = d.weekday()

        if wd <= 4:  # Mon-Fri: machine operators
            roles = machine_role_map[d]
            add(d, "Macky", roles["Macky"], SHIFT_TIME_RANGES[roles["Macky"]])
            add(d, "Joshua", roles["Joshua"], SHIFT_TIME_RANGES[roles["Joshua"]])

        if wd == 2:  # Wednesday - covers the Opening slot
            add(d, "Jha", "Opening", SHIFT_TIME_RANGES["Opening"])
        elif wd == 4:  # Friday - assist only, doesn't cover a slot
            add(d, "Jha", "Assist", SHIFT_TIME_RANGES["Assist"])
        elif wd == 6 and d not in jha_off_sundays:  # Sunday - one of two Opening slots
            add(d, "Jha", "Opening", SHIFT_TIME_RANGES["Opening"])

    # --- Pass A2: Clare (Branch Manager) - fixed Mon-Sat, Sunday off ---
    # She alternates Opening/Closing a full week at a time rather than
    # day-to-day, and the alternation continues seamlessly across month
    # boundaries (whichever phase her last Opening/Closing day was in
    # carries forward) instead of resetting every time a month is
    # (re)generated. The day after each month's inventory Sunday (which
    # she works, like everyone else) is an automatic rest day in lieu of
    # her usual Sunday off.
    def _week_monday(d):
        return d - timedelta(days=d.weekday())

    cur.execute(
        """SELECT schedule.date, schedule.shift_label FROM schedule
           JOIN staff ON schedule.staff_id = staff.id
           WHERE staff.name = %s AND schedule.shift_label IN ('Opening', 'Closing') AND schedule.date < %s
           ORDER BY schedule.date DESC LIMIT 1""",
        ("Clare", first_day.isoformat()),
    )
    ref_row = cur.fetchone()
    if ref_row is not None:
        ref_date = date.fromisoformat(ref_row["date"])
        clare_ref_monday = _week_monday(ref_date)
        clare_ref_phase = ref_row["shift_label"]
    else:
        clare_ref_monday = _week_monday(first_day)
        clare_ref_phase = "Opening"

    def clare_phase_for(d):
        weeks_diff = (_week_monday(d) - clare_ref_monday).days // 7
        if weeks_diff % 2 == 0:
            return clare_ref_phase
        return "Closing" if clare_ref_phase == "Opening" else "Opening"

    clare_comp_off = set()
    if first_sunday is not None:
        comp_monday = first_sunday + timedelta(days=1)
        if comp_monday in assignments:
            clare_comp_off.add(comp_monday)

    clare_shift_by_date = {}
    for d in days:
        if d.weekday() == 6 or d in clare_comp_off:
            continue
        phase = clare_phase_for(d)
        clare_shift_by_date[d] = phase
        add(d, "Clare", phase, SHIFT_TIME_RANGES[phase])

    # --- Pass B: fill Jem/Von, biasing toward 2-day-off blocks,
    #             capping consecutive work days at 6, spreading overlap
    #             days across the month, and keeping each person on
    #             blocks of the same shift type (max 4 days) instead of
    #             flipping Opening/Closing day to day ------------------
    OPEN = ("Opening", SHIFT_TIME_RANGES["Opening"])
    CLOSE = ("Closing", SHIFT_TIME_RANGES["Closing"])
    MAX_CONSECUTIVE_DAYS = 6
    MAX_SAME_TYPE_STREAK = 4

    def day_requirement(d):
        """Shift labels Jem/Von must fill that day. Clare (fixed Mon-Sat
        schedule) already structurally covers whichever of Opening/Closing
        her current weekly phase is, so that slot is subtracted here -
        she isn't part of the flexible names3 pool anymore."""
        wd = d.weekday()
        if wd == 6:  # Sunday: 2 people total on Opening (Clare doesn't work Sundays)
            return [OPEN] if d not in jha_off_sundays else [OPEN, OPEN]
        if wd == 2:  # Wednesday: Jha already covers Opening
            base = [CLOSE]
        else:
            base = [OPEN, CLOSE]
        clare_phase = clare_shift_by_date.get(d)
        if clare_phase is not None:
            clare_slot = OPEN if clare_phase == "Opening" else CLOSE
            if clare_slot in base:
                base = [lbl for lbl in base if lbl != clare_slot]
        return base

    names3 = ["Jem", "Von"]
    targets = {n: staff_rows[n]["target"] for n in names3}
    off_needed = {n: max(0, last_day_num - targets[n]) for n in names3}
    consecutive_worked = {n: 0 for n in names3}
    shift_state = {n: {"type": None, "streak": 0} for n in names3}

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
            for n in names3:
                consecutive_worked[n] += 1
                shift_state[n] = {"type": None, "streak": 0}
            continue
        required = day_requirement(d)
        allowed_off = len(names3) - len(required)
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
        mandatory = [n for n in names3 if consecutive_worked[n] >= cap_today]
        mandatory.sort(key=lambda n: consecutive_worked[n], reverse=True)

        # rare edge case: two people both hit the cap the same Sunday Jha was
        # due to rest - pull her in as backup so both can actually rest
        if (
            len(mandatory) > allowed_off
            and d.weekday() == 6
            and d in jha_off_sundays
            and not any(a["name"] == "Jha" for a in assignments[d])
        ):
            add(d, "Jha", "Opening", SHIFT_TIME_RANGES["Opening"])
            required = required[1:]  # Jha now covers one Opening slot
            allowed_off = len(names3) - len(required)

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
            candidates = [n for n in names3 if n not in offs_today and off_needed[n] > 0]
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
                candidates = [n for n in names3 if n not in offs_today]
                if not candidates:
                    break
                candidates.sort(key=lambda n: off_needed[n], reverse=True)
                chosen = candidates[0]
                offs_today.append(chosen)
                off_needed[chosen] -= 1

        working_today = [n for n in names3 if n not in offs_today]

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
    # (Off, Work, Off) for the 2-person Jem/Von pool. Best-effort, single
    # forward pass, checked per-person (a lone work day can be isolated
    # even on a day the other person also happens to work - an overlap
    # day): a solo isolated day gets swapped to the other person, an
    # isolated day that's part of an overlap just gets dropped (the other
    # person already covers real duty that day). Either way, only applied
    # while the person losing the day is still within SANDWICH_FIX_TOLERANCE
    # days of their monthly target - fixing sandwiches shouldn't come at
    # the cost of meaningfully undershooting someone's quota (and pay).
    SANDWICH_FIX_TOLERANCE = 1
    if len(names3) == 2:
        a, b = names3

        def _entry_for(d, name):
            return next((e for e in assignments[d] if e["name"] == name), None)

        def _works(d, name):
            e = _entry_for(d, name)
            return e is not None and e["label"] in ("Opening", "Closing")

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

            def _isolated(name):
                return (
                    _works(d, name)
                    and (prev_d is None or not _works(prev_d, name))
                    and (next_d is None or not _works(next_d, name))
                )

            a_isolated, b_isolated = _isolated(a), _isolated(b)
            if not a_isolated and not b_isolated:
                continue
            if a_isolated and b_isolated:
                continue  # both isolated the same day (rare) - no clean fix

            worker, other = (a, b) if a_isolated else (b, a)
            if off_needed[worker] < -SANDWICH_FIX_TOLERANCE:
                continue  # worker has no target slack left to give up this day

            if _works(d, other):
                # overlap day: `other` already covers real duty here, so
                # worker's presence was just extra coverage - drop it
                assignments[d] = [e for e in assignments[d] if e["name"] != worker]
                off_needed[worker] -= 1
                continue

            other_isolated_after = (prev_d is None or not _works(prev_d, other)) and (
                next_d is None or not _works(next_d, other)
            )
            if other_isolated_after:
                continue  # would just move the sandwich onto the other person

            if _consecutive_run(other, i, -1) + 1 + _consecutive_run(other, i, 1) > MAX_CONSECUTIVE_DAYS:
                continue

            _entry_for(d, worker)["name"] = other
            off_needed[worker] -= 1

    # --- persist -------------------------------------------------------
    counts = {n: 0 for n in names3}
    for d in days:
        for a in assignments[d]:
            staff_id = staff_rows[a["name"]]["id"]
            cur.execute(
                "INSERT INTO schedule (staff_id, date, shift_label, time_range, detail) VALUES (%s,%s,%s,%s,%s)",
                (staff_id, d.isoformat(), a["label"], a["time_range"], a["detail"]),
            )
            if a["name"] in counts:
                counts[a["name"]] += 1
    db.commit()
    db.close()
    return counts


def fetch_schedule_days(db, year, month):
    """Returns the list of per-day schedule dicts for a given month."""
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
        off_names = [n for n in STAFF_ORDER if n not in working_names]
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
        "SELECT staff_id, ot_hours, sss, pagibig, philhealth, hmo, error_deduction, cash_advance FROM payroll_extras WHERE pay_date=%s",
        (pay_date.isoformat(),),
    )
    extras_by_staff = {r["staff_id"]: dict(r) for r in cur.fetchall()}

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
        extras = extras_by_staff.get(sid)
        if extras is not None:
            ot_hours = extras.get("ot_hours") or 0
            sss = extras.get("sss") or 0
            pagibig = extras.get("pagibig") or 0
            philhealth = extras.get("philhealth") or 0
            hmo = extras.get("hmo") or 0
            error_deduction = extras.get("error_deduction") or 0
            cash_advance = extras.get("cash_advance") or 0
        else:
            ot_hours = 0
            sss = s.get("default_sss") or 0
            pagibig = s.get("default_pagibig") or 0
            philhealth = s.get("default_philhealth") or 0
            hmo = s.get("default_hmo") or 0
            error_deduction = 0
            cash_advance = 0
        ot_pay = ot_hours * OT_HOURLY_RATE
        total_deductions = sss + pagibig + philhealth + hmo + error_deduction + cash_advance + absence_deduction
        net_pay = base_pay + ot_pay + bonus - total_deductions

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
                "has_bonus": s["category"] == "machine",
                "bonus": round(bonus, 2),
                "ot_hours": ot_hours,
                "ot_pay": round(ot_pay, 2),
                "sss": sss,
                "pagibig": pagibig,
                "philhealth": philhealth,
                "hmo": hmo,
                "error_deduction": error_deduction,
                "cash_advance": cash_advance,
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


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------
def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if "user_id" not in session:
            if request.path.startswith("/api/"):
                return jsonify({"status": "error", "message": "Login required"}), 401
            return redirect(url_for("login_page"))
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
    if "user_id" in session:
        return redirect(url_for("index"))

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
            session.permanent = True
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
    db.commit()
    return jsonify({"status": "ok"})


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
def compute_staff_counts(days):
    counts = {n: 0 for n in STAFF_ORDER}
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
        "staff_name": session.get("staff_name"),
    }
    return render_template(
        "index.html", staff=STAFF, business_name=BUSINESS_NAME, current_user=current_user
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
@login_required
def api_staff_list():
    db = get_db()
    cur = db.cursor()
    cur.execute(
        """SELECT staff.name, full_name, role, category, employment, target, daily_rate, monthly_salary, pto_entitlement,
                  address, phone, email, photo_filename, birthday,
                  default_sss, default_pagibig, default_philhealth, default_hmo,
                  sss_id, pagibig_id, philhealth_id, hmo_id,
                  bank_name, bank_account_name, bank_account_number,
                  COALESCE(app_users.login_enabled, FALSE) AS login_enabled,
                  (app_users.pin_hash IS NOT NULL) AS has_pin
           FROM staff
           LEFT JOIN app_users ON app_users.staff_name = staff.name
           ORDER BY staff.id"""
    )
    return jsonify({"staff": [dict(r) for r in cur.fetchall()]})


@app.route("/api/staff/<name>", methods=["POST"])
@login_required
def api_staff_update(name):
    staff_by_name = {s["name"]: s for s in STAFF}
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
        set_clause = ", ".join(f"{field}=%s" for field in updates)
        cur.execute(f"UPDATE staff SET {set_clause} WHERE id=%s", (*updates.values(), staff_id))
        db.commit()
    return jsonify({"status": "ok"})


@app.route("/api/staff/<name>/pto")
@login_required
def api_staff_pto(name):
    """Paid Time Off balance for one calendar year. Used dates aren't a
    separate record - they're just this person's existing schedule rows
    with shift_label='Paid Time Off', so the balance always matches
    whatever's actually on the schedule."""
    staff_by_name = {s["name"]: s for s in STAFF}
    if name not in staff_by_name:
        return jsonify({"status": "error", "message": "Unknown staff member"}), 400

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


@app.route("/api/staff/<name>/photo", methods=["POST"])
@login_required
def api_staff_photo(name):
    staff_by_name = {s["name"]: s for s in STAFF}
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
    db.commit()
    return jsonify({"status": "ok", "photo_filename": filename})


@app.route("/api/generate", methods=["POST"])
@superuser_required
def api_generate():
    data = request.get_json(force=True)
    year = int(data.get("year"))
    month = int(data.get("month"))
    counts = generate_schedule(year, month)
    return jsonify({"status": "ok", "counts": counts})


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
    db.commit()
    return jsonify({"status": "ok", "year": year, "month": month})


@app.route("/api/schedule/entry", methods=["POST"])
@login_required
def api_update_entry():
    """Manually reassign a single person's shift on a single day (e.g. via
    the edit dropdown in the table). label="Off" clears the assignment."""
    data = request.get_json(force=True)
    name = data.get("name")
    date_str = data.get("date")
    label = data.get("label")

    staff_by_name = {s["name"]: s for s in STAFF}
    if name not in staff_by_name:
        return jsonify({"status": "error", "message": "Unknown staff member"}), 400

    try:
        date.fromisoformat(date_str)
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

    cur.execute("DELETE FROM schedule WHERE staff_id=%s AND date=%s", (staff_id, date_str))
    time_range = None
    if label != "Off":
        time_range = SHIFT_TIME_RANGES[label]
        cur.execute(
            "INSERT INTO schedule (staff_id, date, shift_label, time_range, detail) VALUES (%s,%s,%s,%s,%s)",
            (staff_id, date_str, label, time_range, None),
        )
    db.commit()
    return jsonify({"status": "ok", "label": label, "time_range": time_range})


@app.route("/api/schedule")
@login_required
def api_schedule():
    year = int(request.args.get("year"))
    month = int(request.args.get("month"))
    db = get_db()
    days = fetch_schedule_days(db, year, month)
    staff_counts = compute_staff_counts(days)
    return jsonify({"days": days, "staff_counts": staff_counts, "staff": STAFF})


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
@login_required
def api_payroll():
    year = int(request.args.get("year"))
    month = int(request.args.get("month"))
    payday = int(request.args.get("payday"))
    if payday not in (10, 25):
        return jsonify({"status": "error", "message": "payday must be 10 or 25"}), 400
    start, end, pay_date = payroll_period_range(year, month, payday)
    db = get_db()
    return jsonify(compute_payroll(db, start, end, pay_date))


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

    for row in data.get("cup_counts", []):
        cur.execute(
            "INSERT INTO cup_counts (date, quantity) VALUES (%s, %s) "
            "ON CONFLICT(date) DO UPDATE SET quantity=excluded.quantity",
            (row.get("date"), int(row.get("quantity") or 0)),
        )

    staff_by_name = {s["name"]: s for s in STAFF}
    for row in data.get("staff", []):
        name = row.get("name")
        if name not in staff_by_name:
            continue
        cur.execute("SELECT id FROM staff WHERE name=%s", (name,))
        staff_id = cur.fetchone()["id"]
        cur.execute(
            """INSERT INTO payroll_extras (staff_id, pay_date, ot_hours, sss, pagibig, philhealth, hmo, error_deduction, cash_advance)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
               ON CONFLICT(staff_id, pay_date) DO UPDATE SET
                 ot_hours=excluded.ot_hours, sss=excluded.sss, pagibig=excluded.pagibig,
                 philhealth=excluded.philhealth, hmo=excluded.hmo, error_deduction=excluded.error_deduction,
                 cash_advance=excluded.cash_advance""",
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
            ),
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
    days = fetch_schedule_days(db, year, month)

    month_name = date(year, month, 1).strftime("%B %Y")
    day_chunks = _chunk_days_for_pdf(days, year, month)

    html = render_template(
        "print_schedule.html",
        business_name=BUSINESS_NAME,
        month_name=month_name,
        staff=STAFF,
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
