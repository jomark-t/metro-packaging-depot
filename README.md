# Metro Packaging Depot — Scheduling, Payroll & HRMS

A small web app for running a retail branch: it auto-generates the monthly
duty schedule, computes semi-monthly payroll from it, handles time-off
requests, and keeps employee records. Everything lives in Postgres — the
same database whether you're running it locally or on the live
deployment, so there's one source of truth.

## Setup

Requires Python 3.9+ and a Postgres connection string (see **Database**
below — the whole team, local or deployed, points at the same database).

```bash
cd staff-scheduler
pip install -r requirements.txt
python -m playwright install chromium
cp .env.example .env   # then fill in DATABASE_URL and SECRET_KEY
python app.py
```

The `playwright install chromium` step is a one-time download (~150-300MB)
of a headless Chromium browser — it's used to render the schedule PDF so
it comes out pixel-identical to the on-screen table (see below).

Then open **http://127.0.0.1:5000** in your browser.

On the very first run against an empty database the console prints a
generated PIN for the superuser account. Log in with it, then change it
from the Employees tab. That message never appears again.

## Database

The app stores everything (schedules, payroll, employee records) in
Postgres via the `DATABASE_URL` environment variable — loaded from a
local `.env` file for local dev (`python-dotenv`), and set as a Fly
secret for the deployment. Because both point at the *same* database,
there's no separate "local data" vs "production data" to keep in sync —
edit from your laptop or from the live site and it's the same records
either way.

**This means local development touches real payroll data.** There is no
staging copy. Regenerating a month or saving a cutoff from your laptop
overwrites the real thing.

