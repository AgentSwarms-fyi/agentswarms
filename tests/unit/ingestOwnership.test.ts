// Who owns the rows that data ingestion writes.
//
// ingest.server.ts uses the service role fourteen times and contains no
// authorisation of its own. That is a legitimate design — it is a library, not
// an endpoint — but it means the identity it stamps on every row comes from
// its CALLER, and a caller that took `userId` from request input rather than a
// verified token would let anyone write datasets into anyone's workspace.
//
// Audited: both entry points take userId explicitly, every insert stamps it,
// the replace-or-create lookup is scoped by it, and both callers establish it
// from something the client cannot choose. None of that is enforced by
// anything, and any one of them is a one-line change away.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const INGEST = readFileSync("src/utils/data/ingest.server.ts", "utf8");

describe("ingestion stamps an owner it was told, and never guesses one", () => {
  it("both entry points require an explicit userId", () => {
    for (const fn of ["ingestUpload", "ingestRows"]) {
      const at = INGEST.indexOf(`export async function ${fn}(args: {`);
      expect(at, `${fn} is gone or changed shape`).toBeGreaterThan(-1);
      const sig = INGEST.slice(at, INGEST.indexOf("}):", at));
      expect(sig, `${fn} no longer takes a userId`).toMatch(/userId: string;/);
    }
  });

  it("does not read an identity from anywhere ambient", () => {
    // A library that reaches for the request, a session or an env-var owner is
    // one that can be called with the wrong one and not notice.
    expect(INGEST).not.toMatch(/auth\.getUser\(/);
    expect(INGEST).not.toMatch(/getUserIdFromRequest/);
    expect(INGEST).not.toMatch(/process\.env\.[A-Z_]*USER/);
  });

  it("scopes the replace-or-create lookup by user", () => {
    // Without the user filter, uploading a dataset whose name matches another
    // tenant's would resolve to THEIR row and overwrite it.
    const at = INGEST.indexOf('.from("user_data_tables")\n    .select("id")');
    expect(at, "the promotion lookup moved").toBeGreaterThan(-1);
    const lookup = INGEST.slice(at, at + 300);
    expect(lookup, "the promotion lookup is not user-scoped").toContain('.eq("user_id"');
    expect(lookup).toContain('.eq("name"');
  });

  it("stamps user_id on the staging inserts", () => {
    const inserts = [...INGEST.matchAll(/\.insert\(\{([\s\S]{0,220}?)\}\)/g)].map((m) => m[1]);
    expect(inserts.length, "no inserts found to check").toBeGreaterThan(0);
    for (const body of inserts) {
      expect(body, `an insert does not set user_id: ${body.slice(0, 60)}`).toMatch(
        /user_id:\s*args\.userId/,
      );
    }
  });
});

describe("both callers establish that identity from something verified", () => {
  it("the upload route takes it from the bearer token, not the body", () => {
    const route = readFileSync("src/routes/api/data.upload.ts", "utf8");
    // Exchanged for a user via the auth server — not parsed, not trusted.
    expect(route).toMatch(/supabaseAdmin\.auth\.getUser\(bearer\)/);
    // The WHOLE assignment, anchored to end-of-statement. A prefix match
    // passed while a `?? (await request.json()).userId` fallback was appended
    // to the same line — which is precisely the bug this test exists to catch,
    // and it survived the first version of the mutation.
    expect(route, "userId has a fallback source").toMatch(/const userId = auth\.user\?\.id;\s*$/m);
    expect(route).toMatch(/if \(!userId\) return json\(401/);
    // The body must never be a source of identity here.
    const body = route.slice(route.indexOf("ingestUpload({"));
    expect(body.slice(0, 200), "userId comes from request input").not.toMatch(
      /userId:\s*(body|data|payload)\./,
    );
  });

  it("the sync path runs as the connection's owner, resolved under RLS", () => {
    // A grantee may trigger a sync; the rows still belong to the owner. The
    // owner id comes from a connection loaded with the CALLER's client, so a
    // caller who cannot see the connection cannot name its owner either.
    const fns = readFileSync("src/utils/saas.functions.ts", "utf8");
    expect(fns).toMatch(/const \{ sb, userId \} = await requireUser\(data\.access_token\)/);
    expect(fns).toMatch(/loadConnection\(sb, userId, data\.id/);
    const call = fns.slice(fns.indexOf("runConnectionSync("));
    expect(call.slice(0, 260), "the sync no longer runs as the owner").toMatch(
      /userId: conn\.ownerUserId/,
    );
  });
});
