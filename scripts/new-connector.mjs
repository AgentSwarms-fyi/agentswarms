// Start a connector template (R528): `npm run connector:new -- <id>`.
//
// Writes src/connectors/<id>.json from the example and a recorded-response
// stub at tests/fixtures/connectors/<id>.json, then says what to edit. The
// contract test (tests/unit/connectorTemplates.test.ts) runs both through the
// real engine; `npm run connector:check -- <id> …` runs the template against
// your own account.
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";

const id = (process.argv[2] ?? "").trim();
if (!/^[a-z][a-z0-9_]{1,39}$/.test(id)) {
  console.error(
    "Usage: npm run connector:new -- <id>   (lower case letters, digits and _, e.g. acme_crm)",
  );
  process.exitCode = 1;
} else {
  const template = path.resolve("src/connectors", `${id}.json`);
  const fixture = path.resolve("tests/fixtures/connectors", `${id}.json`);
  if (existsSync(template) || existsSync(fixture)) {
    console.error(`${id} exists already; nothing was written.`);
    process.exitCode = 1;
  } else {
    const spec = {
      id,
      label: "Name the API",
      description: "What it syncs, in one sentence.",
      checked: "reference",
      inputs: [],
      credential: "Where to get the key, and how the API takes it.",
      spec: {
        version: 1,
        name: "Name the API",
        base_url: "https://api.example.com/v1",
        auth: { kind: "bearer" },
        streams: [
          {
            id: "orders",
            label: "Orders",
            path: "/orders",
            records: "data",
            pagination: { kind: "page", param: "page", size_param: "per_page", size: 100 },
          },
        ],
      },
    };
    const stub = {
      inputs: {},
      credential: "test-token",
      streams: {
        orders: {
          pages: [{ body: { data: [{ id: 1, name: "An example record" }] } }],
          rows: 1,
        },
      },
    };
    writeFileSync(template, `${JSON.stringify(spec, null, 2)}\n`);
    writeFileSync(fixture, `${JSON.stringify(stub, null, 2)}\n`);
    console.log(
      `Wrote ${path.relative(process.cwd(), template)} and ${path.relative(process.cwd(), fixture)}.`,
    );
    console.log("Next:");
    console.log(
      "  1. Edit the template: base_url, auth, and one stream per list (see the docs: Any REST API).",
    );
    console.log(
      "  2. Record one or two real responses per stream in the fixture (remove anything personal).",
    );
    console.log("  3. npx vitest run tests/unit/connectorTemplates.test.ts");
    console.log(
      `  4. npm run connector:check -- ${id} … against your own account, then set "checked": "live".`,
    );
  }
}
