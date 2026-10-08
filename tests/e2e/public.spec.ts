// The public pages, in a real browser (R324).
//
// Each page is loaded in Chromium and must render its heading with no
// uncaught page error, no console error and no error boundary. Two pages are
// then used: the docs navigate on the client, and the sign-in card switches
// to sign-up, which only happens if the page hydrated.
import { expect, test, type Page } from "@playwright/test";
import { PAGES } from "./pages";

/**
 * Console errors that say something about the environment, not the page: a
 * browser offline in CI cannot reach the hosted analytics or the Supabase URL
 * a placeholder build points at.
 */
const ENVIRONMENT_NOISE = [/placeholder\.supabase\.co/, /googletagmanager|google-analytics/];

function watch(page: Page) {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const where = msg.location()?.url ?? "";
    const text = `${msg.text()} @ ${where}`;
    if (ENVIRONMENT_NOISE.some((re) => re.test(text))) return;
    problems.push(`console: ${text}`);
  });
  return problems;
}

async function settled(page: Page) {
  await page.waitForLoadState("networkidle");
  await expect(page.locator("text=/Something went wrong|Application error/i")).toHaveCount(0);
}

/** The visible copy of a text: some pages render one for wide screens and one for narrow. */
const shown = (page: Page, text: string) => page.getByText(text).filter({ visible: true }).first();

for (const { path, shows } of PAGES) {
  test(`${path} renders in the browser without an error`, async ({ page }) => {
    const problems = watch(page);
    const res = await page.goto(path);
    expect(res?.status(), path).toBeLessThan(400);
    await settled(page);
    await expect(shows ? shown(page, shows) : page.locator("h1").first()).toBeVisible();
    expect(problems, path).toEqual([]);
  });
}

test("the docs navigate on the client, without reloading the page", async ({ page }) => {
  const problems = watch(page);
  await page.goto("/docs");
  await settled(page);
  await page.evaluate(() => ((window as unknown as { __e2e?: number }).__e2e = 1));

  await page.locator('a[href="/docs/swarms"]').first().click();
  await expect(page).toHaveURL(/\/docs\/swarms$/);
  await settled(page);
  // The marker survives only a client-side navigation.
  expect(await page.evaluate(() => (window as unknown as { __e2e?: number }).__e2e)).toBe(1);
  expect(problems).toEqual([]);
});

test("the sign-in card switches to sign-up, which needs the page hydrated", async ({ page }) => {
  const problems = watch(page);
  await page.goto("/login");
  await settled(page);
  await expect(shown(page, "Sign in to your account")).toBeVisible();

  await page.getByRole("button", { name: "Sign up", exact: true }).click();
  await expect(shown(page, "Create your account")).toBeVisible();
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(shown(page, "Sign in to your account")).toBeVisible();
  expect(problems).toEqual([]);
});
