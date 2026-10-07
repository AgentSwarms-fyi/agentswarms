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

## The Sheets page

The page opens on your workbooks, most recently edited first. Each one shows the corner of its first
grid sheet as it reads (values, bold, fills, the charts on it), its sheets, and when it was last
edited: any change to a sheet counts, not only a rename. The thumbnail is drawn by the editor
whenever the cells settle; a workbook not opened since thumbnails began gets one computed on the
server the first time the page shows it.

- **Search** (press `/`) finds a workbook by its name, its description or the name of any of its
  sheets; every word typed has to appear, and accents and case are ignored.
- **Sort** by last edited, name (Q2 before Q10) or date created, and switch between the grid of
  cards and a list. Both choices are remembered in this browser.
- **Start** makes a blank workbook or imports an Excel or CSV file.
- **Samples to explore** opens one of the sample workbooks below. It goes through the same import
  as any Excel file, so the preview shows its sheets first and it becomes your own workbook to
  change.

### Sample workbooks

Three real .xlsx files ship in `public/samples/sheets/`. They open in Excel as well as here.
`npm run sheets:samples` rebuilds them from `scripts/make-sheets-samples.ts`, with the same data
every time. The script refuses to write a file in which any formula errs.

| Sample                     | Sheets                                  | What it shows                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sales performance 2026** | Dashboard, Orders (240), Products, Reps | Order lines filled with XLOOKUP from the product list; revenue by month and region with `SUMIFS` between dates (`EDATE`); a best-product lookup with INDEX/MATCH; a leaderboard that re-sorts itself (`SORTBY`); open orders over $3,000 (`FILTER`). Returned orders are struck through by a formula rule, with data bars and a color scale. Dropdowns cover regions, SKUs from the product list, and status. Charts: line, stacked column, doughnut, and a combo of sold against target. |
| **Project tracker**        | Summary, Tasks, Team                    | Tasks late against `TODAY()` in red; blocked and done by text rules; a dropdown of owners from the Team sheet; a due date that must follow the start; each person's load against their hours. Charts: pie of tasks by status, radar of remaining work, bar of open hours.                                                                                                                                                                                                                 |
| **Budget and cash flow**   | Assumptions, Model, Scenarios           | A scenario picked in one cell (a dropdown) drives a 12-month model through INDEX/MATCH and XLOOKUP: customers, revenue, costs, net and cash, with negatives in red. Charts: combo of revenue, costs and net; area of cash; scatter of customers against revenue.                                                                                                                                                                                                                          |

The figures in each were checked against a separate calculation in Python from the files' own rows.
`tests/unit/sheetsSamples.test.ts` reads each file back and keeps those figures.

## Grid sheets

### Formulas

Type `=` and a formula, as in Excel. More than 400 of Excel's 510 functions are available:

- **Totals:** SUM, AVERAGE, COUNT, COUNTA, SUMIF(S), COUNTIF(S), AVERAGEIF(S), MINIFS, MAXIFS,
  SUMPRODUCT, SUMSQ, SUBTOTAL and AGGREGATE.
  - SUBTOTAL leaves out rows a filter hides, and with 101–111 rows hidden by hand too.
  - It skips other SUBTOTAL cells, so a total of subtotals counts nothing twice.
  - AGGREGATE takes Excel's 19 functions and 8 options (R327). Options 0–3 skip nested SUBTOTAL
    and AGGREGATE cells; 1, 3, 5 and 7 skip hidden rows, by hand or by a filter; 2, 3, 6 and 7
    skip error values, which makes `=AGGREGATE(14,6,A1:A9/(B1:B9="x"),1)` the largest A where B
    is "x".
- **Logic and names:** IF, IFS, IFERROR, IFNA, SWITCH, CHOOSE, AND, OR, XOR, NOT, LET.
- **Functions of your own** (R328): LAMBDA, and MAP, REDUCE, SCAN, BYROW, BYCOL, MAKEARRAY and
  ISOMITTED, which take one.
  - A LAMBDA is called where it is written, `=LAMBDA(x, x*2)(3)`, or given a name and called by
    it: by LET, `=LET(f, LAMBDA(x, x*2), f(A2))`, or in **Data → Names**, where `DOUBLE` referring
    to `LAMBDA(x, x*2)` makes `=DOUBLE(A2)` work in every sheet of the workbook.
  - A parameter in brackets may be left out: `LAMBDA(x, [y], IF(ISOMITTED(y), x, x+y))`.
  - A LAMBDA sees the LET names given before it, not those after, as in Excel.
  - A name may call itself, or another name that calls it back:
    `MYFACT` as `LAMBDA(n, IF(n<2, 1, n*MYFACT(n-1)))` makes `=MYFACT(5)` 120. A name spelled
    like one of Excel's functions (FACT, ISEVEN) is not called: the function is. As in Excel, a recursion
    is #NUM! when it reaches 1,024 ÷ (parameters + 1) calls: 511 deep for one parameter.
  - A cell holding a LAMBDA nobody calls shows #CALC!, as Excel's does, and other cells can't call
    it through the cell.
  - MAP's arrays must be the same size, and each call in MAP, SCAN, BYROW and BYCOL must give one
    value (an array there is #CALC!). MAKEARRAY makes up to a million cells.
  - A table sheet's column formula can't call one: compute it in a grid sheet.
- **Lookups and references:** XLOOKUP, VLOOKUP, HLOOKUP, LOOKUP, INDEX, MATCH, XMATCH, OFFSET,
  INDIRECT, ADDRESS, HYPERLINK, ISREF, ISFORMULA, FORMULATEXT. `INDIRECT(text, FALSE)` reads R1C1
  text (R327): `R2C3` is C2, and `R[-1]C` is the cell above the formula.
- **Dynamic arrays:**
  - UNIQUE, SORT, SORTBY, FILTER, SEQUENCE, RANDARRAY, TRANSPOSE;
  - TAKE, DROP, CHOOSECOLS, CHOOSEROWS, VSTACK, HSTACK, TOCOL, TOROW.
  - WRAPROWS, WRAPCOLS and EXPAND (R331), padding with #N/A unless told otherwise. WRAPROWS and
    WRAPCOLS take one row or one column, and EXPAND does not make an array smaller.
  - `A2#` is the whole range the formula in A2 spills into, however big it grows: `=SUM(A2#)`,
    `=XLOOKUP(x,A2#,C2#)`, `=A2#*10` (which spills too), and `Sheet2!A2#` from another sheet. A
    cell that does not spill (a value, a one-cell answer, a spill that is blocked) makes it #REF!.
    Copying, inserting rows and renaming the sheet move it as they move A2, and an Excel file holds
    it as `_xlfn.ANCHORARRAY(A2)`, both ways.
- **Text:** TEXT, VALUE, NUMBERVALUE, LEFT, MID, TEXTJOIN, TEXTSPLIT, TEXTBEFORE, TEXTAFTER.
  ARRAYTOTEXT and VALUETOTEXT (R331) write values as text, concise (`TRUE, 1, Seattle`) or strict
  (`{TRUE,1;"Seattle"}`, text quoted). LENB, LEFTB, RIGHTB, MIDB, FINDB, SEARCHB and REPLACEB count
  bytes as Excel does outside the double-byte languages: one per character, as LEN and the rest.
- **Sheets:** SHEET and SHEETS (R331). SHEET is a sheet's number among the tabs, table sheets and
  hidden ones counted, for this sheet, a reference, a name or a sheet's name as text (#N/A when
  there is no such sheet). It follows the tabs when they are moved. AREAS is 1 for any reference,
  as Sheets has no unions of ranges.
- **CELL and INFO** (R339). CELL tells about the upper-left cell of a reference: its "address",
  "row" and "col", "contents" (its value) and "type". The type is b for blank, l for text typed in,
  and v for anything else. From what Sheets keeps about the cell it also gives these:
  - "format", as CELL's page codes it: G, F2, ,0, C2-, P0, S2, and D1 to D9 for dates and times.
  - "color" and "parentheses".
  - "prefix": ' " and ^ for left, right and centred text.
  - "width": characters, rounded, and whether the width is the default.
  - "filename".

  CELL's page marks these as not supported in Excel for the web; Sheets answers them.
  - **"filename"** is `[file]sheet`, the file being the name a download gives the workbook
    (`[Plan.xlsx]Summary`). So `=MID(CELL("filename",A1),FIND("]",CELL("filename",A1))+1,255)` gives
    a sheet its own name. Excel's starts with the folder the file is in, and a workbook here has none.
    It follows a rename.
  - **"protect" is always 1.** Sheets has no sheet protection, and Excel locks every cell until it is
    unlocked.
  - **Without a reference**, Excel reads the cell selected when it calculates. Here CELL reads the
    formula's own cell.
  - **Updates.** A new format, alignment or column width updates CELL at once.
  - **INFO.** INFO's page says it is not available in Excel for the web. Sheets answers what a
    browser can know:
    - "numfile" is the workbook's sheets, and "recalc" is Automatic.
    - "release" is 16.0, the Excel whose formulas Sheets computes, so a workbook that tests the
      version takes Excel 365's branch.
    - "system" is pcdos or mac, and "osversion" is the browser's platform.
    - "origin" is $A:$A$1 and "directory" is "".
    - "memavail", "memused" and "totmem" are `#N/A`, as on the page.

