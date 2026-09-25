# Sheets

Spreadsheets with the Excel formulas people already know, over data far larger than a browser
could hold. Find them under **Data & BI → Sheets**.

A workbook holds two kinds of sheet:

| Sheet          | Where the data lives                              | How big                                          | What computes it |
| -------------- | ------------------------------------------------- | ------------------------------------------------ | ---------------- |
| **Grid sheet** | The workbook itself (cells, formats, styles)      | Up to `SHEETS_MAX_CELLS` non-empty cells (200,000) | The browser      |
| **Table sheet** | A lakehouse table; the sheet keeps only its view | As large as the lakehouse holds                  | The lakehouse    |

Grid sheets are for models, assumptions and summaries. Table sheets are for data: millions of rows
scroll, sort, filter and total as quickly as a small table, because the engine does the work and
the browser only ever holds the rows on screen.

## Grid sheets

### Formulas

Type `=` and a formula, as in Excel. About 200 functions are available:

- **Totals:** SUM, AVERAGE, COUNT, COUNTA, SUMIF(S), COUNTIF(S), AVERAGEIF(S), MINIFS, MAXIFS,
  SUMPRODUCT.
- **Logic:** IF, IFS, IFERROR, IFNA, SWITCH, CHOOSE, AND, OR, XOR, NOT.
- **Lookups:** XLOOKUP, VLOOKUP, HLOOKUP, INDEX, MATCH, XMATCH.
- **Dynamic arrays:** UNIQUE, SORT, SORTBY, FILTER, SEQUENCE, TRANSPOSE.
- **Text and dates:** TEXT, VALUE, LEFT, MID, TEXTJOIN, DATE, EDATE, EOMONTH, DAYS.
- **The long tail** of statistical, financial and engineering functions.

The same rules as Excel apply:

- Precedence: `-2^2` is 4, `^` is left-associative, `&` joins text.
- Criteria are strings such as `">100"`, `"<>West"` and `"ap*"`.
- References can be relative or absolute (`$A$1`), whole columns (`A:A`), or cross-sheet (`'Sales Data'!D2`).
- Errors are `#DIV/0!`, `#N/A`, `#VALUE!`, `#REF!` and `#NAME?`. A cell with an error explains it when you hover over it.

A formula that returns several values (UNIQUE, FILTER, SORT, SEQUENCE) **spills** into the cells below and to the
right. If a typed value is in the way, the formula shows `#SPILL!` and says which cells it needs;
clear them and it spills again. A formula that reaches itself shows `#CYCLE!`.

While a formula is being typed:

- The list under the formula bar suggests function names. Press **Tab** to insert one.
- A hint shows the arguments of the function the caret is in.
- Clicking or dragging across cells inserts their reference, as Excel's point mode does.

Open parentheses are closed for you on **Enter**.

### Editing

