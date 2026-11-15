// A grantee no longer reads the terms of a mask on their own grant (R492).
//
// A column mask is a list of column names. "Users can view applicable grants"
// served the grantee their grant rows whole, so
//   GET /rest/v1/iam_resource_grants?select=column_mask
// named the columns the mask hides, and biGetSharedWidgetResults sent a
// dashboard grantee the whole mask too. Migration 20261116000000 serves a grant
// with a mask only to superadmins and the service role, and adds
// my_resource_grants(), which says whether a grant masks and never what.
//
// The database half is proved against a real Postgres, as each user's own JWT,
// by deploy/ci/rds-like/shared-dataset-checks.mjs (both migration harnesses).
// These hold the app half: the dashboard page's row filters, the BI server
// function, every server path that needs the terms reading them with the
// service role, and the migration's shape.
import { readFileSync, readdirSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { contractingStatements } from "../../deploy/ci/migrations/schema-compat.mjs";

type Answer = { data: unknown; error: { code?: string; message: string } | null };

const h = vi.hoisted(() => ({
  rpc: { data: [], error: null } as {
    data: unknown;
    error: { code?: string; message: string } | null;
  },
  rpcCalls: [] as Array<{ name: string; args: unknown }>,
  direct: { data: [], error: null } as { data: unknown; error: { message: string } | null },
  directReads: 0,
  // biGetSharedWidgetResults
  dashboard: null as null | Record<string, unknown>,
  results: [] as Array<Record<string, unknown>>,
  grants: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/integrations/supabase/client", () => {
  const chain = () => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in"]) q[m] = () => q;
    q.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => {
      h.directReads++;
      return Promise.resolve(h.direct).then(ok, bad);
    };
    return q;
  };
  return {
    supabase: {
      from: (table: string) => {
        if (table !== "iam_resource_grants") throw new Error(`unexpected read of ${table}`);
        return chain();
      },
      rpc: async (name: string, args: unknown) => {
        h.rpcCalls.push({ name, args });
        return h.rpc;
      },
    },
  };
});

vi.mock("@/integrations/supabase/client.server", () => {
  const read = (table: string) => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in"]) q[m] = () => q;
    q.maybeSingle = async () => ({ data: h.dashboard, error: null });
    q.then = (ok: (v: unknown) => unknown) =>
      Promise.resolve(
        table === "bi_widget_results"
          ? { data: h.results, error: null }
          : { data: [], error: null },
      ).then(ok);
    return q;
  };
  return {
    supabaseAdmin: {
      auth: { getUser: async () => ({ data: { user: { id: "viewer" } }, error: null }) },
      from: read,
    },
  };
});

vi.mock("@/utils/iam.server", () => ({
  isModelAllowed: () => true,
  readApplicableGrants: async () => h.grants,
}));

// A server function is its handler, validated.
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate: (i: unknown) => unknown = (i) => i;
    const b = {
      validator: (v: (i: unknown) => unknown) => ((validate = v), b),
      handler: (fn: (a: { data: unknown }) => unknown) => (opts: { data: unknown }) =>
        fn({ data: validate(opts.data) }),
    };
    return b;
  },
}));

const { getMyDashboardRowFilters, maskTermsNamedIn } = await import("@/lib/biDashboards");
const { biGetSharedWidgetResults } = await import("@/utils/bi.functions");

const DASHBOARD = "00000000-0000-4000-8000-00000000d000";
const MISSING: Answer = {
  data: null,
  error: {
    code: "PGRST202",
    message: "Could not find the function public.my_resource_grants in the schema cache",
  },
};

beforeEach(() => {
  h.rpc = { data: [], error: null };
  h.rpcCalls = [];
  h.direct = { data: [], error: null };
  h.directReads = 0;
  h.dashboard = null;
  h.results = [];
  h.grants = [];
});

