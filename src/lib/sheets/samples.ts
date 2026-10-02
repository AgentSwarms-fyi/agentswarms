// The sample workbooks under public/samples/sheets/, offered on the Sheets
// page. scripts/make-sheets-samples.ts writes them (npm run sheets:samples);
// each is a real .xlsx, so it opens in Excel as well, and imports here the way
// any Excel file does.

export type SheetsSample = {
  file: string;
  title: string;
  detail: string;
  /** What the art on its tile draws. */
  art: "bars" | "gantt" | "area";
};

export const SHEETS_SAMPLES_PATH = "/samples/sheets";

export const SHEETS_SAMPLES: SheetsSample[] = [
  {
    file: "sales-performance-2026.xlsx",
    title: "Sales performance 2026",
    detail: "240 orders, XLOOKUP and SUMIFS, a leaderboard that re-sorts itself, 4 charts",
    art: "bars",
  },
  {
    file: "project-tracker.xlsx",
    title: "Project tracker",
    detail: "Late tasks in red, dropdowns for owners and status, pie and radar charts",
    art: "gantt",
  },
  {
    file: "budget-cash-flow.xlsx",
    title: "Budget and cash flow",
    detail: "Pick a scenario and a 12-month model follows, with combo, area and scatter charts",
    art: "area",
  },
];