| Keys                        | Does                                                                           |
| --------------------------- | ------------------------------------------------------------------------------ |
| Typing                      | Replaces the active cell; **Enter**/**Tab** commit and move                     |
| Tab … Tab, Enter            | Enter returns to the column the row was started in, ready for the next row     |
| F2, double-click            | Edits the cell in place                                                        |
| Arrows, Ctrl+arrows         | Move; Ctrl jumps to the edge of the data                                       |
| Shift + arrows or click     | Extends the selection; the active cell stays where it started                  |
| Ctrl+A                      | Selects the sheet without moving the view                                      |
| Delete                      | Clears contents (formats stay)                                                 |
| Ctrl+C / Ctrl+X / Ctrl+V    | Copy, cut, paste. Formulas pasted inside the workbook shift; text from Excel or Google Sheets pastes as values, with `12%`, `$1,200` and dates recognised |
| Ctrl+D / Ctrl+R             | Fill down / right                                                              |
| Ctrl+Z / Ctrl+Y             | Undo / redo, including row and column inserts                                  |
| Ctrl+B / Ctrl+I / Ctrl+U    | Bold, italic, underline                                                        |
| Ctrl+S                      | Save now                                                                       |

Drag the square at the corner of a selection to **fill**. Numbers and "Item 1, Item 2" continue as a
series, formulas shift, and anything else repeats.

The right-click menu inserts and deletes rows and columns. Every formula in the workbook that
pointed at the moved cells follows them, and one that pointed into deleted cells shows `#REF!`.
Renaming a sheet rewrites the formulas that name it.

The status bar shows the Average, Count and Sum of the selection.

### Formats

The **Number format** menu has General, Number, Integer, Percent, Currency, Scientific, Date, Date and
time, Time and Text. It also accepts any Excel format code (`#,##0.0`, `0.0%`, `"Q"0`, `yyyy-mm`).
Typing `12%`, `$1,200` or `2024-01-31` picks up the matching format, as Excel does.

### Saving

A workbook saves itself about a second after each change; the toolbar says where it stands.

Each sheet has a version. A save made from a copy of the sheet that is older than the one on the
server is refused, not written over it: two browser tabs cannot silently undo each other. The page then offers:

- **Reload theirs**: shows the saved sheet. Your other sheets keep their changes.
- **Keep mine**: writes your version over theirs.

Leaving the page with unsaved changes asks first.

## Table sheets

Add one from the **+** beside the sheet tabs → **Table sheet**. The data can come from:

- **Lakehouse**: any table you can read.
- **Data catalog**: a table in the catalog. A lakehouse table opens in place. A table in a
  connected database is copied into a new lakehouse table through its connection. Seeing a table
  in the catalog does not give access to its rows; its connection must be shared with you.
- **Connection**: a table or a read-only query on a database connection (Integrations → Data
  Sources), copied into a new lakehouse table in a schema you own.
- **Upload CSV**: a file of up to `SHEETS_UPLOAD_MAX_MB` (50 MB), with the first row as the header
  and column types detected, landed as a new lakehouse table.

An import always creates a new table. Naming an existing one is refused, never replaced. A table
imported from a connection has **Refresh from source**, which runs the import again and replaces
that table's rows. It asks first, because anything else reading the table sees the change.

The sheet's name is how formulas refer to it (`Orders[amount]`): letters, digits, `_` and `.`,
starting with a letter.

### Working with a table

- **Sort** from a column's menu, up to three columns deep. Text sorts without case, as in Excel.
- **Filter** with the funnel on a column. **Values** lists the column's values with their counts
  across the whole table, under the other filters. **Condition** covers equals, greater than,
  contains, begins with, blank and the rest. Filters show as chips above the table.
- **Hide** columns, and **resize** them by dragging the header edge.
- **Copy** selected cells with Ctrl+C.
- **Refresh** reads the table again.

Rows arrive `SHEETS_PAGE_ROWS` at a time (500) as they scroll into view. The row count and the time
the engine took are shown above the table.

### Calculated columns

**+ Column** adds a column computed by an Excel formula for each row:

```
=[@price] * [@qty]
=[@amount] / SUM([amount])
=IF([@region] = "west", "W", "Other")
=SUMIFS([amount], [customer], [@customer])
=XLOOKUP([@customer_id], Customers[id], Customers[name], "unknown")
=VLOOKUP([@amount], Rates, 2)
=TEXT([@order_date], "yyyy-mm")
```

- `[@column]` is this row's value.
- `[column]`, inside SUM, COUNTIFS and the like, is the whole column.
- `Other[column]` reads another table sheet of the workbook.

The formula is checked as you type, with the reason when it cannot work. It is then compiled into
the query the lakehouse runs, so a calculated column costs the same on ten million rows as on ten.

It follows Excel where SQL would differ:

- A blank counts as 0 in arithmetic and as "" in text.
- Text compares without case.
- MOD takes the divisor's sign.
- `DATE(2024, 13, 1)` rolls over to 2025-01-01.
- `&` writes 3, not 3.0.
- Criteria skip blank cells, except `"<>"`.
- VLOOKUP without a fourth argument is an approximate match on sorted data, as in Excel.

Where it cannot follow Excel, it says so:

- A table column has no error values. A division by zero or a failed conversion leaves that row
  **blank**, so one bad row never fails the column. IFERROR fills those blanks.
- A lookup returns the first match it finds. The rows of a table have no fixed order, so keys
  should be unique.
- Functions that return many values (UNIQUE, FILTER) and position-based ones (MATCH on its own)
  have no meaning for one row. The message suggests a pivot, a filter or INDEX(…, MATCH(…, 0)).

A formula that compiles but fails at run time on some row is isolated. That column shows empty with
the engine's reason, and the rest of the table still shows.

### Pivots

**Pivot** groups a table sheet's rows by some columns and totals others (sum, count, average,
min, max, count distinct). The pivot is itself a table sheet, computed by the lakehouse. You can sort
and filter it, add formula columns, look it up from other sheets and save it to the lakehouse.
**Change pivot** edits its definition and keeps its own sort and filters where the columns still exist.

## Formulas over table sheets in grid sheets

A grid cell can total or look up a table sheet of any size:

```
=SUMIFS(Orders[amount], Orders[region], A2)
=COUNTIFS(Orders[plan], "pro", Orders[amount], ">500")
=XLOOKUP("APAC", RevenueByRegion[region], RevenueByRegion[sum_revenue])
=AVERAGE(Orders[amount])
```

The browser sends the function, the column names and the other arguments' values. The lakehouse
computes the answer with the same compiler as calculated columns, so SUMIFS means the same thing
in both places. The cell shows `#BUSY!` for the moment it takes.

These functions are computed this way: SUM, AVERAGE, COUNT, COUNTA, COUNTBLANK, MIN, MAX, MEDIAN,
STDEV, VAR, SUMPRODUCT, SUMIF(S), COUNTIF(S), AVERAGEIF(S), MINIFS, MAXIFS, XLOOKUP, VLOOKUP,
INDEX/MATCH, RANK and ROWS.

A formula over a table sees every row of the table, not the sheet's filtered view, as a structured
reference does in Excel. Answers are kept until the table's formulas change, the table is
refreshed, or the workbook is reopened.

A whole table column read directly (`=Orders[amount]`) would bring every row to the browser. It shows
`#VALUE!` and names the functions to use instead.

## Saving to the lakehouse and the catalog

**Save to lakehouse** writes a new table in a schema you own:

- From a table sheet, it saves what the sheet shows: calculated columns, filters and sort applied,
  hidden columns left out.
- From a grid, it saves the selection, or the whole sheet when one cell is selected. The first row
  names the columns and the values are what the sheet computed. The dialog shows each column's
  detected type (whole number, decimal, text, TRUE/FALSE, date, date and time) and its name, and
  both can be changed.

A save never replaces a table.

With **Add it to the data catalog** (on by default), the table is registered at once:

- its columns, types and sample values, with PII-named columns flagged;
- its row count;
- you as its owner;
- the description and tags you give (it is also tagged `sheets`);
- **Certified** status if you ask for it, otherwise draft;
- **lineage** to the lakehouse tables it was computed from, through pivots and lookups.

The lakehouse catalog source is then re-crawled in the background. The source is created on first
use if you have none. If the table saves but the catalog step fails, the dialog says so and offers
to try the catalog step again on its own.

## Governance

A table sheet reads the lakehouse only through the same path as the Query editor:

- The same schema grants.
- The same row and column security policies.
- The same audit.

The SQL is built on the server from the sheet's settings, never taken as text from the browser.
Formulas are compiled with every name quoted and every value a literal.

Saving reads through the write path. A save that would copy a table under someone else's security
policy is refused.

Every import, save and catalog registration is audited as `lakehouse.import` with `via: sheets`.
Workbooks and sheets are audited as `sheet_workbook` and `sheet_tab` row changes.

Workbooks are private to their owner.

## Limits

| Setting                | Default | What it bounds                                              |
| ---------------------- | ------- | ----------------------------------------------------------- |
| `SHEETS_MAX_CELLS`     | 200,000 | Non-empty cells one grid sheet may hold                     |
| `SHEETS_PAGE_ROWS`     | 500     | Rows a table sheet fetches per page while scrolling         |
| `SHEETS_UPLOAD_MAX_MB` | 50      | The largest CSV an upload brings into the lakehouse         |

All three are editable under **Admin → Developer runtime**. A direct import from a connection is
also bounded by `WAREHOUSE_ABS_MAX_ROWS`. A larger result is refused, never truncated; land it with
an ETL pipeline and open that table instead.

See also: [Lakehouse](./LAKEHOUSE.md) · [Data sources](./DATA_SOURCES.md) ·
[Scale and limits](./SCALE_AND_LIMITS.md)
