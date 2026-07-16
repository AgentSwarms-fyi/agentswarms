import type { Notebook } from "./types";

export const saHelloToolNotebook: Notebook = {
  id: "sa-hello-tool",
  title: "Hello World API Fetcher — Intro to Tool Calling",
  description:
    "A first agent with one tool: fetch the current weather for any city. Tweak the prompt or the persona and watch the agent adapt.",
  difficulty: "beginner",
  tags: ["agent", "langchain"],
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro", kind: "markdown",
      source: `# 7 · Hello World API Fetcher

The smallest useful agent: an LLM + **one tool**.

We'll wire up a real weather API (Open-Meteo — no API key needed) and
let the model decide when to call it. By the end you'll see exactly how
\`tool_calls\` flow through a LangChain agent loop.

**Try this:**
1. Run all cells in order.
2. Change the city in the user message.
3. Edit the system prompt to make the agent reply like a pirate.`,
    },

    { id: "md-1", kind: "markdown", source: `## 1 · Define the weather tool\n\nOpen-Meteo's geocoding + forecast endpoints are free and CORS-friendly. We wrap them in a single LangChain \`tool\`.` },
    {
      id: "weather-tool", kind: "code", language: "js", runtime: "browser",
      source: `const { tool } = ctx.lc.tools;
const { z } = ctx.lc;

const getWeather = tool(
  async ({ city }) => {
    // 1. Geocode the city
    const geo = await (await fetch(
      "https://geocoding-api.open-meteo.com/v1/search?count=1&name=" + encodeURIComponent(city)
    )).json();
    const hit = geo.results?.[0];
    if (!hit) return JSON.stringify({ error: "City not found: " + city });

    // 2. Current weather
    const w = await (await fetch(
      "https://api.open-meteo.com/v1/forecast?current_weather=true" +
      "&latitude=" + hit.latitude + "&longitude=" + hit.longitude
    )).json();

    return JSON.stringify({
      city: hit.name + ", " + (hit.country ?? ""),
      temp_c: w.current_weather?.temperature,
      wind_kph: w.current_weather?.windspeed,
      weather_code: w.current_weather?.weathercode,
    });
  },
  {
    name: "get_weather",
    description: "Get the current weather for a city anywhere in the world.",
    schema: z.object({ city: z.string().describe("City name, e.g. 'Paris' or 'Mumbai'") }),
  },
);

ctx.state.tools = [getWeather];
return { registered: getWeather.name };
`,
    },

    { id: "md-2", kind: "markdown", source: `## 2 · Bind the tool and run the agent loop\n\nClassic pattern: \`bindTools\` → invoke → run any \`tool_calls\` → invoke again until the model is satisfied.` },
    {
      id: "agent-loop", kind: "code", language: "js", runtime: "browser",
      source: `const { ChatOpenAI } = ctx.lc.openai;
const { HumanMessage, SystemMessage, ToolMessage } = ctx.lc.messages;

// 👇 Edit this system prompt — try "Reply like a 1700s pirate captain."
const SYSTEM = "You are a helpful weather assistant. Use get_weather when asked about cities.";

// 👇 Edit this user question — try other cities!
const QUESTION = "What's the weather like in Paris right now?";

const llm = new ChatOpenAI({
  model: "google/gemini-3-flash-preview", temperature: 0.3,
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
}).bindTools(ctx.state.tools);

const toolsByName = Object.fromEntries(ctx.state.tools.map((t) => [t.name, t]));
const msgs = [new SystemMessage(SYSTEM), new HumanMessage(QUESTION)];

for (let i = 0; i < 4; i++) {
  const ai = await llm.invoke(msgs);
  msgs.push(ai);
  const calls = ai.tool_calls ?? [];
  if (!calls.length) return ai.content;
  ctx.log("step", i + 1, "→", calls.map((c) => c.name + "(" + JSON.stringify(c.args) + ")").join(", "));
  for (const c of calls) {
    const out = await toolsByName[c.name].invoke(c.args);
    msgs.push(new ToolMessage({ content: String(out), tool_call_id: c.id }));
  }
}
return "(max steps)";
`,
    },
    { id: "md-2x", kind: "markdown", source: `**Things to try:**\n\n- Change \`QUESTION\` to *"Compare the weather in Tokyo and New York."* — watch the model call the tool twice.\n- Replace \`SYSTEM\` with a pirate persona. The factual weather stays correct; only the *style* changes.\n- Add a second tool (e.g. a stock-price fetcher) and notice the agent picks the right one.` },
  ],
};
