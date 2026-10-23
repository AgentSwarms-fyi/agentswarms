// The server's first loads, before the timed checks (R343).
//
// FOUND IN THREE LOCAL GATES (R333, R339, R342): the server answers its health
// check before it has rendered a page, and the first page of each kind reads
// its server code and assets from disk and compiles them. With four workers
// starting at once on a loaded machine, those first loads took 24 to 55 s and
// one ran past the 60 s budget, while the same pages took 2 to 4 s once
// warm. Loading every page once here, one at a time and with time to spare,
// leaves the checks to time the pages, not the server's start.
//
// Nothing is asserted here: a page that is broken fails in public.spec.ts,
// which says how.
import { test as setup } from "@playwright/test";
import { PAGES } from "./pages";

setup("the server has loaded each page once", async ({ page }) => {
  setup.setTimeout(PAGES.length * 90_000);
  for (const { path } of PAGES) {
    await page.goto(path, { waitUntil: "networkidle", timeout: 90_000 });
  }
});
