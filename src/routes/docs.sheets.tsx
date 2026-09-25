import { createFileRoute } from "@tanstack/react-router";
import {
  C,
  Callout,
  Code,
  DocLink,
  DocsHeader,
  H2,
  H3,
  NextPrev,
  P,
  Table,
  UL,
} from "@/components/docs/DocsShell";

export const Route = createFileRoute("/docs/sheets")({
  head: () => ({
    meta: [
      { title: "Sheets — AgentSwarms Documentation" },
      {
        name: "description",
        content:
          "Spreadsheets with Excel formulas over lakehouse-scale data: grid sheets computed in the browser, table sheets computed by the lakehouse, calculated columns, pivots, formulas over tables, and saving to the lakehouse and the data catalog.",
      },
      { property: "og:title", content: "Sheets — AgentSwarms Documentation" },
      {
        property: "og:description",
        content: "The Excel you know, on tables the size of the lakehouse.",
      },
      { property: "og:url", content: "https://agentswarms.fyi/docs/sheets" },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: "https://agentswarms.fyi/docs/sheets" }],
  }),
  component: SheetsDocsPage,
});

function SheetsDocsPage() {
  return (
    <>
      <DocsHeader
        eyebrow="Data & analytics"
        title="Sheets"
        description="Spreadsheets with the Excel formulas people already know, over data far larger than a browser could hold: the lakehouse computes the big tables, the browser only shows the rows on screen."
      />

      <H2 id="what">Two kinds of sheet</H2>
      <P>
        Find workbooks under <strong>Data &amp; BI → Sheets</strong>. A workbook holds grid sheets
        and table sheets side by side, and formulas reach across both.
      </P>
      <Table
        headers={["Sheet", "Data lives in", "Size", "Computed by"]}
        rows={[
          [
            "Grid sheet",
            "The workbook (cells, formats, styles)",
            <>
              Up to <C>SHEETS_MAX_CELLS</C> non-empty cells (200,000)
            </>,
            "The browser",
          ],
          [
            "Table sheet",
            "A lakehouse table; the sheet keeps only its view",
            "As large as the lakehouse holds",
            "The lakehouse",
          ],
        ]}
      />

      <H2 id="grid">Grid sheets</H2>
      <P>
        Type <C>=</C> and a formula. About 200 functions follow Excel&apos;s rules: SUMIFS and
        COUNTIFS criteria, XLOOKUP and VLOOKUP, dynamic arrays that spill (UNIQUE, FILTER, SORT,
        SEQUENCE, with <C>#SPILL!</C> when a cell is in the way), TEXT and date arithmetic,
        whole-column and cross-sheet references, and Excel&apos;s precedence (<C>-2^2</C> is 4). A
        cell with an error explains it on hover.
      </P>
      <UL>
        <li>
          <strong>Typing formulas.</strong> Function names are suggested as you type (Tab inserts
          one), a hint shows the arguments, and clicking cells inserts their reference.
        </li>
        <li>
          <strong>Keyboard.</strong> Enter/Tab commit and move, and Enter after a run of Tabs
          returns to the row&apos;s first column. Ctrl+arrows jump across data, Shift extends, F2
          edits, Ctrl+D/R fill, and Ctrl+Z/Y undo and redo, including row and column inserts.
        </li>
        <li>
          <strong>Fill and clipboard.</strong> The fill handle continues number series and shifts
          formulas. Pasting inside the workbook shifts formulas; pasting from Excel or Google Sheets
          brings values, recognising percentages, currency and dates.
        </li>
        <li>
          <strong>Rows and columns.</strong> Inserting or deleting them moves every formula that
          pointed at them, workbook-wide, and merged cells and row heights with them; renaming a
          sheet rewrites the formulas that name it. A header&apos;s right-click menu hides and
          unhides, and sets a row height in points or a column width in characters.
        </li>
        <li>
          <strong>Formatting.</strong> The ribbon&apos;s Home tab sets fonts and sizes, bold,
          italic, underline and strikethrough, font and fill colors, borders, alignment, indent,
          wrapping, merged cells (Merge &amp; Center, Merge Across) and number formats, with a
          format painter and Clear. Rows grow for wrapped text and larger fonts. A format code such
          as <C>#,##0;[Red]-#,##0</C> paints negatives red.
        </li>
        <li>
          <strong>Conditional formatting.</strong> Home → Conditional highlights by value, text,
          date, top or bottom N, average or duplicates, draws data bars, color scales and icon sets,
          or applies a formula rule such as <C>=$C2&lt;0</C>. Manage rules sets their order.
        </li>
        <li>
          <strong>Data validation.</strong> Data → Data validation limits cells to a list (with a
          dropdown), numbers, dates, times, text lengths or a formula, with an input message and a
          Stop, Warning or Information alert for a value that fails.
        </li>
        <li>
          <strong>Filter and sort.</strong> Data → Filter (Ctrl+Shift+L) adds header buttons that
          sort, keep ticked values or keep rows meeting a condition; Sort A to Z sorts the data
          around the active cell, formulas moving with their rows.
        </li>
        <li>
          <strong>Links and zoom.</strong> Ctrl+K links a cell to a web address, an email or a place
          in the workbook (<C>#Summary!B6</C>); Ctrl+click follows it. <C>javascript:</C> and other
          schemes are refused. The zoom (Ctrl+wheel, or the status bar) is kept per sheet.
        </li>
        <li>
          <strong>Saving.</strong> Automatic, per sheet and versioned. A save from an older copy is
          refused rather than written over the newer one: <strong>Reload theirs</strong> or{" "}
          <strong>Keep mine</strong>.
        </li>
      </UL>

      <H2 id="tables">Table sheets</H2>
      <P>
        <strong>+</strong> beside the sheet tabs → <strong>Table sheet</strong> opens a lakehouse
        table, a table from the <DocLink to="/docs/data">data catalog</DocLink>, a table or query
        from a database connection, or an uploaded CSV. Anything not already in the{" "}
        <DocLink to="/docs/lakehouse">lakehouse</DocLink> is copied into a new table there first, in
        a schema you own. An import never replaces a table; one from a connection can later be{" "}
        <strong>refreshed from source</strong>.
      </P>
      <UL>
        <li>
          <strong>Sort and filter.</strong> The engine sorts and filters every row. A column&apos;s
          value list shows counts across the whole table.
        </li>
        <li>
          <strong>Paging.</strong> Rows arrive <C>SHEETS_PAGE_ROWS</C> at a time (500) as they
          scroll into view.
        </li>
        <li>
          <strong>Pivots.</strong> Group by some columns and total others. The pivot is itself a
          table sheet you can sort, filter, extend and save.
        </li>
      </UL>

      <H3 id="calculated-columns">Calculated columns</H3>
      <P>
        <strong>+ Column</strong> adds a column computed by an Excel formula for each row, compiled
        into the query the lakehouse runs:
      </P>
      <Code lang="text">{`=[@price] * [@qty]
=[@amount] / SUM([amount])
=SUMIFS([amount], [customer], [@customer])
=XLOOKUP([@customer_id], Customers[id], Customers[name], "unknown")
=TEXT([@order_date], "yyyy-mm")`}</Code>
      <P>
        Excel&apos;s meaning is kept where SQL&apos;s differs: blanks count as 0 in arithmetic, text
        compares without case, MOD follows the divisor&apos;s sign, and VLOOKUP defaults to an
        approximate match. A table column has no error values: a division by zero or a failed
        conversion leaves that row blank, and IFERROR fills it. A formula that fails on some row is
        shown empty with the engine&apos;s reason while the rest of the table still shows.
      </P>

      <H2 id="formulas-over-tables">Formulas over tables in grid sheets</H2>
      <P>
        A grid cell can total or look up a table sheet of any size. The lakehouse computes the
        answer with the same compiler, and the cell shows <C>#BUSY!</C> meanwhile:
      </P>
      <Code lang="text">{`=SUMIFS(Orders[amount], Orders[region], A2)
=XLOOKUP("APAC", RevenueByRegion[region], RevenueByRegion[sum_revenue])`}</Code>
      <P>
        SUM, AVERAGE, COUNT(A), MIN, MAX, MEDIAN, SUMPRODUCT, the IF(S) family, XLOOKUP, VLOOKUP,
        INDEX/MATCH, RANK and ROWS are computed this way. Like a structured reference in Excel,
        these formulas see every row of the table, not the sheet&apos;s filtered view.
      </P>

      <H2 id="files">Excel and CSV files</H2>
      <P>
        <strong>Import Excel or CSV</strong> on the Sheets page starts a workbook from a file, and{" "}
        <strong>File → Import sheets</strong> adds a file&apos;s sheets to an open one. An .xlsx
        brings its formulas (array formulas and newer functions such as XLOOKUP included), number
        formats, fonts, fills, borders, alignment, merged cells, links, widths, heights and hidden
        rows and columns. A formula using a function Sheets does not compute yet shows the value
        Excel last saved, marked, and goes back to Excel as written. A CSV&apos;s delimiter is
        detected, and text that looks like a formula stays text.
      </P>
      <P>
        <strong>File → Download as Excel</strong> writes every sheet: grid sheets with their
        formulas and current values, table sheets as Excel tables named like the sheet (so{" "}
        <C>Orders[amount]</C> keeps working), up to <C>SHEETS_EXPORT_MAX_ROWS</C> rows each and read
        with your own grants. <strong>Download this sheet as CSV</strong> writes what the sheet
        shows. Conditional formatting, data validation and the filter&apos;s range go both ways.
      </P>

      <H2 id="save">Saving to the lakehouse and the catalog</H2>
      <P>
        <strong>Save to lakehouse</strong> writes a new table: what a table sheet shows, or a grid
        range whose first row names the columns (types detected, both editable). With{" "}
        <strong>Add it to the data catalog</strong> the table is registered at once with its
        columns, owner, description, tags, certification if you ask for it, and lineage to the
        tables it came from. It is ready for others to find and query.
      </P>

      <H2 id="governance">Governance</H2>
      <UL>
        <li>
          <strong>Same rules as a query.</strong> A table sheet reads through the path the Query
          editor uses, with the same schema grants, row and column policies, and audit. The SQL is
          built on the server from the sheet&apos;s settings, with every name quoted and every value
          a literal.
        </li>
        <li>
          <strong>Audit.</strong> Imports and saves are audited as <C>lakehouse.import</C>;
          workbooks and sheets as row changes.
        </li>
        <li>
          <strong>Limits.</strong> <C>SHEETS_MAX_CELLS</C> (200,000), <C>SHEETS_PAGE_ROWS</C> (500),{" "}
          <C>SHEETS_UPLOAD_MAX_MB</C> (50), <C>SHEETS_IMPORT_MAX_SHEETS</C> (100) and{" "}
          <C>SHEETS_EXPORT_MAX_ROWS</C> (100,000) are editable under Admin → Developer runtime. A
          direct import from a connection is also bounded by <C>WAREHOUSE_ABS_MAX_ROWS</C>; a larger
          result is refused, never truncated.
        </li>
      </UL>

      <Callout title="How this compares">
        Row Zero (now part of Databricks) made this shape popular: spreadsheet formulas on
        warehouse-sized tables. Here the tables are the platform&apos;s own governed lakehouse, a
        saved result lands in the catalog with lineage, and the same formulas work in a grid and in
        a table&apos;s columns.
      </Callout>

      <NextPrev current="/docs/sheets" />
    </>
  );
}
