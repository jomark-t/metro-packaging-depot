# Next steps

Written 2026-10-13. (The older backlog, mostly payroll features, is in
`NEXT_FEATURES.md`.)

---

## 1. Sync the StoreHub import with Collections

**What you asked for.** Every purchase-order (credit) sale that comes in
through **Import StoreHub** should also exist in the **Collections** tab. If
one doesn't, show a warning in a header naming the PO transactions that were
not found in Collections.

### How the two sides line up

| | StoreHub export | Collections tab |
|---|---|---|
| Table | `Transactions_*.csv` | `purchase_orders` + `purchase_order_payments` |
| Who | `Customer` column (e.g. `Tigers Cafe,NCF `) | `client_id` -> `print_clients` |
| When | `Time` | `po_date` |
| How much | the `P.O.` column, **not** `Total` | `amount` |
| Reference | `Receipt Number` (e.g. `00000002870`) | none yet (only `remarks`) |

Real examples from the Oct 10-12 export (all on Oct 12):
`Tigers Cafe,NCF` 4,400.00 / `Ditto` 160.00 / `Lemon & Co` **1,500.00 of a
3,100.00 receipt** (the rest was paid another way). So the amount to match is
the P.O. portion of the receipt, never the receipt total.

### Proposed build

1. **Remember the receipt.** Add `storehub_receipt TEXT` (unique when set) to
   `purchase_orders`. Today there is nothing to match on except client + date
   + amount, which is fragile. With the receipt number, a re-import can never
   create or flag a duplicate.
2. **Match each StoreHub PO line to a Collections PO.**
   - First by `storehub_receipt`.
   - Otherwise by client (see below) + `po_date` + `amount`. Treat a hit as a
     probable match and stamp the receipt onto it.
3. **Client matching.** StoreHub's `Customer` text is messy (trailing spaces,
   `Tigers Cafe,NCF`, `Tigers Cafe` vs `Tiger's Cafe`). Normalise (trim,
   lowercase, drop punctuation) and compare against `print_clients` names.
   Keep a small alias map so a name that was merged once (the Clients "Merge
   into..." feature) never needs fixing twice.
4. **Header warning.** After the preview in the Import StoreHub dialog, and
   again on the Collections tab itself, show a banner such as:
   > 3 PO transactions from StoreHub are not in Collections:
   > Oct 12 - Tigers Cafe,NCF - 4,400.00 - receipt 00000002870 ...
   Each line gets an **Add to Collections** button (creates the PO under the
   matched client, or asks which client if there's no match).
5. **Decision needed: should the import create the Collections POs
   automatically?** Two options:
   - *Warn only* (what was asked): import fills Monthly Sales, warns about POs
     missing from Collections, you add them.
   - *Warn, then one-click add*: same warning, plus "Add all" so the book
     never lags behind the POS. Recommended, since the data is already in the
     file.
6. **Reverse check (nice to have).** In Collections, flag POs that have no
   matching StoreHub receipt, in case one was keyed twice or by hand.

### Things to settle before building

- A receipt where only part is on PO (Lemon & Co): confirm the PO amount is
  just the `P.O.` portion.
- Same-day repeat orders from one client with the same amount: matching by
  amount alone is ambiguous, so the receipt number must win.
- Existing Collections POs have no receipt number. Decide whether to backfill
  by matching old StoreHub exports, or just start matching from here on.
- "PO" in Monthly Sales (customers' credit sales) is not the same thing as the
  supplier **Purchase Order** tab in Operations (what you buy). This task is
  about the first.

### Files this will touch

`app.py` (`_storehub_parse`, `api_ops_sales_storehub`, a migration, the
`/api/office/purchase-orders` routes), `static/script.js`
(`renderStorehubPreview`, the Collections tab), `templates/index.html`
(warning banner).

---

## 2. Still open from earlier

- **Own-use re-import.** Oct 10 and Oct 12 are saved without own use. Re-import
  the Oct 10-12 export (Monthly Sales -> Import StoreHub): Oct 10 becomes
  23,257.00 and Oct 12 becomes 27,879.50.
- **Check co-owners on the live site** after the deploy: all four apps show,
  an edit is refused with the "view-only" message, switching back to Payroll
  doesn't ask for a PIN, and the **Full access (superuser)** toggle works end
  to end (only the confirmation was tested).
- **Year-end stock count** for a purchase-based COGS cross-check. Suggested
  earlier, not built.
- **FK Merchandising balance / Hahsy credit.** One 50,000 payment (2026-0061)
  looks mis-tagged. Worth a look.
