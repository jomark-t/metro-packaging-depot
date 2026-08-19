# What to build next

Running backlog. Rewritten 2026-08-08 — the previous list is almost
entirely shipped, so this is a fresh gap analysis of what a PH retail
HRMS/payroll usually has that this doesn't.

Nothing below is guesswork about the codebase: every "missing" claim was
checked against `app.py` first.

---

## Shipped so far

| | |
|---|---|
| Roles and PIN login | superuser / manager / staff / outside viewer, enforced at the API |
| Dashboard | branch view for managers, personal view for staff |
| Leave requests | request → approve, writes Paid Time Off onto the schedule |
| Roster management | hire, archive, restore; generator handles any roster by category |
| Cash advance ledger | advances recorded, repayments come from payroll |
| Audit log | append-only, with an Activity tab |
| 13th month pay | basic earned ÷ 12, per PD 851 |
| Self-service | My Pay (own payslip) and My Details (own record) |
| Payroll extras | discretionary bonus, printing errors for everyone |
| Day targets | restricted to superuser and managers |
| Mobile | hamburger nav, phone-friendly login |

---

## 1. Holidays and holiday premium pay — do this first

**The gap.** Grep `app.py` for "holiday": zero hits. `generate_schedule()`
treats 25 December like any Thursday and `compute_payroll()` pays it at
the plain daily rate.

Under PH rules:

| Day type | Worked | Not worked |
|---|---|---|
| Regular holiday | 200% | 100% |
| Special non-working day | 130% | no work, no pay |

**Why first.** It's the only place the app is arguably *wrong* rather than
merely incomplete, and it has the nearest deadline: **National Heroes Day
is Monday 31 August 2026** — a regular holiday, 23 days out. Christmas and
Rizal Day follow, and December is the expensive one to get wrong.

**Scope**

- `holidays` table (`date`, `name`, `type`), seeded with the national list
  and editable so the local fiesta can be added.
- Multipliers applied in `compute_payroll()`, surfaced as their own
  payslip line rather than folded into base pay.
- Holiday columns marked in the schedule table and the printed PDF.
- Decide and document the *not worked* case separately for the
  fixed-salary manager and the daily-rate staff — they behave differently
  and that difference should live in one commented place.

**Touches:** `app.py` (`compute_payroll`, schema, a small admin route),
`payroll_pdf.py`, `static/script.js`, `templates/print_schedule.html`.
**Effort:** medium.

---

## 2. Attendance — the one structural gap

**The gap.** Payroll assumes scheduled means worked.
`compute_payroll()` counts schedule rows and multiplies by the daily rate.
There is no time-in/out, no lates, no undertime, no half day because
someone went home ill. Absence handling exists only for the salaried
manager, and only as "a Mon–Sat with no schedule row".

In practice the schedule *is* the attendance record: if someone misses a
shift you have to remember to edit the schedule or they get paid for it.

**Why it's second despite being the biggest gap.** Everything else in
payroll sits downstream of what "days worked" means, so this is a project
rather than a feature — and it wants the test suite in place first.

**Scope**

- `attendance` table: `staff_id`, `date`, `time_in`, `time_out`, `source`
  (typed by a manager, or self-recorded), `note`.
- Payroll reads actual attendance where present and falls back to the
  schedule where it doesn't, so nothing breaks on day one.
- Lates and undertime as their own payslip lines, with a documented grace
  period.
- A daily entry screen — realistically a manager typing six rows, not a
  biometric device.

**Effort:** large. Worth splitting: recording first, payroll consequences
second.

---

## 3. Overtime rate is below the legal floor

`OT_HOURLY_RATE = 50`, flat. The statutory minimum is **125%** of the
hourly rate on an ordinary day and **130%** on a rest day or holiday. At a
₱460 daily rate that's ₱71.88/hr, not ₱50.

