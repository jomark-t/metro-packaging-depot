# Metro Packaging Depot — Monthly Schedule Generator

A small web app that auto-generates a monthly duty schedule for your
6-person team and stores it in Postgres — the same database whether
you're running it locally or on the live deployment, so there's one
source of truth.

## Setup

Requires Python 3.9+ and a Postgres connection string (see **Database**
below — the whole team, local or deployed, points at the same database).

```bash
cd staff-scheduler
pip install -r requirements.txt
python -m playwright install chromium
cp .env.example .env   # then fill in DATABASE_URL
python app.py
```

The `playwright install chromium` step is a one-time download (~150-300MB)
of a headless Chromium browser — it's used to render the schedule PDF so
it comes out pixel-identical to the on-screen table (see below).

Then open **http://127.0.0.1:5000** in your browser.

## Database

The app stores everything (schedules, payroll, employee records) in
Postgres via the `DATABASE_URL` environment variable — loaded from a
local `.env` file for local dev (`python-dotenv`), and set as a Fly
secret for the deployment. Because both point at the *same* database,
there's no separate "local data" vs "production data" to keep in sync —
edit from your laptop or from the live site and it's the same records
either way.

We use [Neon](https://neon.tech) (free tier, serverless Postgres) — sign
up, create a project, and copy its connection string into `.env` locally
and into the Fly secret:

```bash
fly secrets set DATABASE_URL="postgresql://...neon connection string..." -a metro-packaging-depot
```

`app.py`'s `init_db()` creates the schema automatically on first run
against an empty database — no manual migrations needed.

## Using it

1. Pick a month and year.
2. Click **Generate schedule**. This creates (or replaces) the schedule
   for that month in the database.
3. The table shows every staff member's shift each day, and an "Off
   Today" column shows who is off. Switching months just loads
   whatever was last generated for that month — click Generate again
   any time to reshuffle it.
4. Click **Download PDF** to get a landscape A4 printable version. It's
   rendered by actually loading the on-screen table in a headless
   browser, so it's pixel-identical to the web view (same chip colors,
   fonts, and layout) rather than a redrawn approximation. Pages hold
   15 days each, except a trailing short remainder (e.g. day 31 alone)
   gets folded into the previous page instead of getting its own
   near-empty page — so every real month (28-31 days) prints as
   exactly 2 pages.

Note: the page pulls in Tailwind CSS and Google Fonts from their
CDNs, so it needs an internet connection the first time it loads in
your browser (everything else — the schedule data, generation, and
PDF export — runs fully locally, no internet required for those).

## Deploying (Fly.io, auto-deploy on push)