We use [Neon](https://neon.tech) (free tier, serverless Postgres) — sign
up, create a project, and copy its connection string into `.env` locally
and into the Fly secret:

```bash
fly secrets set DATABASE_URL="postgresql://...neon connection string..." -a metro-packaging-depot
```

`SECRET_KEY` signs the login cookie and is required to start. Generate
one with `python -c "import secrets; print(secrets.token_hex(32))"` and
set it the same way.

`app.py`'s `init_db()` creates the schema on first run and applies new
columns idempotently on every start (`CREATE TABLE IF NOT EXISTS`,
`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`), so deploying a schema change
needs no manual migration step.

## Accounts and roles

Everyone signs in by picking their name and entering a PIN. Five wrong
attempts locks that account for 15 minutes.

| Role | Sees | Can change |
|---|---|---|
| **Superuser** (Jomark) | Everything | Everything |
| **Manager** (Clare) | Everything except Activity and Admin | The schedule and employee records |
| **Staff** | Their own dashboard, the schedule, their leave | Request their own leave; their own PIN |
| **Outside viewer** | Dashboard and Schedule, plus Payroll if granted | Nothing |

- **Manager** isn't a flag — it's anyone whose category is `manager`, read
  live from the database, so promoting someone takes effect on their next
  request rather than their next login.
- **Outside viewers** are login accounts for people who aren't on the
  payroll (co-owners). Created from the Admin tab, read-only everywhere,
  with an optional per-person toggle for the Payroll tab. They can't be
  made superusers — there is deliberately no route that does it.
- Sessions are browser-session cookies with a 30-minute idle timeout, and
  authenticated pages are sent `no-store`, so closing the browser or
  walking away means re-entering the PIN.
- **Monthly day targets** are only sent to the superuser and managers.
  They're stripped from the API payloads for everyone else, not just
  hidden in the page.

## Dashboard

The landing tab for staff; one click away for everyone else.

- **Managers** get: who's on duty today with their shift chips, leave
  requests awaiting a decision (approve/deny inline), the current cutoff's
  running net and whether it's been saved, and a "needs a look" card —
  anyone over or under target, outstanding cash advances, next month not
  generated yet.
- **Staff** get: their next shift, the next 7 days, days worked this
  month, and PTO remaining.
- **Outside viewers** get the branch view without any money in it (the
  cutoff figures aren't rendered blank — they're never sent).

## Schedule

1. Pick a month and year, then **Generate schedule**. This creates or
   replaces that month's schedule.
2. The table shows every staff member's shift each day, plus an "Off
   Today" column. Switching months loads whatever was last generated.
3. **Click any shift to reassign it** — manager and superuser only; staff
   see a read-only table. A line above the table records who last changed
   the month, when, and what they did.
4. **Save Snapshot** stores a point-in-time copy; **Restore** rolls back
   to one. Both are superuser-only.
5. **Download PDF** renders the on-screen table in a headless browser, so
   it's pixel-identical rather than a redrawn approximation. Pages hold 15
   days, except a trailing short remainder folds into the previous page —
   every real month prints as exactly 2 landscape A4 pages.

## Time Off

- Staff pick a date range, a type (Paid Time Off / Unpaid / Sick) and an
  optional reason. Paid Time Off is checked against their remaining
  entitlement for that year, counting days already pending.
- Managers see everyone's requests and approve or deny them; the tab
  carries a badge with the pending count.
- **Approving is what changes the schedule**: a Paid Time Off day is
  written in as a paid day, unpaid and sick days clear the shift.
- Anything still pending can be withdrawn.

## Payroll

Semi-monthly, computed from the generated schedule.

- **Cutoffs:** the 10th payout covers the 25th of the prior month through
  the 9th; the 25th covers the 10th through the 24th.
- **Base pay** = days worked in the cutoff × the daily rate, or half the
  monthly salary for fixed-salary staff. An **Assist** shift counts as a
  half day.
- **Cup bonus:** enter the store-wide daily cup total for every day in the
  cutoff. The first 1,000 cups/day are quota; beyond that whoever held
  **Printer** earns ₱0.15 per qualified cup and **Checker** ₱0.10, read
  from the schedule.
- **Bonus** — a discretionary amount, entered by hand, for anyone.
- **OT hours** at a flat ₱50/hr.
- **SSS / Pag-IBIG / PhilHealth / HMO** auto-fill from each employee's
  standing default the first time a cutoff is opened; edit per cutoff as
  needed. No statutory contribution table is built in.
- **Printing errors** — a peso deduction for spoiled prints, available for
  every staff member.
- **Cash advance** — prefilled from the employee's agreed per-cutoff
  instalment, capped at what's actually left to repay, with the running
  balance shown under the field. See **Cash advances** below.
- **Absence deduction** applies to fixed-salary staff: each unreported
  Mon–Sat day deducts monthly÷26, waived 1-for-1 by any extra Sunday
  worked that cutoff.
- **Save payroll data** persists the cutoff. **Download Payslips PDF**
  prints one stub per staff member, six to an A4 sheet, each with the full
  breakdown and the remaining cash advance balance.
- **13th month pay** (bottom of the tab) — total *basic* salary earned in
  the calendar year ÷ 12, per PD 851. Overtime and both bonuses are
  excluded; absences reduce it. Only months that have a schedule are
  counted, so mid-year it shows what's been earned so far.

## Employees

Manager-only. One editable card per person, each saving independently.

- **Profile** — full name, role, employment type, monthly target, daily
  rate or fixed monthly salary, address, phone, email, birthday, photo.
- **Government** — SSS / Pag-IBIG / PhilHealth / HMO ID numbers and the
  standing amounts that auto-fill into payroll.
- **Bank** — name, account name, account number.
- **Paid Time Off** — yearly entitlement, plus what's been used, by year.
- **Cash advances** — record an advance (amount, date, optional per-cutoff
  instalment, note) and see the outstanding balance. Repayments aren't
  entered here: they're the Cash Advance deduction on each payroll cutoff,
  so the balance can never drift from what payroll actually withheld.
- **Login access** — whether they can sign in, and set or reset their PIN.
- **Add employee** / **Archive**. Archiving keeps past schedules and
  payroll intact (old cutoffs and 13th month still add up), clears
  future-dated shifts, cancels pending leave requests, and revokes the
  login. Archived people keep a schedule column only for months they
  actually worked, and can be restored later.

## Activity

Superuser-only, append-only. Every change in the app with who made it and
what the value was before — schedule edits, generates, snapshot
restores, payroll saves, employee and login changes, cash advances, leave
decisions. Searchable and filterable by person. PINs are never recorded,
only the fact that one changed.

## Admin

Superuser-only. Create, adjust and remove the outside-viewer accounts
described under **Accounts and roles**, and reset their PINs.

## The scheduling rules

Staff are scheduled by **category**, not by name, so hiring and archiving
flow straight into a regenerated month.

- **Store hours:** Mon–Sat 8:00 AM–8:00 PM, Sun 8:00 AM–5:00 PM.
- **Sales shifts:** Opening 8:00 AM–5:00 PM, Closing 11:00 AM–8:00 PM.
- **Managers** — fixed Mon–Sat, Sunday off. Alternate a full week on
  Opening then a full week on Closing, continuing seamlessly across month
  boundaries. Several managers are staggered so they never both open the
  same week.
- **Sales staff** — work to their monthly target, filling whichever
  Opening/Closing slots the managers and part-timers haven't already
  covered. Anyone without a target is treated as full-time Mon–Sat.
- **Part-time sales** — permanent Wed 8AM–5PM (Opening) and Fri 8AM–12NN
  assist, plus a share of the Sundays. A lone part-timer works most
  Sundays but always keeps at least 2 a month; several take turns.
- **Machine operators** — fixed 9:00 AM–6:00 PM, Mon–Fri. Exactly one
  Printer works each day and every other operator that day is a Checker.
  Printer days are shared a week at a time, weighted toward whoever has
  printed least: with two operators that's the familiar 3/2 split
  alternating week to week.
- **Sundays** are capped at 2 people total on Opening; managers don't work
  regular Sundays.
- **1st Sunday** is inventory day — the whole roster works. The following
  Monday is an automatic compensatory day off for managers.
- **2nd Wednesday** is an all-hands day.
- **6 consecutive days** is the cap; a rest day is inserted before anyone
  reaches a 7th.
- **Opening/Closing runs in blocks** of up to 4 days rather than flipping
  daily.
- Overlap days are spread roughly weekly instead of bunching at month-end.
- Days off are grouped into consecutive pairs where possible.

Editing the rules means editing `generate_schedule()` in `app.py`. The
`STAFF` list near the top is **first-run seed data only** — once the app
has run, the `staff` table is the source of truth.

## Deploying (Fly.io, auto-deploy on push)

The app runs as a Docker container on [Fly.io](https://fly.io) at
**metro-packaging-depot.fly.dev**. The database lives in Postgres (see
**Database** above), and a 1GB persistent volume mounted at `/data` holds
uploaded employee photos so they survive redeploys (see `entrypoint.sh`).

**Pushing to `main` deploys.** Fly watches this repo directly via its
GitHub integration — there's no Actions workflow and no `FLY_API_TOKEN`.
Anything merged to `main` is live within a few minutes, and the schema
migrations in `init_db()` run as the container boots.

```bash
fly status -a metro-packaging-depot
fly logs -a metro-packaging-depot
fly volumes list -a metro-packaging-depot
```

Chromium (for the schedule PDF) needs real memory, so the VM is sized at
1GB with scale-to-zero when idle (`auto_stop_machines`) to keep cost near
zero for a low-traffic internal tool — though that isn't guaranteed to be
strictly $0/month the way the smallest Fly VM size is.

## Notes and limitations

- Built with Flask + Postgres, Tailwind CSS via CDN on the frontend, styled
  around the brand colours (#1c33bb blue, #07c067 green, #b88c53 tan). The
  page needs an internet connection to load Tailwind and Google Fonts;
  everything else runs against the database.
- The layout is responsive: on a phone the tabs collapse behind a
  hamburger menu with the account and log-out at its foot.
- This is a rule-based generator, not a constraint solver. Quotas are
  usually landed within a day of target rather than hit exactly — the
  6-day rest cap takes priority over squeezing out a last guaranteed day.
- Rest wins over coverage. Across a 24-month sweep of the current roster
  there is **one** day where two sales staff hit the 6-day cap together
  and the store ends up without a Closing shift. The generator prefers
  that to a 7th consecutive day; fix it by hand on the rare occasion it
  happens.
- Regenerating a month fully replaces that month's saved schedule,
  including manual reassignments and approved time off. Save a snapshot
  first if you might want it back.
- There is no automated test suite in the repo yet.