This may be a deliberate house rule, but right now it's a constant nobody
has revisited. Either way it should be a conscious choice, and the fix
pairs naturally with #1 since both are day-type multipliers.

**Effort:** small, once the day-type work from #1 exists.

---

## 4. Statutory contribution tables

**The gap.** SSS, PhilHealth and Pag-IBIG are standing amounts typed per
employee on the Employees tab. Real systems compute them from the
contribution schedule by salary bracket — PhilHealth a flat percentage of
basic, Pag-IBIG a percentage capped at ₱200, SSS from the published table.

Manual amounts drift silently when the tables change, and this is money
remitted to government rather than kept in-house.

**Scope:** a table per scheme with effective dates, computed amounts with
the manual value available as an override, and a payslip note when an
override is in force.

**Effort:** medium. The tables change periodically, so make them editable
rather than hardcoded.

---

## 5. Withholding tax — probably not needed, worth confirming

Entirely absent (zero hits for "tax"). Likely correct: the annual
exemption is ₱250,000, so at ₱18,000/month the manager is under it and
everyone else is well under. Worth a deliberate "checked, it's zero"
rather than an accidental omission — and revisit if anyone's pay passes
roughly ₱20,800/month.

---

## 6. Government remittance reports

SSS R-3, PhilHealth RF-1, Pag-IBIG MCRF, BIR 1601-C monthly, and annual
2316s per employee. All hand-typed today. Tolerable for six people; it
stops being tolerable as the team grows.

Depends on #4 being right first — there's no point generating a report
from numbers that were typed in by hand.

**Effort:** medium per form. One at a time, most-used first.

---

## 7. Loans as a category

The cash advance ledger is already the right shape. SSS salary loans and
Pag-IBIG MPL are separate recurring deductions that run to a fixed total
and then stop. Adding a `kind` column to `cash_advances` is far cheaper
than building a second mechanism.

**Effort:** small-to-medium.

---

## 8. Leave types beyond one PTO bucket

One entitlement per person per year today. PH mandates 5 days Service
Incentive Leave, plus maternity, paternity, solo parent and VAWC leave.
There's also no accrual (earned monthly vs granted upfront) and no
carryover between years.

**Effort:** medium. The request/approve workflow already exists, so this
is mostly a `leave_type` table and balance rules.

---

## 9. Final pay and separation

Archiving stops the schedule cleanly and keeps history, but there's no
last-pay computation (unused leave, pro-rated 13th month, outstanding
advances) and no Certificate of Employment.

**Effort:** medium.

---

## 10. Notifications

Leave approved or denied, and payslip ready, go nowhere — even though
every employee's email is on file. Everything is pull-only.

**Effort:** medium, and it adds an outbound dependency (SMTP or an email
API) plus a secret to manage. Weigh that against six people who see each
other daily.

---

## Cheap wins

- **Commit the test suite.** Roughly 300 checks currently live only in a
  scratchpad and disappear with the session that wrote them. They cover
  the properties that break silently: staff can't read each other's pay,
  outside viewers can't write anything, day targets don't leak, and the
  generator's output for the current roster is unchanged. **Nothing above
  should be built before this exists.**
- **Payroll register export** — one CSV/XLSX per cutoff for your own
  records, rather than six payslip stubs. About an hour.
- **The rest-cap coverage conflict** — one day in a 24-month sweep where
  two sales staff hit the 6-day cap together and the store ends up with no
  Closing shift. Fixable by stopping the off-day allocator letting two
  people reach the cap on the same day; it shifts rest patterns, so it
  needs a decision.
- **Employee documents** — contracts, IDs, clearances per person. Only a
  photo is stored today.

---

## Deliberately not on this list

- **Night differential** (+10%, 10pm–6am) — the store closes at 8pm.
- **Multi-branch** — a single branch is hardcoded via `BUSINESS_NAME`.
  Revisit only if a second location opens.
- **Biometric time clock** — hardware, for six people who all know each
  other.
