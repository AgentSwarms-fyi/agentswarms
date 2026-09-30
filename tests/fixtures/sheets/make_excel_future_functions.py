"""The functions Excel stores with a prefix, as XlsxWriter knows them (R172).

Excel writes functions added after 2007 as _xlfn.NAME (FILTER and SORT as
_xlfn._xlws.NAME); without it, Excel reads the name as unknown and shows
#NAME?. XlsxWriter's _prepare_formula carries the list. This writes one
name per line, _xlws ones marked, for sheetsFilePrefixes.test.ts.

    python tests/fixtures/sheets/make_excel_future_functions.py
"""

import inspect
import os
import re

import xlsxwriter.worksheet

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "excel-future-functions.txt")

src = inspect.getsource(xlsxwriter.worksheet.Worksheet._prepare_formula)
names = sorted(set(re.findall(r'"_xlfn\.((?:_xlws\.)?[A-Z0-9.]+)\(', src)))
with open(OUT, "w", encoding="utf-8", newline="\n") as fh:
    fh.write(f"# From XlsxWriter {xlsxwriter.__version__}'s _prepare_formula: one per line.\n")
    for n in names:
        fh.write(n + "\n")
print(OUT, len(names))