The app runs as a Docker container on [Fly.io](https://fly.io) at
**metro-packaging-depot.fly.dev**. The database lives in Postgres (see
**Database** above), and a 1GB persistent volume mounted at `/data`
holds uploaded employee photos so they survive redeploys (see
`entrypoint.sh`).

Auto-deploy is handled by Fly's own GitHub integration (set up via the Fly
dashboard's "Launch from GitHub"), not a GitHub Actions workflow — Fly
watches this repo directly and rebuilds/redeploys on every push to `main`.
No `FLY_API_TOKEN` secret or workflow file needed.

To manage the deployed app from the CLI: `fly status -a metro-packaging-depot`,
`fly logs -a metro-packaging-depot`, `fly volumes list -a metro-packaging-depot`.

Note: Chromium (for the schedule PDF) needs real memory, so the VM is
sized at 1GB with scale-to-zero when idle (`auto_stop_machines`) to keep
cost near-zero for a low-traffic internal tool — but this isn't
guaranteed to be strictly $0/month the way the smallest Fly VM size is.

## Payroll tab

Semi-monthly payroll, computed from the generated schedule:

- **Cutoffs:** the 10th payout covers the 25th of the prior month
  through the 9th; the 25th payout covers the 10th through the 24th.
  Pick a month/year and toggle **10th** / **25th** to switch cutoffs.
- **Base pay** = days worked in the cutoff (from the schedule) ×
  each person's daily rate (Clare 550, Jem/Von/Jha 460, Macky 400,
  Joshua 350). An **Assist** shift (Jha's 8AM-12NN Friday helper day)
  only counts as a half day.
- **Printed cup counts:** enter the store-wide daily cup total for
  every day in the cutoff, including weekends. The first 1,000
  cups/day are quota and don't earn a bonus — only cups beyond that
  qualify (e.g. a 3,500-cup day has 2,500 bonus-eligible cups).
  Whoever held **Printer** that day earns ₱0.15 per qualified cup,
  **Checker** earns ₱0.10 — pulled from the schedule automatically,
  only Macky/Joshua ever qualify.
- **OT hours** (fixed ₱50/hr) is entered by hand per staff per cutoff.
  **SSS / Pag-IBIG / PhilHealth / HMO** auto-fill from each employee's
  standing default (set on the **Employees** tab) the first time you
  open a cutoff that hasn't been saved yet — edit them per cutoff if a
  particular pay period differs, still no statutory contribution table
  built in.
- **Printing errors** is a peso deduction for spoiled/wasted prints,
  entered by hand per cutoff — only Macky/Joshua (machine operators)
  have this field, since it doesn't apply to sales staff. No standing
  default; it's expected to vary cutoff to cutoff.
- **Save payroll data** persists the cup counts and OT/benefit entries
  (including any auto-filled defaults) for that cutoff; reopening it
  later reloads the saved values instead of the defaults.
- **Download Payslips PDF** prints one stub per staff member, all 6 on
  a single A4 sheet (2x3 grid), each with their full name and full pay
  breakdown — a thin rule separates earnings (days worked, base pay,
  bonus, OT) from the SSS/Pag-IBIG/PhilHealth/HMO deduction lines above
  the bolder NET PAY line — ready to cut apart and hand out.

## Employees tab

Editable profile per staff member — the fixed 6-person roster itself
(names, roles, and the store's scheduling rules) still lives in the
`STAFF` list in `app.py`, but everything below is stored in the database
and editable from this tab, surviving app restarts:

- **Full name, role, employment type, monthly target, daily rate**
- **Address, phone, email, birthday**
- **Profile photo** — click the pencil badge on the avatar to upload a
  PNG/JPG/WEBP (5MB max); not used anywhere yet, just stored for later.
- **SSS / Pag-IBIG / PhilHealth / HMO** — each has a labeled **ID
  number** field and a labeled **standing amount** field; the amount is
  what auto-fills into the Payroll tab for any cutoff you haven't saved
  yet. The ID numbers aren't used anywhere yet, just stored for later.
- **Bank details** — bank name, account name, and account number; not
  used anywhere yet, just stored for later.

Each card saves independently with its own **Save** button.

## The rules baked in

- **Store hours:** Mon–Sat 8:00 AM–8:00 PM, Sun 8:00 AM–5:00 PM.
- **Sales shifts:** Opening 8:00 AM–5:00 PM, Closing 11:00 AM–8:00 PM.
- **Clare** (Store Manager) — guaranteed 24 duty days/month.
- **Jem & Von** (Sales) — guaranteed 21 duty days/month each.
- **Jha** (Part-time Sales) — permanent Wed 8AM–5PM, labeled Opening
  since she covers that slot; permanent Fri 8AM–12NN assist (helper
  coverage, doesn't replace a full shift); plus most Sundays. She
  always keeps at least 2 Sundays off a month to rest.
- **Sundays are capped at 2 people total** on Opening (8AM–5PM) —
  either Jha + one of Clare/Jem/Von, or two of Clare/Jem/Von on the
  Sundays Jha is off. Never a 3rd.
- **1st Sunday of the month** is inventory day — all 6 staff work.
- **2nd Wednesday of the month** is also a guaranteed all-hands day —
  Macky, Joshua, and Jha already work every Wednesday, so this just
  means Clare, Jem, and Von are all pulled in too.
- **Macky & Joshua** (Machine Operators) — fixed 9:00 AM–6:00 PM,
  Mon–Fri only, shown on the table as just "Printer" or "Checker."
  Each calendar week, one of them is "heavy" (3 days Printer, 2 days
  Checker) and the other is the reverse; who's heavy alternates week
  to week (biased toward whoever has fewer cumulative printer days so
  far) so it balances out over the month.
- **Consecutive work days** are capped at 6 in a row for Clare/Jem/Von —
  a mandatory rest day is inserted before anyone hits a 7th straight
  day (including around the two all-hands days above).
- **Opening/Closing runs in blocks, not day-to-day flips** — each
  person stays on the same shift type for up to 4 straight working
  days before switching, instead of alternating Opening/Closing daily.
- Overlap days (a 3rd sales person on Opening or Closing, not a
  separate "Support" shift) are spread roughly one per week — mainly
  Thursdays plus the 2nd Wednesday — instead of bunching up at the end
  of the month, so Clare/Jem/Von can reach their guaranteed monthly
  day counts. Never happens on Sundays.
- Days off are grouped into consecutive 2-day pairs where possible.

## Notes / limitations

- Built with Flask + Postgres on the backend, Tailwind CSS (via CDN) on
  the frontend, styled around your brand colors (#1c33bb blue, #07c067
  green, #b88c53 tan, plus black/white). Printer/Checker get their own
  bold solid-fill look so they never look like Assist/Closing.
- This is a rule-based generator, not a full constraint solver. Adding
  the 6-day cap means quotas (24/21/21) are usually landed within a
  day of target rather than hit exactly every time — the cap takes
  priority over squeezing out the last guaranteed day, since forcing
  someone past 6 days straight just to hit a number isn't the
  intent. Off-day pairing is also best-effort: near the end of a
  month, once someone's quota is nearly used up, you may see a longer
  run of working days as the algorithm catches everyone up.
- Editing the roster or rules means editing the `STAFF` list and the
  `generate_schedule()` / `compute_machine_roles()` functions near the
  top of `app.py`.
- Regenerating a month fully replaces that month's saved schedule.
  If a month was generated with an older version of this app before
  you replaced the files, hit **Generate schedule** again for that
  month to pick up the latest rules — the saved data in the database
  doesn't update itself.