- **Dates and times:** DATE, TIME, TIMEVALUE, EDATE, EOMONTH, DAYS, DAYS360, NETWORKDAYS(.INTL),
  WORKDAY(.INTL).
  - DAYS360 counts twelve 30-day months, the US (NASD) way or, with TRUE, the European way.
    WEEKDAY takes all of Excel's return types: 1 to 3, and 11 to 17 (the week from Monday to
    Sunday).
  - NETWORKDAYS from a later date back to an earlier one is minus the count forwards (Friday back to
    Monday is -5), times of day are dropped, and an error in a date is passed on, as in Excel.
  - Dates are counted as Excel counts them, with its 1900-02-29 included. Serial 1 is 1900-01-01,
    60 is the 29th of February 1900 (a day that never was, kept from Lotus 1-2-3), and 61 is
    1900-03-01. A blank cell read as a date is serial 0, which YEAR, MONTH and DAY read as 1900, 1
    and 0. DATEDIF in days is the difference of the serials, so 1900-02-28 to 03-01 is 2 days. A
    table sheet counts its dates the same way.
- **Regression** (R337): LINEST and LOGEST, with TREND and GROWTH computed from the same fit.
  - LINEST gives mn…m1 and b in a row. With `stats` TRUE, four more rows follow, as on its page:
    the standard errors, r² and sey, F and df, ssreg and ssresid. The cells those rows leave empty
    are `#N/A`, as is seb when `const` is FALSE. An empty `const` (`=LINEST(A2:A5,B2:B5,,FALSE)`)
    counts as TRUE, as in the page's first example.
  - With y in one column, each column of the x's is a variable; with y in one row, each row is.
    One variable may take any shape the y's have, and without x's they are 1, 2, 3…. x's that do
    not line up are `#REF!`, and a blank, text or TRUE among the values is `#VALUE!`.
  - A column the earlier ones (and the constant) already explain is left out of the model, as
    LINEST's page says: its coefficient and standard error are 0 and it adds 1 to df. The page
    calls the choice of which collinear column goes arbitrary. In Microsoft's GROWTH article,
    Excel's own output drops the later one, and Sheets does the same. A column counts as explained
    when less than 1e-10 of it is left over; Excel does not publish its tolerance.
  - LOGEST is LINEST of ln y. Its coefficients are e raised to LINEST's, and its statistics are
    LINEST's own. A y of 0 or below is `#NUM!`, in GROWTH too.
  - TREND and GROWTH give the fit's y at each new x. With several variables, each row of the new
    x's is one point (each column, when y is a row). With one variable, the new x's take any shape
    and the answer has the same shape. Without new x's they are the known ones.
  - A statistic that would divide by zero is `#NUM!`. For example, two points and a constant leave
    no degrees of freedom for the standard errors. Excel's pages do not say what Excel shows there.
- **Tests and more statistics** (R333): T.TEST, F.TEST, Z.TEST and CHISQ.TEST (and TTEST,
  FTEST, ZTEST, CHITEST), COVAR, PEARSON, STEYX, SKEW.P, STDEVPA, VARPA, MODE.MULT, PROB,
  SUMX2MY2, SUMX2PY2, SUMXMY2 and BINOM.DIST.RANGE.
  - T.TEST's type 1 is paired (the arrays must be the same size), 2 assumes equal variances and 3
    does not. Type 3 uses Welch's degrees of freedom unrounded, as Excel's T.TEST does; the Analysis
    ToolPak rounds them, so its p-values differ slightly.
  - MODE.MULT spills every most frequent value down a column, in the order they first appear.
  - PROB's probabilities must add up to 1 at Excel's 15 digits, so 0.7, 0.2 and 0.1 do.
