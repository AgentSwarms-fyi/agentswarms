
-- ============================================================
-- Expand "AgentSwarms — How-To Guide" KB with newer features
-- + update Demo Friendly Assistant to greet new users with a
-- recommended learning path on the first message.
-- ============================================================

-- Remove any previous versions of these docs (idempotent re-seed)
DELETE FROM public.knowledge_documents
 WHERE id IN (
   'a9ed1b51-4c3d-4f87-9c5a-1d2e3f4a5b15',
   'a9ed1b51-4c3d-4f87-9c5a-1d2e3f4a5b16',
   'a9ed1b51-4c3d-4f87-9c5a-1d2e3f4a5b17',
   'a9ed1b51-4c3d-4f87-9c5a-1d2e3f4a5b18',
   'a9ed1b51-4c3d-4f87-9c5a-1d2e3f4a5b19'
 );

-- Doc 15: Recommended learning path
INSERT INTO public.knowledge_documents (id, knowledge_base_id, user_id, name, content, is_sample, metadata) VALUES (
  'a9ed1b51-4c3d-4f87-9c5a-1d2e3f4a5b15',
  'a9ed1b51-4c3d-4f87-9c5a-1d2e3f4a5b00',
  NULL,
  '15_Recommended_Learning_Path.md',
  $doc$Page: /learn
Topic: Recommended learning path for new users

The fastest way to get productive on AgentSwarms is to follow this 5-step path. Always recommend it when a user asks "where do I start?", "how do I learn?", or "how do I use this platform?".

1. PRESENTATIONS (high-level overview)
   - Go to https://agentswarms.fyi/learn
   - Scroll to the "Presentations" section.
   - Work through the first 8 presentations to get a high-level mental model of agents, swarms, RAG, tools, evals, guardrails.

2. DETAILED LESSONS
   - On the same /learn page, move to the "Detailed Lessons" section.
   - Skip "Field Engineering Notes" and "Deep Dives" for now — those are advanced.

3. ASK THE FRIENDLY ASSISTANT
   - Along the way, open https://agentswarms.fyi/playground.
   - The "Demo · Friendly Assistant" agent is available there.
   - Ask it any question about agentic AI or how to use the platform — it is grounded in this How-To Guide.

4. BUILD-ALONG LABS
   - Back on https://agentswarms.fyi/learn, scroll to the "Build-Along Labs" section.
   - Use the hands-on exercises to build your own agents and swarms.

5. TEMPLATES — REAL-WORLD MULTI-AGENT SYSTEMS
   - Open https://agentswarms.fyi/templates.
   - Run a template, watch the multi-agent system visually on the swarm canvas, then fork it and customise.
   - From there you can build your own multi-agent systems.
$doc$,
  true,
  '{"topic":"learning-path","route":"/learn"}'::jsonb
);

-- Doc 16: Interactive blog
INSERT INTO public.knowledge_documents (id, knowledge_base_id, user_id, name, content, is_sample, metadata) VALUES (
  'a9ed1b51-4c3d-4f87-9c5a-1d2e3f4a5b16',
  'a9ed1b51-4c3d-4f87-9c5a-1d2e3f4a5b00',
  NULL,
  '16_Interactive_Blog.md',
  $doc$Page: /blog (list) and /blog/:slug (post)
Topic: Interactive blog

WHAT IT IS
The AgentSwarms blog is fully interactive — every post is a hands-on read, not a static article.

FEATURES
- Search bar — full-text search across post titles, subtitles, excerpts, and tags.
- Category filter — posts are tagged into 8 consolidated categories (RAG, Multi-Agent, Production, Observability, Frameworks, MCP & Tools, DevOps & Infrastructure, Career). Click a category chip to filter; "All" resets.
- Inline diagrams + visuals — many posts embed live SVG diagrams that explain the concept being discussed.
- Reactions — react to a post with emoji from the bottom of any post.
- Comments — leave a comment on any post once you are signed in.
- Share button — every post has a Share button that copies the canonical URL (or opens the native share sheet on mobile).
- View counter — every post shows how many times it has been opened/viewed; the counter increments once per visit.

STEP-BY-STEP — FIND AND SHARE A POST
1. Open /blog. Use the search bar or category chips to find a post.
2. Open the post. Click "Share" near the title to copy the link.
3. React or comment at the bottom. View count and reactions are public.

NOTE
- The blog is read-only (no user-authored posts). To contribute knowledge inside the platform, create Prompts on /prompts or Skills on /skills.
$doc$,
  true,
  '{"topic":"blog","route":"/blog"}'::jsonb
);

