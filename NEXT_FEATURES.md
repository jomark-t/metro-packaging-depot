# What to build next

Written 2026-08-07, after the PIN login / roles / PTO / snapshots / cash
advance commit (`713dfe1`). This is a shortlist of gaps found by reading
the current `app.py`, `static/script.js`, and the README — ranked, with
scope and effort for each so you can just pick one and start.

**Recommendation: #1 (Leave requests) if you want a clean, self-contained
win that finishes what the last commit started. Jump to #2 (Holiday pay)
instead if payroll accuracy matters more right now — that one is a
compliance gap, not just a convenience.**

---

## 1. Leave request → approval workflow — ✅ BUILT 2026-08-07

**The gap.** PTO exists, but only as arithmetic. `/api/staff/<name>/pto`
counts `Paid Time Off` rows already sitting in the schedule against
`pto_entitlement`. There is no way for Jem to *ask* for a day off — Clare
or you must hand-edit the schedule cell, and the balance quietly follows.
Nothing records who requested what, when, or who approved it.

Now that staff have their own PIN logins, this is the obvious payoff: the
login is currently read-only for everyone but the superuser, so a staff
account can't actually *do* anything yet.

**Scope**

- New `leave_requests` table: `staff_id`, `date` (or start/end), `type`
  (PTO / unpaid / sick), `reason`, `status` (pending/approved/denied),
  `requested_at`, `decided_by`, `decided_at`, `decision_note`.
- Staff view: "Request time off" — pick date(s), see remaining balance
  live, submit. List own requests with status.
- Approver view (superuser + Clare): pending queue with Approve / Deny.
  Approving writes the `Paid Time Off` row into `schedule` (which the
  existing PTO endpoint already counts) and, ideally, warns if that day
  drops sales coverage below the Sunday/all-hands rules.
- Validation: can't request past dates, can't exceed remaining
  entitlement, can't double-book a date already off.

**Why it's the top pick.** It reuses everything already built (roles,
PTO counting, schedule edit API, snapshots for undo) and needs no new
concepts in the scheduling algorithm. It's also the feature that makes
the staff logins worth having.

**Touches:** `app.py` (schema + 3–4 routes), `static/script.js` (new
panel, role-gated), `templates/index.html` (nav entry, maybe a badge
count on pending).
**Effort:** medium — a day or so.

---

## 2. Holidays and holiday premium pay

**The gap.** The app has no concept of a holiday at all — grep for it and
you get nothing. `generate_schedule()` treats Dec 25 like any Thursday,
and `compute_payroll()` pays it at the plain daily rate. Under PH labor
rules a regular holiday worked is 200% and a special non-working day
worked is 130%, with different treatment when *not* worked. Right now
every holiday in the year is silently underpaid or mispaid.

**Scope**

- `holidays` table (`date`, `name`, `type`: regular / special) — seeded
  with the PH national list, editable so you can add the local fiesta.
- Schedule table: mark holiday columns visually (a header tint + the
  holiday name on hover).
- Payroll: apply the multiplier per holiday type in `compute_payroll()`,
  and show it as its own line ("Holiday premium") on the payslip rather
  than folding it into base pay.
- Decide and document the not-worked case for your fixed-salary manager
  vs. the daily-rate staff — they behave differently and that difference
  should live in one commented place.

**Why it matters.** It's the only item on this list where the current
behavior is arguably *wrong* rather than merely missing.

**Touches:** `app.py` (`compute_payroll`, schema, a small admin route),
`payroll_pdf.py` (new line item), `static/script.js`,
`templates/print_schedule.html`.
**Effort:** medium — the multiplier logic is small; getting the payslip
layout and the not-worked cases right is most of the work.

---

## 3. Add / remove / archive employees from the UI — ✅ BUILT 2026-08-07

The `staff` table is the source of truth (the `STAFF` list is seed data
only), hiring and archiving work from the Employees tab, and archiving
keeps history while clearing future shifts and pending leave.

## 3b. Generalise the schedule generator — ✅ BUILT 2026-08-07

`generate_schedule()` no longer knows anyone by name; staff are picked up
by category, so hiring and archiving flow straight into a regenerated
month. Decisions baked in: one Printer per day with every other operator
a Checker; part-timers share the Sundays; multiple managers are staggered
onto opposite Opening/Closing weeks. Output is unchanged for the current
six except that the Monday after inventory Sunday is no longer left with
nobody opening (see the coverage bug fixed in Pass C).

---

## 4. Cash advance ledger — ✅ BUILT 2026-08-07

**The gap.** `cash_advance` is a single per-cutoff number on
`payroll_extras`. There's no record of the *loan* — how much was borrowed,
how much has been repaid across cutoffs, what's still outstanding. You're
tracking the balance in your head or on paper.

**Scope**

- `cash_advances` table: `staff_id`, `amount`, `date_granted`, `note`,
  optional `installments`.
- Auto-suggest the per-cutoff deduction from the outstanding balance
  instead of typing it in fresh each time.
- Show "outstanding: ₱X" on the employee card and the payslip.

**Effort:** small-to-medium. Good candidate for a short session.

---

## 5. Change / audit log — ✅ BUILT 2026-08-07

**The gap.** Snapshots let you *undo* a bad month, but nothing records
who edited a shift, changed a daily rate, or saved a payroll cutoff. With
multiple people now able to log in, "who changed Von's rate?" has no
answer.

**Scope:** an `audit_log` table (`user`, `action`, `target`, `before`,
`after`, `at`) written from the handful of mutating routes, plus a plain
reverse-chronological list view for the superuser.

**Effort:** small. Mostly mechanical — one helper function called from
`api_update_entry`, `api_staff_update`, `api_payroll_save`,
`api_generate`, `api_restore_snapshot`.

---

## 6. Dashboard (staff + manager views) — ✅ BUILT 2026-08-07

**The gap.** A staff member logging in on their phone gets the full
6-person month grid, horizontally scrolled, with every control disabled.
What they actually want is: my next shifts, my PTO balance, my last
payslip.

**Scope:** a mobile-first landing page for non-superusers — next 7 days,
this month's day count vs. target, PTO remaining, and read-only access to
their own payslips (their own only — `compute_payroll` currently returns
all six, so the endpoint needs filtering by `session["staff_name"]`).

**Note:** worth checking anyway — right now `/api/payroll` is
`@login_required` but not filtered, so any logged-in staff member can
read everyone's pay by hitting the API directly, even though the UI
doesn't show it. Small fix, do it regardless of whether you build this
feature.

**Effort:** medium, mostly frontend.

---

## Quick wins, if you only have an hour

- ~~Filter `/api/payroll` by the logged-in staff member~~ — done
  2026-08-07, and went further: payroll and employee records are now
  manager-only (superuser + Clare) at both the tab and the API.
- Update the README: it predates `713dfe1` and documents none of the
  login, roles, PTO, snapshot, cash-advance, leave-request, 13th-month
  or last-edited features.
- `/api/schedule/entry` is still only `@login_required` — any staff
  member who can log in can reassign anyone's shift. The new
  last-edited-by line means you'd at least see who did it, but the
  permission itself is probably worth tightening.
- Payroll register export — one CSV/XLSX of a cutoff for your records,
  rather than six individual payslip stubs.