- **Statistics:** STDEV, VAR, RANK, MODE, PERCENTILE and QUARTILE, under their old names and new
  ones; FORECAST(.LINEAR), TREND, GROWTH, FREQUENCY. Also AVERAGEA, MAXA and MINA (from a range,
  text counts as 0 and TRUE as 1), TRIMMEAN, QUARTILE.EXC, PERCENTRANK and its .INC and .EXC forms
  (truncated to three digits, as Excel does: 5 of 9 is 0.555), BINOM.DIST, and the T.DIST family
  (T.DIST, T.DIST.RT, T.DIST.2T, TDIST). VARP and VARA under their old names.
  - The distributions and their inverses: EXPON.DIST, POISSON.DIST, WEIBULL.DIST, HYPGEOM.DIST,
    NEGBINOM.DIST, CHISQ.DIST(.RT) and CHISQ.INV(.RT), GAMMA.DIST and GAMMA.INV, BETA.DIST and
    BETA.INV, F.DIST(.RT) and F.INV(.RT), LOGNORM.DIST and LOGNORM.INV, T.INV and T.INV.2T,
    BINOM.INV, CONFIDENCE.NORM and CONFIDENCE.T; GAMMA, GAMMALN(.PRECISE), FISHER, FISHERINV, PHI,
    GAUSS, STANDARDIZE, COMBINA, PERMUTATIONA; and the pre-2010 names (POISSON, CHIDIST, FDIST,
    TINV, BETADIST, LOGNORMDIST, CRITBINOM…) with their own arguments — BETADIST takes bounds,
    LOGNORMDIST is cumulative, FDIST and CHIDIST are the right tail, TINV is two-tailed.
  - A statistic with too few numbers answers Excel's error, never a number: a sample STDEV or VAR
    needs two (#DIV/0!), SKEW three and KURT four (#DIV/0!), a population STDEV or VAR one
    (#DIV/0!); LARGE, SMALL, PERCENTILE and QUARTILE of an empty list are #NUM!, GEOMEAN of nothing
    #NUM!, MODE #N/A; HARMEAN of any value of 0 or less is #NUM!.
- **Database functions:** DSUM, DAVERAGE, DCOUNT, DCOUNTA, DMAX, DMIN, DPRODUCT, DGET, DSTDEV,
  DSTDEVP, DVAR and DVARP, over a table whose first row names its columns, with a criteria range
  read as Excel reads one: its first row names fields (in any case), each row under it is one
  alternative (OR), the cells in a row must all hold (AND), a blank cell is no condition, and bare
  text means _begins with_ (`Ap` finds Apple) while `=Apple` is exact. DGET is #VALUE! when nothing
  matches and #NUM! when more than one record does. A criteria column whose label is not a field of
  the table matches nothing: Excel reads such a column as a formula criterion, which is not
  supported here.
- **Math, trigonometry and engineering** (R330, beside the ones of every spreadsheet): ACOSH,
  ASINH, ATANH, ACOT, ACOTH, COT, COTH, CSC, CSCH, SEC, SECH, FACTDOUBLE, MULTINOMIAL,
  SERIESSUM, SQRTPI, CEILING.PRECISE, FLOOR.PRECISE, ISO.CEILING, DELTA, GESTEP, ERF (from 0, or
  between two limits), ERF.PRECISE, ERFC, ERFC.PRECISE, BESSELI, BESSELJ, BESSELK, BESSELY, MUNIT,
  MDETERM and MINVERSE.
  - ERF and ERFC are right to about 16 digits, far out too: `ERFC(5)` is 1.53745979442803E-12.
  - COT, CSC and SEC (and the hyperbolic three) take an angle below 2^27 in size, as Excel's do,
    and 1/0 is #DIV/0!. ACOT is from 0 to π.
  - FACTDOUBLE(-1) is 1, as in Excel, and below that #NUM!. A Bessel order is truncated, and one
    below 0 is #NUM!.
  - CONVERT (R332) takes every unit on Excel's page, in its groups: mass, distance, time,
    pressure, force, energy, power, magnetism, temperature, volume, area, information and speed.
    Units are case-sensitive, as in Excel (`"lbm"`, not `"LBM"`). The SI prefixes go on the metric
    units (`"km"`, `"kWh"`, `"ml"`), and on a square or a cube they are squared or cubed with it
    (`"cm2"` is 1E-4 m²). The binary prefixes (`"ki"`, `"Mi"`, `"Gi"`…) go on bits and bytes only. A
    unit it does not know, or two of different groups, is #N/A, and the cell says which. Excel's page
    gives 6 gallons as 22.71741274 litres; they are 22.712470704 (3.785411784 L each), which is
    what CONVERT answers.
  - MINVERSE of a matrix with no inverse is #NUM!. MDETERM is exact to about 16 digits, as
    Excel's page says of its own: the 4×4 example on that page shows 88.
- **Complex numbers:** all twenty-five of Excel's — IMSUM, IMSUB, IMPRODUCT, IMDIV, IMCONJUGATE,
  IMPOWER, IMSQRT, IMABS, IMREAL, IMAGINARY, IMARGUMENT, IMEXP, IMLN, IMLOG10, IMLOG2, and the
  trigonometric and hyperbolic ones (IMSIN … IMCSCH) — over Excel's text form (`3+4i`, `2-j`,
  `1E-07+2i`) or a plain number. An answer keeps the suffix its arguments used, a mix of `i` and `j`
  is #VALUE!, a zero part is dropped and a unit written `i` alone, and every number is written to
  fifteen significant digits as Excel writes one (`IMDIV("1","3")` is `0.333333333333333`). Angles
  are in (−π, π], so the negative real axis is at π: `IMSQRT("-4")` is `2i`, `IMLN("-1")` is
  `3.14159265358979i`. Text that is not a complex number is #NUM!, TRUE or FALSE #VALUE!, a pole
  (`IMCOT("0")`) or an overflow #NUM!. IMSUM and IMPRODUCT read ranges and pass over blank cells; a
  blank single argument counts as 0 (Excel's own answer for a blank is unconfirmed).
- **Matrices, bits and types:** MMULT spills its product; BITAND, BITOR, BITXOR, BITLSHIFT,
  BITRSHIFT; COMPLEX writes Excel's text form (`3+4i`); TYPE (1 number, 2 text, 4 logical, 16 error,
  64 array) and ERROR.TYPE (2 for #DIV/0!, 7 for #N/A…).
- **The long tail** of statistical, financial and engineering functions.
  - CEILING, FLOOR and their .MATH forms land on the multiple a decimal step names
    (`=FLOOR(4.35,0.05)` is 4.35), and a positive number with a negative step is #NUM!, as in
    Excel. GCD and LCM truncate to whole numbers and refuse negatives. Hexadecimal comes out in
    capitals, and all twelve base conversions are there (DEC2HEX, HEX2BIN, OCT2HEX…).
  - For loans and investments, beside PMT, IPMT, PPMT, FV, PV, NPER, RATE, NPV, IRR, XNPV and XIRR:
    CUMIPMT and CUMPRINC (interest and principal between two periods), MIRR (which skips blank
    flows, as IRR does), FVSCHEDULE, SYD, ISPMT, PDURATION and RRI.
  - For securities (R335): the coupon schedule (COUPDAYBS, COUPDAYS, COUPDAYSNC, COUPNCD, COUPNUM,
    COUPPCD), the discount family (DISC, INTRATE, PRICEDISC, RECEIVED, YIELDDISC), ACCRINTM,
    PRICEMAT and YIELDMAT, the Treasury bills (TBILLEQ, TBILLPRICE, TBILLYIELD), and DOLLARDE and
    DOLLARFR. They take Excel's five day-count bases: 0 US 30/360, 1 actual/actual, 2 actual/360,
    3 actual/365 and 4 European 30/360. A coupon schedule from a month's last day stays on last
    days, and COUPNCD and COUPPCD return date numbers, so format them as dates. Dates, the
    frequency and the basis are truncated; a frequency other than 1, 2 or 4, a basis past 4, or
    settlement on or after maturity is #NUM!, as on Excel's pages.
  - Bonds (R336): PRICE, YIELD, DURATION, MDURATION, ACCRINT, ODDFPRICE, ODDFYIELD, ODDLPRICE and
    ODDLYIELD, each from its page's equation, and AMORDEGRC and AMORLINC (French depreciation, with
    no basis 2). YIELD and ODDFYIELD solve their price function for the yield; with one period
    left YIELD uses its page's closed form. DURATION times each cash flow from the days to the next
    coupon (DSC/E), as its page's 10.9191453 requires. ACCRINT sums its page's quasi-coupon
    periods: with settlement past the first interest date it can differ from a YEARFRAC-based
    figure (LibreOffice's), and follows Excel's page. AMORDEGRC is checked against its page for
    periods 0 and 1; later periods follow the add-in's algorithm and have not been checked
    against Excel.
  - YEARFRAC uses the same day counts (R335). It now counts a 31st as the 30th under European
    30/360, and takes a 366-day year only for a span that holds a February 29th.
  - Excel's DISC page prints 0.001038 for 1 July 2018 to 1 January 2048. Those dates give 0.000686;
    0.001038 is what a maturity in 2038 gives. DISC answers for the dates you give it.
  - VDB depreciates from one period to another by declining balance (double, unless a factor is
    given) and switches to straight line over what is left once that is larger, unless its last
    argument is TRUE. A part period takes its share of that period, so `=VDB(2400,300,10,0,0.875,1.5)`
    is 315 and the pieces of a life add up to cost − salvage. A span that ends before it starts or
    after the life, a negative number, a factor of 0 or a salvage above the cost is #NUM!.
  - They read their arguments as Excel does. In a range, a blank cell is not a 0, and text and TRUE
    are left out, so `=GEOMEAN(A1:A3)` over 1, a blank and 3 is 1.73 and `=NPV(0.1,A1:A3)`
    discounts two payments, not three. STDEVA counts text as 0 and TRUE as 1, and still skips
    blanks.
  - CORREL, SLOPE, INTERCEPT, RSQ, COVARIANCE and FORECAST read their two ranges side by side, and
    leave out a row where either is not a number.
  - Data that do not vary give `#DIV/0!`, as on each function's page (R337). SLOPE, INTERCEPT and
    FORECAST do so when the x's do not vary; CORREL, PEARSON and RSQ when either list does not. With
    no pairs at all each is `#N/A`, except CORREL, which is `#DIV/0!`.
  - VSTACK, HSTACK, TAKE, DROP, CHOOSECOLS and CHOOSEROWS take one value as a one-cell array, so
    `=VSTACK("Name",A2:A9)` puts a heading over a list. A RANK of a number not in the list is
    `#N/A`.

The same rules as Excel apply:

- Precedence: `-2^2` is 4, `^` is left-associative, `&` joins text.
- A number joined into text (`=A1&"-"&B1`, LEN, LEFT, TEXTJOIN) is written to 15 significant digits,
  as Excel writes it: 123456789012 stays whole (`LEN` 12), `=1/3&""` is `0.333333333333333`, and
  `=0.1+0.2&""` is `0.3`. From 1E+15 up, and under 1E-9, it is written in scientific notation. The
  cell itself still shows a long number the way a narrow cell does (`1.23457E+11`).
- General shows ten significant digits, and a whole part of eleven digits in full:
  12345678901.005 shows as `12345678901`. Numbers from 1E+11 up and under 1E-6 show in scientific
  notation with a two-digit exponent (`1.5E-07`).
- A General number wider than its column is rounded to fit, as in Excel (R334). It keeps fewer
  decimals while a digit that is not 0 is left, so 0.000308192017 shows as `0.000308192`, then
  `0.000308` and `0.0003` as the column narrows. Then it moves to scientific notation with fewer
  digits: `3E-04`, and `1.23E+08` for 123456789. It is rounded from the 15 digits Excel keeps, so
  2.675 shows as `2.68`. Only when nothing fits does it show `####`. A number with a format of its
  own (`0.00`, a currency, a date) shows `####` when it does not fit, as in Excel.
- A number format past 15 digits shows 15 and then zeros, as Excel does:
  `=TEXT(12345678901234567,"#,##0")` is `12,345,678,901,234,600`, and `=TEXT(1.5E+21,"0")` writes
  out all 22 digits.
- CEILING, FLOOR and their .MATH forms read the quotient at the same 15 digits:
  `=CEILING(0.0000000001,1)` is 1 and `=CEILING(5.0000000001,1)` is 6, while `=FLOOR(0.3,0.1)` is
  still 0.3.
- A number format and TEXT() round the 15 digits Excel keeps, as ROUND does. 2.675 is stored a
  hair under 2.675, but `=TEXT(2.675,"0.00")` and a cell formatted `0.00` both show 2.68, and
  `=TEXT(0.01+0.075,"0.00")` is 0.09. TEXT of a blank cell is TEXT of 0 (`0.00`).
- ROUND, ROUNDUP, ROUNDDOWN and TRUNC round the same 15 digits: `=ROUND(1.005,2)` is 1.01, and
  `=TRUNC(0.29,2)` is 0.29 (TRUNC is ROUNDDOWN, as in Excel).
- `=`, `<>`, `<`, `>`, `<=` and `>=` compare numbers to the 15 significant digits Excel keeps
  (R327): `=0.1+0.2=0.3` is TRUE, and `=(0.1+0.2)>0.3` is FALSE. MATCH, the lookups and sorting
  compare the stored values, as Excel's do, so a lookup of a computed value can still miss; ROUND
  it first.
- UPPER and LOWER change case one character for one, as Excel does (R327): `=UPPER("straße")` is
  `STRAßE`, `=LOWER("İ")` is `i`, and a final Σ lowers to σ.
- PROPER capitalises the first letter of each word in any alphabet: `=PROPER("ÉCOLE normale")` is
  `École Normale`. As in Excel, anything that is not a letter starts a word, so `o'neil 2-way`
  becomes `O'Neil 2-Way`. A letter whose capital is two letters, such as `ß`, stays as it is.
- Criteria are strings such as `">100"`, `"<>West"` and `"ap*"`.
- References can be relative or absolute (`$A$1`), whole columns (`A:A`), or cross-sheet (`'Sales Data'!D2`).
  - A whole column is all 1,048,576 rows, as in Excel, and a whole row all 16,384 columns.
    `ROWS(A:A)` is 1,048,576, and `COUNTBLANK(A:A)` and `COUNTIF(A:A,"<>x")` count the blank rows
    below the data.
  - `INDEX(A:A,500)` below the data is an empty cell, not `#REF!`.
  - Arithmetic over a whole column counts the blank rows too: `SUMPRODUCT(--(A:A=""))`,
    `SUM(--(A:A=""))` and `COUNT(IF(A:A="",1))` all give the number of blank rows, and
    `MATCH(TRUE,INDEX(A:A="",0),0)` the first empty one.
  - A whole column spilled into the grid (`=A:A=""` in a cell) shows only the rows the sheet uses.
  - ROW and COLUMN of a range give every row (as a column) and every column (as a row), as Excel's
    do (R337). `=SUMPRODUCT((A1:A9="x")*ROW(A1:A9))` sums the matching rows, and LINEST's page's
    `=LINEST(y, x^COLUMN($A:$C))` fits a cubic. `ROW(A:A)` is the exception to the million rows
    above: it runs to the rows the sheet uses, where Excel's runs to row 1,048,576.
    `MAX((A:A<>"")*ROW(A:A))` still finds the last row; the blank rows below the data are not
    numbered.
- Array formulas work element by element, as in Excel's dynamic arrays:
  - A function of one value given a range answers for each cell: `ISNUMBER(SEARCH("x",A2:A9))`,
    `LEN(A2:A9)`, `ROUND(B2:B9,0)`, `SUM(SIN(A2:A9))`, `PMT(5%/12,360,-B2:B9)`,
    `NORM.S.DIST(A2:A9,TRUE)`. Every function whose arguments each take one value does this
    (R329): the math, trigonometry, number-system, complex-number, distribution, loan,
    depreciation and date functions. One that takes a list (GCD, NPV, IMSUM, the statistics) takes
    the whole range, and NETWORKDAYS and WORKDAY take their start and end one by one but their
    holidays as one list, down a column or across a row.
  - So does the one value of a lookup or a criterion: `MATCH(A2:A9,list,0)`,
    `SUM(COUNTIF(A:A,{"apple","cherry"}))`.
  - `IF` over a range takes each branch's cell in the same place, so `MAX(IF(A2:A9="West",C2:C9))`
    and `TEXTJOIN(",",TRUE,IF(C2:C9>100,A2:A9,""))` work. `IFERROR` and `IFNA` replace each error
    on its own.
- A formula whose answer is an empty cell (`=A500`, a gap in a spilled range) shows 0, as in Excel.
- Errors are `#DIV/0!`, `#N/A`, `#VALUE!`, `#REF!` and `#NAME?`. A cell with an error explains it when you hover over it.
- A value a function's page in Excel's documentation refuses gets the error that page names
  (R329): `FACT(-1)` and `NORM.INV(0,0,1)` are `#NUM!`, `ROMAN(4000)` is `#VALUE!`, `ATAN2(0,0)`
  and `LOG(10,1)` are `#DIV/0!`. The same holds for the inverse distributions at their bounds,
  EXPON.DIST, POISSON.DIST and WEIBULL.DIST below 0, PERMUT, QUOTIENT, BASE and
  CONFIDENCE.NORM.

A formula that returns several values (UNIQUE, FILTER, SORT, SEQUENCE) **spills** into the cells below and to the
right. If a typed value is in the way, the formula shows `#SPILL!` and says which cells it needs;
clear them and it spills again. A formula that reaches itself shows `#CYCLE!`.

**`@`** takes one value where a range would spill, as in Excel 365: from a column, the cell in the
formula's own row (`=@A2:A9` in row 5 is A5); from a row, the cell in its own column; from a block,
the cell in both. Outside the range it is `#VALUE!`, and from an array it is the first value.

While a formula is being typed:

- The list under the formula bar suggests function names and the workbook's names. Press
  **Tab** to insert one.
- A hint shows the arguments of the function the caret is in.
- Clicking or dragging across cells inserts their reference, as Excel's point mode does. Dragging
  across the whole of a spilled array inserts its spill reference, `A2#`, so the formula follows the
  array when it grows or shrinks; part of it is an ordinary range, and a spill that is blocked has
  no `A2#`.

Open parentheses are closed for you on **Enter**.

### Named ranges

A name stands for cells, a range or a value, and formulas use it as Excel's do:
`=SUM(Revenue)*TaxRate`. Names belong to the workbook, so any sheet can use them.

- **Name the selection.** Select the cells, type a new name in the **Name box** (left of the
  formula bar) and press Enter. The name refers to the cells absolutely, with their sheet:
  `Data!$B$2:$B$13`.
- **Go to a name.** Type it in the Name box (its list offers the names for cells), and the cells
  are selected, on their own sheet. When the selection is exactly a name's cells, the Name box
  shows the name.
- **Data → Names** lists every name, what it refers to and what it comes to now, such as
  `{10;20;30} (3×1)`. There you add, edit, rename and delete names, with an optional comment. A
  name can refer to a value (`0.2`) or a formula (`Data!B2*TaxRate`); a reference typed without
  its sheet is kept on the active one.
- **Renaming a name** renames it in every formula that uses it: cells, conditional formatting and
  validation rules, and other names. Deleting one leaves those formulas showing `#NAME?`.
- **Names follow the cells.** Inserting or deleting rows or columns, inserting or deleting cells, and
  renaming a sheet move a name as they move formulas. Deleting all of a name's cells makes it
  `#REF!`. Undo puts the names back with the cells.
- A name for cells is a reference wherever a function takes one: `ROWS(Revenue)`,
  `INDEX(Revenue,2)`, `OFFSET(Revenue,1,0)`, `SUMIFS(Revenue,Region,"West")`. A name that refers
  to itself shows `#CYCLE!`. LET's own names come before the workbook's.
- A name can hold a LAMBDA, and formulas then call it like a function (R328): `DOUBLE` as
  `LAMBDA(x, x*2)` makes `=DOUBLE(B2)`. Such a name may call itself; see Functions of your own.

A name follows Excel's rules: it starts with a letter or `_`, holds letters, digits, `.` and `_`, and
cannot read as a cell (`A1`, `R1C1`) or as TRUE or FALSE. Case does not matter. A workbook keeps up
to 1,000. Names are kept in each version and restored with it. Someone whose share leaves a sheet
out is not sent the names that refer to it.

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
| Ctrl+F / Ctrl+H          | Find / Find and replace (below)                                                                                                                           |
| Alt+Enter                | A line break inside the cell (Wrap text turns on)                                                                                                         |
| Ctrl+mouse wheel         | Zoom                                                                                                                                                      |
| Ctrl+S                   | Save now                                                                                                                                                  |
| Ctrl+Shift+L             | Filter on or off                                                                                                                                          |
| Alt+Down                 | Open the active cell's list (data validation)                                                                                                             |

Drag the square at the corner of a selection to **fill**. Formulas shift, a series continues, and
anything else repeats, as Excel's AutoFill does:

- **Numbers** with a step (2, 4 → 6, 8); one number alone repeats.
- **Dates and times:** one date goes on by the day, across month ends, and one time by the hour; dates on the same day of their months
  go on by the month (15 Jan, 15 Feb → 15 Mar), ending short months on their last day, or by the
  year; others by their step in days.
- **Months and days of the week** by name (Jan → Feb, Monday → Tuesday, Mon, Wed → Fri), in the
  same short or long form and case, round the year and the week.
- **Quarters:** Q3 → Q4, Q1 (also `Qtr 1` and `Quarter 1`).
- **Text ending in a number:** Item 9 → Item 10.

The right-click menu inserts and deletes rows and columns. Every formula in the workbook that
pointed at the moved cells follows them, and one that pointed into deleted cells shows `#REF!`.
Merged cells, row heights and hidden rows and columns move with them. New rows take the formats
of the row above, and new columns those of the column to the left, as Excel's default Insert Options
("Format Same As Above"): a row inserted into a table of dollars is dollars, with its borders and
fill. At the top edge, with no row above, they take the row below's (the column to the right's at
the left edge). Only formats come across, never values, notes or links. Renaming a sheet rewrites
the formulas that name it, in cells and in rules alike: a validation list over `=Lists!$A$2:$A$9`,
or a conditional format's formula, follows the new name. Right-click a row or column header for its
own menu: hide and unhide,
**Row height…** (in points, as Excel measures it) and **Column width…** (in characters).
**Paste values only** and **Paste formatting only** work on cells copied in the workbook.

**Paste special…** (Ctrl+Alt+V, or the cell's menu) is Excel's Paste Special, for cells copied in
the workbook.

- **Paste.** All; Formulas (the target keeps its formats); Values (what the cells showed); Values and
  number formats; Formats; or Notes.
- **Operation.** Add, subtract, multiply or divide each copied number into the cell it lands on. A
  formula there keeps its formula (`=(LEN(B2))+16`), a blank counts as 0, and text on either side
  leaves the cell as it is. The cell keeps its formats, and dividing by zero shows `#DIV/0!`.
- **Skip blanks.** A blank copied cell leaves its target alone.
- **Transpose.** Rows become columns: A1:E1 pasted at K1 fills K1:K5. A formula's references move
  to where it lands.

It is one Ctrl+Z. After a cut it is refused, as in Excel: what was cut moves whole.

A cell's menu also has **Insert cells…** and **Delete cells…**, as Excel's: shift the neighbouring
cells right or down (insert) or left or up (delete), or take whole rows or columns. The dialog starts
on the way the selection's shape suggests: sideways for a selection taller than it is wide (B8:B12
shifts right), up or down otherwise, one cell included. Only the cells
in the block's rows (or columns) move. Formulas that pointed at a moved cell follow it, and one
that pointed into deleted cells shows `#REF!`. A range follows when it lies wholly in the rows (or
columns) that move, so `=SUM(A2:E2)` grows with a cell inserted into row 2, while `=SUM(C1:C9)`
stays. Rules, validations and charts over such a range move the same way, and the formulas inside
rules follow moved cells as cell formulas do: a list over `=$E$1:$E$3` still lists the same three
cells after they shift down. A merged cell that the shift would cut in two is refused, with a note
to unmerge it first. The new cells take the formats of the cells above them (shifted down) or to
their left (shifted right), and cells beside the block keep their own.

The status bar shows the Average, Count and Sum of the selection, and the zoom (**−**, the level,
**+**). The zoom is remembered per sheet in your browser.

### Sheet tabs

A sheet tab's menu (the arrow on the tab) renames, duplicates, moves, hides and deletes the sheet.

- **Duplicate** adds a copy at the end of the tabs, named like `Summary (2)`. It has the same
  cells, formats, rules, notes and charts, and its formulas work on its own cells, as a copy in
  Excel does.
- **Hide** takes the sheet off the tab bar. Its cells stay, and formulas read them as before.
  **Unhide ▸** lists the hidden sheets; picking one shows it and goes to it. Hiding the sheet in
  view moves to the next one showing. Ctrl+Z takes back a Hide or an Unhide, and a hidden sheet
  is never left on screen.
- A workbook keeps at least one sheet showing, so hiding or deleting the last one is refused.
  That holds for two deletes arriving at the same moment too: the count that decides is taken
  after the delete, and a delete that turns out to have taken the last sheet puts it back whole,
  cells and all, and says so (R246). If a workbook does end up with no sheets, it says that
  plainly and offers to add one, rather than sitting on "Opening…".
- **Delete** asks first, and says what goes. A grid sheet's cells go with it, and formulas
  elsewhere that refer to it show #REF!. A table sheet has no cells: only the sheet goes, and the
  lakehouse table (or the query's tables, or the sheet a pivot sums up) stays; a table Sheets held
  — rows uploaded or imported into it — can be changed from the Lakehouse again. Formulas and
  pivots that use a deleted table sheet show an error.
- Moving a tab passes over the hidden sheets beside it, and Find leaves hidden sheets out, as
  Excel's does.
- Only grid sheets can be hidden or duplicated for now.

Hiding a sheet does not keep it from anyone: it is sent to everyone the workbook is shared with.
To keep a sheet from someone, leave it out of their share (see [Sharing](#sharing)).

### Find and replace

**Ctrl+F** (or **Home → Find**) opens Find over the grid, and **Ctrl+H** opens it on Replace. The
grid stays usable while it is open, and **Esc** closes it.

- **Find Next** (Enter) goes to the next match after the active cell, and wraps round at the end.
  **Find Previous** (Shift+Enter) goes back.
- **Find All** lists every match with its sheet and cell; click one to go there.
- **Within**: the sheet, or every grid sheet of the workbook. A table sheet lives in the lakehouse
  and is searched with its own filters.
- **Look in: Values** matches what a cell shows, so a formula's answer, or `$1,350.00` for a
  number formatted as currency. **Formulas** matches what was typed: a formula's text, or a
  constant.
- **Match case** and **Entire cell** narrow the match. As in Excel, `*` stands for any run of
  characters, `?` for any one, and `~` before either (or before `~`) for the character itself:
  `SO-102??` finds SO-10200 to SO-10299, and `5~*` finds `5*`.
- **Replace** changes what was typed, as Excel's does, so Look in is Formulas. The first **Replace**
  goes to a match and the next one replaces it. **Replace All** changes every match at once, and a
  single Ctrl+Z takes all of them back, across sheets.
- A change that would break a formula (`COUNTA(` → `COUNTA((`) is not made; the panel says how many
  cells it left.

The panel opens with the last search. Someone who can only view a workbook finds, and has no
Replace. Sheets their share leaves out are never sent to them, so Find cannot show them.

### Freeze panes

**View → Freeze** keeps rows and columns in view while the rest of the sheet scrolls, as Excel's
Freeze Panes does:

- **Freeze panes**: the rows above and the columns left of the active cell. Select C3 to keep rows
  1–2 and columns A–B.
- **Freeze top row** and **Freeze first column**.
- **Unfreeze panes**.

A line marks where the frozen part ends. Frozen cells are edited, selected and filtered like any
other; a filter's buttons in a frozen header row stay in reach however far down the sheet is.
Charts scroll under the frozen part. Inserting rows above the line moves it down with them.
Deleting frozen rows moves it up. Undo takes a freeze back.

A sheet keeps at most 100 rows and 50 columns frozen. An Excel file's frozen panes come in with it
and go back out in a download.

### Notes

A cell can carry a note, as a comment does in Excel. **Shift+F2**, or **New note…** on the cell's
menu, opens it, and **Ctrl+Enter** saves. Once a cell has a note, its menu has **Edit note…** and
**Delete note**.

A cell with a note has a red corner at its top right. The note shows on hover, and beside the
active cell. A note can sit on an empty cell, as in Excel.

A note stays with its cell:

- a sort moves it with its row;
- Copy and Paste bring it, and Cut moves it;
- inserted and deleted rows move it.

Undo takes any of these back. **Home → Clear → Clear all** takes the note with everything else.
**Clear contents** leaves it, as in Excel, and **Clear notes** takes only the notes.

**Find → Look in: Notes** searches notes, in the sheet or the whole workbook. An Excel file's
notes come in with it, and go back out in a download.

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
matching format, as Excel does, and so does typing a time (`12:30`, `9:00 AM`, `25:00`) or a date
with its month's name (`15-Mar-2023`, `Mar 15, 2023`, `15 March 2023`, `Mar 2023`): each is a
number that adds up and counts, shown as typed. A day past its month's end (`31-Feb-2023`) stays
text. Dates with slashes (`3/15/2023`) stay text too: which part is the month depends on where
you are, and a workbook is read the same way by everyone it is shared with. The same codes work in
TEXT(). Among them:

- **Durations:** `[h]:mm` shows 1.5 days as 36:00, `[mm]:ss` counts minutes past the hour, and
  `[ss]` seconds. A column of them is saved to the lakehouse as numbers, not dates.
- **Currency tags:** `[$€-2] #,##0.00` shows € 1,234.50, and `[$-409]` (a locale alone) nothing.
- **Fractions:** `# ?/?` shows 1 1/2, `?/?` 3/2, `# ?/8` eighths, and `# ??/??` the nearest with
  two-digit parts.
- **Conditions:** `[<10]"small";"big"`, or `[>=1000000]0.0,,"M";[>=1000]0.0,"K";0`, choose a section
  by the value, and its colour with it.
- **Dates in capitals,** `DD/MM/YYYY` as LibreOffice writes them, read as `dd/mm/yyyy`.
- **A formula's format from what it reads.** A formula typed into a cell with no format of its own
  takes one, as Excel does: `=A1` takes A1's; `+` and `-` take their first formatted operand's, so
  `=A1+30` over a date is a date; SUM, AVERAGE, MIN, MAX, MEDIAN and the ROUNDs take their first
  argument's, so `=SUM(B1:B9)` over dollars is dollars. Two dates apart (`=A2-A1`) are a number of
  days. `*` and `/` take none (Excel would show `=A1*100` over 12% as 1200%).
- **Spacing codes:** `_)` is a space as wide as ")", so `#,##0_);(#,##0)` lines up positives with
  negatives, and Excel's Accounting format `_("$"* #,##0.00_)` shows `$1,234.50`. A fill (`* `),
  which Excel stretches to the cell's width, is left out.

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
blanks sort last either way. Numbers come before text, text before TRUE and FALSE, and those before
errors. Text sorts as Excel sorts it, character by character with case aside, so A10 comes before
A2: the same order `=SORT()` gives and an approximate MATCH or VLOOKUP expects, so a lookup over
data sorted here finds its rows.

**Data → Sort…** is Excel's Custom Sort. It sorts the selection, the data around the active cell,
or the filter's range when the active cell is in it.

- **Levels.** Sort by one column, then by another for rows that tie, and so on (up to 8 levels),
  each A to Z or Z to A. **Add level** takes the next column not used yet. Levels move up and down
  and are deleted with the buttons beside them.
- **Headers.** **My data has headers** keeps the first row on top and names the columns by it. It
  is ticked when the first row is all text, and always for a filter's range.
- **Once only.** A column in two levels is refused, as in Excel.
- **Stable.** Rows that tie on every level keep their order.

No sort moves rows under a merged cell: a range with merged cells is refused, and the message says
to unmerge them first, as Excel does.

### Remove duplicates

**Data → Remove duplicates…** takes out the rows of a list that repeat an earlier row, as Excel's
Remove Duplicates does. It works on the selection, or, with one cell selected, on the data around
it (bounded by empty rows and columns).

The dialog lists the columns, all checked. A row goes when every checked column repeats an earlier
row, so checking only Email keeps one row per address. **My data has headers** keeps the first row
out of it; it is ticked when the first row is all text.

As in Excel, cells are compared as they are shown, ignoring case:

- `ASHA@EXAMPLE.COM` repeats `asha@example.com`;
- the number 1 repeats the text `1`;
- one date shown as `2026-03-08` and as `8 Mar 2026` does not repeat.

The rows below a removed one move up within the list, with their formats, links and notes, and a
formula's references move with its row, as in a sort. Nothing outside the list moves. A list with
merged cells is refused, since they cannot move up. The message says how many rows went and how
many remain. One Ctrl+Z puts them back.

### Text to columns

**Data → Text to columns…** splits each cell of one column into the cells to its right, as
Excel's does: "Asha Rao" into Asha and Rao, "Lisbon,PT,2026" into three.

- **Split at.** Tab, semicolon, comma, space, or any other one character. **Treat several in a
  row as one** makes "Asha Rao" two pieces, not four.
- **Quotes.** Text in double quotes (or single, or none) stays whole: `"Lisbon, PT",2026` is two
  pieces. A doubled quote inside is one quote.
- **Destination.** The first cell of the column unless you type another. A preview shows the first
  rows split.
- **What the pieces become.** As a CSV's fields: 1,200 a number and 2026-03-08 a date, with the
  format they imply. Text that would read as a formula (`=…`, `@…`) stays text, so splitting never
  runs anything.

The pieces fill as many columns as the widest cell needs; a shorter row's other cells are emptied.
If the cells the pieces go to hold anything (other than the column being split), it asks before
writing over them. A merged cell there is refused. One Ctrl+Z takes it all back. A whole column
selected is split down to its last cell in use; cells in two or more columns are refused.

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
- **Lakehouse query**: a SELECT you write. See [Query sheets](#query-sheets).
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

### Query sheets

A query sheet's rows are what a SELECT over the lakehouse returns, as a connected table is in
Row Zero. Nothing is copied: the query runs whenever the sheet is read.

- **Writing it.** **Lakehouse query** in **Add a table sheet** has the SQL, the tables you can
  read (a click puts one in the query), and **Preview** (Ctrl+Enter), which shows the first 50
  rows and how long they took.
- **What it may be.** One `SELECT` or `WITH` statement. Anything that writes is refused, and so is
  a second statement. As in the Query editor, the lakehouse refuses file and database functions
  such as `read_csv`.
- **Who it runs as.** Whoever reads the sheet, with their own schema grants, row filters and
  column masks. A shared workbook never shows a viewer more than they could query themselves, and
  a share's row filter narrows further.
- **Everything else is a table sheet's.** Sort, filters, calculated columns, pivots, **Save to
  lakehouse**, downloads, and formulas over it from a grid sheet (`=SUM(Revenue[revenue])`) all
  work on what the query returns.
- **Refresh** runs the query again.
- **Edit query** (owners and editors) changes the SQL. The sheet keeps its calculated columns,
  sort and filters, and one that names a column the new query lacks says why.

Each column the query returns needs a name of its own (`SELECT a.id, b.id` needs an `AS`), and
none may be called `__row`. A query is at most 20,000 characters.

#### Variables

`{{Name}}` in a query is the value of the workbook name `Name` (**Data → Names**, or type a name in
the Name box with a cell selected). A cell can steer the query:

```sql
SELECT month, revenue
FROM analytics.bi_demo_sales
WHERE region = {{Region}}
ORDER BY month
```

Type APAC in the cell `Region` names, and the sheet shows APAC's months. Every formula over the
sheet follows, as does `=SUM(ByMonth[revenue])` in a grid sheet.

- **Always a value, never SQL.** Text is quoted, with its own quotes doubled, so `x' OR '1'='1`
  matches nothing rather than every row. A number is a number, TRUE and FALSE are booleans, and an
  empty cell is NULL.
- **A date cell** goes as its date (`'2026-03-08'`), so it compares with a DATE column the way it
  reads.
- **A name over several cells** is a list for `IN`: `WHERE region IN {{Regions}}`. Blanks are left
  out, and at most 1,000 values are used.
- **Row Zero's quoted form** reads the same: `'{{Start}}'` and `{{Start}}` are one value.
- **A variable whose name is not defined** stops the sheet with a reason (`{{Region}} has no value: name a cell
Region…`) rather than showing no rows. The query editor lists each variable with its value now.

The values travel with each read, and the SQL is still the saved one: a value is bound as a literal
on the server, whatever a browser sends.

The SQL a read runs is always the one saved with the sheet, never one sent with the read. A viewer's
copy of the sheet does not carry the SQL. Making a query sheet and changing its query are audited
(`sheets.query.create`, `sheets.query.update`) with the SQL, and each read is audited as a
lakehouse query.

### Tables a sheet holds

A table that Sheets made for a table sheet, from an uploaded file or rows imported from a
connection, belongs to that sheet. Sheets replaces it when the import is refreshed, and the
sheet's calculated columns, pivots and formulas stand on its columns. So it is changed only from
Sheets:

- In the Lakehouse it reads like any table. Its page says **Held by Sheets · workbook › sheet**,
  links to the sheet, and offers no **Insert row** or **Drop**. If it is also a materialized view,
  **Rebuild** is off, and says why on hover: only Sheets changes it; delete the sheet, and it can
  be rebuilt there.
- Anything that would change it is refused, naming the sheet:
  - a statement in the SQL editor or a workflow SQL step;
  - an ETL pipeline writing it;
  - an Iceberg import into it;
  - a materialized view, SQL model or batch prediction whose name it has taken;
  - dropping the schema that holds it.
- To change the data somewhere else, copy it: `CREATE TABLE schema.table_copy AS SELECT * FROM
schema.table`. Or delete the sheet in Sheets; the table stays, and is an ordinary lakehouse
  table again.

A table opened from the Lakehouse or the catalog is not held: it was there before the sheet and
stays editable. Nor is a table made with **Save to lakehouse**, a copy the sheet no longer reads.
A sheet holds a table only in a schema its owner owns, as an import requires; a sheet that names
a table in someone else's schema holds nothing.

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

- A blank counts as 0 in arithmetic and as "" in text: `[@name] & ": " & [@amount]` ends in ": "
  on a row with no amount, as a grid does.
- MIN, MAX and AVERAGE of this row's values (`AVERAGE([@a], [@b])`) skip a blank, text or
  TRUE/FALSE reference, as Excel skips such a cell.
- ROUND, ROUNDUP, ROUNDDOWN, TRUNC and TEXT round the 15 significant digits Excel keeps, by the
  same rule as a grid: `ROUND(1.005, 2)` is 1.01 and `TRUNC(0.29, 2)` is 0.29, though the stored
  binary is a hair under each. Most rows take plain arithmetic; only a value on the edge of a half
  is worked out from its digits, so the cost over a million rows is close to SQL's own `round()`.
- A number in text is written to 15 significant digits, as in a grid: `[@total] & ""` over
  0.01 + 0.075 is `0.085`, not the 17-digit `0.08499999999999999`. TEXT past 15 digits shows 15
  and then zeros, and CEILING and FLOOR read the quotient at 15 digits, as a grid does.
- PROPER capitalises each word in any alphabet, a word starting after anything that is not a
  letter: `o'neil 2-way` becomes `O'Neil 2-Way`, as in Excel.
- A number with no value, a negative to a fractional power or MROUND with signs that differ, shows
  `#NUM!`.
- `tests/unit/sheetsGridTableParity.test.ts` runs a list of formulas through the grid engine and
  through the compiled SQL on DuckDB, row by row, and they must agree.
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
borders, alignment and wrapping, merged cells, links, notes, column widths, row heights, hidden rows
and columns, frozen panes and gridlines. A sheet name with a character a formula cannot carry (`'`, `[`, `]`…) is
renamed, and every formula that named it follows.

**Text stays text.** A cell the file holds as text comes in as text, even when it reads like a
number or a date (`£1,234.50`, `€99`, a code like `1e5`, `2023-03-15`, `=1+1`), so COUNT and SUM
leave it out as Excel does. It is marked as typed text with a leading `'`, which the formula bar
shows; a text that starts with `'` in the file keeps it.

**Formulas from older Excel.** A formula that a file holds as a plain formula (every formula of
Excel 2019 and older, and every one a library such as openpyxl writes) is read as Excel 365 reads
it: where it expects one value and meets a range, it takes the value in its own row, and shows an
`@` there. `=Price*Qty`, with names over whole columns, becomes `=@Price*@Qty` and gives each row's
own product; `=SUM(LEN(A2:A4))` becomes `=SUM(LEN(@A2:A4))`. Where every Excel works over arrays
(SUMPRODUCT, LOOKUP, INDEX, and the dynamic-array functions) and in an array formula, nothing
changes. A download gives such a formula back as it came, and an `@` that older Excel would not read
the same goes out as Excel 365's `_xlfn.SINGLE`.

A function whose answer can be several values takes the `@` too, where the cell takes its answer
(R338). In the Excel that wrote it, `=LINEST(B2:B7,A2:A7)` typed in one cell showed the slope alone,
and `=ROW(A2:A4)` showed 2. Here they become `=@LINEST(B2:B7,A2:A7)` and `=@ROW(A2:A4)` and show the
same, rather than spilling. This follows Microsoft's page on `@`, which gives `=INDEX(A1:A10,B1)` as
`=@INDEX(A1:A10,B1)` and `=OFFSET(A1:A2,1,1)` as `=@OFFSET(A1:A2,1,1)`:

- **Which functions.** LINEST, LOGEST, TREND, GROWTH, TRANSPOSE, MMULT, MINVERSE, FREQUENCY and
  MODE.MULT always take the `@`. ROW and COLUMN take it over several cells. INDEX, OFFSET and
  INDIRECT take it unless their own arguments pick one cell: `INDEX(A1:A10,3)`, `OFFSET(A1,1,1)` and
  `INDIRECT("B2")` stay as they are.
- **Under an operator or a function of one value**, the `@` still goes in: `=ABS(-LINEST(…))` becomes
  `=ABS(-@LINEST(…))`.
- **A range that IF, IFERROR or CHOOSE passes on to the cell** takes it too: `=IF(A2>0,B2:B7,0)`
  becomes `=IF(A2>0,@B2:B7,0)`.
- **Not inside a function that takes an array or range.** The page names SUM and AVERAGE as the
  exception, so `=SUM(LINEST(B2:B7,A2:A7)*{9,1})` (LINEST's page's 11,000) stays as it is.
- **What `@` takes from the answer.** From a range that INDEX, OFFSET or INDIRECT answers with, `@`
  takes the cell in the formula's own row or column, as it does from a range written out. In row 5,
  `=@INDEX(A2:B7,0,2)` is B5, and in row 8 it is `#VALUE!`. From any other array, `@` takes the first
  value.
- **On the way out**, a download drops these `@` again, so older Excel reads the formula as it was.

**Hidden sheets** come in hidden, and so do very hidden ones (helper sheets that only a macro can
show), so the formulas that read them still compute. The dialog marks each one "(hidden, as in
Excel)". The workbook opens on the first sheet showing. A download writes them hidden, and Excel
opens on the first sheet showing too. A very hidden sheet goes back out as an ordinary hidden one.

The file's **named ranges** come with it, with their comments, and the formulas that use them
compute here. The dialog says how many there are. Some are left out, and the import says which:

- Excel's own names (print areas, filter ranges);
- hidden helper names;
- names pointing into another workbook;
- names over several areas, such as `Data!$B$2,Data!$B$4`.

A name that one sheet of the file scopes to itself comes in for the whole workbook, if no other
name has it. Importing into an open workbook keeps that workbook's own name when both have one of
the same name, and says so. A download writes every name back, in the file's sheet names.

**Notes** come in on their cells, the author first ("Asha:" on its own line), whether Excel or a
library such as openpyxl wrote them. Excel 365's threaded comments come in as one note, the
replies after the first. The dialog counts each sheet's notes. A download writes each as Excel's
note.

A formula that uses a function Sheets does not compute yet (CUBEVALUE, a link to another
workbook, a name the import had to leave out) shows **the value Excel last saved**, with a small amber mark and a note on hover
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
A formula that spills, and one that works over a range where Excel before dynamic arrays took a
single value (`=SUM(LEN(A1:A3))`, `=SUM(IF(A1:A3="x",1,0))`), goes out as Excel 365's dynamic array
formula. Excel then computes it as Sheets does, and a spill grows or shrinks with its data. Written
as a plain formula, Excel would take only the value in the formula's own row. Excel 2019 and older
show these formulas in braces, as array formulas.
Functions Excel added after 2007 go out under the names Excel's files use for them
(`_xlfn.XLOOKUP`, `_xlfn._xlws.FILTER`, `_xlfn.NUMBERVALUE`), every one Sheets computes; without
the prefix Excel reads the name as unknown and, recalculating on open, shows #NAME?. LET's names
and a LAMBDA's parameters go out as `_xlpm.x`, where they are given and where they are used
(R328): `=LET(x,1,x+1)` is `_xlfn.LET(_xlpm.x,1,_xlpm.x+1)` in the file. A workbook name that
holds a LAMBDA goes out with the names, and a file's named LAMBDAs come in computing, recursive
ones included, rather than showing the values Excel saved.
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

## Sharing

The workbook's owner shares it from **Share**, beside **File**. It can go to a person, by the email
they sign in with, or to an IAM group. The share lets them view it or edit it. It then appears on
their Sheets page with who shared it, and **Shared with me** lists only those.

| What                                                                                            | Owner | Can edit | Can view                |
| ----------------------------------------------------------------------------------------------- | ----- | -------- | ----------------------- |
| Open it, sort and filter a table sheet's view, download                                         | ✓     | ✓        | ✓, what the share gives |
| Change cells, sheets and table settings; pivots; version history; save to the lakehouse; rename | ✓     | ✓        |                         |
| Add a table sheet over a lakehouse table                                                        | ✓     | ✓        |                         |
| Upload a file, import from a connection, refresh an import                                      | ✓     |          |                         |
| Share it, delete it                                                                             | ✓     |          |                         |

An import makes a new table in its owner's schema, which the sheet then holds (see
[Tables a sheet holds](#tables-a-sheet-holds)), so importing is the owner's alone.

A share to view can keep things back:

- **Sheets left out** are not sent at all, not even their names. A formula in a sheet the viewer
  does see that reads one left out shows `#REF!`.
- **Some rows of a sheet**:
  - On a grid sheet, it keeps the rows whose value in a column (named by its letter) is one of those
    picked, and the header rows at the top.
  - On a table sheet, it keeps the rows whose column holds one of the values.
  - The server sends only those rows, and everything built on them is computed from them: a total
    in a grid sheet, a grid formula over the table (`=SUM(Orders[amount])`), a lookup into it, a
    pivot of it, a filter's value list, a download.
  - A cell's saved Excel value, for a formula this engine cannot compute, is not sent to a filtered
    viewer: it can total the rows left out.

**Several shares combine to the widest.** Someone can have shares to themselves and to groups they
are in:

- an editor share wins;
- a sheet is left out only if every share leaves it out;
- a row is kept if any share keeps it.

**Table sheets read the lakehouse as whoever opens them.** Sharing a workbook shares the workbook,
not your data access; the AI Analyst works the same way. A table sheet runs with the reader's own
grants, row filters and column masks, and the share's row filter narrows further. Someone without
access to a table sees an error on that sheet that names the table. When you share with a person,
Share says which table sheets they cannot read.

**View as**, in the share list, opens the workbook exactly as that share sees it: read-only, under a
banner. Its table sheets then read as you, with the share's filters.

Grid sheets are stored content, so a grid sheet's row filter is all that stands between a viewer and
its other rows. Table sheets are governed by the lakehouse as well.

Every share, change and removal is audited as `sheet.share` or `sheet.unshare`, naming who was
given what.

## AI in a workbook

**Ask AI**, beside the zoom control, opens the assistant beside the grid. Ask in plain words, the way
you would ask a colleague who knows Excel: "total units for West", "add a revenue column", "a
summary sheet by region with a chart", "why is H2 #N/A?".

The model starts from a short description of the workbook:

- each sheet's name, header row, size and a few sample rows;
- a table sheet's columns;
- the active cell.

It does not see the values. To answer, it asks the workbook for them, and the browser works out
each request from the workbook as you see it:

| It asks to         | What it gets back                                                         |
| ------------------ | ------------------------------------------------------------------------- |
| Read a range       | The values as shown (at most 2,000 cells at a time)                       |
| Evaluate a formula | Any Excel formula, computed by the workbook, including totals over tables |
| Describe a sheet   | Its columns, their types, its size and a sample                           |
| Find a text        | The cells whose shown text contains it                                    |

Each request shows as a step under the answer, such as `Computed =SUMIFS(BiDemoSales[revenue],
BiDemoSales[region], "EMEA")`, so you can see where a number came from. The model is told never to
state a number it did not read or compute.

**Nothing changes until you apply it.** An answer can come with proposals:

- a formula in a cell, filled down to the last row of the data;
- values or formulas in a range;
- a number format;
- a highlight (a conditional-format rule from a formula, red, yellow or green);
- a chart beside its data;
- a new sheet, such as a summary whose formulas point back at the data (`=SUMIFS(Sales!D:D,…)`).

Each proposal says in plain words what it will do. **Apply** carries it out as one step that
**Ctrl+Z** undoes. Proposals change grid sheets only.

**Before the proposals are shown, the panel checks each one against the workbook, without changing
anything.** A proposal is sent back when:

- it can't be carried out (a sheet that isn't there, a table sheet, two blocks of cells where one is
  needed);
- it would leave every cell as it is;
- a formula it writes would show an error by itself: an unknown function or name, or a table
  sheet's rows brought into the grid (`=FILTER(Orders, …)`, which shows `#VALUE!`; see
  [Formulas over table sheets](#formulas-over-table-sheets-in-grid-sheets)).

What can't be done goes back to the model once, with the reason, and the model answers again. The
steps say when that happened.

On a cell, **Explain this formula** and **Fix this error** ask about the active cell.

### Fill with AI

Select the column to work from, then **Fill with AI…** in the assistant. Say what to do with each
value, such as "positive, negative or neutral", "the company's country" or "the first name".

- Answers go into the first column to the right that isn't full, or into a column you name.
- Answers already typed in that column are used as examples, as Flash Fill learns from them.
- **Try on 5 rows** shows the first five answers before anything is written.
- **Fill N rows** writes those five as shown and asks for the rest, 50 rows per call.
- Rows that already have an answer are left as they are.
- It writes everything as one step that **Ctrl+Z** undoes.
- An answer the model gives in a shape that can't be read is an error, and nothing is written.

One fill works through at most `SHEETS_AI_FILL_MAX_ROWS` rows (2,000). The page checks that limit
per fill; `SHEETS_ASSIST_PER_MINUTE` is what bounds each person's calls on the server.

### Who may use it

| What                  | Owner | Can edit | Can view |
| --------------------- | ----- | -------- | -------- |
| Ask AI, see its steps | ✓     | ✓        | ✓        |
| Apply a proposal      | ✓     | ✓        |          |
| Fill with AI          | ✓     | ✓        |          |

**A viewer can ask, and the reads see only what their share gives.** Sheets left out are not in
the workbook the browser holds, and neither are rows kept back. Proposals show as **View only**.
**View as** starts its own conversation, so the owner's earlier questions and reads don't carry
into it.

**The model.** The assistant's **Model** row picks it, as the platform's other AI tools do. It
lists the model providers connected for you (Integrations, or the instance's OpenRouter key) and
their models, leaving out any an IAM model rule refuses you.

- **Default · …** is the admin's model: `SHEETS_ASSIST_MODEL` under **Admin → Developer runtime →
  Data platform**.
- **Remembered.** Your pick is remembered in this browser, and Fill with AI runs on it too; its
  dialog names the model.
- **Named.** Each answer says which model gave it, beside its cost.
- **Dropped when it stops being yours.** A pick you can no longer use (its provider disconnected, or
  a rule now refusing it) goes back to the default, and says so.

Every call goes through the chat channel as you, so your IAM model rules, budget, traces and cost
apply whichever model you pick. A model the channel refuses is refused with its reason.
`SHEETS_ASSIST_PER_MINUTE` (30) bounds each person's calls a minute; each step of a question is one
call.

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

Sharing is audited as `sheet.share` and `sheet.unshare` ([Sharing](#sharing)).

## Limits

| Setting                           | Default                       | What it bounds                                                          |
| --------------------------------- | ----------------------------- | ----------------------------------------------------------------------- |
| `SHEETS_MAX_CELLS`                | 200,000                       | Non-empty cells one grid sheet may hold                                 |
| `SHEETS_PAGE_ROWS`                | 500                           | Rows a table sheet fetches per page while scrolling                     |
| `SHEETS_UPLOAD_MAX_MB`            | 50                            | The largest CSV an upload brings into the lakehouse                     |
| `SHEETS_IMPORT_MAX_SHEETS`        | 100                           | Sheets one Excel or CSV import may bring into a workbook                |
| `SHEETS_EXPORT_MAX_ROWS`          | 100,000                       | Rows of a table sheet written into a downloaded .xlsx or .csv           |
| `SHEETS_VERSION_INTERVAL_MINUTES` | 30                            | The least time between two automatic versions of a workbook             |
| `SHEETS_VERSIONS_MAX`             | 50                            | Automatic versions kept per workbook (named ones are kept)              |
| `SHEETS_ASSIST_MODEL`             | Gemini 3 Flash via OpenRouter | The model the assistant and Fill with AI call ([AI](#ai-in-a-workbook)) |
| `SHEETS_ASSIST_PER_MINUTE`        | 30                            | Model calls one person's assistant and Fill with AI may make a minute   |
| `SHEETS_AI_FILL_MAX_ROWS`         | 2,000                         | Rows one Fill with AI works through                                     |

All ten are editable under **Admin → Developer runtime**. A direct import from a connection is
also bounded by `WAREHOUSE_ABS_MAX_ROWS`. A larger result is refused, never truncated; land it with
an ETL pipeline and open that table instead.

See also: [Lakehouse](./LAKEHOUSE.md) · [Data sources](./DATA_SOURCES.md) ·
[Scale and limits](./SCALE_AND_LIMITS.md)
