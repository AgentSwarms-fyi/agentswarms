// Incremental SaaS sync: following a source instead of re-reading it.
//
// Every sync used to be a full refresh — page the whole source, replace the
// dataset. That is right for a spreadsheet and untenable for a Salesforce org:
// re-reading millions of records hourly burns the customer's rate limit for no
// new information and eventually takes longer than the interval it runs on.
//
// The decisions worth pinning are the ones that go wrong SILENTLY. A cursor
// that moves when it should not skips rows for ever and nothing reports it; a
// merge without a primary key turns every edit into a duplicate row; a cursor
// written before the rows are committed loses a whole window on the next run.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  advanceCursor,
  cursorAdvances,
  SYNC_MODES,
  type IncrementalSpec,
} from "@/utils/saas/types";

const rd = (p: string) => readFileSync(p, "utf8");

const ISO: IncrementalSpec = { cursorField: "updated", primaryKey: "id", compare: "iso" };
const NUM: IncrementalSpec = { cursorField: "seq", primaryKey: "id", compare: "number" };

describe("the cursor only ever moves forward", () => {
  it("advances from nothing to anything", () => {
    expect(cursorAdvances(null, "2026-01-01T00:00:00Z", "iso")).toBe(true);
    expect(cursorAdvances("", "5", "number")).toBe(true);
  });

  it("does not advance on a tie", () => {
    // An API that returns records with the same timestamp across a page
    // boundary would otherwise lose every one after the first.
    expect(cursorAdvances("2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", "iso")).toBe(false);
    expect(cursorAdvances("5", "5", "number")).toBe(false);
  });

  it("does not go backwards", () => {
    expect(cursorAdvances("2026-06-01T00:00:00Z", "2026-01-01T00:00:00Z", "iso")).toBe(false);
    expect(cursorAdvances("10", "9", "number")).toBe(false);
  });

  it("compares numbers as numbers, not as text", () => {
    // "9" > "10" as strings. A numeric cursor compared lexically walks
    // BACKWARDS at every power of ten, re-reading everything for ever.
    expect(cursorAdvances("9", "10", "number")).toBe(true);
    expect(cursorAdvances("10", "9", "number")).toBe(false);
  });

  it("refuses to advance on a value it cannot read", () => {
    // Refusing is the safe half of the mistake: it re-reads rather than skips.
    expect(cursorAdvances("2026-01-01T00:00:00Z", "not a date", "iso")).toBe(false);
    expect(cursorAdvances("5", "banana", "number")).toBe(false);
    expect(cursorAdvances(null, null, "iso")).toBe(false);
    expect(cursorAdvances("5", "", "number")).toBe(false);
  });

  it("takes the highest in a batch, whatever order it arrives in", () => {
    const rows = [
      { id: "a", updated: "2026-03-01T00:00:00Z" },
      { id: "b", updated: "2026-05-01T00:00:00Z" },
      { id: "c", updated: "2026-04-01T00:00:00Z" },
    ];
    expect(advanceCursor(null, rows, ISO)).toBe("2026-05-01T00:00:00Z");
    // An API that does not sort is not a reason to lose ground.
    expect(advanceCursor("2026-06-01T00:00:00Z", rows, ISO)).toBe("2026-06-01T00:00:00Z");
  });

  it("ignores rows with no cursor value rather than resetting", () => {
    // A record the API returned without the field must not drag the mark back
    // to null, which would re-read the source from the beginning next time.
    const rows = [{ id: "a" }, { id: "b", updated: null }, { id: "c", updated: undefined }];
    expect(advanceCursor("2026-01-01T00:00:00Z", rows, ISO)).toBe("2026-01-01T00:00:00Z");
    // And a mixed batch still takes the one real value in it.
    const mixed = [{ id: "a" }, { id: "b", updated: "2026-02-01T00:00:00Z" }];
    expect(advanceCursor("2026-01-01T00:00:00Z", mixed, ISO)).toBe("2026-02-01T00:00:00Z");
  });

  it("handles a numeric batch", () => {
    const rows = [
      { id: "a", seq: 3 },
      { id: "b", seq: 41 },
      { id: "c", seq: 9 },
    ];
    expect(advanceCursor("2", rows, NUM)).toBe("41");
  });
});

