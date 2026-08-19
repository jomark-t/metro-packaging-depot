"""
Builds a printable payslip PDF (portrait A4, 4 quarter-page stubs per
sheet) from computed payroll data. Kept in its own module so app.py
stays focused on the payroll calculation logic.
"""

import os
from io import BytesIO

from reportlab.lib import colors
from reportlab.lib.enums import TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)

# reportlab's built-in Helvetica (a base-14 PDF font) has no glyph for the
# peso sign (u20B1) - it renders as a missing-glyph box. Arial does, and
# ships with Windows/most Mac installs, so embed it when available and
# fall back to Helvetica (peso sign will show as a box) otherwise.
BASE_FONT = "Helvetica"
BASE_FONT_BOLD = "Helvetica-Bold"
for _regular, _bold in [
    ("C:/Windows/Fonts/arial.ttf", "C:/Windows/Fonts/arialbd.ttf"),
    ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
    ("/Library/Fonts/Arial.ttf", "/Library/Fonts/Arial Bold.ttf"),
    ("/System/Library/Fonts/Supplemental/Arial.ttf", "/System/Library/Fonts/Supplemental/Arial Bold.ttf"),
]:
    if os.path.exists(_regular) and os.path.exists(_bold):
        pdfmetrics.registerFont(TTFont("PayslipSans", _regular))
        pdfmetrics.registerFont(TTFont("PayslipSans-Bold", _bold))
        BASE_FONT = "PayslipSans"
        BASE_FONT_BOLD = "PayslipSans-Bold"
        break

BLUE = colors.HexColor("#1c33bb")
GRAY = colors.HexColor("#555555")
LIGHT_GRAY = colors.HexColor("#888888")
BORDER = colors.HexColor("#CCCCCC")
NET_BG = colors.HexColor("#E7EAFA")

PAGE_W, PAGE_H = A4
MARGIN = 6 * mm
CELL_PADDING = 8
STUBS_PER_ROW = 2
STUBS_PER_PAGE = 6
STUB_W = (PAGE_W - 2 * MARGIN) / STUBS_PER_ROW
STUB_H = (PAGE_H - 2 * MARGIN) / (STUBS_PER_PAGE // STUBS_PER_ROW)
CONTENT_W = STUB_W - 2 * CELL_PADDING

tag_style = ParagraphStyle("tag", fontName=BASE_FONT_BOLD, fontSize=6.5, textColor=LIGHT_GRAY, leading=8)
name_style = ParagraphStyle("name", fontName=BASE_FONT_BOLD, fontSize=11.5, textColor=BLUE, leading=13.5)
role_style = ParagraphStyle("role", fontName=BASE_FONT, fontSize=8, textColor=GRAY, leading=9.5)
period_style = ParagraphStyle("period", fontName=BASE_FONT, fontSize=7.5, textColor=colors.black, leading=9.5)
label_style = ParagraphStyle("label", fontName=BASE_FONT, fontSize=8.5, textColor=colors.black, leading=11.5)
value_style = ParagraphStyle("value", fontName=BASE_FONT, fontSize=8.5, textColor=colors.black, leading=11.5, alignment=TA_RIGHT)
net_label_style = ParagraphStyle("net_label", fontName=BASE_FONT_BOLD, fontSize=10, textColor=BLUE, leading=13)
net_value_style = ParagraphStyle("net_value", fontName=BASE_FONT_BOLD, fontSize=10, textColor=BLUE, leading=13, alignment=TA_RIGHT)


def _money(amount):
    return f"₱{amount:,.2f}"


def _payslip_rows(person, ot_rate):
    """Returns (rows, deductions_start) - deductions_start is the row
    index where the SSS/Pag-IBIG/PhilHealth/HMO block begins, so the
    caller can draw a separator line above it."""
    if person.get("monthly_salary"):
        rows = [
            ("Monthly salary", _money(person["monthly_salary"])),
            ("Base pay (half-month)", _money(person["base_pay"])),
        ]
    else:
        rows = [
            ("Days worked", f"{person['days_worked']} d &times; {_money(person['daily_rate'])}"),
            ("Base pay", _money(person["base_pay"])),
        ]
    if person["has_bonus"]:
        rows.append(("Cup bonus", _money(person["bonus"])))
    if person.get("manual_bonus"):
        rows.append(("Bonus", _money(person["manual_bonus"])))
    rows.append((f"OT ({person['ot_hours']:g} h &times; {_money(ot_rate)})", _money(person["ot_pay"])))

    deductions_start = len(rows)
    # undertime prints as its own deduction rather than being netted off
    # the OT line above - Art. 88 forbids offsetting the two
    if person.get("undertime_hours"):
        rows.append((
            f"Undertime ({person['undertime_hours']:g} h &times; {_money(person['undertime_rate'])})",
            f"-{_money(person['undertime_deduction'])}",
        ))
    rows.append(("SSS", f"-{_money(person['sss'])}"))
    rows.append(("Pag-IBIG", f"-{_money(person['pagibig'])}"))
    rows.append(("PhilHealth", f"-{_money(person['philhealth'])}"))
    rows.append(("HMO", f"-{_money(person['hmo'])}"))
    if person.get("error_deduction"):
        rows.append(("Printing errors", f"-{_money(person['error_deduction'])}"))
    if person.get("cash_advance"):
        label = "Cash advance"
        # show what's left to repay after this deduction, so the stub
        # answers "how much do I still owe?" without anyone asking
        remaining = person.get("advance_outstanding_after")
        if remaining:
            label = f"Cash advance (bal. {_money(remaining)})"
        rows.append((label, f"-{_money(person['cash_advance'])}"))
    if person.get("absence_deduction"):
        rows.append(("Absence deduction", f"-{_money(person['absence_deduction'])}"))
    rows.append(("NET PAY", _money(person["net_pay"])))
    return rows, deductions_start


def _stub_flowables(business_name, person, period_label, pay_date_label, ot_rate):
    flow = [
        Paragraph(f"{business_name.upper()} &middot; PAYSLIP", tag_style),
        Paragraph(person["full_name"], name_style),
        Paragraph(person["role"], role_style),
        Spacer(1, 5),
        Paragraph(f"Period: {period_label}", period_style),
        Paragraph(f"Pay date: {pay_date_label}", period_style),
        Spacer(1, 7),
    ]

    rows, deductions_start = _payslip_rows(person, ot_rate)
    data = [[Paragraph(lbl, label_style), Paragraph(val, value_style)] for lbl, val in rows[:-1]]
    net_lbl, net_val = rows[-1]
    data.append([Paragraph(net_lbl, net_label_style), Paragraph(net_val, net_value_style)])

    line_table = Table(data, colWidths=[CONTENT_W * 0.6, CONTENT_W * 0.4])
    line_table.setStyle(
        TableStyle(
            [
                ("TOPPADDING", (0, 0), (-1, -1), 1),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 1),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                # separates earnings (days worked/base pay/bonus/OT) from
                # the SSS/Pag-IBIG/PhilHealth/HMO deduction lines below it
                ("LINEABOVE", (0, deductions_start), (-1, deductions_start), 0.6, BORDER),
                ("TOPPADDING", (0, deductions_start), (-1, deductions_start), 3),
                ("LINEABOVE", (0, -1), (-1, -1), 0.7, BLUE),
                ("TOPPADDING", (0, -1), (-1, -1), 3),
                ("BOTTOMPADDING", (0, -1), (-1, -1), 3),
                ("BACKGROUND", (0, -1), (-1, -1), NET_BG),
            ]
        )
    )
    flow.append(line_table)
    return flow


