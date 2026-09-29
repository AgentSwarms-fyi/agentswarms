"""Excel 365's dynamic array formulas, as XlsxWriter writes them (R161).

The reference for how a download marks its own: a one-cell formula that
works over a range (=SUM(LEN(A1:A3)), which Excel before dynamic arrays
computes from one cell of it), a spilling FILTER, and a plain formula that
needs no mark. XlsxWriter writes Excel's own parts: the cells' cm="1", the
xl/metadata.xml part, its content type and the workbook's relationship.

    python tests/fixtures/sheets/make_xlsxwriter_dynamic.py
"""

import os

import xlsxwriter

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "xlsxwriter-dynamic.xlsx")

wb = xlsxwriter.Workbook(OUT)
ws = wb.add_worksheet("Data")
for i, word in enumerate(["one", "three", "eleven"]):
    ws.write(i, 0, word)
ws.write_dynamic_array_formula("B5:B5", "=SUM(LEN(A1:A3))", None, 14)
ws.write_dynamic_array_formula("D1:D2", "=_xlfn._xlws.FILTER(A1:A3,LEN(A1:A3)>3)", None, "three")
ws.write_formula("E1", "=LEN(A1)", None, 3)
wb.close()
print(OUT)
