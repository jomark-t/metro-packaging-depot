"""Reads the Products price-list CSV (the Google Sheet export) into rows ready
for the Products module. Pure functions - no database, no Flask - so it can be
tested on its own.

The sheet is one row per sellable item, with the family implied by the name
("Double Wall Cup 8oz White", "Double Wall Cup 12oz Black"...). The importer
takes the size and the colour off the name and calls what is left the family,
so those rows land under one product with size and colour options.
"""

import csv
import io
import re

# longest first, so "brown silver" wins over "brown" and "silver"
COLORS = ["brown silver", "white", "black", "kraft", "brown", "blue", "red", "green", "pink", "yellow", "orange",
          "purple", "clear", "gold", "silver", "natural", "beige", "gray", "grey", "plain", "printed", "windowed",
          "transparent"]
FINISHES = ("windowed", "printed", "plain")  # a finish, not a colour: kept with the size part
COLOR_RE = re.compile(r"^(?:%s)$" % "|".join(re.escape(c) for c in COLORS), re.I)
TRAILING_COLOR_RE = re.compile(
    r"\b(brown silver|%s)\s*$" % "|".join(re.escape(c) for c in COLORS if c != "brown silver"), re.I
)
# 12oz, 750ml, 260cc, 8 inch, 95mm, 8x8x5, 7x7+3 cm, 100gsm, 15x18+3 cm
SIZE_RE = re.compile(
    r"(?<![A-Za-z0-9])("
    r"\d+(?:\.\d+)?\s?(?:x\s?\d+(?:\.\d+)?)+(?:\s?\+\s?\d+(?:\.\d+)?)?(?:\s?(?:cm|mm|inch|in|\"))?"
    r"|\d+(?:\.\d+)?\s?(?:oz|ml|cc|l|liters?|inch|in|cm|mm|gsm|g|kg|lb|lbs|yards?|meters?|m|pcs|ply|\")"
    r")(?![A-Za-z0-9])",
    re.I,
)
SIZE_WORDS = re.compile(r"\b(xs|small|medium|large|xl|jumbo|mini)\b", re.I)
NUMBERED_SIZE_RE = re.compile(r"\s(#\d+|\d+ Holes?|Single|Double|Tiny)\s*$", re.I)
TRAILING_NUMBER_RE = re.compile(r"(?<=[A-Za-z])\s(\d{1,3})\s*$")

STATUS_MAP = {"new": "new", "repriced": "repriced", "incoming": "incoming", "shelfed": "shelfed", "shelved": "shelfed"}


def money(text):
    """'₱ 1,350.00' -> 1350.0. Blank, '₱ -' and anything unreadable -> None."""
    s = re.sub(r"[^0-9.\-]", "", (text or "").replace(",", ""))
    if not s or s in ("-", ".", "-."):
        return None
    try:
        value = float(s)
    except ValueError:
        return None
    return value if value > 0 else None


def number(text):
    s = (text or "").replace(",", "").strip()
    try:
        return float(s)
    except ValueError:
        return None


def split_name(name):
    """-> (family, size, colour) from a product name as the sheet writes it."""
    n = " ".join((name or "").split())
    color = ""
    extras = []
    # " - Colour" / " - Windowed" tails; more than one can stack
    while " - " in n:
        head, tail = n.rsplit(" - ", 1)
        t = tail.strip()
        if t.lower() in FINISHES:
            extras.append(t.title())
            n = head.strip()
        elif not color and COLOR_RE.match(t):
            color, n = t, head.strip()
        else:
            break
    # or a trailing colour word: "Double Wall Cup 8oz White"
    if not color:
        m = TRAILING_COLOR_RE.search(n)
        if m and len(n) > len(m.group(0)) + 2:
            color, n = m.group(1), n[: m.start()].strip()
    sizes = [m.group(0).strip() for m in SIZE_RE.finditer(n)]
    rest = SIZE_RE.sub(" ", n)
    sizes += [w.title() for w in SIZE_WORDS.findall(rest)]
    rest = SIZE_WORDS.sub(" ", rest)
    # numbered sizes: "Bag #3", "Kraft Paper 20", "Carrier 4 Hole", "Eco Carrier Single"
    m = NUMBERED_SIZE_RE.search(rest) or TRAILING_NUMBER_RE.search(rest)
    if m and len(rest) > len(m.group(0)) + 3:
        sizes.append(m.group(1).strip())
        rest = rest[: m.start()]
    stem = re.sub(r"\s+", " ", rest).strip(" -+/,")
    sizes += extras
    return stem, " ".join(sizes), color.title()


