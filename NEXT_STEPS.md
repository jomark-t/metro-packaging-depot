# Next steps

Refreshed 2026-11-07. (Written 2026-10-13; payroll/HRMS backlog is in
`NEXT_FEATURES.md`.)

---

## 1. Sync the StoreHub import with Collections — not built yet

**What you asked for.** Every purchase-order (credit) sale that comes in
through **Import StoreHub** should also exist in the **Collections** tab. If
one doesn't, show a warning naming the PO transactions that were not found in
Collections.

### What already exists (groundwork)

- The StoreHub reader (`_storehub_receipts`, `_storehub_parse`) takes both
  date styles StoreHub has used, and pulls the `P.O.` tender, the receipt
  number and the customer.
- **Client matching** is done: names are matched ignoring case, spacing and
  punctuation; close names are suggested for you to confirm and remembered as
  aliases (`client_aliases`), and a Clients merge teaches the same alias.
- The Clients dashboard already **matches POs to StoreHub receipts** (same
  client, same amount, within 3 days) to avoid counting a sale twice. On the
  current data, 44 of 56 POs have an equal-amount receipt and 40 are matched.
  That matcher (`_match_sales`) is the starting point for this feature.

### Still to build

1. **Remember the receipt.** Add `storehub_receipt TEXT` (unique when set) to
   `purchase_orders`, so a re-import can never create or flag a duplicate.
2. **Match each StoreHub PO line to a Collections PO** by receipt number
   first, otherwise by client + `po_date` + amount (probable match, stamp the
   receipt onto it).
3. **Warning.** After the Import StoreHub preview, and on the Collections tab,
   a banner such as:
   > 3 PO transactions from StoreHub are not in Collections:
   > Oct 12 - Tigers Cafe,NCF - 4,400.00 - receipt 00000002870 ...
   Each line gets an **Add to Collections** button.
4. **Reverse check (nice to have).** Flag Collections POs with no matching
   StoreHub receipt, in case one was keyed twice or by hand. Today 12 of 56
   POs have none.

### Decisions needed first

- **Auto-add or warn only?** *Warn, then one-click add* (an "Add all" button)
  is recommended: the data is already in the file.
- **Partly-PO receipts.** A receipt can be paid partly by PO (Lemon & Co:
  1,500 of a 3,100 receipt). The PO amount is the `P.O.` portion only —
  confirm.
- **Terms.** Collections POs now carry payment terms; a PO added from StoreHub
  has none. Default to "No terms" and let someone set it?
- **Existing POs** have no receipt number: backfill by matching old exports,
  or only match from here on.

### Files this will touch

`app.py` (`_storehub_parse`, `api_ops_sales_storehub`, a migration, the
`/api/office/purchase-orders` routes), `static/script.js`
(`renderStorehubPreview`, the Collections tab), `templates/index.html`
(banner).

---

## 2. Still open

- **Own-use re-import.** Oct 10 and Oct 12 were saved without own use.
  Re-import the Oct 10–12 export (Monthly Sales → Import StoreHub): Oct 10
  becomes 23,257.00 and Oct 12 becomes 27,879.50.
- **Check co-owners on the live site:** all four apps show, an edit is refused
  with the "view-only" message, switching back to Payroll doesn't ask for a
  PIN, and the **Full access (superuser)** toggle works end to end.
- **Year-end stock count** for a purchase-based COGS cross-check.
- **FK Merchandising balance / Hahsy credit.** One 50,000 payment (2026-0061)
  looks mis-tagged.
- **Cup counts before July.** Daily printed cups were only entered from July,
  so earlier months on the Cup Printing dashboard are estimated from delivered
  orders. Enter the real counts if they exist.
- **Last year's cup prints** were imported with prices taken from today's
  price list (the sheet had none), and Unplug and Cafeza show as unpaid as the
  sheet said. Tick them paid if they were settled.
- **Clients with no contact details.** None of the clients have a phone,
  email or social handle on file; the Clients dashboard shows 0%.
