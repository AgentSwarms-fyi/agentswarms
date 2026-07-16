
-- Backfill: add a "Demo · Image Generator" agent for every existing user
-- who doesn't already have one. Uses the Gemini Nano Banana 2 image model
-- which the chat route routes through the image-generation code path.
INSERT INTO public.agents
  (user_id, name, description, system_prompt, llm_provider, llm_model, temperature, max_tokens, tools, is_active)
SELECT
  u.id,
  'Demo · Image Generator',
  'Generate and edit images with Gemini Nano Banana 2. Just describe what you want — "a watercolor fox reading a book", "make this product photo darker", etc. Attach an image to edit it. [demo:image-gen]',
  'You are an image-generation assistant powered by Gemini Nano Banana 2. When the user describes an image, generate it. When the user attaches an image, edit it according to their instructions. Keep any text replies short — the image is the answer.',
  'lovable_ai',
  'google/gemini-3.1-flash-image-preview',
  0.7,
  4096,
  '{"builtInTools": {}, "toolConfigs": {}, "knowledgeBaseIds": []}'::jsonb,
  true
FROM auth.users u
WHERE NOT EXISTS (
  SELECT 1 FROM public.agents a
  WHERE a.user_id = u.id AND a.name = 'Demo · Image Generator'
);

-- Update handle_new_user so future signups also receive the image agent.
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

  INSERT INTO public.agents (user_id, name, description, system_prompt, llm_provider, llm_model, temperature, max_tokens, tools, is_active)
  VALUES (NEW.id, 'Demo · Image Generator',
    'Generate and edit images with Gemini Nano Banana 2. Just describe what you want — "a watercolor fox reading a book", "make this product photo darker", etc. Attach an image to edit it. [demo:image-gen]',
    'You are an image-generation assistant powered by Gemini Nano Banana 2. When the user describes an image, generate it. When the user attaches an image, edit it according to their instructions. Keep any text replies short — the image is the answer.',
    'lovable_ai', 'google/gemini-3.1-flash-image-preview', 0.7, 4096,
    '{"builtInTools": {}, "toolConfigs": {}, "knowledgeBaseIds": []}'::jsonb, true);

  RETURN NEW;
END;
$function$;