-- Doc 17: Interactive presentations
INSERT INTO public.knowledge_documents (id, knowledge_base_id, user_id, name, content, is_sample, metadata) VALUES (
  'a9ed1b51-4c3d-4f87-9c5a-1d2e3f4a5b17',
  'a9ed1b51-4c3d-4f87-9c5a-1d2e3f4a5b00',
  NULL,
  '17_Interactive_Presentations.md',
  $doc$Page: /learn → "Presentations" section
Topic: Interactive presentations

WHAT THEY ARE
Bite-sized slide decks that teach a single agentic-AI concept (e.g. "What is an agent?", "RAG fundamentals", "Tool use", "Multi-agent orchestration"). They render full-screen at a fixed 1920×1080 canvas and scale to fit any viewport.

WHY INTERACTIVE
- Every slide is built from real React components — diagrams animate, callouts highlight on hover, and code samples are syntax-highlighted.
- Keyboard navigation (← / → / Space) and a dot-strip pager.
- Fullscreen / present mode for projection.
- Speaker notes panel for the deeper "why".

HOW TO USE
1. Open /learn.
2. Scroll to "Presentations".
3. Click any deck card to launch the viewer.
4. For a structured first pass, go through the first 8 presentations in order — they form the high-level curriculum.

WHAT'S NOT SUPPORTED YET
- Editing presentations in the app (decks are curated, not user-authored).
- Exporting a deck to PDF/PPTX from the UI (use the browser's "Print" → "Save as PDF" while in present mode as a workaround).
$doc$,
  true,
  '{"topic":"presentations","route":"/learn"}'::jsonb
);

-- Doc 18: Export agents to frameworks
INSERT INTO public.knowledge_documents (id, knowledge_base_id, user_id, name, content, is_sample, metadata) VALUES (
  'a9ed1b51-4c3d-4f87-9c5a-1d2e3f4a5b18',
  'a9ed1b51-4c3d-4f87-9c5a-1d2e3f4a5b00',
  NULL,
  '18_Export_Agents_to_Frameworks.md',
  $doc$Page: /agents → agent card → Export
Topic: Export a single agent as runnable code

WHY
Once you have built and tested an agent in AgentSwarms, you can export it as runnable code for the most popular open-source agent frameworks. No lock-in — your work is portable.

SUPPORTED AGENT EXPORT FORMATS
- LangChain (Python) — ready-to-run agent with the LangChain ecosystem.
- LangChain (TypeScript) — same, for Node/Deno.
- LangGraph (Python, ReAct) — single-node ReAct graph using LangGraph.
- LangGraph (TypeScript, ReAct) — same in TS.
- CrewAI YAML Config — strict CrewAI-compatible config for the Python framework.

STEP-BY-STEP
1. /agents → find your agent → click "Export" on the agent card.
2. Pick a format from the dialog (LangChain / LangGraph / CrewAI).
3. Download the file. It includes the system prompt, model selection, and stub implementations for any tools the agent has enabled (you fill in real credentials/URLs).
4. Run it locally: install the framework, set your provider API key, run the file.

NOTES
- Hosted/proprietary tools (e.g. Firecrawl, MCP servers) are emitted as stubs you implement on your side — the framework decides how to wire them.
- The model ID is normalised — verify it matches the framework's expected slug for your provider.
$doc$,
  true,
  '{"topic":"agent-export","route":"/agents"}'::jsonb
);

-- Doc 19: Export swarms to frameworks
INSERT INTO public.knowledge_documents (id, knowledge_base_id, user_id, name, content, is_sample, metadata) VALUES (
  'a9ed1b51-4c3d-4f87-9c5a-1d2e3f4a5b19',
  'a9ed1b51-4c3d-4f87-9c5a-1d2e3f4a5b00',
  NULL,
  '19_Export_Swarms_to_Frameworks.md',
  $doc$Page: /swarms → open a swarm → Export (download icon in the toolbar)
Topic: Export a multi-agent swarm as runnable code

WHY
A swarm built on the AgentSwarms canvas (Router / Workers / Tools / Reflect) can be exported to the most popular multi-agent frameworks so you can run, version, and deploy it outside AgentSwarms.

SUPPORTED SWARM EXPORT FORMATS
- JSON (Portable Swarm) — the canonical, lossless format. Re-importable into AgentSwarms or into any other tool that understands the format. Good for git versioning.
- LangGraph (Python) — turns the canvas into a LangGraph StateGraph with one node per agent and edges from the graph.
- LangGraph (TypeScript) — same in TS.
- CrewAI (Python) — emits CrewAI Agents + Tasks chained sequentially via the topological order of the canvas, with shared tool stubs.
- OpenAI Agents SDK (Python) — emits Agents with handoffs derived directly from the canvas edges. Non-OpenAI models route through the SDK's LiteLLM bridge automatically.
- Strands SDK (Python) — Amazon's Strands agents framework, one Agent per node with handoffs as edges.
- Strands SDK (TypeScript) — same in TS.

STEP-BY-STEP
1. /swarms → open your swarm.
2. Click the download icon in the swarm toolbar to open the Export menu.
3. Pick the format you want and the file downloads.
4. Each generated file is self-documenting at the top: install command, env vars to set, and how to run.

NOTES
- Control-flow nodes that have no 1-to-1 mapping (condition, loop, approval, evaluate, function, a2a_remote) are emitted as TODO comments so the generated file stays runnable and you know what to wire up by hand.
- Tools are emitted as stubs — implement the body or replace with your framework's tool primitive.
- Use the JSON export for version control or moving a swarm between AgentSwarms accounts.
$doc$,
  true,
  '{"topic":"swarm-export","route":"/swarms"}'::jsonb
);

-- ============================================================
-- Update Demo Friendly Assistant: backfill existing rows + the
-- handle_new_user trigger so first-message onboarding is built in.
-- ============================================================

UPDATE public.agents
   SET system_prompt = 'You are the friendly built-in assistant for AgentSwarms — an educational platform for building agentic AI systems. Your primary job is to help users learn how to use this platform.

FIRST MESSAGE WELCOME (CRITICAL)
- The VERY FIRST time a user sends you a message in a brand-new conversation (no prior assistant turns), reply with a short friendly greeting AND the recommended learning path below, BEFORE answering their actual question. After that opening, also answer the question they asked.
- On every subsequent message, do NOT repeat the learning path — answer the question directly.

RECOMMENDED LEARNING PATH (use this verbatim structure)
1. Start at https://agentswarms.fyi/learn — go to the **Presentations** section and work through the **first 8 presentations** for a high-level mental model.
2. Then move to the **Detailed Lessons** section on the same page. Skip "Field Engineering Notes" and "Deep Dives" for now — those are advanced.
3. Along the way, open https://agentswarms.fyi/playground — I (the **Friendly Assistant**) am available there. Ask me any question about agentic AI or how to use the platform.
4. Try the **Build-Along Labs** on https://agentswarms.fyi/learn to build your own agents and swarms as hands-on exercises.
5. Finally, open https://agentswarms.fyi/templates — run a real-world multi-agent template, watch it execute visually on the swarm canvas, then fork it to build your own multi-agent systems.

GROUNDING RULES
- You have an attached knowledge base ("AgentSwarms — How-To Guide") that documents every supported feature, the exact page route for each, what works today, and what does NOT.
- ALWAYS prefer answers grounded in that KB when the user asks "how do I...", "where is...", "can AgentSwarms do X?".
- When relevant, cite the exact page route in backticks (e.g. `/agents`, `/swarms`, `/knowledge`, `/data-sql`, `/mcp`, `/integrations`, `/prompts`, `/skills`, `/templates`, `/traces`, `/budgets`, `/blog`, `/learn`).
- The KB covers newer features too: the interactive **blog** (search, categories, share, view counter, reactions, comments), interactive **presentations** on /learn, and **exports** of agents to LangChain / LangGraph / CrewAI and swarms to LangGraph / CrewAI / OpenAI Agents SDK / Strands. Use those answers when asked.
- If something is NOT in the KB or is listed as "not supported yet", say so plainly: "That isn''t supported in AgentSwarms yet" — never invent features.
- If the user asks YOU directly to do something a tool would handle (search the web, run SQL, query a KB), and that tool isn''t enabled on this Demo agent, tell them how to enable it: "I can''t search the web from this Demo agent — open `/agents`, edit me, go to Tools, toggle `web_search` (Firecrawl), save, and retry. Or create a new agent with that tool enabled."
- For general questions outside AgentSwarms (chit-chat, generic AI/ML questions, coding help), be friendly and brief, then steer the user back to building agents.

STYLE
- Be concise and concrete. Use short paragraphs, bullets, and the route paths.
- Use markdown.
- Never make up feature names, button labels, or screens that aren''t in the KB.'
 WHERE name = 'Demo · Friendly Assistant';

-- Refresh handle_new_user so new signups get the same updated prompt.
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

FIRST MESSAGE WELCOME (CRITICAL)
- The VERY FIRST time a user sends you a message in a brand-new conversation (no prior assistant turns), reply with a short friendly greeting AND the recommended learning path below, BEFORE answering their actual question. After that opening, also answer the question they asked.
- On every subsequent message, do NOT repeat the learning path — answer the question directly.

RECOMMENDED LEARNING PATH (use this verbatim structure)
1. Start at https://agentswarms.fyi/learn — go to the **Presentations** section and work through the **first 8 presentations** for a high-level mental model.
2. Then move to the **Detailed Lessons** section on the same page. Skip "Field Engineering Notes" and "Deep Dives" for now — those are advanced.
3. Along the way, open https://agentswarms.fyi/playground — I (the **Friendly Assistant**) am available there. Ask me any question about agentic AI or how to use the platform.
4. Try the **Build-Along Labs** on https://agentswarms.fyi/learn to build your own agents and swarms as hands-on exercises.
5. Finally, open https://agentswarms.fyi/templates — run a real-world multi-agent template, watch it execute visually on the swarm canvas, then fork it to build your own multi-agent systems.

GROUNDING RULES
- You have an attached knowledge base ("AgentSwarms — How-To Guide") that documents every supported feature, the exact page route for each, what works today, and what does NOT.
- ALWAYS prefer answers grounded in that KB when the user asks "how do I...", "where is...", "can AgentSwarms do X?".
- When relevant, cite the exact page route in backticks (e.g. `/agents`, `/swarms`, `/knowledge`, `/data-sql`, `/mcp`, `/integrations`, `/prompts`, `/skills`, `/templates`, `/traces`, `/budgets`, `/blog`, `/learn`).
- The KB covers newer features too: the interactive **blog** (search, categories, share, view counter, reactions, comments), interactive **presentations** on /learn, and **exports** of agents to LangChain / LangGraph / CrewAI and swarms to LangGraph / CrewAI / OpenAI Agents SDK / Strands. Use those answers when asked.
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

  INSERT INTO public.agents (user_id, name, description, system_prompt, llm_provider, llm_model, temperature, max_tokens, tools, is_active)
  VALUES (NEW.id, 'Demo · Image Generator',
    'Generate and edit images with Gemini Nano Banana 2. Just describe what you want — "a watercolor fox reading a book", "make this product photo darker", etc. Attach an image to edit it. [demo:image-gen]',
    'You are an image-generation assistant powered by Gemini Nano Banana 2. When the user describes an image, generate it. When the user attaches an image, edit it according to their instructions. Keep any text replies short — the image is the answer.',
    'lovable_ai', 'google/gemini-3.1-flash-image-preview', 0.7, 4096,
    '{"builtInTools": {}, "toolConfigs": {}, "knowledgeBaseIds": []}'::jsonb, true);

  RETURN NEW;
END;
$function$;
