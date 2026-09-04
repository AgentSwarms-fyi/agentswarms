// Use-case walkthroughs exist, in both doc sets, and cite UI labels that exist.
//
// A walkthrough is the part of documentation that rots fastest: it names tabs
// and buttons, and nobody re-clicks through it when a label changes. So every
// label a walkthrough leans on is checked against the component that renders
// it, and the README scorecard's honesty lines are pinned so a gap cannot be
// quietly deleted without also being fixed.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(__dirname, "../..");
const rd = (p: string) => readFileSync(path.join(REPO, p), "utf8");

const MD = [
  "docs/IAM.md",
  "docs/LAKEHOUSE.md",
  "docs/PROVENANCE.md",
  "docs/KNOWLEDGE_BASES.md",
  "docs/DATA_SOURCES.md",
  "docs/AGENT_CHAT.md",
];
const APP = [
  "src/routes/docs.iam.tsx",
  "src/routes/docs.lakehouse.tsx",
  "src/routes/docs.knowledge.tsx",
  "src/routes/docs.data.tsx",
  "src/routes/docs.debugging.tsx",
];

describe("every thin doc now has worked use cases", () => {
  for (const f of MD) {
    it(`${f} has a Use cases section with at least two walkthroughs`, () => {
      const text = rd(f);
      const i = text.indexOf("\n## Use cases\n");
      expect(i).toBeGreaterThan(0);
      const section = text.slice(i);
      const walkthroughs = section.match(/^### /gm) ?? [];
      expect(walkthroughs.length).toBeGreaterThanOrEqual(2);
    });
  }

  for (const f of APP) {
    it(`${f} has a use-cases section before NextPrev`, () => {
      const text = rd(f);
      const i = text.indexOf('<H2 id="use-cases">');
      expect(i).toBeGreaterThan(0);
      expect(text.indexOf("<NextPrev")).toBeGreaterThan(i);
      expect((text.slice(i).match(/<H3 id="use-case-/g) ?? []).length).toBeGreaterThanOrEqual(2);
    });
  }
});

describe("walkthroughs cite labels the UI actually renders", () => {
  const iamPage = rd("src/routes/_authenticated/admin.iam.tsx");
  const lakePage = rd("src/routes/_authenticated/lakehouse.tsx");
  const kbPage = rd("src/routes/_authenticated/knowledge.tsx");
  const traces = rd("src/routes/_authenticated/traces.tsx");
  const audit = rd("src/components/observability/AuditLog.tsx");
  const integrations = rd("src/routes/_authenticated/integrations.tsx");
  const wizard = rd("src/components/catalog/AddSourceWizard.tsx");

  it("IAM tabs named in IAM.md are the tabs on the page", () => {
    for (const v of ["users", "groups", "access", "attributes", "budgets", "sso", "settings"]) {
      expect(iamPage).toContain(`TabsTrigger value="${v}"`);
    }
    const doc = rd("docs/IAM.md");
    for (const label of [
      "_Users_",
      "_Groups_",
      "_Access_",
      "_Attributes_",
      "_Budgets_",
      "_SSO_",
      "_Settings_",
    ]) {
      expect(doc).toContain(label);
    }
  });

  it("the lakehouse walkthrough's markers and controls exist", () => {
    expect(lakePage).toContain('aria-label="Missing data files"');
    expect(lakePage).toContain("Search schemas and tables");
    expect(lakePage).toContain("Ask in plain language");
    expect(lakePage).toContain('TabsTrigger value="query"');
    expect(lakePage).toContain('TabsTrigger value="history"');
    expect(lakePage).toContain("Drop table ${schema}.${table}?");
  });

  it("the knowledge walkthrough's button exists and the delete asks first", () => {
    expect(kbPage).toContain("Add Source");
    expect(kbPage).toContain('actionLabel: "Delete knowledge base"');
  });

  it("the provenance walkthrough's controls exist", () => {
    expect(traces).toContain("> Passport");
    expect(traces).toContain("Replaying");
    expect(audit).toContain("Verify integrity");
  });

  it("the data-sources walkthrough's tabs and wizard fields exist", () => {
    expect(integrations).toContain(">Data Sources<");
    expect(integrations).toContain(">Apps<");
    expect(wizard).toContain("Azure Blob Storage / ADLS Gen2");
    expect(wizard).toContain("Storage account name");
    expect(wizard).toContain("Account key or SAS token");
  });

  it("DEPLOYMENT's post-restore check uses real labels", () => {
    const dep = rd("docs/DEPLOYMENT.md");
    expect(dep).not.toContain("Lakehouse → Tables");
    expect(dep).not.toContain("Observability → Audit");
    expect(dep).toContain("**Verify integrity**");
  });
});

describe("the README scorecard is honest about what is missing", () => {
  const readme = rd("README.md");
  const start = readme.indexOf("## Where it stands");
  const next = readme.indexOf("\n## ", start + 1);
  const section = readme.slice(start, next > 0 ? next : undefined);

  it("exists and states the known gaps by name", () => {
    expect(readme).toContain("## Where it stands");
    expect(section).toContain("No SCIM");
    expect(section).toContain("One vector store");
    expect(section).toContain("High availability of the lakehouse catalog");
    expect(section).toContain("verified to validation");
  });

  it("its gap claims are still true of the code", () => {
    // No SCIM endpoint anywhere.
    const apiFiles = readdirSync(path.join(REPO, "src/routes/api"), {
      recursive: true,
    }) as string[];
    expect(apiFiles.some((f) => /scim/i.test(String(f)))).toBe(false);
    // One vector store: the picker on the knowledge page offers pgvector only.
    const kb = rd("src/routes/_authenticated/knowledge.tsx");
    const stores = kb.slice(
      kb.indexOf("const VECTOR_STORES"),
      kb.indexOf("];", kb.indexOf("const VECTOR_STORES")),
    );
    expect((stores.match(/\bid: "/g) ?? []).length).toBe(1);
    // Single catalog container in compose.
    const compose = rd("docker-compose.yml");
    expect(compose).toContain("lakehouse-catalog:\n    image: postgres:16");
  });

  it("does not call the project open source", () => {
    expect(section.toLowerCase()).not.toContain("open source");
    expect(section.toLowerCase()).not.toContain("open-source");
  });
});