def build_payroll_pdf(business_name, period_label, pay_date_label, staff_payroll, ot_rate):
    buf = BytesIO()
    # Zero-padding frame: SimpleDocTemplate's default 6pt frame padding
    # (on top of the margins) would otherwise make the 2x2 stub grid a
    # hair too tall/wide for one page and split it across four pages.
    frame = Frame(
        MARGIN, MARGIN, PAGE_W - 2 * MARGIN, PAGE_H - 2 * MARGIN,
        leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0, id="normal",
    )
    doc = BaseDocTemplate(
        buf,
        pagesize=A4,
        pageTemplates=[PageTemplate(id="payslips", frames=[frame])],
        title=f"{business_name} Payslips - {pay_date_label}",
    )

    story = []
    groups = [staff_payroll[i : i + STUBS_PER_PAGE] for i in range(0, len(staff_payroll), STUBS_PER_PAGE)]
    num_rows = STUBS_PER_PAGE // STUBS_PER_ROW

    for gi, group in enumerate(groups):
        cells = [_stub_flowables(business_name, p, period_label, pay_date_label, ot_rate) for p in group]
        while len(cells) < STUBS_PER_PAGE:
            cells.append("")
        grid_data = [cells[r * STUBS_PER_ROW : (r + 1) * STUBS_PER_ROW] for r in range(num_rows)]
        grid = Table(
            grid_data,
            colWidths=[STUB_W] * STUBS_PER_ROW,
            rowHeights=[STUB_H] * num_rows,
        )
        grid.setStyle(
            TableStyle(
                [
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                    ("GRID", (0, 0), (-1, -1), 0.5, BORDER),
                    ("LEFTPADDING", (0, 0), (-1, -1), CELL_PADDING),
                    ("RIGHTPADDING", (0, 0), (-1, -1), CELL_PADDING),
                    ("TOPPADDING", (0, 0), (-1, -1), CELL_PADDING),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), CELL_PADDING),
                ]
            )
        )
        story.append(grid)
        if gi < len(groups) - 1:
            story.append(PageBreak())

    doc.build(story)
    pdf_bytes = buf.getvalue()
    buf.close()
    return pdf_bytes
