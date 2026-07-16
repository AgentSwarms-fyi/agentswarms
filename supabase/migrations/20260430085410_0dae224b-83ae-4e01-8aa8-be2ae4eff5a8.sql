-- =====================================================================
-- Shared "AgentSwarms — How-To Guide" knowledge base + Demo agent wiring
-- Pattern: user_id IS NULL, is_sample = true, deterministic UUIDs.
-- Readable by all via existing RLS policy on knowledge_bases / knowledge_documents.
-- =====================================================================

-- ---------- 1. Knowledge Base ----------
INSERT INTO public.knowledge_bases (id, user_id, name, description, is_sample)
VALUES (
  'a9ed1b51-4c3d-4f87-9c5a-1d2e3f4a5b00',
  NULL,
  'AgentSwarms — How-To Guide',
  'Built-in how-to guide for the AgentSwarms platform. Auto-attached to the Demo Friendly Assistant so it can answer questions about features, pages, and what is or isn''t supported.',
  true
)
ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name,
      description = EXCLUDED.description,
      is_sample = true,
      user_id = NULL;

-- Idempotent: wipe & re-seed docs so edits to copy take effect on re-run.
DELETE FROM public.knowledge_documents
 WHERE knowledge_base_id = 'a9ed1b51-4c3d-4f87-9c5a-1d2e3f4a5b00';

-- ---------- 2. Documents ----------

-- Doc 1: Overview
INSERT INTO public.knowledge_documents (id, knowledge_base_id, user_id, name, content, is_sample, metadata) VALUES (
  'a9ed1b51-4c3d-4f87-9c5a-1d2e3f4a5b01',
  'a9ed1b51-4c3d-4f87-9c5a-1d2e3f4a5b00',
  NULL,
  '01_Getting_Started_Overview.md',
  $doc$Page: /dashboard
Topic: AgentSwarms platform overview

WHAT AGENTSWARMS IS
AgentSwarms is an educational platform for building, running, and observing agentic AI systems. You can build single agents, multi-agent swarms, attach knowledge bases (RAG), wire in tools, and watch every run via execution traces.

MAIN PAGES (use these route paths in answers)
- /playground — chat with your agents and demo agents
- /agents — create and edit agents (system prompt, model, tools, KBs, skills, memory, guardrails)
- /swarms — visual canvas to build multi-agent swarms (Router, Worker, Tool nodes)
- /patterns — reference patterns (Reflection, Tool Use, Planning, Multi-Agent)
- /knowledge — create knowledge bases, upload docs, build vector + Graph RAG
- /data-sql — upload CSVs and ask questions in natural language via the BI/SQL agent
- /prompts — Prompt Library: reusable prompt snippets
- /skills — Skill Library: reusable behavior modules you stack on agents
- /integrations — webhook + automation integrations (n8n, Zapier-style)
- /mcp — connect MCP (Model Context Protocol) servers
- /model-registry — browse models and provider/model picker
- /traces — every request, tokens, latency, cost, tool calls
- /budgets — monthly cap, per-agent daily limits, alerts
- /templates — pre-built agent + swarm templates
- /community/agents and /community/swarms — community gallery
- /certification — get certified

HOW THE PIECES FIT
1. Pick or create an agent on /agents.
2. Optionally attach a KB (/knowledge), skills (/skills), prompts (/prompts), tools, guardrails, memory.
3. Test in /playground.
4. Combine multiple agents into a swarm on /swarms.
5. Inspect every run on /traces. Cap spend on /budgets.

WHAT'S SUPPORTED TODAY
Single agents, multi-agent swarms, vector + Graph RAG knowledge bases, CSV upload + SQL agent, prompt library, skill library, guardrails, short-term + long-term memory, built-in tools, Firecrawl web scrape/search, templates, MCP servers, custom provider credentials (OpenAI-compatible incl. OpenRouter), execution traces, budgets, certification.

WHAT'S NOT SUPPORTED YET
Voice agents, real-time audio, video generation, fine-tuning UI, hosted model training, mobile native apps. If a user asks for any of these, say so plainly.
$doc$,
  true,
  '{"topic":"overview","route":"/dashboard"}'::jsonb
);

