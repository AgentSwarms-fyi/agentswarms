"""An .xlsx whose cells carry notes (Excel's comments), for the Sheets notes tests (R152).

openpyxl writes a cell comment as Excel's legacy note: xl/comments1.xml and a
VML drawing. Excel shows each as a red corner and the text on hover.

    python tests/fixtures/sheets/make_openpyxl_notes.py
"""

import os

import openpyxl
from openpyxl.comments import Comment

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "openpyxl-notes.xlsx")

wb = openpyxl.Workbook()
ws = wb.active
ws.title = "Budget"
ws["A1"], ws["B1"] = "Item", "Amount"
rows = [("Rent", 1200), ("Travel", 450), ("Software", 300)]
for i, (item, amount) in enumerate(rows, start=2):
    ws.cell(i, 1, item)
    ws.cell(i, 2, amount)
ws["B5"] = "=SUM(B2:B4)"

ws["B3"].comment = Comment("Two trips to the Lisbon office.\nReceipts in the shared drive.", "Asha")
ws["A4"].comment = Comment("Annual licences, paid in March.", "Ben")
ws["B5"].comment = Comment("Checked against the ledger on 30 Sep.", "Asha")
# A note on an empty cell: Excel keeps it, and so must Sheets.
ws["D2"].comment = Comment("Ask finance about Q4.", "Ben")

other = wb.create_sheet("Notes 2")
other["A1"] = "x"
other["A1"].comment = Comment("On the second sheet.", "Asha")

wb.save(OUT)
print(OUT)
