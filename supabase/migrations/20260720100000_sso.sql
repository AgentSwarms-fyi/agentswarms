-- Enterprise single sign-on (SAML: Okta, Auth0, Azure AD, …).
--
-- Identity providers themselves are registered in GoTrue via its admin API
-- (superadmin-gated server functions call /auth/v1/admin/sso/providers), so
-- the database only carries the instance-level switches:
--   sso_enabled  — show "Continue with single sign-on" on the login page
--   sso_enforced — hide native email/password + social login (SSO-only)
--
-- Also reworks the invite-only signup gate: users provisioned through SSO
-- (GoTrue sets app_metadata.provider = 'sso:<provider-id>') must be allowed
-- in even when public signup is disabled. The gate moves out of
-- handle_new_user() into its own BEFORE INSERT trigger so signup policy and
-- demo-content seeding evolve independently.

ALTER TABLE public.iam_settings
  ADD COLUMN sso_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN sso_enforced boolean NOT NULL DEFAULT false;

-- ── Signup policy gate (BEFORE INSERT) ───────────────────────────────────────

CREATE OR REPLACE FUNCTION public.iam_enforce_signup_policy()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF (SELECT NOT allow_public_signup FROM public.iam_settings LIMIT 1)
     AND NEW.invited_at IS NULL
     AND COALESCE(NEW.raw_app_meta_data->>'provisioned_by', '') <> 'admin'
     AND COALESCE(NEW.raw_app_meta_data->>'provider', '') NOT LIKE 'sso:%'
  THEN
    RAISE EXCEPTION 'signups_disabled';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS on_auth_user_created_policy ON auth.users;
CREATE TRIGGER on_auth_user_created_policy
  BEFORE INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.iam_enforce_signup_policy();

-- ── handle_new_user: back to profile + demo-agent seeding only ───────────────
-- (Same body as 20260719000000_fix_new_user_seed_provider.sql; the signup
-- gate added in 20260720000000_iam.sql now lives in the trigger above.)

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
    'openrouter', 'openai/gpt-4o-mini', 0.5, 4096,
    '{"builtInTools": {}, "toolConfigs": {}, "knowledgeBaseIds": ["a9ed1b51-4c3d-4f87-9c5a-1d2e3f4a5b00"]}'::jsonb,
    true,
    'a9ed1b51-4c3d-4f87-9c5a-1d2e3f4a5b00');

  INSERT INTO public.agents (user_id, name, description, system_prompt, llm_provider, llm_model, temperature, max_tokens, tools, is_active)
  VALUES (NEW.id, 'Sample · SQL Reviewer',
    'Reviews SQL for safety + performance. Demonstrates a single focused Skill driving the whole behaviour. [skill-sample:sql-reviewer]',
    'You are a senior database engineer. Be concise and direct. Stay strictly within SQL review — politely refuse unrelated tasks.',
    'openrouter', 'openai/gpt-4o-mini', 0.2, 4096,
    '{"builtInTools": {}, "toolConfigs": {}, "knowledgeBaseIds": [], "skillIds": ["sample:sql-analyst"], "skillTourId": "sql-reviewer"}'::jsonb, true);

  INSERT INTO public.agents (user_id, name, description, system_prompt, llm_provider, llm_model, temperature, max_tokens, tools, is_active)
  VALUES (NEW.id, 'Sample · Support Agent (with Tone + Refusal)',
    'A friendly support assistant. Demonstrates stacking multiple Skills (tone + refusal policy + JSON discipline). [skill-sample:support-agent]',
    'You are a customer support assistant for AgentSwarms. Help users understand the product. Never invent features. If you don''t know, say so.',
    'openrouter', 'openai/gpt-4o-mini', 0.4, 4096,
    '{"builtInTools": {}, "toolConfigs": {}, "knowledgeBaseIds": [], "skillIds": ["sample:support-tone", "sample:json-only"], "skillTourId": "support-agent"}'::jsonb, true);

  INSERT INTO public.agents (user_id, name, description, system_prompt, llm_provider, llm_model, temperature, max_tokens, tools, is_active)
  VALUES (NEW.id, 'Sample · Research Synthesizer',
    'Summarises sources into a structured brief. Demonstrates a Skill that enforces an output format. [skill-sample:research-synth]',
    'You are a careful research assistant. Synthesize information accurately. If you don''t have enough information to answer, say so explicitly.',
    'openrouter', 'openai/gpt-4o-mini', 0.3, 4096,
    '{"builtInTools": {}, "toolConfigs": {}, "knowledgeBaseIds": [], "skillIds": ["sample:research-synthesizer", "sample:step-by-step-debugger"], "skillTourId": "research-synth"}'::jsonb, true);

  INSERT INTO public.agents (user_id, name, description, system_prompt, llm_provider, llm_model, temperature, max_tokens, tools, is_active)
  VALUES (NEW.id, 'Demo · Image Generator',
    'Generate and edit images with Gemini Nano Banana 2. Just describe what you want — "a watercolor fox reading a book", "make this product photo darker", etc. Attach an image to edit it. [demo:image-gen]',
    'You are an image-generation assistant powered by Gemini Nano Banana 2. When the user describes an image, generate it. When the user attaches an image, edit it according to their instructions. Keep any text replies short — the image is the answer.',
    'openrouter', 'google/gemini-2.5-flash-image', 0.7, 4096,
    '{"builtInTools": {}, "toolConfigs": {}, "knowledgeBaseIds": []}'::jsonb, true);

  RETURN NEW;
END;
$function$;
