// Every Enterprise Ontology server function checks who is asking, the ones
// that change things are audited, and data is always read as the caller.
//
// Read from the source, function by function, so a new server function that
// forgets its access check, a write that forgets its audit event, or a query
// run as the owner on a grantee's behalf fails here rather than in review.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const FILES = [
  "src/utils/ontology.functions.ts",
  "src/utils/ontologyData.functions.ts",
  "src/utils/ontologyAi.functions.ts",
  "src/utils/ontologyActions.functions.ts",
];

type Fn = { file: string; name: string; body: string };

function serverFns(): Fn[] {
  const out: Fn[] = [];
  for (const file of FILES) {
    const src = readFileSync(file, "utf8");
    const parts = src.split(/(?=^export const \w+ = createServerFn)/m).slice(1);
    for (const body of parts) {
      const name = /^export const (\w+)/.exec(body)![1];
      out.push({ file, name, body });
    }
  }
  return out;
}

const fns = serverFns();

/** Functions that act on no particular ontology (listing, creating, the table picker, drafting). */
const NOT_ONE_ONTOLOGY = new Set([
  "ontologyList",
  "ontologyCreate",
  "ontologyCreateSample",
  "ontologyTables",
  "ontologyDraftFromTables",
]);

/** Only the owner may do these. */
const OWNER_ONLY = new Set([
  "ontologySave",
  "ontologyPublish",
  "ontologyRestore",
  "ontologyDelete",
  "ontologyPreviewTable",
  "ontologyRunRules",
  "ontologyActionDecide",
  "ontologyVerifyAnswer",
  "ontologyDeleteQuestion",
  "ontologyRunEval",
]);

/** These change something and must leave an audit event. */
const AUDITED = new Set([
  "ontologyCreate",
  "ontologyCreateSample",
  "ontologyPublish",
  "ontologyRestore",
  "ontologyDelete",
  "ontologyPropose",
  "ontologyDecideProposal",
  "ontologyRunRules",
  "ontologyDraftFromTables",
  "ontologyAsk",
  "ontologyVerifyAnswer",
  "ontologyDeleteQuestion",
  "ontologyRunEval",
]);

