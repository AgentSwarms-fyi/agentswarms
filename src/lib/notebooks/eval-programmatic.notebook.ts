import type { Notebook } from "./types";

/**
 * Agentic Evals #2 — Programmatic Evaluation against ground truth.
 * Build a tiny city dataset and grade an LLM on factual lookups,
 * calculations, comparisons, and structured extraction. No judges, just code.
 */
export const evalProgrammaticNotebook: Notebook = {
  id: "eval-programmatic",
  title: "Programmatic Evaluation — Ground Truth, Exact Match & Calculations",
  description:
    "When answers are objectively correct (facts, numbers, classifications), grade them with code. Build a city dataset and run exact-match, calculation, comparison, and structured-extraction evals — then compute an accuracy scoreboard.",
  difficulty: "beginner",
  tags: ["evaluation"],
  subgroup: "Evaluation Fundamentals",
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro",
      kind: "markdown",
      source: `# 2 · Programmatic Evaluation

Before reaching for an LLM judge, ask: *"Could a deterministic function tell me if the answer is right?"*

If yes — **always use code**. Programmatic evals are:

- **Free** — no extra model calls.
- **Fast** — milliseconds.
- **Reproducible** — same input, same verdict, forever.
- **Auditable** — anyone can read the assertion.

This notebook builds a tiny "City Facts" ground-truth dataset and grades a model across four eval types:

1. **Exact match** — does it know the city's population?
2. **Calculation** — can it compute population density correctly?
3. **Comparison** — does it rank cities correctly?
4. **Structured extraction** — can it return the right JSON shape?

Then we compute an **accuracy scoreboard** broken down by category.`,
    },

    // ───────── dataset
    {
      id: "md-ds",
      kind: "markdown",
      source: `## Step 1 · The ground-truth dataset

Real eval datasets have thousands of rows. For learning, three cities is enough.

Each row is the **source of truth**. The model's answer is compared against these values — never the other way around.`,
    },
    {
      id: "dataset",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `const CITIES = [
  { name: "Tokyo",   country: "Japan",          population: 13960000, area_km2: 2194 },
  { name: "Mumbai",  country: "India",          population: 20400000, area_km2: 603  },
  { name: "Berlin",  country: "Germany",        population:  3645000, area_km2: 891  },
];

// Derived ground truth
const density = (c) => Math.round(c.population / c.area_km2);
for (const c of CITIES) c.density_per_km2 = density(c);

ctx.state.CITIES = CITIES;

// Chat helper, structured output
ctx.state.askJSON = async (prompt) => {
  const res = await ctx.fetch(ctx.aiBaseURL + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + ctx.aiApiKey },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash",
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error?.message ?? JSON.stringify(data));
  const raw = data.choices[0].message.content.trim().replace(/^\`\`\`(?:json)?\s*|\s*\`\`\`$/g, "");
  return JSON.parse(raw);
};

ctx.state.evalResults = ctx.state.evalResults ?? {};

return CITIES;
`,
    },

    // ───────── eval 1: exact match
    {
      id: "md-1",
      kind: "markdown",
      source: `## Eval 1 · Exact-match factual lookup

We force JSON output so we can extract a number. Then we just compare against ground truth.

> **Why force JSON?** A free-form answer like *"Tokyo has roughly 14 million residents"* requires fragile regex. JSON makes the comparison trivial.`,
    },
    {
      id: "exact",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `const { CITIES, askJSON } = ctx.state;

const results = [];
for (const city of CITIES) {
  const out = await askJSON(
    \`Return the population of \${city.name}, \${city.country}. Reply JSON: { "population": number }\`
  );

  // Programmatic check: within 5% of ground truth = pass (LLMs round; that's OK)
  const tolerance = city.population * 0.05;
  const diff = Math.abs(out.population - city.population);
  const pass = diff <= tolerance;

  results.push({
    city: city.name,
    model: out.population,
    truth: city.population,
    diff_pct: +(diff / city.population * 100).toFixed(1),
    pass,
  });
}
ctx.state.evalResults = { ...(ctx.state.evalResults ?? {}), exact_match: results };
return results;
`,
    },
    {
      id: "md-1x",
      kind: "markdown",
      source: `**Tolerance windows** are key for numeric evals. If the truth is 13,960,000 and the model says 14,000,000, that's a perfect answer — within rounding. Reject only *meaningfully* wrong answers.`,
    },

    // ───────── eval 2: calculation
    {
      id: "md-2",
      kind: "markdown",
      source: `## Eval 2 · Calculation — does the math hold up?

We give the model the inputs and ask it to compute density. The answer must match \`population / area\` to within 5%.

This catches the classic LLM failure mode: it *says* it computed something but actually hallucinated a plausible-looking number.`,
    },
    {
      id: "calc",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `const { CITIES, askJSON } = ctx.state;

const results = [];
for (const c of CITIES) {
  const out = await askJSON(
    \`Compute the population density of \${c.name}.
Population: \${c.population.toLocaleString()}
Area: \${c.area_km2} km²
Reply JSON: { "density_per_km2": number }\`
  );
  const truth = c.density_per_km2;
  const diff = Math.abs(out.density_per_km2 - truth);
  const pass = diff / truth <= 0.05;
  results.push({ city: c.name, model: out.density_per_km2, truth, pass });
}
ctx.state.evalResults = { ...(ctx.state.evalResults ?? {}), calculation: results };
return results;
`,
    },

    // ───────── eval 3: comparison
    {
      id: "md-3",
      kind: "markdown",
      source: `## Eval 3 · Comparison / ranking

"Which city is larger, A or B?" — a binary classification. The ground truth is computed from the dataset, the model's answer is constrained to one of the two names.`,
    },
    {
      id: "compare",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `const { CITIES, askJSON } = ctx.state;

const pairs = [
  [CITIES[0], CITIES[1]],
  [CITIES[1], CITIES[2]],
  [CITIES[0], CITIES[2]],
];

const results = [];
for (const [a, b] of pairs) {
  const truth = a.population > b.population ? a.name : b.name;
  const out = await askJSON(
    \`Which city has a larger population: \${a.name} or \${b.name}? Reply JSON: { "larger": "\${a.name}" | "\${b.name}" }\`
  );
  results.push({ pair: \`\${a.name} vs \${b.name}\`, model: out.larger, truth, pass: out.larger === truth });
}
ctx.state.evalResults = { ...(ctx.state.evalResults ?? {}), comparison: results };
return results;
`,
    },

    // ───────── eval 4: structured extraction
    {
      id: "md-4",
      kind: "markdown",
      source: `## Eval 4 · Structured extraction — schema correctness

Sometimes "correct" means *"the JSON has the right shape and types"*. We grade on:

- All required keys present
- Types match
- Values within plausible ranges

This is the eval style you want for any AI-generated form/object that downstream code consumes.`,
    },
    {
      id: "extract",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `const { CITIES, askJSON } = ctx.state;

function validateProfile(p) {
  const issues = [];
  if (typeof p.name !== "string") issues.push("name not string");
  if (typeof p.country !== "string") issues.push("country not string");
  if (typeof p.population !== "number" || p.population <= 0) issues.push("bad population");
  if (typeof p.area_km2 !== "number" || p.area_km2 <= 0) issues.push("bad area");
  if (!Array.isArray(p.fun_facts) || p.fun_facts.length < 2) issues.push("need >=2 fun_facts");
  return { pass: issues.length === 0, issues };
}

const results = [];
for (const c of CITIES) {
  const out = await askJSON(
    \`Build a city profile for \${c.name}. Reply JSON: {
  "name": string, "country": string, "population": number, "area_km2": number,
  "fun_facts": string[] (at least 2 items)
}\`
  );
  const v = validateProfile(out);
  results.push({ city: c.name, ...v, sample_keys: Object.keys(out) });
}
ctx.state.evalResults = { ...(ctx.state.evalResults ?? {}), extraction: results };
return results;
`,
    },

    // ───────── scoreboard
    {
      id: "md-sb",
      kind: "markdown",
      source: `## Final · Accuracy scoreboard

Now we aggregate the four evals into a single dashboard — per-category accuracy + overall.

In production, this becomes a CI step: any change that drops accuracy below the threshold blocks the deploy.`,
    },
    {
      id: "scoreboard",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `const r = ctx.state.evalResults ?? {};
function score(rows = []) {
  const passed = rows.filter((x) => x.pass).length;
  return { passed, total: rows.length, pct: rows.length ? +(passed / rows.length * 100).toFixed(1) : 0 };
}

const board = {
  exact_match : score(r.exact_match ?? []),
  calculation : score(r.calculation ?? []),
  comparison  : score(r.comparison ?? []),
  extraction  : score(r.extraction ?? []),
};
const all = [...(r.exact_match ?? []), ...(r.calculation ?? []), ...(r.comparison ?? []), ...(r.extraction ?? [])];
board.overall = score(all);

return board;
`,
    },
    {
      id: "md-end",
      kind: "markdown",
      source: `### When programmatic evals are **not** enough

The moment "correct" depends on tone, helpfulness, completeness, or coverage of an open-ended topic — code can't grade it. That's when you bring in an LLM judge.

That's the next notebook: **LLM-as-a-Judge & Jury**.`,
    },
  ],
};
