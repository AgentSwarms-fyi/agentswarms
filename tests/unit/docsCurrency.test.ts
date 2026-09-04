// The in-app handbook has to describe the product that shipped.
//
// MEASURED, which is why this exists. Three features shipped and their REPO
// docs were updated while the IN-APP docs were not, so the two doc sets
// disagreed and nothing noticed:
//
//   · The BI export row still read "PDF for the page, Excel/CSV for the data"
//     after PowerPoint export shipped with its own dialog.
//   · Governed dashboard generation was undocumented, and the page still told
//     readers to "read the generated query" — advice that is specifically
//     wrong on the path where a compiler writes the SQL.
//   · The price-resolution table listed four layers and was missing the new
//     top one, provider-reported cost, which outranks all of them.
//
// A stale handbook is not a cosmetic problem. It is the product making false
// statements to the person who went looking for the truth, and it is the
// failure mode this whole adversarial pass exists to catch.
//
// WHAT THIS DOES AND DOES NOT PROVE. Each case ties a capability that exists
// in code to a phrase that must appear in the page documenting it. It catches
// "shipped it, forgot the handbook" for these specific capabilities. It cannot
// prove the handbook is complete, correct or well written — no test can — so
// adding a feature still means adding a case here by hand.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(resolve(root, rel), "utf8");
const has = (rel: string) => existsSync(resolve(root, rel));

/** Every docs page slug on disk, excluding the index and the layout. */
const docPageSlugs = (): string[] =>
  readdirSync(resolve(root, "src/routes"))
    .filter((f) => /^docs\..+\.tsx$/.test(f) && f !== "docs.index.tsx")
    .map((f) => f.replace(/^docs\./, "").replace(/\.tsx$/, ""));

type Currency = {
  /** What shipped. */
  capability: string;
  /** A file whose existence means the capability is in the product. */
  code: string;
  /** An export or literal that must be present in that file, so a renamed or
   *  gutted module does not keep vouching for a feature that left. */
  codeContains: string;
  /** The in-app page that must describe it. */
  doc: string;
  /** Phrases the page must contain, one per distinct claim. */
  docMentions: RegExp[];
};

const CASES: Currency[] = [
  {
    capability: "Models train in a sandbox and explain themselves by permutation importance",
    code: "src/utils/ml/pyTrain.ts",
    codeContains: "permutation_importance(",
    doc: "src/routes/docs.ml.tsx",
    docMentions: [/permutation importance/i],
  },
  {
    capability: "A prediction is audited as a data read with a digest",
    code: "src/utils/ml/predict.server.ts",
    codeContains: "ml.predict_query",
    doc: "src/routes/docs.ml.tsx",
    docMentions: [/ml\.predict_query/],
  },
  {
    capability: "Clustering, anomaly detection and recommendation are trained by the same program",
    code: "src/utils/ml/pyTrain.ts",
    codeContains: "def _train_recommendation(",
    doc: "src/routes/docs.ml.tsx",
    docMentions: [/item-item cosine similarity/i, /isolation forest/i, /silhouette/i],
  },
  {
    capability: "A model can be published as an API with per-key scopes",
    code: "src/utils/ml/api.server.ts",
    codeContains: "export async function authenticateMlApiKey(",
    doc: "src/routes/docs.ml.tsx",
    docMentions: [/\/api\/ml\/predict/, /ml\.api_key\.denied/],
  },
  {
    capability: "One forecaster for charts, the Analyst and alerts",
    code: "src/lib/mlForecast.ts",
    codeContains: "export function forecastValues",
    doc: "src/routes/docs.ml.tsx",
    docMentions: [/cannot\s+disagree/],
  },
  {
    capability: "Export a BI dashboard as a PowerPoint deck",
    code: "src/lib/biDeck.ts",
    codeContains: "export function buildDeckPlan",
    doc: "src/routes/docs.bi.tsx",
    docMentions: [/PowerPoint/],
  },
  {
    capability: "The deck's prose may quote figures but never compute them",
    code: "src/lib/biDeckNarrative.ts",
    codeContains: "export function stripInventedNumbers",
    doc: "src/routes/docs.bi.tsx",
    // BOTH halves, as separate entries. Written first as one alternation
    // (/prohibition|enforcement/) it survived a mutation that deleted the
    // prohibition, because the other branch still matched — an assertion that
    // passes when half its subject is gone is not asserting the claim.
    docMentions: [
      /not allowed to calculat|may not calculat|never calculat/i,
      /stripped|removed before it/i,
    ],
  },
  {
    capability: "Generate a whole dashboard from a governed semantic model",
    code: "src/lib/biGenerateSemantic.ts",
    codeContains: "export function validatePlan",
    doc: "src/routes/docs.bi.tsx",
    docMentions: [/semantic model/i, /refused|reject/i],
  },
  {
    capability: "Provider-reported cost outranks every price table",
    code: "src/utils/observability/providerCost.ts",
    codeContains: "export function providerReportedCost",
    doc: "src/routes/docs.budgets.tsx",
    docMentions: [/provider-reported/i],
  },
  {
    capability: "A spend total says when it is a floor rather than the answer",
    code: "src/lib/spendCompleteness.ts",
    codeContains: "export function spendCaveat",
    doc: "src/routes/docs.budgets.tsx",
    docMentions: [/floor/i],
  },
];

describe("the in-app handbook describes what shipped", () => {
  for (const c of CASES) {
    describe(c.capability, () => {
      it("still exists in the code this case vouches for", () => {
        // Guards the test itself: if the module is renamed or its entry point
        // removed, this fails loudly rather than passing on a stale premise.
        expect(has(c.code), `${c.code} is missing — update or remove this case`).toBe(true);
        expect(read(c.code)).toContain(c.codeContains);
      });

      it(`is documented in ${c.doc.split("/").pop()}`, () => {
        const page = read(c.doc);
        for (const phrase of c.docMentions) {
          expect(
            page,
            `${c.doc} does not mention ${phrase} — "${c.capability}" shipped without reaching the handbook`,
          ).toMatch(phrase);
        }
      });
    });
  }
});

describe("every handbook page is reachable", () => {
  // An unlinked page is a page nobody finds, which is the same outcome as not
  // having written it.
  //
  // Reachability is decided by the SIDEBAR in DocsShell, not by the index
  // page's card grid — checking the index instead flags `account` and
  // `dashboard`, which are in the sidebar on every docs page and perfectly
  // findable. The nav a reader actually uses is the one worth asserting on.
  it("links every docs.*.tsx route from the docs sidebar", () => {
    const shell = read("src/components/docs/DocsShell.tsx");
    const missing = docPageSlugs().filter((slug) => !shell.includes(`/docs/${slug}`));
    expect(missing, `not linked from the docs sidebar: ${missing.join(", ")}`).toEqual([]);
  });

  it("every sidebar link points at a page that exists", () => {
    // The other direction: a nav entry for a deleted page is a 404 wearing a
    // menu item.
    const shell = read("src/components/docs/DocsShell.tsx");
    const linked = [...shell.matchAll(/"\/docs\/([a-z-]+)"/g)].map((m) => m[1]);
    const slugs = new Set(docPageSlugs());
    const dangling = [...new Set(linked)].filter((s) => !slugs.has(s));
    expect(dangling, `sidebar links with no page: ${dangling.join(", ")}`).toEqual([]);
  });
});
