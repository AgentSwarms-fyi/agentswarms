// Sharing a warehouse connection through IAM.
//
// A shared connection is the one place in this codebase where widening a
// filter widens access to a CREDENTIAL. Everything here is about the two ways
// that goes wrong: a grantee reaching a connection nobody granted them, and a
// grantee receiving the credential rather than merely the use of it.
//
// The query is built as a PostgREST filter string, so these read the source.
// That is unusual in a test and it is the only way to check a decision that
// otherwise needs a live database and two real tenants.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const loaderSrc = readFileSync("src/utils/warehouse/connections.server.ts", "utf8");
const iamSrc = readFileSync("src/utils/iam.server.ts", "utf8");
const migration = readFileSync("supabase/migrations/20260778000000_connection_grants.sql", "utf8");

describe("the grant is the only thing that widens access", () => {
  it("falls back to owner-only when no grants are passed", () => {
    // The default must stay exactly what it was before sharing existed.
    expect(loaderSrc).toContain('query.eq("user_id", ownerUserId)');
  });

  it("widens to owner-OR-granted only when ids are supplied", () => {
    expect(loaderSrc).toContain('user_id.eq.${ownerUserId},id.in.(${granted.join(",")})');
  });

  it("does NOT resolve the grant itself", () => {
    // Deliberate: the caller has to go and fetch the grant. A loader that
    // looked it up would silently widen every existing call site — including
    // the service-role ones, where RLS is off.
    // Anchored on the LOW-LEVEL loader specifically — "loadWarehouseConnection"
    // without the paren also matches loadWarehouseConnectionForUser, which
    // appears earlier and legitimately does resolve. Matching a CALL rather
    // than a mention, since the doc comment names the resolver on purpose.
    const fn = loaderSrc.slice(loaderSrc.indexOf("export async function loadWarehouseConnection("));
    expect(fn).not.toMatch(/resolveGrantedResourceIds\s*\(/);
  });

  it("validates every granted id as a uuid before interpolating it", () => {
    // `id.in.(…)` is a filter STRING. An unvalidated value there is an
    // injection into the query, not merely a row that fails to match.
    expect(loaderSrc).toContain("UUID_RE.test(x)");
    expect(loaderSrc).toMatch(/const UUID_RE = \/\^\[0-9a-f\]\{8\}/);
  });

  it("keeps the owner filter when the granted list is empty after validation", () => {
    // A list of nothing but malformed ids must not degrade into "no filter".
    expect(loaderSrc).toContain("granted.length");
  });
});

describe("a grantee uses the connection without receiving it", () => {
  it("resolves secret references as the OWNER, not the caller", () => {
    // On a shared connection those differ. Resolving as the caller looks up
    // {{secret:PROD_PW}} in the GRANTEE's vault — finding nothing, or worse a
    // different secret that happens to share the name.
    expect(loaderSrc).toContain("const secretScope = row.user_id ?? ownerUserId");
    expect(loaderSrc).toMatch(/resolveSecretRefsInObject\(\s*secretScope\s*,/);
  });

  it("reports whether the connection was reached by grant", () => {
    // Callers need this to mark a shared connection read-only in the UI.
    expect(loaderSrc).toContain("shared: !!ownerUserId && row.user_id !== ownerUserId");
  });

  it("returns config but never the stored ciphertext", () => {
    const ret = loaderSrc.slice(loaderSrc.lastIndexOf("return {"));
    expect(ret).not.toContain("credentials");
    expect(ret).not.toContain("ciphertext");
  });
});

describe("the migration", () => {
  it("permits the two new grant types", () => {
    expect(migration).toContain("'warehouse_connection'");
    expect(migration).toContain("'saas_connection'");
  });

  it("keeps every previously grantable type", () => {
    // A DROP + ADD that forgot one would silently revoke live grants.
    for (const t of [
      "knowledge_base",
      "data_table",
      "secret",
      "bi_dashboard",
      "semantic_model",
      "catalog_source",
      "integration",
      "provider_credential",
    ]) {
      expect(migration, `${t} dropped from the grantable list`).toContain(`'${t}'`);
    }
  });

  it("adds NO row-level policy to the connection tables", () => {
    // Unlike semantic_models, these rows carry the encrypted credential. An
    // RLS SELECT policy for grantees would let them fetch that ciphertext
    // straight from PostgREST with their own JWT.
    expect(migration).not.toMatch(/CREATE POLICY[\s\S]*data_warehouse_connections/i);
    expect(migration).not.toMatch(/CREATE POLICY[\s\S]*saas_connections/i);
  });
});

describe("resolveGrantedResourceIds accepts the new types", () => {
  it("lists them in its resourceType union", () => {
    expect(iamSrc).toContain('| "warehouse_connection"');
    expect(iamSrc).toContain('| "saas_connection"');
  });
});

describe("the grantable list does not drift from the database", () => {
  // The list of grantable types was hand-maintained in four places and had
  // silently drifted in three of them: the admin UI offered ten types while
  // its own description named four, and both doc pages named four. Nothing
  // failed — the feature worked and only the words were wrong, which is
  // exactly the kind of rot no test was watching.
  const adminSrc = readFileSync("src/routes/_authenticated/admin.iam.tsx", "utf8");

  /**
   * The CHECK constraint is the authority on what may be granted.
   *
   * Scoped to the IN list rather than the whole file — the migration's comments
   * name several of these types in prose, and a file-wide match would pick
   * those up and pass no matter what the constraint said.
   */
  const IN_LIST = "resource_type IN (";
  const checkStart = migration.indexOf(IN_LIST);
  const checkBody = migration.slice(
    checkStart + IN_LIST.length,
    migration.indexOf(")", checkStart),
  );
  const dbTypes = new Set([...checkBody.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));

  const pickerTypes = new Set(
    [
      ...adminSrc
        .slice(
          adminSrc.indexOf("const shareTypeOptions"),
          adminSrc.indexOf("const shareableOfType"),
        )
        .matchAll(/value: "([a-z_]+)"/g),
    ].map((m) => m[1]),
  );

  it("offers every type the database permits", () => {
    // A type in the CHECK but not the picker is ungrantable in practice —
    // the migration ran, and nobody can use what it added.
    expect([...dbTypes].filter((t) => !pickerTypes.has(t))).toEqual([]);
  });

  it("offers nothing the database would reject", () => {
    // The other direction fails at INSERT time with a constraint violation,
    // surfacing to the admin as an opaque error.
    expect([...pickerTypes].filter((t) => !dbTypes.has(t))).toEqual([]);
  });

  it("counts them correctly wherever the docs state a number", () => {
    // The specific rot found: "Four resource types are grantable".
    const docsSrc = readFileSync("src/routes/docs.iam.tsx", "utf8");
    const stated = docsSrc.match(/(\w+) resource types are grantable/);
    expect(stated, "the docs no longer state a count — drop this assertion").not.toBeNull();
    const words = [
      "zero",
      "one",
      "two",
      "three",
      "four",
      "five",
      "six",
      "seven",
      "eight",
      "nine",
      "ten",
    ];
    expect(stated![1].toLowerCase()).toBe(words[dbTypes.size]);
  });
});

describe("grants are resolved in exactly one place", () => {
  it("every call site goes through loadWarehouseConnectionForUser", () => {
    // Nine call sites each resolving their own grants is nine chances to
    // forget, and forgetting does not raise an error — it silently stops a
    // shared connection working for the grantee.
    const callers = [
      "src/utils/catalog.functions.ts",
      "src/utils/catalog/schedule.server.ts",
      "src/utils/bi/refresh.server.ts",
      "src/utils/warehouse.functions.ts",
      "src/utils/bi/prep.server.ts",
      "src/utils/tools/registry.server.ts",
      "src/utils/semantic.functions.ts",
    ];
    for (const f of callers) {
      const src = readFileSync(f, "utf8");
      // The bare loader must not be called directly any more. Matching on the
      // call form, since the ForUser name contains the bare one.
      expect(src, `${f} still calls the un-granted loader`).not.toMatch(
        /loadWarehouseConnection\s*\(/,
      );
      expect(src, `${f} does not load connections at all`).toMatch(
        /loadWarehouseConnectionForUser\s*\(/,
      );
    }
  });

  it("resolves grants FRESH on every call, never cached", () => {
    // A cached grant keeps working after revocation — indefinitely on the
    // scheduled paths, which is the worst place for it.
    const fn = loaderSrc.slice(
      loaderSrc.indexOf("export async function loadWarehouseConnectionForUser"),
    );
    expect(fn).toContain("await resolveGrantedResourceIds(");
    expect(fn).not.toMatch(/cache|memo/i);
  });

  it("resolves grants with the SERVICE ROLE, not the caller's client", () => {
    // The answer to "may I use this connection" must not depend on RLS
    // policies over a table the asker can see.
    const fn = loaderSrc.slice(
      loaderSrc.indexOf("export async function loadWarehouseConnectionForUser"),
      loaderSrc.indexOf("export async function loadWarehouseConnection("),
    );
    // Whitespace-tolerant: prettier reflows this call between one and several
    // lines depending on its length, and an exact-string assertion broke the
    // moment it did.
    expect(fn).toMatch(/resolveGrantedResourceIds\(\s*supabaseAdmin\s*,/);
  });
});

describe("shared app sources", () => {
  const saas = readFileSync("src/utils/saas.functions.ts", "utf8");

  it("resolves grants with the service role, fresh", () => {
    expect(saas).toMatch(/resolveGrantedResourceIds\(\s*supabaseAdmin\s*,/);
    expect(saas).toContain('"saas_connection"');
  });

  it("only widens when the caller asked for shared access", () => {
    // Save and delete must stay owner-only, so the widening is opt-in per
    // call site rather than a property of the loader.
    expect(saas).toContain("opts.allowShared");
    expect(saas).toContain('if (!isShared) q = q.eq("user_id", userId)');
  });

  it("SYNCS AS THE OWNER, not as the grantee who triggered it", () => {
    // The datasets this source maintains already exist under the owner.
    // Running as the caller would build a parallel, half-populated copy under
    // the grantee instead of refreshing the real one.
    expect(saas).toContain("userId: conn.ownerUserId");
  });

  it("syncs a shared source with the service role, an owned one without", () => {
    // Naming the owner is not enough on its own: under the GRANTEE's client
    // the writes to the owner's row and datasets are refused by RLS, so a
    // shared sync would fail rather than run as claimed. The owned case stays
    // on the caller's client so RLS still guards the ordinary path.
    expect(saas).toMatch(/runConnectionSync\(\s*isShared \? supabaseAdmin : sb\s*,/);
  });

  it("records in the audit trail when a grantee triggered it", () => {
    // Actor and affected account differ on a shared source; an entry naming
    // only the trigger would not answer "whose datasets changed".
    expect(saas).toContain("triggered_by_grantee");
  });

  it("never selects the credential when listing", () => {
    const list = saas.slice(
      saas.indexOf("export const listSaasConnections"),
      saas.indexOf("export const saveSaasConnection"),
    );
    expect(list).not.toMatch(/select\([^)]*\bconfig\b/s);
  });
});

describe("the connection list", () => {
  const fns = readFileSync("src/utils/warehouse.functions.ts", "utf8");

  it("never selects the credential column, owned or shared", () => {
    const list = fns.slice(
      fns.indexOf("export const listWarehouseConnections"),
      fns.indexOf("export const saveWarehouseConnection"),
    );
    expect(list).not.toMatch(/select\([^)]*credentials/s);
  });

  it("marks granted rows as shared", () => {
    expect(fns).toContain("shared: true");
  });

  it("does not list a granted connection twice when you also own it", () => {
    expect(fns).toContain("!ownedIds.has(c.id)");
  });
});
