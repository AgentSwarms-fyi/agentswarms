// Run a connector template against your own account (R528).
//
//   npm run connector:check -- <id> [name=value …]
//
// The template's inputs are given as name=value; the credential, when the API
// needs one, is read from the CONNECTOR_CREDENTIAL environment variable so it
// never sits in your shell history. Each stream's first page is read through
// the same engine a sync uses, and the script prints what came back: rows and
// the first columns. Nothing is saved. This is how a template earns
// "checked": "live": the maintainers cannot run it against your account, you
// can, in one command.
import { readFileSync } from "node:fs";
import path from "node:path";

import { applyTemplate, type ConnectorTemplate } from "../src/lib/connectorTemplate";
import { fetchRestRows } from "../src/utils/saas/restApi.server";

const PREVIEW = 5;

async function main(): Promise<void> {
  const [id, ...pairs] = process.argv.slice(2);
  if (!id) {
    console.error("Usage: npm run connector:check -- <id> [name=value …]");
    process.exitCode = 1;
    return;
  }
  let template: ConnectorTemplate;
  try {
    template = JSON.parse(
      readFileSync(path.resolve("src/connectors", `${id}.json`), "utf8"),
    ) as ConnectorTemplate;
  } catch (e) {
    console.error(`No template ${id}: ${(e as Error).message}`);
    process.exitCode = 1;
    return;
  }
  const values = Object.fromEntries(
    pairs.map((p) => [p.slice(0, p.indexOf("=")), p.slice(p.indexOf("=") + 1)]),
  );
  const applied = applyTemplate(template, values);
  if (!applied.ok) {
    console.error(`${template.label}: ${applied.errors.join("; ")}`);
    process.exitCode = 1;
    return;
  }
  const cfg = {
    provider: "rest_api" as const,
    spec: JSON.stringify(applied.spec),
    credential: process.env.CONNECTOR_CREDENTIAL ?? "",
  };
  let failed = 0;
  for (const stream of applied.spec.streams) {
    const rows: Record<string, unknown>[] = [];
    try {
      for await (const r of fetchRestRows(cfg, stream.id)) {
        rows.push(r);
        if (rows.length >= PREVIEW) break;
      }
      const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
      console.log(
        `ok    ${stream.id}: ${rows.length}${rows.length >= PREVIEW ? "+" : ""} rows; columns ${cols.slice(0, 8).join(", ")}${cols.length > 8 ? ", …" : ""}`,
      );
    } catch (e) {
      failed += 1;
      console.log(`fail  ${stream.id}: ${(e as Error).message}`);
    }
  }
  console.log(
    failed
      ? `${failed} of ${applied.spec.streams.length} streams failed.`
      : `Every stream answered. If this was a real account, set "checked": "live" in src/connectors/${id}.json.`,
  );
  // process.exitCode, not process.exit(): exiting straight after a fetch
  // aborts Node on Windows and reads as a failure.
  process.exitCode = failed ? 1 : 0;
}

void main();