describe("what a connector must declare to sync incrementally", () => {
  it("offers exactly two modes", () => {
    expect([...SYNC_MODES]).toEqual(["full_refresh", "incremental"]);
  });

  it("every declared spec names a key AND a cursor, with a comparison", async () => {
    // A spec missing the primary key can only append, so an edited record
    // arrives as a SECOND row and the dataset grows duplicates silently.
    const { connectorFor } = await import("@/utils/saas/sync.server");
    const { SAAS_PROVIDERS } = await import("@/utils/saas/types");
    let declared = 0;
    for (const provider of SAAS_PROVIDERS) {
      const connector = connectorFor(provider);
      if (!connector.incremental) continue;
      const streams = STREAM_IDS[provider] ?? [];
      expect(streams.length, `no stream ids listed for ${provider}`).toBeGreaterThan(0);
      for (const stream of streams) {
        const spec = connector.incremental(stream);
        if (!spec) continue;
        declared += 1;
        expect(spec.cursorField, `${provider}.${stream} cursorField`).toBeTruthy();
        expect(spec.primaryKey, `${provider}.${stream} primaryKey`).toBeTruthy();
        expect(["iso", "number"]).toContain(spec.compare);
      }
    }
    expect(declared, "no connector declares incremental support").toBeGreaterThan(0);
  });

  it("says no for a stream it does not know", async () => {
    const { connectorFor } = await import("@/utils/saas/sync.server");
    expect(connectorFor("salesforce").incremental?.("not_a_stream")).toBeNull();
    expect(connectorFor("stripe").incremental?.("not_a_stream")).toBeNull();
  });

  it("leaves a mutable Stripe object on full refresh, deliberately", () => {
    // `customers` and `subscriptions` are edited in place and their `created`
    // never moves, so following it would miss every edit.
    const src = rd("src/utils/saas/stripe.server.ts");
    const table = src.slice(
      src.indexOf("const INCREMENTAL"),
      src.indexOf("export function stripeIncremental"),
    );
    expect(table).toContain("charges:");
    expect(table).not.toContain("customers:");
    expect(table).not.toContain("subscriptions:");
  });

  it("follows Salesforce's SystemModstamp, not LastModifiedDate", () => {
    // LastModifiedDate reflects user edits only. SystemModstamp also moves on
    // a merge, a cascade or a bulk update — the changes nobody notices missing.
    const src = rd("src/utils/saas/salesforce.server.ts");
    expect(src).toContain('cursorField: "SystemModstamp"');
    expect(src).not.toMatch(/cursorField: "LastModifiedDate"/);
    // Ordered, or paging past the first page returns arbitrary records.
    expect(src).toContain("ORDER BY SystemModstamp ASC");
  });

  it("asks Stripe for a closed interval, so a boundary row is not dropped", () => {
    // `gt` would drop any record sharing the exact second of the last one
    // seen; `gte` re-reads it and the primary key folds it away.
    const src = rd("src/utils/saas/stripe.server.ts");
    expect(src).toContain("created[gte]");
    expect(src).not.toContain("created[gt]:");
  });
});

/** The streams each connector offers, for the conformance sweep above. */
const STREAM_IDS: Record<string, string[]> = {
  stripe: [
    "charges",
    "customers",
    "invoices",
    "subscriptions",
    "payment_intents",
    "products",
    "prices",
    "refunds",
    "payouts",
    "balance_transactions",
  ],
  salesforce: ["accounts", "contacts", "leads", "opportunities", "cases", "campaigns", "users"],
  shopify: ["orders", "customers", "products", "draft_orders", "price_rules"],
  hubspot: ["contacts", "companies", "deals", "tickets", "line_items", "products"],
  zendesk: ["tickets", "users", "organizations"],
  jira: ["issues:ACME"],
  servicenow: [
    "incident",
    "change_request",
    "problem",
    "sc_request",
    "sc_req_item",
    "task",
    "sys_user",
    "cmdb_ci",
  ],
  intercom: ["contacts", "conversations", "admins"],
  github: ["issues:acme/web"],
  linear: ["issues", "projects", "teams", "users", "cycles"],
  asana: ["tasks:1234567890"],
  freshdesk: ["tickets", "contacts", "companies", "agents"],
  klaviyo: ["profiles", "events", "lists", "metrics", "campaigns"],
  notion: ["database:11111111-2222-3333-4444-555555555555"],
  airtable: ["records:appAbCdEf123456:tblAbCdEf123456"],
  // Google Sheets is the one source with genuinely nothing to follow: a
  // worksheet's rows are edited and deleted in place with no timestamp.
  google_sheets: ["Sheet1"],
};