describe("a dashboard viewer's row filters", () => {
  it("come from my_resource_grants(), masked grants included", async () => {
    // A grant with a mask is no longer in the direct read: read that way, its
    // filter was lost and the page applied only the others'.
    h.rpc = {
      data: [
        { row_filter: { column: "region", values: ["east"] }, masked: true },
        { row_filter: { column: "region", values: ["west"] }, masked: false },
      ],
      error: null,
    };
    expect(await getMyDashboardRowFilters(DASHBOARD)).toEqual([
      { column: "region", values: ["east"] },
      { column: "region", values: ["west"] },
    ]);
    expect(h.rpcCalls).toEqual([
      {
        name: "my_resource_grants",
        args: { _resource_type: "bi_dashboard", _resource_ids: [DASHBOARD] },
      },
    ]);
    expect(h.directReads).toBe(0);
  });

  it("are unrestricted when one grant has no filter, as before", async () => {
    h.rpc = {
      data: [
        { row_filter: { column: "region", values: ["east"] }, masked: true },
        { row_filter: null, masked: true },
      ],
      error: null,
    };
    expect(await getMyDashboardRowFilters(DASHBOARD)).toBeNull();
  });

  it("are read directly from a database that predates the function", async () => {
    h.rpc = MISSING;
    h.direct = { data: [{ row_filter: { column: "region", values: ["east"] } }], error: null };
    expect(await getMyDashboardRowFilters(DASHBOARD)).toEqual([
      { column: "region", values: ["east"] },
    ]);
    expect(h.directReads).toBe(1);
  });

  it("are not read directly when the function fails for another reason", async () => {
    h.rpc = { data: null, error: { message: "connection reset" } };
    expect(await getMyDashboardRowFilters(DASHBOARD)).toBeNull();
    expect(h.directReads).toBe(0);
  });
});

describe("the mask terms a dashboard's own document names", () => {
  const chart = (columns: string[], rows: Record<string, unknown>[] = []) => ({
    kind: "chart",
    id: "w",
    columns,
    rows,
  });

  it("are only those a chart widget's columns or stored rows name, on any page", () => {
    const widgets = [chart(["Region", "revenue"]), { kind: "text", columns: ["ssn"] }];
    const pages = [{ widgets: [chart([], [{ Salary: 1, region: "east" }])] }];
    expect(
      maskTermsNamedIn(["region", "salary", "ssn", "email"], [widgets, pages[0].widgets]),
    ).toEqual(["region", "salary"]);
  });

  it("are none for an empty mask, or a document with no widgets", () => {
    expect(maskTermsNamedIn([], [[chart(["salary"])]])).toEqual([]);
    expect(maskTermsNamedIn(["salary"], [null, undefined, "x", [null, 3]])).toEqual([]);
  });
});

describe("biGetSharedWidgetResults", () => {
  const call = (o: { data: unknown }) =>
    (biGetSharedWidgetResults as unknown as (o: { data: unknown }) => Promise<unknown>)(o);

  it("masks the results, and tells the page only the terms its document names", async () => {
    h.dashboard = {
      id: DASHBOARD,
      user_id: "owner",
      // A widget whose rows are stored in the document, from before
      // bi_widget_results, naming `salary`.
      widgets: [{ kind: "chart", id: "old", rows: [{ region: "east", salary: 1 }] }],
      pages: [{ widgets: [{ kind: "chart", id: "new" }] }],
    };
    h.results = [
      {
        widget_id: "new",
        columns: ["region", "salary", "ssn"],
        rows: [{ region: "east", salary: 1, ssn: "123" }],
        truncated: false,
        refreshed_at: "2026-11-15T00:00:00Z",
      },
    ];
    h.grants = [
      {
        resource_id: DASHBOARD,
        principal_type: "user",
        principal_id: "viewer",
        row_filter: null,
        column_mask: ["salary", "ssn"],
      },
    ];
    const res = (await call({
      data: { access_token: "t", dashboard_id: DASHBOARD },
    })) as {
      ok: true;
      results: { columns: string[]; rows: Record<string, unknown>[] }[];
      masked_columns: string[];
    };
    expect(res.ok).toBe(true);
    expect(res.results[0].columns).toEqual(["region"]);
    expect(res.results[0].rows).toEqual([{ region: "east" }]);
    // `ssn` is named nowhere the grantee can read: sending it named it.
    expect(res.masked_columns).toEqual(["salary"]);
  });
});