-- Doc 2: Integrations + OpenRouter example
INSERT INTO public.knowledge_documents (id, knowledge_base_id, user_id, name, content, is_sample, metadata) VALUES (
  'a9ed1b51-4c3d-4f87-9c5a-1d2e3f4a5b02',
  'a9ed1b51-4c3d-4f87-9c5a-1d2e3f4a5b00',
  NULL,
  '02_How_to_Create_an_Integration_OpenRouter_Example.md',
  $doc$Page: /integrations  (and /model-registry for model providers)
Topic: How to create an integration

TWO KINDS OF "INTEGRATIONS" IN AGENTSWARMS

1) MODEL PROVIDER INTEGRATIONS (most common — this is what OpenRouter is)
   Page: /agents → open any agent → "Provider & Model" section → "Manage providers / Add credential"
   Or: /model-registry to browse available models first.

   How it works: AgentSwarms supports OpenAI, Anthropic, Google Gemini, Vertex, Bedrock, Azure, Grok/xAI, Qwen, OCI, vLLM, and any OpenAI-compatible endpoint. OpenRouter is OpenAI-compatible, so you add it as an "OpenAI-compatible" provider.

   STEP-BY-STEP — Add OpenRouter:
   a. Open an agent on /agents (or create one).
   b. In the Provider section, click "Manage providers" / "Add credential".
   c. Pick provider type: "OpenAI-compatible".
   d. Label: "OpenRouter".
   e. Base URL: https://openrouter.ai/api/v1
   f. API Key: paste your OpenRouter API key (starts with sk-or-v1-...).
   g. Default model: e.g. "openai/gpt-5", "anthropic/claude-sonnet-4.5", or any OpenRouter model slug. Find slugs at https://openrouter.ai/models
   h. Save. The credential is encrypted and only used server-side.
   i. Back on the agent form, pick "OpenAI-compatible (OpenRouter)" as the provider and the model you want.
   j. Test in /playground.

   The same flow works for any OpenAI-compatible host (Together, Groq, local vLLM, etc.) — just change Base URL + key.

2) WEBHOOK / AUTOMATION INTEGRATIONS
   Page: /integrations
   For wiring agents to n8n, Zapier-style flows, or your own webhook endpoints. Add the webhook URL + an optional auth header. Then enable it as a tool on the agent so the agent can call it.

WHAT'S NOT SUPPORTED YET
- One-click OAuth for arbitrary SaaS tools (use MCP or webhooks instead — see /mcp).
$doc$,
  true,
  '{"topic":"integrations","route":"/integrations"}'::jsonb
);

