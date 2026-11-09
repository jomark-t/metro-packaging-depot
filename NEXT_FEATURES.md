# What to build next

Running backlog. Refreshed 2026-11-07 against the code and git history.
The August version was a gap analysis of payroll/HRMS; since then most of
the work has gone into Cup Printing, Admin and Operations, so this lists
what exists first and then what is still missing.

Every "missing" claim below was checked against `app.py`.
(Cup Printing, Admin and Operations follow-ups are in `NEXT_STEPS.md`.)

---

## Shipped so far

### People and payroll

| | |
|---|---|
| Roles and PIN login | superuser / manager / staff / outside viewer / co-owner (read-only, optional full access), enforced at the API |
| Dashboard, Schedule | branch view for managers, personal view for staff; Sales and Printing groups |
| Leave requests | request → approve, writes Paid Time Off onto the schedule |
| Roster management | hire, archive, restore; Position dropdown sets category and title together |
| Cash advance ledger | advances recorded, repayments come from payroll |
| Audit log | append-only, with an Activity tab |
| 13th month pay | basic earned ÷ 12, per PD 851 |
| Self-service | My Pay (own payslip) and My Details (own record) |
| Payroll extras | discretionary bonus, undertime, printing errors for everyone |
| Holiday pay | regular and special holidays, own payslip line, start date and on/off switch, holidays marked in the schedule |
| Cup bonus | daily quota with dated changes; **per-shift** cups with named Printer/Checker for two-shift days; **per-operator** Printer and Checker rates from a date; a **Cup Bonus** page that shows every line behind a bonus and flags odd rates |
| Day targets | restricted to superuser and managers |
| Mobile and install | hamburger nav, phone-friendly login, installable app (PWA) with an offline page |

### Cup Printing

Status board, Cup Prints sheet with **edit** (add, change, remove cups) and
**drafts**, required cup/colour/quantity once an order is final, new-logo
and paid flags, cup-pricing page, a **Dashboard** (printed vs ordered by
month, backlog, product/ink/lid mix, weekdays), and view-only access for
machine operators unless the superuser allows editing.

### Clients (its own module)

Dashboard, paginated and sortable list with filters, a three-column client
popup (details, store purchases, cup prints), merge with a searchable picker
that remembers the old name, **Import StoreHub** to file receipts per client
(near-name matching with confirm), and discounts.

### Admin (Collections, Expenses, Inventory, Notes)

Collections with payment **terms** (15/30/45/60 days) and a dashboard
(ageing, who to chase, how clients pay); expense types, capital depreciation,
Discounts tab.

### Operations (owners only)

Monthly Sales with one-click StoreHub import and Own Use, Master Sales
analytics, supplier purchase orders, payroll-to-OpEx sync.

---

## 1. Holidays and holiday pay — shipped, with follow-ups

**Built (2026-11-07).** A **Holidays** tab in the Payroll app (superuser edits,
managers read), seeded each year with the days fixed by law and Holy Week
(worked out from Easter). Holiday pay is its own line on the payroll table
and the payslip, holidays are marked in the schedule and its PDF, and the
Payroll tab names the holidays in the cutoff being viewed.

| Day type | Worked | Not worked |
|---|---|---|
| Regular holiday | 200% | 100% (daily-rate staff who worked in the 7 days before; the salaried manager is already paid in her salary) |
| Special non-working day | 130% | no work, no pay |

Paid Time Off on a holiday is already paid, so nothing is added. The rules
are written once, above `holiday_pay_lines()` in `app.py`.

**Holiday crew (added 2026-11-09).** On a holiday from Monday to Saturday the
schedule runs two people: the manager and **one** sales person, and nobody
from the machines (James, who is filed as sales staff but runs the machines,
counts as a machine operator here). The generator follows it — the manager
works even on the rest day after the inventory Sunday, the machine operators
and part-timers are off, and exactly one person from the sales pool covers the
other of Opening/Closing. A holiday on a Sunday keeps the Sunday rule. For a
month that is already scheduled, the Holidays tab has **Check the current
schedule**, which previews the changes and applies them (a snapshot of each
month is saved first, and leave days are never touched).

**Decisions taken, worth revisiting**

- **Start date.** Payroll is worked out live from the schedule, so adding
  holidays would have changed cutoffs that were already paid. Holiday pay
  applies **from a date** (default 10 Nov 2026, the first unpaid cutoff when
  it was built); anything earlier is untouched. The same page has an on/off
  switch.
- **"Present the day before"** is read as *worked in the 7 days before the
  holiday*. The schedule cannot tell a rest day from an unexcused absence, so
  that is the closest it can get.
- **Proclaimed days are added by hand.** Eid'l Fitr and Eid'l Adha, Chinese
  New Year, 24 and 31 December and any one-off are announced each year. The
  standard list is a starting point — check it against the proclamation.
