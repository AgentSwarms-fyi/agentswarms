// Every feature that calls a model directly asks the caller's model rules first.
//
// FOUND FROM THE SURVEY (R97). The rules are enforced at /api/chat. Five
// features called a provider directly and asked nothing: the ETL, lakehouse and
// skill code generators, the knowledge-graph builder, and embedded BI.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const flat = (s: string) => s.replace(/\s+/g, " ");
const read = (p: string) => flat(readFileSync(p, "utf8"));
const iam = read("src/utils/iam.server.ts");

const GENERATORS = [
  "src/routes/api/etl.generate.ts",
  "src/routes/api/lakehouse.generate.ts",
  "src/routes/api/skills.generate.ts",
];

describe("the question", () => {
  it("is the shared rules, read for this user, with /api/chat's sentence", () => {
    const fn = iam.slice(iam.indexOf("export async function modelAccessRefusal("));
    expect(fn).toContain("const rules = await getEffectiveModelRules(supabaseAdmin, userId);");
    expect(fn).toContain("if (rules && !isModelAllowedShared(rules, provider, model)) {");
    expect(fn).toContain(
      "Your administrator has not allowed ${provider}/${model} for your account.",
    );
  });
});

describe("the code generators", () => {
  for (const path of GENERATORS) {
    it(`${path} asks once the model is final, and before it calls one`, () => {
      const src = read(path);
      // The model is final once the resolver has chosen it (the request, or
      // the instance default — itself asked about this user's rules), and
      // the rules are asked again of the final model before any call.
      const chosen = src.indexOf("const chosen = await chooseModel( user.id,");
      const final = src.indexOf("const model = chosen.model;");
      const ask = src.indexOf("refused = await modelAccessRefusal(user.id, provider, model);");
      const call = src.indexOf("await providerFetch(transport.endpointUrl");
      expect(chosen).toBeGreaterThan(-1);
      expect(final).toBeGreaterThan(chosen);
      expect(ask).toBeGreaterThan(final);
      expect(ask).toBeLessThan(call);
      expect(src).toContain("if (refused) return json({ error: refused }, 403);");
    });

    it(`${path} refuses to call a model when it cannot read the rules`, () => {
      expect(read(path)).toContain("Could not check your model access:");
      expect(read(path)).toContain("503");
    });
  }
});

describe("the knowledge-graph builder", () => {
  const src = read("src/routes/api/kb/build-graph.ts");

  it("asks about the model it will use, before it wipes the graph it has", () => {
    // The resolver asks this user's rules about the model (and refuses with
    // the reason when even the default is not allowed), before anything is
    // marked building or wiped.
    const ask = src.indexOf("const chosen = await chooseModel(user.id, null);");
    expect(ask).toBeGreaterThan(-1);
    expect(ask).toBeLessThan(src.indexOf('.from("kb_graph_entities") .delete()'));
    expect(ask).toBeLessThan(src.indexOf('kb_graph_status: "building"'));
    expect(src).toContain(
      "if (!chosen.ok) return Response.json({ error: chosen.error }, { status: chosen.status });",
    );
    const resolver = read("src/utils/providers/defaultModel.server.ts");
    expect(resolver).toContain("const rules = await getEffectiveModelRules(iamClient, userId);");
    expect(resolver).toContain("if (rules && !isModelAllowed(rules, t.provider, t.model)) {");
  });
});

describe("embedded BI", () => {
  const src = read("src/utils/embedBi.server.ts");

  it("asks the owner's rules before its own model call, and closes when it cannot", () => {
    const fn = src.slice(src.indexOf("async function llmJsonServer("));
    const ask = fn.indexOf("const refused = await modelAccessRefusal(ownerId, provider, model)");
    expect(ask).toBeGreaterThan(-1);
    expect(ask).toBeLessThan(fn.indexOf("await providerFetch(transport.endpointUrl"));
    expect(fn).toContain("could not check model access:");
    expect(fn).toContain("if (refused) {");
    expect(fn.slice(fn.indexOf("if (refused) {"), fn.indexOf("if (refused) {") + 160)).toContain(
      "return null;",
    );
  });
});
