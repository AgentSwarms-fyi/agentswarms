# Sheets

Spreadsheets with the Excel formulas people already know, over data far larger than a browser
could hold. Find them under **Data & BI → Sheets**.

A workbook holds two kinds of sheet:

| Sheet           | Where the data lives                             | How big                                            | What computes it |
| --------------- | ------------------------------------------------ | -------------------------------------------------- | ---------------- |
| **Grid sheet**  | The workbook itself (cells, formats, styles)     | Up to `SHEETS_MAX_CELLS` non-empty cells (200,000) | The browser      |
| **Table sheet** | A lakehouse table; the sheet keeps only its view | As large as the lakehouse holds                    | The lakehouse    |

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

| Keys                     | Does                                                                                                                                                      |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Typing                   | Replaces the active cell; **Enter**/**Tab** commit and move                                                                                               |
| Tab … Tab, Enter         | Enter returns to the column the row was started in, ready for the next row                                                                                |
| F2, double-click         | Edits the cell in place                                                                                                                                   |
| Arrows, Ctrl+arrows      | Move; Ctrl jumps to the edge of the data                                                                                                                  |
| Shift + arrows or click  | Extends the selection; the active cell stays where it started                                                                                             |
| Ctrl+A                   | Selects the sheet without moving the view                                                                                                                 |
| Delete                   | Clears contents (formats stay)                                                                                                                            |
| Ctrl+C / Ctrl+X / Ctrl+V | Copy, cut, paste. Formulas pasted inside the workbook shift; text from Excel or Google Sheets pastes as values, with `12%`, `$1,200` and dates recognised |
| Ctrl+D / Ctrl+R          | Fill down / right                                                                                                                                         |
| Ctrl+Z / Ctrl+Y          | Undo / redo, including row and column inserts                                                                                                             |
| Ctrl+B / Ctrl+I / Ctrl+U | Bold, italic, underline                                                                                                                                   |
| Ctrl+5                   | Strikethrough                                                                                                                                             |
| Ctrl+K                   | Insert or edit a link                                                                                                                                     |
| Alt+Enter                | A line break inside the cell (Wrap text turns on)                                                                                                         |
| Ctrl+mouse wheel         | Zoom                                                                                                                                                      |
| Ctrl+S                   | Save now                                                                                                                                                  |
| Ctrl+Shift+L             | Filter on or off                                                                                                                                          |
| Alt+Down                 | Open the active cell's list (data validation)                                                                                                             |

Drag the square at the corner of a selection to **fill**. Numbers and "Item 1, Item 2" continue as a
series, formulas shift, and anything else repeats.

The right-click menu inserts and deletes rows and columns. Every formula in the workbook that
pointed at the moved cells follows them, and one that pointed into deleted cells shows `#REF!`.
Merged cells, row heights and hidden rows and columns move with them. Renaming a sheet rewrites
the formulas that name it. Right-click a row or column header for its own menu: hide and unhide,
**Row height…** (in points, as Excel measures it) and **Column width…** (in characters).
**Paste values only** and **Paste formatting only** work on cells copied in the workbook.

A cell's menu also has **Insert cells…** and **Delete cells…**, as Excel's: shift the neighbouring
cells right or down (insert) or left or up (delete), or take whole rows or columns. Only the cells
in the block's rows (or columns) move. Formulas that pointed at a moved cell follow it, and one
that pointed into deleted cells shows `#REF!`. A range follows when it lies wholly in the rows (or
columns) that move, so `=SUM(A2:E2)` grows with a cell inserted into row 2, while `=SUM(C1:C9)`
stays. Rules, validations and charts over such a range move the same way. A merged cell that the
shift would cut in two is refused, with a note to unmerge it first.

The status bar shows the Average, Count and Sum of the selection, and the zoom (**−**, the level,
**+**). The zoom is remembered per sheet in your browser.

### Formatting

The ribbon's **Home** tab formats the selection, as Excel's does:

- **Font** and **size** (in points), bold, italic, underline, strikethrough, and **A+ / A−** to step
  the size through Excel's list.
- **Font color** and **Fill color**: theme colors in tints, the standard row, or any hex value. The
  half of the button with the color bar applies the last color chosen.
- **Borders**: bottom, top, left, right, all, outside, inside, thick outside, bottom double, or none,
  in thin, medium, thick, dashed, dotted or double lines of a chosen color.
- Horizontal and vertical alignment, indent, and **Wrap text**. A row grows to fit wrapped text or a
  larger font until you set its height yourself; double-click a row's lower edge to return it to fitting.
- **Merge & Center**, **Merge Across**, **Merge Cells** and **Unmerge**. Merging asks before it throws
  away any value but the upper-left one. A merged cell selects, moves and edits as one cell.
- The **format painter** copies the formats of the selection to the next cells you select.
- **Clear**: all, formats, contents or hyperlinks.

**View** turns gridlines off and on. **Insert → Link** (or Ctrl+K) links a cell to a web address, an
email, or a place in the workbook such as `#Summary!B6`. The link shows under the active cell;
Ctrl+click follows it. Only web (`http`, `https`), `mailto:` and in-workbook links are stored:
`javascript:` and other schemes are refused.

### Number formats

The **Number format** menu has General, Number, Integer, Percent, Currency, Scientific, Date, Date and
time, Time and Text, and the **$**, **%**, **,** and increase/decrease decimal buttons. It also accepts
any Excel format code (`#,##0.0`, `0.0%`, `"Q"0`, `yyyy-mm`); a section color such as
`#,##0;[Red]-#,##0` paints negatives red. Typing `12%`, `$1,200` or `2024-01-31` picks up the
matching format, as Excel does.

### Conditional formatting

**Home → Conditional** colors cells by their values, as Excel's menu does:

- **Highlight cells rules**: greater than, less than, between, equal to (a value, or a formula such
  as `=$D$1`), text that contains, a date occurring (yesterday, today, the last 7 days, this week,
  last month…), and duplicate or unique values.
- **Top/bottom rules**: the top or bottom N items or N percent, and above or below average.
- **Data bars**, **color scales** (two or three colors) and **icon sets** (arrows, traffic lights,
  symbols, flags, stars), drawn from the range's own numbers. A data bar for a negative number grows
  left from the zero line.
- **New rule with a formula**: a formula written for the range's first cell, such as `=$C2<0`, that
  moves with each cell as a copied formula would.
- **Manage rules** lists the sheet's rules in priority order: move one up or down, change the range
  it applies to, or delete it. Where two rules set the same thing, the higher one wins.
- **Clear rules** from the selected cells (the rest of each rule's range keeps it) or the sheet.

Rules move and grow with inserted and deleted rows and columns, and their formulas follow as cell
formulas do.

### Data validation

**Data → Data validation…** sets what the selected cells accept: a **list** (typed choices, or a
range such as `=$F$2:$F$9` or `=Lists!$A$2:$A$20`), a **whole number**, **decimal**, **date**,
**time** or **text length** in limits (values, or formulas such as `=B1`), or a **custom** formula
that must be TRUE (`=COUNTIF($A:$A,A2)=1`). **Ignore blank** lets a cell stay empty.

- A list shows a dropdown button beside the active cell; **Alt+Down** opens it.
- An **input message** shows under the cell while it is selected.
- A value that fails is met by the rule's **error alert**: **Stop** refuses it (Retry or Cancel),
  **Warning** asks (Yes keeps it, No returns to the edit), **Information** says so and keeps it. The
  alert shows the rule's own message, or a sentence naming the rule ("Enter a whole number between
  1 and 100").

### Filter and sort

**Data → Filter** (Ctrl+Shift+L) puts filter buttons on the header row of the data around the active
cell (or of the selection). A column's button sorts the range A to Z or Z to A, keeps the values you
tick (with a search box and counts), or keeps rows meeting a condition: equals, greater than,
between, top N, above average, contains, begins with, is blank and more. Rows that fail are hidden,
not deleted; the buttons of filtered columns change to a funnel. **Clear** shows every row,
**Reapply** runs the filters again after the data changed, and **Filter** again removes them.

**Data → Sort A to Z / Z to A** sorts the data around the active cell by its column, keeping a text
header row on top. Formulas move with their rows and are rewritten for the new row, as in Excel;
blanks sort last either way.

### Charts

**Insert → Chart** charts the selection, or the block of data around the active cell. The range is
read as Excel reads it: a first row of text names the series, a first column of text gives the
categories, and the series run down the columns when the range is at least as tall as it is wide
(across the rows otherwise; the dialog can set either). The dialog previews the chart as you
choose:

- **Column**, **Bar**, **Line**, **Area** (side by side, stacked, or 100% stacked), **Pie** and
  **Doughnut** (the first series, with percentages as labels), **Scatter** (the first column is x,
  the others y), **Column and line** (the first series as columns, the rest as lines) and **Radar**.
- A title, the legend's place (or none), data labels, smooth lines, and axis titles.

A chart floats over the grid and redraws whenever its cells change. Drag its top edge to move it,
its lower right corner to resize it; the pencil (or a double-click, or Enter) edits it and the bin
(or Delete) removes it. All of it undoes with Ctrl+Z. Inserting or deleting rows and columns moves
and resizes a chart's range as it does a formula's.

### Version history

**File → Version history** shows the workbook as it stood at earlier moments. A version is taken
automatically while people edit (at most one every `SHEETS_VERSION_INTERVAL_MINUTES`, 30), by hand
with a name (**Save version**), and before every restore. Each shows its time, how many sheets it
holds and its size.

- **Open a copy** creates a new workbook from the version, leaving this one as it is: the way to look
  at an old version, or to take one sheet back from it.
- **Restore** puts every sheet back as it was in that version. What is there now is saved as a
  version first ("Before restoring …"), so a restore can itself be undone from the same list.

A table sheet's version is its definition (source, calculated columns, filters); the lakehouse table
it reads is not copied. Automatic versions beyond `SHEETS_VERSIONS_MAX` (50) are removed oldest
first; named ones are kept.

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

## Excel and CSV files

**Import Excel or CSV** on the Sheets page starts a workbook from a file; **File → Import sheets
from Excel or CSV…** in a workbook adds a file's sheets to it. The file is read in the browser and
shown before anything is saved: each sheet, its size, and any name that has to change.

An `.xlsx` (or `.xlsm`; its macros are not kept) comes in with its formulas (shared and array
formulas, and Excel's `_xlfn.` names such as XLOOKUP and UNIQUE), number formats, fonts, fills,
borders, alignment and wrapping, merged cells, links, column widths, row heights, hidden rows and
columns, and gridlines. A sheet name with a character a formula cannot carry (`'`, `[`, `]`…) is
renamed, and every formula that named it follows.

A formula that uses a function Sheets does not compute yet (CUBEVALUE, a defined name, a link to
another workbook) shows **the value Excel last saved**, with a small amber mark and a note on hover
saying why it does not recalculate. It is kept exactly as written, so it goes back to Excel intact.
Editing it drops the saved value.

A CSV comes in as one sheet. The delimiter (`,` `;` tab or `|`) is detected; numbers, dates,
percentages and `1,200` are recognised as Excel does; text that would read as a formula (`=…`,
`@…`) stays text, so a CSV from elsewhere cannot run anything.

**File → Download as Excel (.xlsx)** writes the whole workbook: grid sheets as the editor holds
them (unsaved edits included), each formula with its current value and Excel told to recalculate on
open; table sheets as Excel tables named like the sheet, so `Orders[amount]` still works in Excel.
Excel refuses a sheet name longer than 31 characters, so a longer one is cut to fit in the file
(kept unique with ` (2)`), and every formula that names that sheet is rewritten to match.
A table sheet contributes the rows its view shows (its filters, sort and hidden columns), read
through the lakehouse, so your grants and row and column policies apply, up to
`SHEETS_EXPORT_MAX_ROWS` (100,000). **Download this sheet as CSV** writes the active sheet as it
is shown, UTF-8 with a byte-order mark so Excel reads accents correctly, and prefixes any text
that starts with `= + - @` with `'` so opening the file cannot run it.

Conditional formatting and data validation go both ways: every rule above is written as Excel's
own (a "does not contain", "begins with", blank or duplicate rule as the formula Excel's rule
means), and a file's rules come in as editable rules. A rule of a kind Sheets does not have yet is
left out and the import says how many. A date limit that is a formula (`=TODAY()`) is written as
the same test on a number, because the file library cannot write a formula into a date rule. The
AutoFilter's range goes both ways and its hidden rows stay hidden; the criteria of each column are
kept in Sheets only.

Charts go both ways too. A downloaded workbook carries each chart as an Excel chart over the same
cells (DrawingML parts beside the sheet, placed where the chart sits in the grid), so Excel draws
it from the data and redraws it when the data changes. An imported workbook's charts come in when
they chart a range of their own sheet with a type Sheets draws; one over another sheet's data, or of
a kind Sheets does not draw (a stock or 3-D chart), is left out and the import says so.

Not yet carried by files: the external-link part behind a formula such as `[1]Budget!B2` (its value
comes in; Excel may show `#REF!` for it when it recalculates the downloaded copy).

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

| Setting                           | Default | What it bounds                                                |
| --------------------------------- | ------- | ------------------------------------------------------------- |
| `SHEETS_MAX_CELLS`                | 200,000 | Non-empty cells one grid sheet may hold                       |
| `SHEETS_PAGE_ROWS`                | 500     | Rows a table sheet fetches per page while scrolling           |
| `SHEETS_UPLOAD_MAX_MB`            | 50      | The largest CSV an upload brings into the lakehouse           |
| `SHEETS_IMPORT_MAX_SHEETS`        | 100     | Sheets one Excel or CSV import may bring into a workbook      |
| `SHEETS_EXPORT_MAX_ROWS`          | 100,000 | Rows of a table sheet written into a downloaded .xlsx or .csv |
| `SHEETS_VERSION_INTERVAL_MINUTES` | 30      | The least time between two automatic versions of a workbook   |
| `SHEETS_VERSIONS_MAX`             | 50      | Automatic versions kept per workbook (named ones are kept)    |

All seven are editable under **Admin → Developer runtime**. A direct import from a connection is
also bounded by `WAREHOUSE_ABS_MAX_ROWS`. A larger result is refused, never truncated; land it with
an ETL pipeline and open that table instead.

See also: [Lakehouse](./LAKEHOUSE.md) · [Data sources](./DATA_SOURCES.md) ·
[Scale and limits](./SCALE_AND_LIMITS.md)