- **Small-establishment exemption.** Labor Code Art. 94 exempts retail and
  service establishments regularly employing fewer than 10 workers from
  regular holiday pay. If that applies, paying it is a policy choice (the
  switch is there for it) — worth confirming with your accountant.

**Not done yet**

- A holiday that is also a rest day (a higher rate).
- Overtime on a holiday (130% — see #3).
- A per-person exception ("no holiday pay for this holiday").
- Choosing *which* sales person works a holiday: the generator picks whoever has the most days still owed; the apply step keeps whoever is already scheduled.
- Tests covering holiday pay in the rebuilt test suite (see Cheap wins).

---

## 2. Attendance — the one structural gap

**The gap.** Payroll assumes scheduled means worked. There is no time-in/out,
no lates, no half day because someone went home ill. Undertime hours can be
typed per cutoff, but nothing records them.

In practice the schedule *is* the attendance record: if someone misses a
shift you have to remember to edit the schedule or they get paid for it.

**Scope**

- `attendance` table: `staff_id`, `date`, `time_in`, `time_out`, `source`,
  `note`.
- Payroll reads actual attendance where present and falls back to the
  schedule where it doesn't, so nothing breaks on day one.
- Lates and undertime as their own payslip lines, with a documented grace
  period.
- A daily entry screen — a manager typing six rows, not a biometric device.

**Effort:** large. Worth splitting: recording first, payroll consequences
second. Wants the test suite (below) in place first.

---

## 3. Overtime rate is below the legal floor

`OT_HOURLY_RATE = 50`, flat. The statutory minimum is **125%** of the hourly
rate on an ordinary day and **130%** on a rest day or holiday. At a ₱460
daily rate that is ₱71.88/hr, not ₱50.

This may be a deliberate house rule, but it is a constant nobody has
revisited. It pairs naturally with holiday pay (both are day-type multipliers), which now exists.

**Effort:** small now that the day-type work from #1 exists.

---

## 4. Statutory contribution tables

SSS, PhilHealth and Pag-IBIG are standing amounts typed per employee. Real
systems compute them from the contribution schedule by salary bracket.
Manual amounts drift silently when the tables change, and this is money
remitted to government.

**Scope:** a table per scheme with effective dates, computed amounts with the
manual value as an override, and a payslip note when an override is in force.

**Effort:** medium. The tables change periodically, so make them editable.

---

## 5. Withholding tax — probably not needed, worth confirming

Absent. Likely correct: the annual exemption is ₱250,000, so at ₱18,000/month
the manager is under it and everyone else is well under. Worth a deliberate
"checked, it's zero", and a revisit if anyone's pay passes roughly
₱20,800/month.

---

## 6. Government remittance reports

SSS R-3, PhilHealth RF-1, Pag-IBIG MCRF, BIR 1601-C monthly, annual 2316s.
All hand-typed today. Depends on #4 being right first.

**Effort:** medium per form, most-used first.

---

## 7. Loans as a category

The cash advance ledger is already the right shape. SSS salary loans and
Pag-IBIG MPL are recurring deductions that run to a fixed total and stop.
A `kind` column on `cash_advances` is far cheaper than a second mechanism.

---

## 8. Leave types beyond one PTO bucket

One entitlement per person per year. PH mandates 5 days Service Incentive
Leave, plus maternity, paternity, solo parent and VAWC leave; there is also
no accrual and no carryover. The request/approve workflow exists, so this is
mostly a `leave_type` table and balance rules.

---

## 9. Final pay and separation

Archiving stops the schedule and keeps history, but there is no last-pay
computation (unused leave, pro-rated 13th month, outstanding advances) and no
Certificate of Employment.

---

## 10. Notifications

Leave approved or denied, and payslip ready, go nowhere. Everything is
pull-only. Adds an outbound dependency (SMTP or an email API) and a secret.

---

## Cheap wins

- **Commit the test suite.** About 300 checks were written in an earlier
  session's scratchpad and are gone with it. They covered the properties that
  break silently: staff can't read each other's pay, outside viewers can't
  write, day targets don't leak, the generator's output is unchanged. It
  should be rebuilt and committed before anything large (#2, #4) is built —
  and it now also needs to cover the cup bonus lines and holiday pay.
- **Payroll register export** — one CSV/XLSX per cutoff for your own records.
  About an hour.
- **The rest-cap coverage conflict** — one day in a 24-month sweep where two
  sales staff hit the 6-day cap together and nobody covers Closing. Needs a
  decision because it shifts rest patterns.
- **Employee documents** — contracts, IDs, clearances. Only a photo is stored.

---

## Deliberately not on this list

- **Night differential** (+10%, 10pm–6am) — the store closes at 8pm.
- **Multi-branch** — a single branch is hardcoded via `BUSINESS_NAME`.
- **Biometric time clock** — hardware, for six people who all know each other.