describe("ontology server functions", () => {
  it("are all found (the sweep is not empty)", () => {
    expect(fns.length).toBeGreaterThanOrEqual(25);
    for (const n of [...OWNER_ONLY, ...AUDITED, ...NOT_ONE_ONTOLOGY]) {
      expect(
        fns.map((f) => f.name),
        n,
      ).toContain(n);
    }
  });

  it("every one resolves the caller from their token first", () => {
    for (const f of fns) {
      expect(f.body, `${f.name} takes no access token`).toMatch(/access_token: token/);
      expect(f.body, `${f.name} never resolves the caller`).toMatch(
        /resolveCaller\(|ctxFor\(|await access\(/,
      );
    }
  });

  it("every one that acts on an ontology loads it through the access check", () => {
    for (const f of fns.filter((x) => !NOT_ONE_ONTOLOGY.has(x.name))) {
      expect(f.body, `${f.name} reads the ontology without the access check`).toMatch(
        /loadOntology\(|ctxFor\(|await access\(/,
      );
    }
  });

  it("the owner-only ones ask for ownership", () => {
    for (const f of fns.filter((x) => OWNER_ONLY.has(x.name))) {
      expect(f.body, `${f.name} must require the owner`).toMatch(/"own"\)/);
    }
    // And nothing else does: a grantee can read, explore, ask, propose and request.
    for (const f of fns.filter((x) => !OWNER_ONLY.has(x.name) && !NOT_ONE_ONTOLOGY.has(x.name))) {
      if (f.name === "ontologyCompare") continue; // owner-only for the draft, read for versions
      expect(f.body, `${f.name} should not demand ownership`).not.toMatch(/"own"\)/);
    }
  });

  it("every change is audited", () => {
    for (const f of fns.filter((x) => AUDITED.has(x.name))) {
      expect(f.body, `${f.name} leaves no audit event`).toContain("auditEvent(");
    }
    const actions = readFileSync("src/utils/ontology/actions.server.ts", "utf8");
    for (const a of [
      "ontology.action.propose",
      "ontology.action.apply",
      "ontology.action.fail",
      "ontology.action.approve",
      "ontology.action.reject",
    ]) {
      expect(actions).toContain(`"${a}"`);
    }
  });

  it("data is read and written as the caller, never as the ontology's owner", () => {
    const all = [
      ...FILES,
      "src/utils/ontology/actions.server.ts",
      "src/utils/ontology/ask.server.ts",
      "src/utils/tools/ontology.server.ts",
    ]
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    const calls = [...all.matchAll(/\b(?:runRows|runCount|runSql)\(\s*([\w.]+)/g)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThan(20);
    for (const who of calls) {
      expect(
        ["ctx.userId", "caller.userId", "userId", "asUser"],
        `a query runs as ${who}`,
      ).toContain(who);
    }
    expect(all).not.toMatch(/run(?:Rows|Count|Sql)\(\s*(?:access\.)?row\.user_id/);
    // asUser is the approver (decideAction) or the requester (requestAction) — both callers.
    const actions = readFileSync("src/utils/ontology/actions.server.ts", "utf8");
    expect(actions).toMatch(/applyWrite\(userId,/);
    expect(actions).not.toMatch(/applyWrite\(req\.requested_by/);
  });

  it("a grantee is served the published version under their share's policy", () => {
    const access = readFileSync("src/utils/ontology/access.server.ts", "utf8");
    expect(access).toContain('.eq("version", row.published_version)');
    expect(access).toContain("policy: await ontologyPolicyFor(userId, ontologyId)");
    expect(access).toContain(
      'readApplicableGrants(supabaseAdmin, userId, "ontology", [ontologyId])',
    );
    // Not published yet: a grantee gets nothing rather than the owner's draft.
    expect(access).toContain("The owner has not published this ontology yet");
    const data = readFileSync("src/utils/ontologyData.functions.ts", "utf8");
    expect(data).toContain('seeRestricted: a.role === "owner"');
    expect(data).toContain("...(a.policy ? { policy: a.policy } : {})");
  });

  it("the migration lets grantees read and nobody else, and adds the IAM type", () => {
    const sql = readFileSync("supabase/migrations/20261030000000_enterprise_ontology.sql", "utf8");
    for (const t of [
      "ontologies",
      "ontology_versions",
      "ontology_proposals",
      "ontology_rule_runs",
      "ontology_actions",
      "ontology_questions",
    ]) {
      expect(sql).toContain(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY;`);
    }
    expect(sql).toContain("has_resource_access('ontology', id, auth.uid())");
    expect(sql).toMatch(/'ml_model',\s*\n(?:\s*--.*\n)*\s*'ontology'/);
    // Versions cannot be edited once written: no UPDATE or DELETE policy on them.
    expect(sql).not.toMatch(/ON public\.ontology_versions FOR (ALL|UPDATE|DELETE)/);
  });

  it("the agent tool is deny-by-default and re-checks its allow-list", () => {
    const registry = readFileSync("src/utils/tools/registry.server.ts", "utf8");
    const start = registry.indexOf('if (allows("ontology_query")) {');
    const block = registry.slice(start, start + 1200);
    expect(block).toContain("const allowedOntologies = cfg.ontology_names ?? [];");
    expect(block).toContain("if (catalog.count > 0) {");
    expect(block).toContain("runOntologyTool(c, a, allowedOntologies)");
    const tool = readFileSync("src/utils/tools/ontology.server.ts", "utf8");
    expect(tool).toContain("This agent may not read the ontology");
    // The handler refuses a name outside the list before loading anything.
    expect(tool).toMatch(/if \(\s*!allowedNames\.some\(/);
  });

  it("an action cannot write a property hidden from the requester", () => {
    const actions = readFileSync("src/utils/ontology/actions.server.ts", "utf8");
    expect(actions).toMatch(
      /if \(p\.name in params && isMasked\(access\.spec, t, p\.property, opts\)\)/,
    );
    // And the object must be visible to them (their row filter) before anything runs.
    expect(actions).toContain("compileGetObject(access.spec, t.name, key, opts)");
  });

  it("the sample leaves nothing behind when it cannot finish", () => {
    // Found live: on a database without the ontology tables the sample made
    // its schema and six tables, then failed to save the ontology and kept
    // them, so the next try landed in ontology_sample_2.
    const body = fns.find((f) => f.name === "ontologyCreateSample")!.body;
    const probe = body.indexOf('.from("ontologies").select("id").limit(1)');
    const claim = body.indexOf('.from("lakehouse_schemas")');
    expect(probe).toBeGreaterThan(-1);
    expect(probe).toBeLessThan(claim);
    // It fills only a schema it created: no IF NOT EXISTS, and an existing
    // one is released and skipped rather than filled or dropped.
    expect(body).toContain("await c.run(`CREATE SCHEMA ${name}`);");
    expect(body).not.toContain("CREATE SCHEMA IF NOT EXISTS");
    expect(body).toMatch(/already exists/);
    // Both later failures roll the whole thing back.
    const insert = body.search(/\.from\("ontologies"\)\s*\.insert\(/);
    expect(insert).toBeGreaterThan(-1);
    expect(body.match(/await rollback\(\);/g)?.length).toBe(2);
    expect(body.indexOf("await rollback();", insert)).toBeGreaterThan(insert);
    // The schema is audited as made only once the ontology exists.
    expect(body.indexOf('action: "lakehouse.schema.create"')).toBeGreaterThan(insert);
  });

  it("an ontology's statements say where they came from in the audit log", () => {
    // Every compiled statement is audited with via: "ontology:<what>"; the
    // Audit Log row shows it ("SELECT · 4 rows · via ontology:ask").
    const run = readFileSync("src/utils/ontology/run.server.ts", "utf8");
    expect(run).toContain("auditVia: opts.via");
    const ui = readFileSync("src/components/observability/AuditLog.tsx", "utf8");
    const summary = ui.slice(ui.indexOf("function describeDetail("));
    expect(summary).toMatch(
      /if \(typeof d\.via === "string"\) bits\.push\(`via \$\{String\(d\.via\)\}`\);/,
    );
  });

  it("an owner's ontology names are unique, and an agent resolves one per name", () => {
    // Found live: two samples were both "Northwind Outfitters", the agent
    // builder listed the name twice, and the tool read whichever came first.
    const body = (n: string) => fns.find((f) => f.name === n)!.body;
    expect(body("ontologyCreate")).toContain("await nameClash(caller.userId, data.name)");
    expect(body("ontologySave")).toContain(
      "await nameClash(caller.userId, parsed.data.name, data.id)",
    );
    expect(body("ontologyRestore")).toContain("await nameClash(caller.userId, spec.name, data.id)");
    expect(body("ontologyDecideProposal")).toContain(
      "await nameClash(access.row.user_id, spec.name, data.id)",
    );
    // A second sample gets a name of its own rather than a duplicate.
    expect(body("ontologyCreateSample")).toMatch(/name = `\$\{SAMPLE_NAME\} \$\{i\}`/);
    const tool = readFileSync("src/utils/tools/ontology.server.ts", "utf8");
    expect(tool).toContain("x.name.toLowerCase() === o.name.toLowerCase()");
    expect(tool).toContain('.order("updated_at", { ascending: false })');
  });

  it("publishing runs the verified questions first and stops on a broken one", () => {
    // Semantic CI: a draft that no longer answers a verified question is not
    // frozen into a version unless the owner, shown which, says so.
    const body = fns.find((f) => f.name === "ontologyPublish")!.body;
    const run = body.indexOf("await runVerifiedQuestions(");
    const insert = body.indexOf('.from("ontology_versions").insert(');
    expect(run).toBeGreaterThan(-1);
    expect(run).toBeLessThan(insert);
    expect(body).toMatch(/if \(summary\.errors > 0 && !data\.allow_broken\) \{/);
    expect(body).toContain('broken: summary.results.filter((r) => r.status === "error")');
    // The counts travel with the version and the audit row.
    expect(body).toContain("...(evalCounts ? { eval: evalCounts } : {})");
    expect(body).toContain("published_with_broken_questions: true");
    // Evaluate and Publish share one runner, so they cannot disagree.
    const evalBody = fns.find((f) => f.name === "ontologyRunEval")!.body;
    expect(evalBody).toContain("await runVerifiedQuestions(ctx.userId, ctx.a, ctx.opts, data.id)");
  });
});