describe("every path that needs a mask's terms reads them with the service role", () => {
  // Since 20261116000000 a caller's own JWT is served no grant that masks
  // anything. A reader handed that client finds no grant: it fails closed, and
  // serves a masked share with no columns at all.
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
      d.isDirectory()
        ? files(`${dir}/${d.name}`)
        : /\.(ts|tsx)$/.test(d.name)
          ? [`${dir}/${d.name}`]
          : [],
    );
  const SRC = files("src").map((f) => [f, readFileSync(f, "utf8")] as const);

  it("readApplicableGrants is called with supabaseAdmin, everywhere", () => {
    const calls = SRC.flatMap(([f, src]) =>
      [...src.matchAll(/readApplicableGrants\(\s*([^,\s)]+)/g)]
        .map((m) => [f, m[1]] as const)
        // The definition.
        .filter(([, arg]) => arg !== "sb:"),
    );
    expect(calls.length).toBeGreaterThan(5);
    expect(calls.filter(([, arg]) => arg !== "supabaseAdmin")).toEqual([]);
  });

  it("the shared-dataset helpers take no client to read the grants with", () => {
    const src = readFileSync("src/utils/data/sharedDatasets.server.ts", "utf8");
    expect(src).toMatch(/export async function restrictSharedDataset\(\s*tableId: string,/);
    expect(src).toMatch(
      /export async function columnsVisibleTo<C extends \{ name: string \}>\(\s*viewerId:/,
    );
    expect(src).toContain('readApplicableGrants(supabaseAdmin, viewerId, "data_table", tableIds)');
  });

  it("no browser module selects a mask", () => {
    // Server modules read with the service role; anything that ships to the
    // browser reads as the user, and the user is not served the terms.
    const browser = SRC.filter(
      ([f, src]) =>
        !/\.server\.tsx?$|\.functions\.ts$|\/routes\/api\//.test(f) &&
        src.includes('from("iam_resource_grants")'),
    );
    expect(browser.map(([f]) => f)).toEqual(["src/lib/biDashboards.ts"]);
    for (const [, src] of browser) {
      expect(src).not.toMatch(/from\("iam_resource_grants"\)\s*\.select\("[^"]*column_mask/);
    }
  });
});

describe("migration 20261116000000", () => {
  const FILE = "20261116000000_grant_mask_terms.sql";
  const SQL = readFileSync(`supabase/migrations/${FILE}`, "utf8");

  it("has a version no other migration has", () => {
    const versions = readdirSync("supabase/migrations").map((f) => f.split("_")[0]);
    expect(versions.filter((v) => v === "20261116000000")).toHaveLength(1);
  });

  it("contracts nothing, so it carries no contract line", () => {
    expect(contractingStatements(SQL)).toEqual([]);
    expect(SQL).not.toMatch(/^\s*--\s*contract:/m);
  });

  it("serves a grantee their grant directly only when it masks nothing", () => {
    expect(SQL).toContain(
      'DROP POLICY IF EXISTS "Users can view applicable grants" ON public.iam_resource_grants;',
    );
    expect(SQL).toMatch(
      /CREATE POLICY "Users can view applicable grants that mask nothing"\s+ON public\.iam_resource_grants FOR SELECT\s+TO authenticated\s+USING \(\s+COALESCE\(cardinality\(column_mask\), 0\) = 0\s+AND \(/,
    );
  });

  it("is the last word on who reads a grant", () => {
    // A later migration that re-creates a broad SELECT policy would put the
    // terms back, and nothing else would notice.
    const later = readdirSync("supabase/migrations")
      .filter((f) => f > FILE)
      .filter((f) =>
        /CREATE POLICY[^;]*ON public\.iam_resource_grants/i.test(
          readFileSync(`supabase/migrations/${f}`, "utf8"),
        ),
      );
    expect(later).toEqual([]);
  });

  it("returns whether a grant masks, never the terms, and to signed-in callers only", () => {
    const fn = SQL.slice(SQL.indexOf("CREATE OR REPLACE FUNCTION public.my_resource_grants"));
    const returns = fn.slice(fn.indexOf("RETURNS TABLE"), fn.indexOf("LANGUAGE sql"));
    expect(returns).toContain("masked boolean");
    expect(returns).not.toContain("column_mask");
    expect(fn).toContain("SECURITY DEFINER");
    expect(fn).toContain("WHERE auth.uid() IS NOT NULL");
    expect(SQL).toContain(
      "REVOKE ALL ON FUNCTION public.my_resource_grants(text, uuid[]) FROM PUBLIC, anon;",
    );
    expect(SQL).toContain(
      "GRANT EXECUTE ON FUNCTION public.my_resource_grants(text, uuid[]) TO authenticated, service_role;",
    );
  });
});