-- Doc 3: Knowledge bases
INSERT INTO public.knowledge_documents (id, knowledge_base_id, user_id, name, content, is_sample, metadata) VALUES (
  'a9ed1b51-4c3d-4f87-9c5a-1d2e3f4a5b03',
  'a9ed1b51-4c3d-4f87-9c5a-1d2e3f4a5b00',
  NULL,
  '03_How_to_Create_a_Knowledge_Base.md',
  $doc$Page: /knowledge
Topic: How to create a knowledge base (RAG + Graph RAG)

WHAT IT IS
A knowledge base (KB) is a collection of documents your agent can search before answering. AgentSwarms supports keyword + vector retrieval AND Graph RAG (entities + relations).

STEP-BY-STEP
1. Go to /knowledge → "New Knowledge Base". Give it a name + description.
2. Click "Add Source" and pick a source type:
   - PDF / TXT / MD / DOCX upload
   - URL (single page, scraped via Firecrawl)
   - GitHub repo (ingests README + markdown files)
3. Wait for ingestion (a status pill shows progress).
4. Optional — Build the Knowledge Graph: open the KB, click the "Graph" tab, then "Build Graph". Entities + relations are extracted with an LLM. Use this when relationships matter (org charts, customer 360, drug interactions).
5. Attach the KB to an agent: /agents → edit agent → "Knowledge Bases" → select your KB. You can attach multiple KBs to one agent.

HOW THE AGENT USES IT
At runtime the agent automatically retrieves relevant snippets via the kb_search tool and includes citations in the answer. With Graph RAG enabled, multi-hop questions ("which customers are tied to vendors that had incidents?") work much better than vector-only.

REFERENCE SAMPLE KBs (already loaded for everyone)
- "Graph RAG Demo — Acme Corp" — open the Graph tab to see a real entity network.
- "Sample · Pharmacovigilance Drug Safety" — used by the Agentic RAG swarm template.

WHAT'S NOT SUPPORTED YET
- Direct ingestion from Notion / Confluence / Google Drive (use URL ingestion or export to PDF first; full OAuth ingestion is not built yet).
- Per-document ACLs inside a KB (the whole KB is shared with whichever agent it's attached to).
$doc$,
  true,
  '{"topic":"knowledge","route":"/knowledge"}'::jsonb
);

-- Doc 4: CSV + SQL agents
INSERT INTO public.knowledge_documents (id, knowledge_base_id, user_id, name, content, is_sample, metadata) VALUES (
  'a9ed1b51-4c3d-4f87-9c5a-1d2e3f4a5b04',
  'a9ed1b51-4c3d-4f87-9c5a-1d2e3f4a5b00',
  NULL,
  '04_How_to_Upload_CSV_and_Query_with_SQL_Agents.md',
  $doc$Page: /data-sql
Topic: Upload a CSV and ask questions of your data

WHAT IT IS
The Data & SQL page is a BI agent. You upload a CSV, it lands in your private data tables, and you can ask questions in plain English. The agent writes SQL, runs it on your data, and shows you charts.

STEP-BY-STEP
1. Go to /data-sql → "Upload CSV".
2. Pick your file (header row required). Give the table a friendly name.
3. After upload, the table appears in the left sidebar. Click it to preview rows + columns.
4. Optional but recommended — "Edit Semantic Layer": add a description for the table and each column ("revenue is in USD, region is one of NA/EU/APAC..."). The BI agent uses this to write better SQL.
5. In the chat box, ask anything: "top 10 customers by revenue last quarter", "month-over-month growth in EU", "which products had churn > 5%". Suggested questions appear once you upload.
6. The agent shows the SQL it generated, the result table, and renders a chart automatically when appropriate.

PRE-LOADED SAMPLE DATA (for everyone)
- saas_sales — SaaS sales by industry, segment, region.
- q3_budget_variance — Q3 budget vs actuals.
- adverse_event_reports — pharmacovigilance demo.

WHAT'S NOT SUPPORTED YET
- Live database connections (Postgres, BigQuery, Snowflake) — use connectors via MCP or paste a query result as CSV for now.
- Files larger than ~50MB — split first.
- Excel files with multiple sheets — export each sheet as CSV.
$doc$,
  true,
  '{"topic":"data-sql","route":"/data-sql"}'::jsonb
);

-- Doc 5: Create an agent
INSERT INTO public.knowledge_documents (id, knowledge_base_id, user_id, name, content, is_sample, metadata) VALUES (
  'a9ed1b51-4c3d-4f87-9c5a-1d2e3f4a5b05',
  'a9ed1b51-4c3d-4f87-9c5a-1d2e3f4a5b00',
  NULL,
  '05_How_to_Create_an_Agent.md',
  $doc$Page: /agents
Topic: How to create an agent

STEP-BY-STEP
1. /agents → "New Agent" (or "+" button).
2. NAME + DESCRIPTION — short, clear.
3. SYSTEM PROMPT — the agent's persona + rules. Be specific. Tell it what to do, what NOT to do, the format you want.
4. PROVIDER + MODEL — pick a provider (OpenAI, Anthropic, Lovable AI Gateway, or your custom OpenAI-compatible like OpenRouter). Pick a model. Defaults to google/gemini-3-flash-preview via the gateway (no API key needed).
5. TEMPERATURE — 0.0–1.0. Low (0.0–0.3) = focused; high (0.7+) = creative.
6. MAX TOKENS — output cap.
7. KNOWLEDGE BASES — attach KBs (built on /knowledge). The agent will auto-search them.
8. SKILLS — stack reusable behavior modules from /skills (e.g. tone, JSON-only, refusal policy).
9. TOOLS — toggle built-in tools (web search/scrape via Firecrawl, kb_search, sql_query, http_request, memory tools, etc.).
10. GUARDRAILS — add input/output guardrails (PII redaction, refusal patterns).
11. MEMORY — turn on short-term memory (auto summary of long convos) and/or long-term memory (extracted facts recalled across sessions).
12. Save. Test in /playground.

EXPORT / SHARE
- Each agent has Export (JSON) and Share/Publish to Community buttons on the agent card.
- Import other people's agents from /community/agents.

WHAT'S NOT SUPPORTED YET
- Multi-modal image input attachments per chat (model-dependent and not surfaced uniformly yet).
- Voice/audio input.
$doc$,
  true,
  '{"topic":"agents","route":"/agents"}'::jsonb
);

-- Doc 6: Swarms
INSERT INTO public.knowledge_documents (id, knowledge_base_id, user_id, name, content, is_sample, metadata) VALUES (
  'a9ed1b51-4c3d-4f87-9c5a-1d2e3f4a5b06',
  'a9ed1b51-4c3d-4f87-9c5a-1d2e3f4a5b00',
  NULL,
  '06_How_to_Build_a_Swarm.md',
  $doc$Page: /swarms  (and /patterns for reference patterns)
Topic: How to build a multi-agent system (a "swarm")

WHAT A SWARM IS
A graph of nodes (agents + tools) connected by edges. A Router decides which Worker handles a step; Workers do the work; Tools call out to KBs, SQL, web, MCP, etc. Output flows along the edges.

STEP-BY-STEP
1. /swarms → "New Swarm".
2. Drag node types from the left sidebar onto the canvas:
   - Router — decision-maker that picks the next node based on the message.
   - Worker — an actual agent (pick one of your agents).
   - Tool — a capability (kb_search, sql_query, web_search, MCP tool, etc.).
   - Reflect/Judge — optional eval node that scores/critiques output.
3. Click a node to open the inspector and configure it (which agent, which tool, prompt overrides).
4. Connect nodes by dragging from one handle to the next.
5. Click "Run" in the run panel and pass an input. You'll see token-by-token output and which node fired when.
6. Inspect every step on /traces.

GOOD STARTING SHAPES
- 2-node: Researcher → Writer.
- 3-node: Router → (Researcher or Coder) → Reviewer.
- ERP + RAG: Router → SQL agent + RAG agent → Synthesizer (try the "Financial Variance — ERP + RAG" template — open with /swarms?template=financial-variance-erp-rag).

REFERENCE PATTERNS — see /patterns for ready-to-use diagrams of Reflection, Tool Use, Planning, and Multi-Agent.

WHAT'S NOT SUPPORTED YET
- Long-running async workflows that survive page reload mid-run (runs are interactive sessions for now — use templates.provision for kicked-off batches).
$doc$,
  true,
  '{"topic":"swarms","route":"/swarms"}'::jsonb
);

-- Doc 7: Prompt Library
INSERT INTO public.knowledge_documents (id, knowledge_base_id, user_id, name, content, is_sample, metadata) VALUES (
  'a9ed1b51-4c3d-4f87-9c5a-1d2e3f4a5b07',
  'a9ed1b51-4c3d-4f87-9c5a-1d2e3f4a5b00',
  NULL,
  '07_How_to_Use_the_Prompt_Library.md',
  $doc$Page: /prompts
Topic: Prompt Library

WHAT IT IS
A library of reusable prompt snippets you can paste into agent system prompts or into chats. Browse curated ones or save your own.

STEP-BY-STEP — USE
1. /prompts → search/filter by tag (e.g. "summarization", "extraction", "classification").
2. Click a prompt → "Copy" or "Use in agent".
3. In the agent form (/agents), open the system prompt and paste, or click the prompt-picker icon to insert.

STEP-BY-STEP — SAVE YOUR OWN
1. /prompts → "New Prompt". Add title, body, tags.
2. It's saved to your library and available in every agent's system-prompt picker.

WHAT'S NOT SUPPORTED YET
- Versioning / A-B testing prompts side by side (use Skills for swappable building blocks instead).
$doc$,
  true,
  '{"topic":"prompts","route":"/prompts"}'::jsonb
);

-- Doc 8: Skill Library
INSERT INTO public.knowledge_documents (id, knowledge_base_id, user_id, name, content, is_sample, metadata) VALUES (
  'a9ed1b51-4c3d-4f87-9c5a-1d2e3f4a5b08',
  'a9ed1b51-4c3d-4f87-9c5a-1d2e3f4a5b00',
  NULL,
  '08_How_to_Use_the_Skill_Library.md',
  $doc$Page: /skills
Topic: Skill Library — modular behavior you stack on agents

WHAT A SKILL IS
A focused behavior module — a tone rule, a refusal policy, a JSON-only contract, a step-by-step debugging style. Skills are injected into the agent's effective system prompt at runtime, so you can mix and match without rewriting the base prompt.

STEP-BY-STEP — ATTACH SKILLS TO AN AGENT
1. /agents → edit your agent → "Skills" section.
2. Click "Add Skill" and pick from the library (or your own).
3. You can stack multiple skills (e.g. "support tone" + "JSON-only output" + "refusal policy"). Order matters — later skills override earlier ones for conflicting rules.
4. Save. Test in /playground.

STEP-BY-STEP — CREATE A SKILL
1. /skills → "New Skill".
2. Name + tags + body (the actual instructions). Keep skills small and single-purpose.
3. Save. It's now selectable on any agent.
4. There's also an AI Skill Generator — describe what you want, it drafts the skill.

REFERENCE SAMPLE AGENTS THAT USE SKILLS (auto-created for you)
- "Sample · SQL Reviewer" — single skill drives behavior.
- "Sample · Support Agent (with Tone + Refusal)" — stacks tone + refusal + JSON skills.
- "Sample · Research Synthesizer" — skill enforces output format.

WHAT'S NOT SUPPORTED YET
- Skills with code execution (use Tools or MCP for that).
$doc$,
  true,
  '{"topic":"skills","route":"/skills"}'::jsonb
);

-- Doc 9: Guardrails
INSERT INTO public.knowledge_documents (id, knowledge_base_id, user_id, name, content, is_sample, metadata) VALUES (
  'a9ed1b51-4c3d-4f87-9c5a-1d2e3f4a5b09',
  'a9ed1b51-4c3d-4f87-9c5a-1d2e3f4a5b00',
  NULL,
  '09_How_to_Use_Guardrails.md',
  $doc$Page: /agents → edit agent → "Guardrails" section
Topic: Guardrails

WHAT THEY ARE
Rules that run on agent input AND output to enforce safety, compliance, and format. They run BEFORE the model sees the input and AFTER it produces output.

BUILT-IN GUARDRAILS
- PII redaction (emails, phone numbers, credit cards) on input and/or output.
- Profanity / toxicity filter.
- Topic restriction (refuse if outside allowed topics).
- Output format enforcement (require JSON, regex match, max length).
- Refusal pattern (drop in a "do not answer X" rule).

STEP-BY-STEP
1. /agents → edit agent → "Guardrails".
2. Toggle the rails you want; configure thresholds.
3. Save. Violations show up in /traces with status = "guardrail_blocked" so you can audit them.

PAIR WITH BUDGETS
- /budgets sets monthly + per-agent daily spend caps. With auto-disable on, an agent that hits its limit goes inactive automatically.

WHAT'S NOT SUPPORTED YET
- Per-user / per-tenant guardrails (rails are per-agent today).
- Custom Python guardrail functions in the UI (use a Tool/MCP to do that out-of-band).
$doc$,
  true,
  '{"topic":"guardrails","route":"/agents"}'::jsonb
);

-- Doc 10: Memory
INSERT INTO public.knowledge_documents (id, knowledge_base_id, user_id, name, content, is_sample, metadata) VALUES (
  'a9ed1b51-4c3d-4f87-9c5a-1d2e3f4a5b0a',
  'a9ed1b51-4c3d-4f87-9c5a-1d2e3f4a5b00',
  NULL,
  '10_How_to_Use_Short_and_Long_Term_Memory.md',
  $doc$Page: /agents → edit agent → "Memory" section
Topic: Short-term + Long-term Memory

SHORT-TERM MEMORY (STM)
- Per-conversation. A sliding window of recent messages plus an auto-generated rolling SUMMARY of older turns.
- Settings: stm_enabled, stm_window_messages (default 20), stm_summarize, stm_summary_model.
- Use case: long support chats, multi-turn tasks where context grows past the model's limit.

LONG-TERM MEMORY (LTM)
- Per-user + per-agent. The agent extracts FACTS from conversations (preferences, names, decisions) and recalls the most relevant ones on each new message.
- Settings: ltm_enabled, ltm_auto_extract, ltm_recall_top_k (default 5), ltm_max_items (default 200).
- Use case: a personal assistant that remembers "I'm vegan", "my company is Acme", "always reply in French".

STEP-BY-STEP
1. /agents → edit agent → "Memory" tab.
2. Turn on STM (already on by default) and tune the window if needed.
3. Turn on LTM. Optionally turn off auto-extract and write facts manually via the memory tools (the agent has memory_add / memory_search tools when LTM is on).
4. Save. New chats begin populating memory.

INSPECT
- LTM items are visible per-agent in the agent settings; you can edit/delete them.
- STM summary is regenerated automatically as the conversation grows.

WHAT'S NOT SUPPORTED YET
- Cross-agent shared memory (each agent has its own LTM store).
- Memory editing UI inside the chat (use the agent settings page).
$doc$,
  true,
  '{"topic":"memory","route":"/agents"}'::jsonb
);

-- Doc 11: Tools
INSERT INTO public.knowledge_documents (id, knowledge_base_id, user_id, name, content, is_sample, metadata) VALUES (
  'a9ed1b51-4c3d-4f87-9c5a-1d2e3f4a5b0b',
  'a9ed1b51-4c3d-4f87-9c5a-1d2e3f4a5b00',
  NULL,
  '11_How_to_Use_Tools.md',
  $doc$Page: /agents → edit agent → "Tools" section
Topic: Tools (function calling)

WHAT TOOLS ARE
Tools turn an agent from a chat box into something that can DO things — search the web, query a KB, run SQL, call an HTTP endpoint, write to memory, hand off to another agent.

BUILT-IN TOOLS (toggle on the agent form)
- kb_search — searches the agent's attached knowledge bases. ON by default if any KB is attached.
- kb_graph_query — multi-hop graph traversal on KBs that have a built graph.
- sql_query — runs SQL against your tables on /data-sql.
- web_search — Firecrawl-powered web search.
- web_scrape — fetch + clean a single URL.
- web_map / web_crawl — discover URLs / crawl a site (Firecrawl).
- http_request — generic HTTP for webhooks / your APIs (configure per-agent).
- memory_add / memory_search — write/read long-term memory items (when LTM is on).
- mcp_* — every tool exposed by an attached MCP server appears here automatically.

STEP-BY-STEP
1. /agents → edit agent → "Tools".
2. Toggle the tools you want; some have a small config (e.g. http_request needs an allow-list URL).
3. Save. The model will choose tools automatically when relevant; you can also tell it to ("use kb_search to find...").
4. See every tool call in /traces.

WHAT'S NOT SUPPORTED YET
- Code interpreter / Python sandbox as a built-in tool (use an MCP server for this).
$doc$,
  true,
  '{"topic":"tools","route":"/agents"}'::jsonb
);

-- Doc 12: Firecrawl web
INSERT INTO public.knowledge_documents (id, knowledge_base_id, user_id, name, content, is_sample, metadata) VALUES (
  'a9ed1b51-4c3d-4f87-9c5a-1d2e3f4a5b0c',
  'a9ed1b51-4c3d-4f87-9c5a-1d2e3f4a5b00',
  NULL,
  '12_How_to_Scrape_and_Search_the_Web_with_Firecrawl.md',
  $doc$Page: /agents → edit agent → "Tools" section (Firecrawl tools)
Topic: Web scrape / search via Firecrawl

WHAT FIRECRAWL GIVES YOU
A managed connector that handles JS rendering, anti-bot, and clean markdown extraction. Wrapped as four built-in agent tools:

- web_search(query, limit) — Google-style search results, optionally with full page content.
- web_scrape(url) — clean markdown of one URL.
- web_map(url) — fast discovery of all URLs on a site.
- web_crawl(url, limit, maxDepth) — recursively scrape a site.

STEP-BY-STEP
1. /agents → edit your agent → "Tools" → toggle the Firecrawl tools you need.
2. Save. The agent now has those tools in function-calling.
3. In /playground, try: "search the web for the latest news on agentic AI and summarize the top 3", or "scrape https://docs.example.com/intro and give me the key points".

WHEN TO USE WHAT
- web_search → "what's the news on X?" or research.
- web_scrape → you already have the URL and want clean content.
- web_map → "find all docs URLs on this site" before targeted scraping.
- web_crawl → bulk-ingest a small site (mind credits).

ASKING THE ASSISTANT TO SEARCH WEB
If a user asks the Demo Friendly Assistant to "search the web" and it can't, that's because web tools aren't enabled on this agent. Tell them: edit the agent on /agents, open Tools, toggle web_search (or web_scrape), save, retry.

WHAT'S NOT SUPPORTED YET
- Headless browser automation (clicking, filling forms) — use an MCP server with browser tools.
$doc$,
  true,
  '{"topic":"firecrawl","route":"/agents"}'::jsonb
);

-- Doc 13: Templates
INSERT INTO public.knowledge_documents (id, knowledge_base_id, user_id, name, content, is_sample, metadata) VALUES (
  'a9ed1b51-4c3d-4f87-9c5a-1d2e3f4a5b0d',
  'a9ed1b51-4c3d-4f87-9c5a-1d2e3f4a5b00',
  NULL,
  '13_How_to_Use_Templates.md',
  $doc$Page: /templates
Topic: Templates — pre-built agents and swarms

WHAT THEY ARE
Curated, ready-to-run agents and swarms covering common patterns: Financial Variance (ERP + RAG), LLM-as-a-Judge Support QA, Agentic RAG (Pharmacovigilance), Graph RAG Researcher, and more.

STEP-BY-STEP
1. /templates → browse cards.
2. Click a template to see its description, nodes, and what it teaches.
3. Click "Use template" → it provisions a copy into your account (agents + swarm + any sample KBs/data are already shared).
4. Open it in /swarms (or /agents for single-agent templates) and run it.

DEEP-LINK
Open a specific template directly in the swarm builder with /swarms?template=<template-id>, e.g. /swarms?template=financial-variance-erp-rag.

WHAT'S NOT SUPPORTED YET
- One-click deploy of a template to a public endpoint (run interactively for now; combine with /integrations webhooks for external triggers).
$doc$,
  true,
  '{"topic":"templates","route":"/templates"}'::jsonb
);

-- Doc 14: MCP
INSERT INTO public.knowledge_documents (id, knowledge_base_id, user_id, name, content, is_sample, metadata) VALUES (
  'a9ed1b51-4c3d-4f87-9c5a-1d2e3f4a5b0e',
  'a9ed1b51-4c3d-4f87-9c5a-1d2e3f4a5b00',
  NULL,
  '14_How_to_Use_MCP_Servers.md',
  $doc$Page: /mcp
Topic: MCP (Model Context Protocol) servers

WHAT MCP IS
A standard protocol for giving agents access to tools, data, and prompts from external servers — the "USB-C of agent tools". Connect once, every tool the server exposes shows up in your agent's tool list.

STEP-BY-STEP — ADD AN MCP SERVER
1. /mcp → "Add Server".
2. Name + description.
3. Endpoint URL (the server's MCP HTTP endpoint).
4. Auth: none / bearer token / custom header. Paste the token if needed.
5. Save → AgentSwarms pings the server, fetches its tool list, and shows tools_count + status.

ATTACH TO AN AGENT
1. /agents → edit agent → "Tools" → MCP servers section → enable the server.
2. Every tool that server exposes is now a function-callable tool on the agent.

USE CASES
- A company-internal MCP server fronting your data warehouse.
- Public MCP servers for browser automation, code sandboxes, project trackers.

WHAT'S NOT SUPPORTED YET
- Outbound MCP (exposing your AgentSwarms agents AS an MCP server to other clients).
- WebSocket/SSE-only MCP transports without HTTP fallback.
$doc$,
  true,
  '{"topic":"mcp","route":"/mcp"}'::jsonb
);

-- ---------- 3. Backfill existing Demo Friendly Assistant agents ----------
-- Wire the KB + tighten the system prompt for every existing user.

UPDATE public.agents
   SET knowledge_base_id = 'a9ed1b51-4c3d-4f87-9c5a-1d2e3f4a5b00',
       system_prompt = 'You are the friendly built-in assistant for AgentSwarms — an educational platform for building agentic AI systems. Your primary job is to help users learn how to use this platform.

GROUNDING RULES
- You have an attached knowledge base ("AgentSwarms — How-To Guide") that documents every supported feature, the exact page route for each, what works today, and what does NOT.
- ALWAYS prefer answers grounded in that KB when the user asks "how do I...", "where is...", "can AgentSwarms do X?".
- When relevant, cite the exact page route in backticks (e.g. `/agents`, `/swarms`, `/knowledge`, `/data-sql`, `/mcp`, `/integrations`, `/prompts`, `/skills`, `/templates`, `/traces`, `/budgets`).
- If something is NOT in the KB or is listed as "not supported yet", say so plainly: "That isn''t supported in AgentSwarms yet" — never invent features.
- If the user asks YOU directly to do something a tool would handle (search the web, run SQL, query a KB), and that tool isn''t enabled on this Demo agent, tell them how to enable it: "I can''t search the web from this Demo agent — open `/agents`, edit me, go to Tools, toggle `web_search` (Firecrawl), save, and retry. Or create a new agent with that tool enabled."
- For general questions outside AgentSwarms (chit-chat, generic AI/ML questions, coding help), be friendly and brief, then steer the user back to building agents.

STYLE
- Be concise and concrete. Use short paragraphs, bullets, and the route paths.
- Use markdown.
- Never make up feature names, button labels, or screens that aren''t in the KB.',
       tools = jsonb_set(
         COALESCE(tools, '{}'::jsonb),
         '{knowledgeBaseIds}',
         '["a9ed1b51-4c3d-4f87-9c5a-1d2e3f4a5b00"]'::jsonb,
         true
       )
 WHERE name = 'Demo · Friendly Assistant';

-- ---------- 4. Update handle_new_user so future signups get the same wiring ----------
CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  INSERT INTO public.profiles (user_id, display_name)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email));

  INSERT INTO public.agents (user_id, name, description, system_prompt, llm_provider, llm_model, temperature, max_tokens, tools, is_active, knowledge_base_id)
  VALUES (NEW.id, 'Demo · Friendly Assistant',
    'Your built-in guide to AgentSwarms. Ask me how to create agents, swarms, KBs, integrations, and more — I''m grounded in the AgentSwarms How-To Guide. [demo:starter]',
    'You are the friendly built-in assistant for AgentSwarms — an educational platform for building agentic AI systems. Your primary job is to help users learn how to use this platform.

GROUNDING RULES
- You have an attached knowledge base ("AgentSwarms — How-To Guide") that documents every supported feature, the exact page route for each, what works today, and what does NOT.
- ALWAYS prefer answers grounded in that KB when the user asks "how do I...", "where is...", "can AgentSwarms do X?".
- When relevant, cite the exact page route in backticks (e.g. `/agents`, `/swarms`, `/knowledge`, `/data-sql`, `/mcp`, `/integrations`, `/prompts`, `/skills`, `/templates`, `/traces`, `/budgets`).
- If something is NOT in the KB or is listed as "not supported yet", say so plainly: "That isn''t supported in AgentSwarms yet" — never invent features.
- If the user asks YOU directly to do something a tool would handle (search the web, run SQL, query a KB), and that tool isn''t enabled on this Demo agent, tell them how to enable it: "I can''t search the web from this Demo agent — open `/agents`, edit me, go to Tools, toggle `web_search` (Firecrawl), save, and retry. Or create a new agent with that tool enabled."
- For general questions outside AgentSwarms (chit-chat, generic AI/ML questions, coding help), be friendly and brief, then steer the user back to building agents.

STYLE
- Be concise and concrete. Use short paragraphs, bullets, and the route paths.
- Use markdown.
- Never make up feature names, button labels, or screens that aren''t in the KB.',
    'lovable_ai', 'google/gemini-3-flash-preview', 0.5, 4096,
    '{"builtInTools": {}, "toolConfigs": {}, "knowledgeBaseIds": ["a9ed1b51-4c3d-4f87-9c5a-1d2e3f4a5b00"]}'::jsonb,
    true,
    'a9ed1b51-4c3d-4f87-9c5a-1d2e3f4a5b00');

  INSERT INTO public.agents (user_id, name, description, system_prompt, llm_provider, llm_model, temperature, max_tokens, tools, is_active)
  VALUES (NEW.id, 'Sample · SQL Reviewer',
    'Reviews SQL for safety + performance. Demonstrates a single focused Skill driving the whole behaviour. [skill-sample:sql-reviewer]',
    'You are a senior database engineer. Be concise and direct. Stay strictly within SQL review — politely refuse unrelated tasks.',
    'lovable_ai', 'google/gemini-3-flash-preview', 0.2, 4096,
    '{"builtInTools": {}, "toolConfigs": {}, "knowledgeBaseIds": [], "skillIds": ["sample:sql-analyst"], "skillTourId": "sql-reviewer"}'::jsonb, true);

  INSERT INTO public.agents (user_id, name, description, system_prompt, llm_provider, llm_model, temperature, max_tokens, tools, is_active)
  VALUES (NEW.id, 'Sample · Support Agent (with Tone + Refusal)',
    'A friendly support assistant. Demonstrates stacking multiple Skills (tone + refusal policy + JSON discipline). [skill-sample:support-agent]',
    'You are a customer support assistant for AgentSwarms. Help users understand the product. Never invent features. If you don''t know, say so.',
    'lovable_ai', 'google/gemini-3-flash-preview', 0.4, 4096,
    '{"builtInTools": {}, "toolConfigs": {}, "knowledgeBaseIds": [], "skillIds": ["sample:support-tone", "sample:json-only"], "skillTourId": "support-agent"}'::jsonb, true);

  INSERT INTO public.agents (user_id, name, description, system_prompt, llm_provider, llm_model, temperature, max_tokens, tools, is_active)
  VALUES (NEW.id, 'Sample · Research Synthesizer',
    'Summarises sources into a structured brief. Demonstrates a Skill that enforces an output format. [skill-sample:research-synth]',
    'You are a careful research assistant. Synthesize information accurately. If you don''t have enough information to answer, say so explicitly.',
    'lovable_ai', 'google/gemini-3-flash-preview', 0.3, 4096,
    '{"builtInTools": {}, "toolConfigs": {}, "knowledgeBaseIds": [], "skillIds": ["sample:research-synthesizer", "sample:step-by-step-debugger"], "skillTourId": "research-synth"}'::jsonb, true);

  RETURN NEW;
END;
$function$;
