#!/usr/bin/env node
// Load every page of the app and report what breaks.
//
//   node scripts/ui-smoke.mjs [baseUrl]        # default http://localhost:8080
//
// WHAT THIS CATCHES, and what it does not. It renders each route on the SERVER
// and checks the response: a 500 from a bad loader, a 404 from a route that was
// renamed, an error boundary that made it into the HTML. It does NOT sign in,
// so it cannot see anything that only happens after the client has a session —
// use the browser for that. The value is that it covers every route in one
// pass, in a few seconds, and can run in CI against a built image.
//
// The route list is DERIVED from src/routes rather than typed out, so a new
// page is covered the day it is added and a deleted one stops being checked.
import { readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = (process.argv[2] ?? "http://localhost:8080").replace(/\/+$/, "");
// fileURLToPath, not URL.pathname: on Windows the latter yields "/C:/..." and
// every readdir silently found nothing, so the run reported three routes and a
// clean bill of health.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Route paths from the filesystem router's own conventions. */
function routesFrom(dir, { prefix = "" } = {}) {
  const full = path.join(REPO, "src", "routes", dir);
  if (!existsSync(full)) return [];
  return (
    readdirSync(full)
      .filter((f) => f.endsWith(".tsx") && !f.startsWith("_") && f !== "index.tsx")
      .map((f) => f.replace(/\.tsx$/, ""))
      // `$param` segments need a real id to be meaningful; skip them.
      .filter((n) => !n.includes("$"))
      .map((n) => `${prefix}/${n.replace(/_\./g, "/").replace(/\./g, "/")}`)
      // `docs.index.tsx` is the route `/docs`, not `/docs/index` — the router's
      // convention, and without this the run reports a phantom 404.
      .map((r) => r.replace(/\/index$/, "") || "/")
  );
}

const routes = [
  "/",
  "/login",
  "/docs",
  ...routesFrom("_authenticated"),
  ...routesFrom(".", { prefix: "" }).filter((r) => r.startsWith("/docs")),
];

const results = [];
for (const route of [...new Set(routes)].sort()) {
  const t0 = Date.now();
  try {
    const res = await fetch(BASE + route, { redirect: "manual" });
    const body = res.status < 400 ? await res.text() : "";
    // A rendered error boundary is a 200 that is still a failure.
    const boundary = /Something went wrong|Application error|Unhandled Runtime Error/i.test(body);
    results.push({
      route,
      status: res.status,
      ms: Date.now() - t0,
      bytes: body.length,
      bad: res.status >= 400 || boundary,
      note: boundary ? "error boundary in HTML" : "",
    });
  } catch (e) {
    results.push({
      route,
      status: 0,
      ms: Date.now() - t0,
      bytes: 0,
      bad: true,
      note: String(e).slice(0, 80),
    });
  }
}

for (const r of results) {
  const mark = r.bad ? "FAIL" : "ok  ";
  console.log(
    `${mark} ${String(r.status).padEnd(3)} ${String(r.ms).padStart(5)}ms ${String(r.bytes).padStart(7)}b  ${r.route}${r.note ? "  <- " + r.note : ""}`,
  );
}
const bad = results.filter((r) => r.bad);
console.log(`\n${results.length} routes, ${bad.length} failing`);
process.exit(bad.length ? 1 : 0);
