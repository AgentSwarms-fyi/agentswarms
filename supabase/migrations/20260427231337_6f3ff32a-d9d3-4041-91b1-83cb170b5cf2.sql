-- Update the new-user handler to also seed a starter "Demo · Friendly Assistant"
-- agent so users land in the Playground with something to chat with immediately.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  INSERT INTO public.profiles (user_id, display_name)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email));

  -- Seed a starter demo agent using the AgentSwarms AI gateway (no API key
  -- required from the user). The "[demo:starter]" tag lets us detect/upgrade
  -- it later without creating duplicates.
  INSERT INTO public.agents (
    user_id, name, description, system_prompt,
    llm_provider, llm_model, temperature, max_tokens,
    tools, is_active
  ) VALUES (
    NEW.id,
    'Demo · Friendly Assistant',
    'A ready-to-chat starter agent powered by AgentSwarms AI. Open the Playground and say hi. [demo:starter]',
    'You are a friendly, concise AI assistant built on the AgentSwarms platform. Help the user explore what agents can do: answer questions, brainstorm, summarise, draft text, and explain agentic AI concepts. Keep responses clear and practical. If the user is new, suggest things they could try (e.g. "ask me to draft an email", "explain RAG in 2 lines", "give me 5 ideas for a side project").',
    'lovable_ai',
    'google/gemini-3-flash-preview',
    0.7,
    4096,
    '{"builtInTools": {}, "toolConfigs": {}, "knowledgeBaseIds": []}'::jsonb,
    true
  );

  RETURN NEW;
END;
$function$;

-- Backfill: give every existing user the same starter agent if they don't
-- already have one tagged [demo:starter].
INSERT INTO public.agents (
  user_id, name, description, system_prompt,
  llm_provider, llm_model, temperature, max_tokens,
  tools, is_active
)
SELECT
  u.id,
  'Demo · Friendly Assistant',
  'A ready-to-chat starter agent powered by AgentSwarms AI. Open the Playground and say hi. [demo:starter]',
  'You are a friendly, concise AI assistant built on the AgentSwarms platform. Help the user explore what agents can do: answer questions, brainstorm, summarise, draft text, and explain agentic AI concepts. Keep responses clear and practical. If the user is new, suggest things they could try (e.g. "ask me to draft an email", "explain RAG in 2 lines", "give me 5 ideas for a side project").',
  'lovable_ai',
  'google/gemini-3-flash-preview',
  0.7,
  4096,
  '{"builtInTools": {}, "toolConfigs": {}, "knowledgeBaseIds": []}'::jsonb,
  true
FROM auth.users u
WHERE NOT EXISTS (
  SELECT 1 FROM public.agents a
  WHERE a.user_id = u.id
    AND a.description LIKE '%[demo:starter]%'
);