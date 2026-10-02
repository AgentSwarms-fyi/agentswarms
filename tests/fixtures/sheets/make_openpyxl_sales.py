"""An .xlsx written by openpyxl (not ExcelJS), for the Sheets import tests.

It holds what Excel files commonly carry: theme and indexed colors, fonts,
fills, borders, alignment, wrap, merges, a hyperlink, column widths, a custom
row height, a hidden row and column, frozen panes, number formats with a
[Red] section, dates, shared formulas, a cross-sheet reference, a formula
using a function Sheets lacks (with no cached value, as openpyxl writes none),
and a sheet name with an apostrophe.
"""

import datetime
import sys

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.styles.colors import Color

out = sys.argv[1]
wb = Workbook()
ws = wb.active
ws.title = "Sales"

ws["A1"] = "Region"
ws["B1"] = "Q1"
ws["C1"] = "Q2"
ws["D1"] = "Total"
ws["E1"] = "Updated"
for c in "ABCDE":
    ws[f"{c}1"].font = Font(name="Arial", size=12, bold=True, color=Color(theme=0))
    ws[f"{c}1"].fill = PatternFill("solid", fgColor=Color(theme=4, tint=-0.249977111117893))
    ws[f"{c}1"].alignment = Alignment(horizontal="center", vertical="center")

rows = [("West", 1200, 1350), ("East", -350, 410), ("North", 980, 1010), ("South", 1500, 1720)]
for i, (region, q1, q2) in enumerate(rows, start=2):
    ws[f"A{i}"] = region
    ws[f"B{i}"] = q1
    ws[f"C{i}"] = q2
    ws[f"D{i}"] = f"=B{i}+C{i}"
    ws[f"E{i}"] = datetime.date(2024, 3, i)
    ws[f"E{i}"].number_format = "yyyy-mm-dd"
    for c in "BCD":
        ws[f"{c}{i}"].number_format = '#,##0;[Red]-#,##0'

thin = Side(style="thin", color="FF000000")
thick = Side(style="thick", color="FFC00000")
for r in range(1, 6):
    for c in "ABCDE":
        ws[f"{c}{r}"].border = Border(left=thin, right=thin, top=thin, bottom=thin)
ws["D6"] = "=SUM(D2:D5)"
ws["D6"].border = Border(top=thick, bottom=Side(style="double"))
ws["D6"].font = Font(bold=True, italic=True, strike=True, color=Color(indexed=10))

ws["A8"] = "A title merged across A8:D8"
ws.merge_cells("A8:D8")
ws["A8"].alignment = Alignment(horizontal="center")

ws["A10"] = "A long note that wraps inside its cell because Wrap Text is on"
ws["A10"].alignment = Alignment(wrap_text=True, vertical="top")
ws.row_dimensions[10].height = 45

ws["A12"] = "Docs"
ws["A12"].hyperlink = "https://example.com/handbook"

ws.column_dimensions["A"].width = 22
ws.column_dimensions["E"].width = 12.5
ws.column_dimensions["F"].hidden = True
ws.row_dimensions[14].hidden = True
ws["A14"] = "hidden row"
ws.freeze_panes = "B2"

other = wb.create_sheet("Bob's notes")
other["A1"] = "Total from Sales"
other["B1"] = "=Sales!D6"
other["A2"] = "Unknown function"
other["B2"] = "=CUBEVALUE(\"x\",\"y\")"
other["A3"] = "Growth"
other["B3"] = 0.1234
other["B3"].number_format = "0.0%"

ref = wb.create_sheet("Lists")
ref["A1"] = "=\'Bob\'\'s notes\'!B1*2"

wb.save(out)
print("wrote", out)