def decode(raw):
    for enc in ("utf-8-sig", "cp1252"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", "replace")


def parse_price_list(text):
    """-> {"rows": [...], "warnings": [...]}.

    Each row has: section (the band the row sits under), product, sub, family,
    name, size, color, sku, note, supplier, unit_type, qty_per_unit,
    qty_per_box, unit_cost, unit_price, price, box_price, min_qty, status.

    The selling price is Unit Price x Qty Per Unit, the way the sheet's own
    Price column works. Where the sheet's Price column disagrees with that
    (someone typed over the formula) the row keeps the Price the sheet shows,
    so what clients are quoted does not move, and it is listed in the
    warnings to be looked at. Cost Price, Margin and the other computed
    columns are not read: Products works them out."""
    table = list(csv.reader(io.StringIO(text)))
    header_at = next((i for i, r in enumerate(table) if any(c.strip().lower() == "product name" for c in r)), None)
    if header_at is None:
        return {"rows": [], "warnings": ["No 'Product Name' column found - is this the price list export?"]}

    cols = {}
    for i, c in enumerate(table[header_at]):
        cols.setdefault(" ".join(c.split()).lower(), i)

    def col(*names):
        for n in names:
            if n in cols:
                return cols[n]
        return None

    c_status, c_cat, c_sub = col("status"), col("product"), col("sub")
    c_name, c_sku, c_desc, c_sup = col("product name"), col("sku"), col("description"), col("supplier")
    c_unit, c_qpu, c_qpb = col("unit type"), col("qty per unit"), col("qty per box")
    c_cost, c_uprice, c_price = col("unit cost"), col("unit price"), col("price")
    c_box, c_min = col("wholesale box price"), col("minimum qty")

    def cell(r, i):
        return r[i].strip() if i is not None and i < len(r) else ""

    rows, warnings, section = [], [], "Others"
    seen = set()
    for lineno, r in enumerate(table[header_at + 1:], start=header_at + 2):
        name = " ".join(cell(r, c_name).split())
        if not name:
            first = cell(r, 0)
            # a band heading: the name in column A and nothing else but the
            # stray "0.00%" the sheet leaves in the margin column of some
            if first and not any(c.strip() and not re.fullmatch(r"[\d.,\s%₱\-]+", c.strip()) for c in r[1:]):
                section = first
            continue
        family, size, color = split_name(name)
        key = (section.lower(), name.lower())
        if key in seen:
            warnings.append(f"Row {lineno}: '{name}' appears twice under {section} - the second one was skipped.")
            continue
        seen.add(key)

        qpu = number(cell(r, c_qpu))
        qty = qpu if qpu and qpu > 0 else 1.0
        unit_price = money(cell(r, c_uprice))
        sheet_price = money(cell(r, c_price))
        if unit_price is None and sheet_price is not None:
            unit_price = round(sheet_price / qty, 4)
        elif unit_price is not None and sheet_price is not None and abs(unit_price * qty - sheet_price) > 0.015:
            warnings.append(
                f"Row {lineno}: '{name}' - Unit Price {unit_price:g} x {qty:g} = {unit_price * qty:,.2f}, but the sheet's Price is "
                f"{sheet_price:,.2f}. Kept {sheet_price:,.2f}; check which is right."
            )
            unit_price = round(sheet_price / qty, 4)
        unit_cost = money(cell(r, c_cost))
        sheet_cost_price = money(cell(r, col("cost price")))
        if unit_cost is not None and sheet_cost_price is not None and abs(unit_cost * qty - sheet_cost_price) > 0.015:
            warnings.append(
                f"Row {lineno}: '{name}' - Unit Cost {unit_cost:g} x {qty:g} = {unit_cost * qty:,.2f}, but the sheet's Cost Price is "
                f"{sheet_cost_price:,.2f}. Products will use {unit_cost * qty:,.2f}."
            )
        if unit_price is None:
            warnings.append(f"Row {lineno}: '{name}' has no price.")
        rows.append({
            "section": section, "product": cell(r, c_cat), "sub": cell(r, c_sub),
            "family": family or name, "name": name, "size": size, "color": color,
            "sku": cell(r, c_sku), "note": cell(r, c_desc), "supplier": cell(r, c_sup),
            "unit_type": cell(r, c_unit), "qty_per_unit": qpu, "qty_per_box": number(cell(r, c_qpb)),
            "unit_cost": unit_cost, "unit_price": unit_price,
            "price": round(unit_price * qty, 2) if unit_price is not None else None,
            "box_price": money(cell(r, c_box)), "min_qty": number(cell(r, c_min)),
            "status": STATUS_MAP.get(cell(r, c_status).lower(), ""),
        })
    return {"rows": rows, "warnings": warnings}
