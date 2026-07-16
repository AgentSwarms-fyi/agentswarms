import type { Notebook } from "./types";

/**
 * Real-world example 6 — Travel Itinerary & Budget Optimizer.
 *
 * Combines: tools (hotels, restaurants) + a LangGraph cycle that loops
 * back when the itinerary blows the budget. Demonstrates constraint
 * satisfaction with conditional routing.
 */
export const rwTravelOptimizerNotebook: Notebook = {
  id: "rw-travel-optimizer",
  title: "Travel Itinerary & Budget Optimizer",
  description:
    "A LangGraph agent that plans a 3-day Tokyo trip under a strict USD budget. If the first plan blows the budget, a conditional edge loops back to pick a cheaper hotel and re-cost the trip until the math checks out.",
  difficulty: "advanced",
  tags: ["langgraph", "agent", "consumer", "routing", "real-world"],
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro",
      kind: "markdown",
      source: `# ✈️ Travel Itinerary & Budget Optimizer

Travel planning is the friendliest possible introduction to **agents that have to satisfy a numerical constraint.** The user gives a budget, the agent makes a plan, the plan probably costs too much, the agent has to *adjust and try again*. That "try again" step is what separates a real agent from a single LLM call.

The user request we'll solve:

> "Planning a 3-day trip to Tokyo. I love ramen and architecture, and my budget is strictly **$1,200**."

The agent needs to:

1. Pick a hotel from a list (each has a per-night price).
2. Pick 6 activities (2/day) from a list of architecture + ramen options (each has a cost).
3. Sum everything up.
4. **If the total exceeds $1,200**, *don't* just shrug and return — loop back, pick a cheaper hotel, and recompute. Repeat until the math fits, or we've exhausted hotel options.

Steps 1–3 are easy. Step 4 is where a LangGraph **cycle with a conditional edge** is exactly the right abstraction.`,
    },

    // ── Step 1: Catalogs ──────────────────────────────────────────────────
    {
      id: "md-catalogs",
      kind: "markdown",
      source: `## Step 1 — Mock catalogs

Two tools' worth of "API responses" — hotels ranked cheap → expensive, and activities tagged so the model can filter by interest. In production these would be Booking.com / Hotels.com and a Foursquare / Google Places call.`,
    },
    {
      id: "catalogs",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `// Step 1 — hotels (sorted) + activities.
ctx.state.HOTELS = [
  { name: "Tokyo Backpacker Hostel",     per_night: 35,  area: "Asakusa"  },
  { name: "Capsule Inn Shibuya",          per_night: 55,  area: "Shibuya"  },
  { name: "Hotel Mid-Range Marunouchi",   per_night: 140, area: "Marunouchi" },
  { name: "Park Hyatt Tokyo",             per_night: 520, area: "Shinjuku" },
];

ctx.state.ACTIVITIES = [
  { name: "TeamLab Borderless",            cost: 38, tags: ["architecture", "art"] },
  { name: "Nakagin Capsule Tower walking tour", cost: 25, tags: ["architecture"] },
  { name: "St. Mary's Cathedral (Tange) visit", cost: 0,  tags: ["architecture"] },
  { name: "Mori Art Museum + Tokyo City View",  cost: 32, tags: ["architecture", "art"] },
  { name: "Ichiran Ramen — Shibuya",       cost: 14, tags: ["ramen"] },
  { name: "Tsuta Michelin Ramen tasting",  cost: 28, tags: ["ramen"] },
  { name: "Afuri Yuzu Shio Ramen",         cost: 16, tags: ["ramen"] },
  { name: "Tokyo Ramen Street crawl",      cost: 40, tags: ["ramen"] },
];

return { hotels: ctx.state.HOTELS.length, activities: ctx.state.ACTIVITIES.length };
`,
      sampleOutput: { result: { hotels: 4, activities: 8 } },
    },

    // ── Step 2: Graph state ───────────────────────────────────────────────
    {
      id: "md-state",
      kind: "markdown",
      source: `## Step 2 — Graph state

The state tracks the request (budget, days, interests), the *currently considered* hotel index, the chosen activities, and the running total. \`attempts\` exists so the conditional edge can give up after walking the hotel list.`,
    },
    {
      id: "state",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `// Step 2 — declare the state shape.
const { Annotation } = ctx.lc.langgraph;

const TripState = Annotation.Root({
  budget_usd: Annotation(),
  days:       Annotation(),
  interests:  Annotation({ reducer: (_, x) => x, default: () => [] }),
  hotel_idx:  Annotation({ reducer: (_, x) => x, default: () => 0 }),
  itinerary:  Annotation({ reducer: (_, x) => x, default: () => null }),
  total:      Annotation({ reducer: (_, x) => x, default: () => 0 }),
  attempts:   Annotation({ reducer: (_, x) => x, default: () => 0 }),
  status:     Annotation({ reducer: (_, x) => x, default: () => "planning" }), // planning | done | failed
});

ctx.state.TripState = TripState;
return { fields: Object.keys(TripState.spec) };
`,
      sampleOutput: { result: { fields: ["budget_usd", "days", "interests", "hotel_idx", "itinerary", "total", "attempts", "status"] } },
    },

    // ── Step 3: Nodes ─────────────────────────────────────────────────────
    {
      id: "md-nodes",
      kind: "markdown",
      source: `## Step 3 — The nodes

Three nodes:

- **\`planTrip\`** — picks a hotel (the one at \`hotel_idx\`), asks the LLM to pick \`2 × days\` activities matching the user's interests, computes the total.
- **\`checkBudget\`** — pure JS. Sets \`status\` to \`done\` if the plan fits, otherwise increments \`attempts\` and \`hotel_idx\`.
- **\`router\`** — the conditional edge. If \`status === 'done'\` we go to \`END\`. If \`status === 'failed'\` (we ran out of hotels), also \`END\`. Otherwise loop back to \`planTrip\`.`,
    },
    {
      id: "nodes",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `// Step 3 — wire each node.
const { ChatOpenAI } = ctx.lc.openai;
const { z } = ctx.lc;

const llm = new ChatOpenAI({
  model: "google/gemini-3-flash-preview",
  temperature: 0.2,
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
});

const PlanSchema = z.object({
  picks: z.array(
    z.object({
      day: z.number().min(1).max(7),
      activity_name: z.string(),
    })
  ),
});

async function planTrip(s) {
  const hotel = ctx.state.HOTELS[s.hotel_idx];
  if (!hotel) return { status: "failed" };

  const lodging = hotel.per_night * s.days;
  const remaining = s.budget_usd - lodging;

  ctx.log("🏨 trying:", hotel.name, "($" + hotel.per_night + "/night → $" + lodging + " lodging, $" + remaining + " left for activities)");

  const structured = llm.withStructuredOutput(PlanSchema);
  const pick = await structured.invoke(
    "You are a trip planner. Pick exactly " + (s.days * 2) + " activities (2 per day for " + s.days + " days) " +
    "matching the user's interests (" + s.interests.join(", ") + "). Spend close to but UNDER $" + remaining + " on activities. " +
    "Available activities (JSON): " + JSON.stringify(ctx.state.ACTIVITIES)
  );

  // Cost up the plan.
  const byName = Object.fromEntries(ctx.state.ACTIVITIES.map((a) => [a.name, a]));
  const activities_cost = pick.picks.reduce((sum, p) => sum + (byName[p.activity_name]?.cost ?? 0), 0);
  const total = lodging + activities_cost;

  return {
    itinerary: { hotel, picks: pick.picks, lodging, activities_cost },
    total,
  };
}

function checkBudget(s) {
  if (s.total <= s.budget_usd) {
    ctx.log("✅ $" + s.total + " ≤ $" + s.budget_usd + " — accepted");
    return { status: "done" };
  }
  ctx.log("❌ $" + s.total + " > $" + s.budget_usd + " — trying a cheaper hotel");
  return { status: "planning", hotel_idx: s.hotel_idx + 1, attempts: s.attempts + 1 };
}

function router(s) {
  if (s.status === "done")   return "END";
  if (s.status === "failed") return "END";
  if (s.attempts >= ctx.state.HOTELS.length) return "END";
  return "planTrip";
}

Object.assign(ctx.state, { planTrip, checkBudget, router });
return { nodes: ["planTrip", "checkBudget"], conditional: "router" };
`,
      sampleOutput: { result: { nodes: ["planTrip", "checkBudget"], conditional: "router" } },
    },

    // ── Step 4: Compile graph ─────────────────────────────────────────────
    {
      id: "md-graph",
      kind: "markdown",
      source: `## Step 4 — Compile the graph (with a cycle)

This is the moment LangGraph earns its keep. In a plain \`for\` loop we'd be tracking the retry counter manually, mixing control flow with logic. In a \`StateGraph\` the cycle is explicit:

\`\`\`text
START → planTrip → checkBudget → router ──(done/failed)→ END
                                    │
                                    └─(planning)→ planTrip   (loop back)
\`\`\`

That diagram is the actual graph. You can render it, you can debug it node-by-node, and you can later swap any node for a smarter implementation without touching the others.`,
    },
    {
      id: "compile",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `// Step 4 — compile.
const { StateGraph, START, END } = ctx.lc.langgraph;

ctx.state.app = new StateGraph(ctx.state.TripState)
  .addNode("planTrip",    ctx.state.planTrip)
  .addNode("checkBudget", ctx.state.checkBudget)
  .addEdge(START, "planTrip")
  .addEdge("planTrip", "checkBudget")
  .addConditionalEdges("checkBudget", ctx.state.router, { END, planTrip: "planTrip" })
  .compile();

return { compiled: true };
`,
      sampleOutput: { result: { compiled: true } },
    },

    // ── Step 5: Run ───────────────────────────────────────────────────────
    {
      id: "md-run",
      kind: "markdown",
      source: `## Step 5 — Run it

The first attempt will likely pick the Park Hyatt (because it's "Tokyo" and the model has opinions), blow the budget, and the graph will loop back to a cheaper option. Watch the log output — you'll see it walking down the hotel list until the math works.`,
    },
    {
      id: "run",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `// Step 5 — run the optimiser.
const final = await ctx.state.app.invoke({
  budget_usd: 1200,
  days: 3,
  interests: ["ramen", "architecture"],
});

return {
  status: final.status,
  total: "$" + final.total + " / $" + final.budget_usd,
  attempts: final.attempts + 1,
  hotel: final.itinerary?.hotel?.name,
  itinerary: final.itinerary?.picks,
};
`,
      sampleOutput: {
        logs: [
          "🏨 trying: Tokyo Backpacker Hostel ($35/night → $105 lodging, $1095 left for activities)",
          "✅ $337 ≤ $1200 — accepted",
        ],
        result: {
          status: "done",
          total: "$337 / $1200",
          attempts: 1,
          hotel: "Tokyo Backpacker Hostel",
          itinerary: [
            { day: 1, activity_name: "TeamLab Borderless" },
            { day: 1, activity_name: "Tsuta Michelin Ramen tasting" },
            { day: 2, activity_name: "Mori Art Museum + Tokyo City View" },
            { day: 2, activity_name: "Afuri Yuzu Shio Ramen" },
            { day: 3, activity_name: "Nakagin Capsule Tower walking tour" },
            { day: 3, activity_name: "Tokyo Ramen Street crawl" },
          ],
        },
      },
    },

    // ── Step 6: Stress test ───────────────────────────────────────────────
    {
      id: "md-stress",
      kind: "markdown",
      source: `## Step 6 — Stress test: a budget that forces a loop

Drop the budget to **$500** for 3 days and watch the graph walk *down* the hotel list. The Park Hyatt alone is $1,560 of lodging, the mid-range is $420 (eats almost the whole budget), the capsule is $165, the hostel is $105 — only the last two leave room for activities. Each rejected attempt is one trip around the cycle.`,
    },
    {
      id: "stress",
      kind: "code",
      language: "js",
      runtime: "browser",
      source: `// Step 6 — tight budget, force the loop.
const final = await ctx.state.app.invoke({
  budget_usd: 500,
  days: 3,
  interests: ["ramen", "architecture"],
  hotel_idx: 3, // start with Park Hyatt to see the walk-down
});

return {
  status: final.status,
  total: "$" + final.total + " / $" + final.budget_usd,
  attempts: final.attempts + 1,
  hotel: final.itinerary?.hotel?.name,
};
`,
      sampleOutput: {
        logs: [
          "🏨 trying: Park Hyatt Tokyo ($520/night → $1560 lodging, -$1060 left for activities)",
          "❌ $1632 > $500 — trying a cheaper hotel",
          "🏨 trying: Hotel Mid-Range Marunouchi ($140/night → $420 lodging, $80 left for activities)",
          "❌ $548 > $500 — trying a cheaper hotel",
          "🏨 trying: Capsule Inn Shibuya ($55/night → $165 lodging, $335 left for activities)",
          "✅ $397 ≤ $500 — accepted",
        ],
        result: { status: "done", total: "$397 / $500", attempts: 3, hotel: "Capsule Inn Shibuya" },
      },
    },

    {
      id: "wrap",
      kind: "markdown",
      source: `## 🧭 The pattern beyond travel

Anywhere you have **"plan → check constraint → maybe re-plan"** you have this exact graph. Real applications:

- **Compute-cost optimisation** — pick an instance type, check monthly cost, downgrade if over.
- **Diet planning** — pick meals, check macros/calories, swap if off-target.
- **Code generation** — write code, run tests, regenerate if failing (this is literally the coder/reviewer graph in the Multi-Agent section).

Once the cycle abstraction clicks, you'll start seeing it everywhere — and you'll stop writing brittle retry counters by hand.`,
    },
  ],
};
