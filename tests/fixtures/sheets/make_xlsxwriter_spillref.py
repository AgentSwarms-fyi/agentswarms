"""Excel 365's spill reference, A1#, as XlsxWriter writes it (R171).

In a file, A1# is _xlfn.ANCHORARRAY(A1). The reference for how a file's
spill references are read, and how a download must write them: a spilling
SEQUENCE, a formula over the whole spill, one that spills from it, and
spill references from another sheet, plain and quoted.

    python tests/fixtures/sheets/make_xlsxwriter_spillref.py
"""

import os

import xlsxwriter

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "xlsxwriter-spillref.xlsx")

wb = xlsxwriter.Workbook(OUT)
data = wb.add_worksheet("Data")
data.write_dynamic_array_formula("A1:A3", "=_xlfn.SEQUENCE(3)", None, 1)
data.write_dynamic_array_formula("C1:C3", "=_xlfn.ANCHORARRAY(A1)*2", None, 2)
data.write_dynamic_array_formula("E1:E1", "=SUM(_xlfn.ANCHORARRAY(A1))", None, 6)
other = wb.add_worksheet("My Sums")
other.write_dynamic_array_formula("A1:A1", "=SUM(_xlfn.ANCHORARRAY(Data!A1))", None, 6)
other.write_dynamic_array_formula("A2:A2", "=ROWS(_xlfn.ANCHORARRAY(Data!$C$1))", None, 3)
other.write_dynamic_array_formula("A3:A4", "=_xlfn.SEQUENCE(2)", None, 1)
data.write_dynamic_array_formula("G1:G1", "=SUM(_xlfn.ANCHORARRAY('My Sums'!A3))", None, 3)
wb.close()
print(OUT)