describe("the runner cannot lose or skip a window", () => {
  const runner = () => rd("src/utils/saas/sync.server.ts");

  it("writes the cursor only after the rows are committed", () => {
    // Advanced first and then lost to a failed ingest, the next run skips
    // everything in that window and nothing ever says so.
    const src = runner();
    const ingest = src.indexOf("const result = await ingestRows");
    const write = src.indexOf("await writeStreamState");
    expect(ingest).toBeGreaterThan(0);
    expect(write).toBeGreaterThan(ingest);
  });

  it("replaces rather than merges on the FIRST pass", () => {
    // With no cursor the connector reads everything, so merging into a stale
    // dataset would leave rows the source has since deleted, for ever.
    const src = runner();
    expect(src).toContain("const merging = Boolean(spec && since);");
    expect(src).toContain("...(merging && spec ? { mergeKey: spec.primaryKey } : {})");
  });

  it("tracks the high-water mark as rows stream past, not afterwards", () => {
    // The generator is consumed once by ingestRows and cannot be replayed.
    const src = runner();
    expect(src).toMatch(/for await \(const row of connector\.fetchRows[\s\S]{0,200}?advanceCursor/);
  });

  it("passes the stored cursor to the connector, and nothing when full", () => {
    const src = runner();
    expect(src).toContain("const since = state?.cursor ?? undefined;");
    expect(src).toContain("args.fullRefresh ? null : (connector.incremental?.(args.streamId)");
  });

  it("offers a way to forget the cursor", () => {
    // The escape hatch for what a cursor cannot see: records changed without
    // moving their cursor field, or a backfill predating the connection.
    expect(runner()).toContain("export async function resetStreamCursor");
  });
});

describe("the merge is a database statement, and it is owner-safe", () => {
  const sql = () => rd("supabase/migrations/20260897000000_saas_incremental.sql");

  it("refuses to splice one owner's rows into another's dataset", () => {
    expect(sql()).toContain("datasets have different owners");
  });

  it("is not callable by a signed-in client", () => {
    // A client that could set its own cursor could skip rows it did not want
    // synced, or force a full re-read of somebody's paid API quota.
    const s = sql();
    expect(s).toMatch(
      /REVOKE ALL ON FUNCTION public\.merge_dataset_rows[\s\S]{0,80}?authenticated/,
    );
    expect(s).toContain('CREATE POLICY "Users read own stream state"');
    expect(s).not.toMatch(/saas_stream_state FOR (INSERT|UPDATE|ALL)/);
  });

  it("does not let one keyless row delete the others", () => {
    // A NULL key matches nothing, so it can only ever be an insert.
    expect(sql()).toContain("(row ->> p_key) IS NOT NULL");
  });

  it("refuses a dataset with no owner, which is what a sample is", () => {
    // `user_data_tables.user_id` is NULLABLE because sample datasets belong to
    // nobody. Treating NULL as "matches any owner" would let a connector merge
    // into the shared samples every deployment ships with.
    const s = sql();
    expect(s).toContain("unknown or unowned dataset");
    expect(s).toContain("IF v_owner IS NULL OR v_staging_owner IS NULL THEN");
  });

  it("counts updates and inserts separately", () => {
    const s = sql();
    expect(s).toContain("RETURNS TABLE (updated integer, inserted integer)");
  });

  it("keys the high-water mark per stream, not per connection", () => {
    // One Stripe connection syncing charges and customers has two independent
    // marks; one stream failing must not rewind the other.
    expect(sql()).toContain("PRIMARY KEY (connection_id, stream)");
  });
});

describe("the ingest path still replaces for everything else", () => {
  it("only the connector call site can merge", () => {
    // An upload has no cursor and must keep replacing.
    const src = rd("src/utils/data/ingest.server.ts");
    expect(src.match(/mergeKey: args\.mergeKey/g)?.length).toBe(1);
    expect(src).toContain("if (args.mergeKey) {");
  });

  it("snapshots the dataset before either path touches it", () => {
    // The recovery story for a sync that pulls a truncated source.
    const src = rd("src/utils/data/ingest.server.ts");
    const snap = src.indexOf("snapshotDatasetQuiet");
    const merge = src.indexOf("merge_dataset_rows");
    expect(snap).toBeGreaterThan(0);
    expect(merge).toBeGreaterThan(snap);
  });
});

describe("it is operable, and the costly half is the owner's", () => {
  it("shows the mode for EVERY selected stream, not just followed ones", () => {
    // A stream on full refresh has no state row, and is exactly the one
    // somebody is looking for when they ask why a sync takes an hour.
    const fns = rd("src/utils/saas.functions.ts");
    expect(fns).toContain("states: conn.streams.map((stream)");
    expect(fns).toContain("connector.incremental?.(stream)");
  });

  it("lets a grantee look but not spend the owner's quota", () => {
    // Triggering a sync is shared; a full re-read is charged to the owner's
    // API limit and can take hours.
    const fns = rd("src/utils/saas.functions.ts");
    const reset = fns.slice(fns.indexOf("export const resetSaasCursor"));
    expect(reset).toContain("allowShared: false");
    const states = fns.slice(
      fns.indexOf("export const saasStreamStates"),
      fns.indexOf("export const resetSaasCursor"),
    );
    expect(states).toContain("allowShared: true");
  });

  it("audits a reset, because it spends something", () => {
    // "Why did we hit Salesforce's API ceiling on Tuesday" is a question this
    // answers.
    const fns = rd("src/utils/saas.functions.ts");
    expect(fns).toContain('action: "saas_connection.cursor_reset"');
    expect(fns).toMatch(/cursor_reset[\s\S]{0,400}?streams:/);
  });

  it("hides Start over from a grantee, rather than letting it always fail", () => {
    const ui = rd("src/components/integrations/StreamStateDialog.tsx");
    expect(ui).toContain('s.mode === "incremental" && !shared');
    // And says why, instead of showing nothing.
    expect(ui).toContain("Shared source — starting over is the owner's to decide.");
  });

  it("no longer tells everyone that a sync always replaces", () => {
    // The card said "A sync REPLACES that dataset" — true of every source
    // until this milestone, and now only half the story. A claim the product
    // makes about itself is the first thing an operator believes.
    const tab = rd("src/components/integrations/SaasSourcesTab.tsx");
    expect(tab).not.toContain("A sync REPLACES that dataset");
    expect(tab).toContain("it got to last time");
    expect(tab).toContain("is re-read in full, replacing the dataset");
  });

  it("does not report a failure as an empty source", () => {
    // FOUND FROM THE UI. A failed read landed in `states = []`, which renders
    // as "no streams are selected" — a calm, wrong answer. "Nothing selected"
    // and "we could not read this" are different facts and only one of them
    // needs acting on.
    const ui = rd("src/components/integrations/StreamStateDialog.tsx");
    expect(ui).toContain("const [failed, setFailed]");
    // The error branch is checked BEFORE the empty branch, or it never shows.
    const failedAt = ui.indexOf(") : failed ? (");
    const emptyAt = ui.indexOf("No streams are selected for this source yet.");
    expect(failedAt).toBeGreaterThan(0);
    expect(failedAt).toBeLessThan(emptyAt);
    expect(ui).toContain("{failed}");
  });

  it("distinguishes 'nothing changed' from 'never followed'", () => {
    // The two look identical from outside and mean opposite things.
    const ui = rd("src/components/integrations/StreamStateDialog.tsx");
    expect(ui).toContain("Not followed yet");
    expect(ui).toContain("Caught up to");
  });
});

describe("each connector asks its own API the right question", () => {
  it("Shopify filters on updated_at_min, inclusive", () => {
    const src = rd("src/utils/saas/shopify.server.ts");
    expect(src).toContain('first.searchParams.set("updated_at_min"');
    // Re-parsed rather than interpolated, so a bad stored cursor cannot
    // become part of the query string.
    expect(src).toContain("const at = since ? new Date(since) : null;");
  });

  it("Jira orders ASCENDING, because it pages by offset", () => {
    // With `updated DESC` a record edited mid-sync was prepended and shifted
    // every later page down one, skipping a row per edit on a busy project.
    const src = rd("src/utils/saas/jira.server.ts");
    expect(src).toContain("ORDER BY updated ASC");
    expect(src).not.toContain("ORDER BY updated DESC");
  });

  it("Jira widens the window past any timezone offset", () => {
    // JQL compares a bare timestamp against the SITE's timezone, which this
    // code cannot know. Guessing wrong in the wrong direction skips edits.
    const src = rd("src/utils/saas/jira.server.ts");
    expect(src).toContain("const JQL_SAFETY_HOURS = 24;");
    expect(src).toContain("JQL_SAFETY_HOURS * 3600_000");
  });

  it("HubSpot searches rather than lists, and survives the 10k ceiling", () => {
    // The list endpoint cannot filter by date at all. Search can, but stops
    // returning a cursor past 10,000 — a naive follower stops there silently.
    const src = rd("src/utils/saas/hubspot.server.ts");
    expect(src).toContain("/search");
    expect(src).toContain("const SEARCH_WINDOW = 10_000;");
    expect(src).toContain('direction: "ASCENDING"');
    // And it cannot loop for ever when a whole window shares one timestamp.
    expect(src).toContain("if (newest <= windowStart) return;");
  });

  it("Zendesk uses the incremental export, and does not stop on a quiet page", () => {
    // The export walks a time-ordered log: an empty page is a quiet hour, not
    // the end. `end_of_stream` is the only authoritative terminator.
    const src = rd("src/utils/saas/zendesk.server.ts");
    expect(src).toContain("/api/v2/incremental/tickets/cursor.json");
    expect(src).toContain("if (page.end_of_stream || !page.after_cursor) return;");
    // Zendesk rejects a start_time inside the last minute.
    expect(src).toContain("Date.now() - 60_000");
  });

  it("says which streams have nothing to follow, rather than leaving a gap", () => {
    // Zendesk organizations have no incremental export; Google Sheets has no
    // cursor at all. Both are full refresh ON PURPOSE.
    const zendesk = rd("src/utils/saas/zendesk.server.ts");
    expect(zendesk).toContain("Zendesk offers no incremental export for organizations");
    const sheets = rd("src/utils/saas/googleSheets.server.ts");
    expect(sheets).not.toContain("IncrementalSpec");
  });

  it("every incremental connector accepts a `since` it can ignore", async () => {
    // The runner only passes one where the connector declared support, but a
    // connector that took a third argument it did not use would be a trap for
    // the next person to add a stream.
    const { connectorFor } = await import("@/utils/saas/sync.server");
    const { SAAS_PROVIDERS } = await import("@/utils/saas/types");
    for (const provider of SAAS_PROVIDERS) {
      const c = connectorFor(provider);
      const declaresAny = (STREAM_IDS[provider] ?? []).some((s) => c.incremental?.(s));
      // fetchRows(cfg, streamId, since?) — three parameters where followed.
      expect(c.fetchRows.length, `${provider} fetchRows arity`).toBe(declaresAny ? 3 : 2);
    }
  });
});

describe("adding a provider means wiring every place that knows about one", () => {
  // FOUND FROM A PREVIOUS MILESTONE. `workflow_node_runs_kind_check` admitted
  // four of fifteen kinds: a graph saved and drew fine, then failed the moment
  // anybody ran it, with a raw Postgres constraint name where a reason should
  // be. A list in the database that lags a list in the code is invisible
  // until the worst moment, so it is pinned.
  const providersInCode = () => {
    const src = rd("src/utils/saas/types.ts");
    const block = src.slice(
      src.indexOf("export const SAAS_PROVIDERS"),
      src.indexOf("export const SAAS_LABELS"),
    );
    return [...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  };

  it("the database CHECK admits exactly the providers the code offers", () => {
    const sql = rd("supabase/migrations/20260900000000_saas_klaviyo_notion_airtable.sql");
    const inCheck = [...sql.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect([...inCheck].sort()).toEqual([...providersInCode()].sort());
  });

  it("every provider has a label, a card and a connector", async () => {
    const { connectorFor } = await import("@/utils/saas/sync.server");
    const types = rd("src/utils/saas/types.ts");
    const tab = rd("src/components/integrations/SaasSourcesTab.tsx");
    for (const p of providersInCode()) {
      expect(types, `${p} has no label`).toMatch(new RegExp(`${p}: "`));
      expect(tab, `${p} has no card`).toContain(`  ${p}: {`);
      // Throws for an unregistered provider, which is the assertion.
      expect(connectorFor(p as never)).toBeTruthy();
    }
  });

  it("the counts the README and the docs quote are the real ones", () => {
    // These drifted silently once already: adding three connectors left the
    // README saying 29 and "7 apps". A number a reader trusts is worse wrong
    // than absent, and nothing was checking it.
    const apps = providersInCode().length;
    const readme = rd("README.md");
    expect(readme, "README app count").toContain(`${apps} apps (`);
    // 22 warehouse connectors + the apps. If either half moves, this fails.
    expect(readme, "README total").toContain(`**${22 + apps} connectors**`);
    expect(readme).toContain(`- **Coverage** — ${22 + apps} connectors`);
    expect(rd("src/routes/docs.integrations.tsx")).toContain(`${apps} apps synced into datasets`);
    // And every provider is actually named in the connector reference.
    const sources = rd("docs/DATA_SOURCES.md");
    for (const p of providersInCode()) {
      const label = p === "google_sheets" ? "Google Sheets" : p;
      expect(sources.toLowerCase(), `${p} is undocumented`).toContain(label.toLowerCase());
    }
  });

  it("does not invent plurals", () => {
    // FOUND FROM THE UI. `${unit}s` rendered "Connect and list repositorys".
    // English plurals are not derivable, so each provider states its own.
    const tab = rd("src/components/integrations/SaasSourcesTab.tsx");
    expect(tab).not.toContain("].unit}s`");
    expect(tab).toContain('units: "repositories"');
    // One plural per provider, and the type makes it non-optional.
    const units = tab.match(/units: "/g)?.length ?? 0;
    expect(units).toBe(providersInCode().length);
    expect(tab).toContain("unit: string; units: string;");
  });

  it("does not describe every source as a spreadsheet", () => {
    // FOUND FROM THE UI. The connect dialog's Name field was written for
    // Google Sheets and shown for all ten providers, so somebody connecting
    // ServiceNow was told about spreadsheets and a "Sheet1" they do not have.
    const tab = rd("src/components/integrations/SaasSourcesTab.tsx");
    expect(tab).not.toContain('placeholder="Finance spreadsheet"');
    expect(tab).not.toContain("a “Sheet1” cannot overwrite");
    // It uses the unit each provider already declares.
    expect(tab).toContain("PROVIDER_HELP[dialogProvider].unit");
  });

  it("every provider the sweep covers has its streams listed", () => {
    // A provider added without stream ids would slip through the conformance
    // sweep above without failing it — passing by being invisible.
    for (const p of providersInCode()) {
      expect(STREAM_IDS[p], `${p} is missing from STREAM_IDS`).toBeDefined();
    }
  });
});

describe("the three native connectors ask their own APIs correctly", () => {
  it("ServiceNow orders its query, because it pages by offset", () => {
    // Without ORDERBY, ServiceNow promises no stable order and an offset into
    // an unordered set repeats or skips rows as records change mid-sync.
    const src = rd("src/utils/saas/servicenow.server.ts");
    expect(src).toContain("^ORDERBYsys_updated_on");
    expect(src).toContain("sys_updated_on>=");
  });

  it("ServiceNow asks for RAW values, not display values", () => {
    // `sysparm_display_value=true` renders dates in the instance's own format
    // and timezone, which makes the cursor unparseable and shifts the window.
    const src = rd("src/utils/saas/servicenow.server.ts");
    expect(src).toContain('sysparm_display_value: "false"');
  });

  it("ServiceNow keys on sys_id, not the display number", () => {
    // INC0012345 is display text an admin can reformat; sys_id is a GUID.
    const src = rd("src/utils/saas/servicenow.server.ts");
    expect(src).toContain('primaryKey: "sys_id"');
    expect(src).not.toContain('primaryKey: "number"');
  });

  it("Intercom compares its cursor as a NUMBER", () => {
    // `updated_at` is Unix seconds. Compared as text, "9…" beats "10…" and the
    // cursor walks backwards at every digit boundary.
    const src = rd("src/utils/saas/intercom.server.ts");
    expect(src).toContain('compare: "number"');
    expect(src).toContain('sort_order: "ascending"');
  });

  it("Intercom leaves admins on full refresh, and says so", () => {
    const src = rd("src/utils/saas/intercom.server.ts");
    expect(src).toContain("searchable: false");
    expect(src).toContain("Stated rather than left as an absence.");
  });

  it("GitHub asks for every state, or it silently omits closed issues", () => {
    // The default is open-only, which is a minority of any real repo.
    const src = rd("src/utils/saas/github.server.ts");
    expect(src).toContain('first.searchParams.set("state", "all")');
    expect(src).toContain('first.searchParams.set("direction", "asc")');
  });

  it("GitHub records that an issue is a pull request rather than hiding it", () => {
    // The issues endpoint returns PRs too. Dropping them loses data; hiding
    // the difference makes "how many issues" wrong.
    const src = rd("src/utils/saas/github.server.ts");
    expect(src).toContain("is_pull_request: isPr");
  });

  it("GitHub tries the org endpoint before the user one", () => {
    // /users/<org>/repos returns only PUBLIC repositories for an org, silently
    // omitting the private ones somebody is most likely to want.
    const src = rd("src/utils/saas/github.server.ts");
    // The URLs themselves, not the comment that explains them.
    const orgAt = src.indexOf("${API}/orgs/");
    const userAt = src.indexOf("${API}/users/");
    expect(orgAt).toBeGreaterThan(0);
    expect(orgAt).toBeLessThan(userAt);
  });

  it("every new connector explains a 401 and a 403 differently", () => {
    // "Rejected" and "lacks permission" send somebody to different places.
    for (const f of ["servicenow", "intercom", "github"]) {
      const src = rd(`src/utils/saas/${f}.server.ts`);
      expect(src, `${f} 401`).toMatch(/res\.status === 401/);
      expect(src, `${f} 403`).toMatch(/res\.status === 403/);
    }
  });
});

describe("the marketing, wiki and spreadsheet sources", () => {
  it("Klaviyo follows its own next link rather than rebuilding one", () => {
    // The link carries the cursor AND the filters. Rebuilding is how a filter
    // gets dropped on page two and the sync quietly returns everything.
    const src = rd("src/utils/saas/klaviyo.server.ts");
    expect(src).toContain("url = page.links?.next ?? null;");
    expect(src).toContain("greater-or-equal(");
    // The revision header is required on every request, not optional.
    expect(src).toContain('const REVISION = "2024-10-15";');
    expect(src).toContain("revision: REVISION");
  });

  it("Klaviyo sends its key the way Klaviyo wants it", () => {
    const src = rd("src/utils/saas/klaviyo.server.ts");
    expect(src).toContain("Klaviyo-API-Key ${cfg.api_key}");
    expect(src).not.toContain("Bearer ${cfg.api_key}");
  });

  it("Klaviyo asks campaigns for a channel, which is not optional", () => {
    const src = rd("src/utils/saas/klaviyo.server.ts");
    expect(src).toContain("equals(messages.channel,'email')");
  });

  it("Notion unwraps a property rather than flattening its type wrapper", async () => {
    // Left alone this produces columns like properties_Owner_people_0_id.
    const { notionPropertyValue } = await import("@/utils/saas/notion.server");
    expect(notionPropertyValue({ type: "title", title: [{ plain_text: "Ship it" }] })).toBe(
      "Ship it",
    );
    expect(notionPropertyValue({ type: "select", select: { name: "Done" } })).toBe("Done");
    expect(
      notionPropertyValue({ type: "multi_select", multi_select: [{ name: "a" }, { name: "b" }] }),
    ).toBe("a, b");
    expect(notionPropertyValue({ type: "number", number: 7 })).toBe(7);
    expect(notionPropertyValue({ type: "checkbox", checkbox: true })).toBe(true);
  });

  it("Notion keeps the END of a date range", () => {
    // Collapsing a range to its start is a silently wrong answer to "how long
    // did this take".
    const src = rd("src/utils/saas/notion.server.ts");
    expect(src).toContain("d?.end ? `${d.start} → ${d.end}`");
  });

  it("Notion says WHY an empty database list is empty", () => {
    // Notion answers an unshared integration with an empty list, not an error.
    const src = rd("src/utils/saas/notion.server.ts");
    expect(src).toContain("Connections");
    expect(src).toMatch(/streams\.length === 0[\s\S]{0,300}?add the integration/);
  });

  it("Airtable is full refresh on purpose, and the reason is written down", () => {
    // It exposes no universal modified timestamp. Guessing at a likely field
    // name would follow the wrong column on some bases and miss edits.
    const src = rd("src/utils/saas/airtable.server.ts");
    expect(src).toContain("no universal");
    expect(src).toMatch(/export function airtableIncremental[\s\S]{0,200}?return null;/);
  });

  it("Airtable merges fields up, and tolerates a varying column set", () => {
    // An empty Airtable cell is omitted from `fields` entirely rather than
    // sent as null, so a record's columns vary row to row.
    const src = rd("src/utils/saas/airtable.server.ts");
    expect(src).toContain("...(r.fields ?? {})");
    expect(src).toContain("varies row to row");
  });
});
