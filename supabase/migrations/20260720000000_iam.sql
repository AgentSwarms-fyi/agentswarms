-- Identity & Access Management for the self-hosted build.
--
-- Adds: DB-backed superadmin role (bootstrapped by ADMIN_EMAIL app-side),
-- groups + memberships, per-user/group model allow-rules, read-only resource
-- grants for knowledge bases and SQL data tables, and an instance settings
-- row with an invite-only (disable public signup) switch enforced in the
-- signup trigger.
--
-- Model-rule semantics (enforced app-side in /api/chat): a user with ZERO
-- applicable rules is unrestricted; otherwise their allowed set is the UNION
-- of their own rules and all their groups' rules.

-- ── Tables ───────────────────────────────────────────────────────────────────

CREATE TABLE public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role = 'superadmin'),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);

CREATE TABLE public.iam_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  description text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.iam_group_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES public.iam_groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  added_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (group_id, user_id)
);
CREATE INDEX idx_iam_group_members_user ON public.iam_group_members(user_id);

CREATE TABLE public.iam_model_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_type text NOT NULL CHECK (principal_type IN ('user', 'group')),
  principal_id uuid NOT NULL,
  provider text NOT NULL,
  -- '*' = every model of the provider; 'openai/*' = prefix glob; else exact id.
  model_pattern text NOT NULL DEFAULT '*',
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (principal_type, principal_id, provider, model_pattern)
);
CREATE INDEX idx_iam_model_rules_principal ON public.iam_model_rules(principal_type, principal_id);

CREATE TABLE public.iam_resource_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_type text NOT NULL CHECK (resource_type IN ('knowledge_base', 'data_table')),
  resource_id uuid NOT NULL,
  principal_type text NOT NULL CHECK (principal_type IN ('user', 'group')),
  principal_id uuid NOT NULL,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (resource_type, resource_id, principal_type, principal_id)
);
CREATE INDEX idx_iam_resource_grants_resource ON public.iam_resource_grants(resource_type, resource_id);
CREATE INDEX idx_iam_resource_grants_principal ON public.iam_resource_grants(principal_type, principal_id);

-- Single-row settings table (id is always true).
CREATE TABLE public.iam_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  allow_public_signup boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.iam_settings (id) VALUES (true);

-- ── Helper functions ─────────────────────────────────────────────────────────
-- SECURITY DEFINER so they can be used inside RLS policies without recursion:
-- they read the IAM tables directly, bypassing those tables' own policies.

CREATE OR REPLACE FUNCTION public.is_superadmin(uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = uid AND role = 'superadmin'
  );
$$;

CREATE OR REPLACE FUNCTION public.has_resource_access(rtype text, rid uuid, uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.iam_resource_grants g
    WHERE g.resource_type = rtype
      AND g.resource_id = rid
      AND (
        (g.principal_type = 'user' AND g.principal_id = uid)
        OR (
          g.principal_type = 'group'
          AND g.principal_id IN (
            SELECT m.group_id FROM public.iam_group_members m WHERE m.user_id = uid
          )
        )
      )
  );
$$;

-- ── RLS on the IAM tables ────────────────────────────────────────────────────

ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own roles"
  ON public.user_roles FOR SELECT
  USING (auth.uid() = user_id OR public.is_superadmin(auth.uid()));
CREATE POLICY "Superadmins manage roles"
  ON public.user_roles FOR ALL
  USING (public.is_superadmin(auth.uid()))
  WITH CHECK (public.is_superadmin(auth.uid()));

ALTER TABLE public.iam_groups ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Members and superadmins can view groups"
  ON public.iam_groups FOR SELECT
  USING (
    public.is_superadmin(auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.iam_group_members m
      WHERE m.group_id = id AND m.user_id = auth.uid()
    )
  );
CREATE POLICY "Superadmins manage groups"
  ON public.iam_groups FOR ALL
  USING (public.is_superadmin(auth.uid()))
  WITH CHECK (public.is_superadmin(auth.uid()));

ALTER TABLE public.iam_group_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own memberships"
  ON public.iam_group_members FOR SELECT
  USING (auth.uid() = user_id OR public.is_superadmin(auth.uid()));
CREATE POLICY "Superadmins manage memberships"
  ON public.iam_group_members FOR ALL
  USING (public.is_superadmin(auth.uid()))
  WITH CHECK (public.is_superadmin(auth.uid()));

ALTER TABLE public.iam_model_rules ENABLE ROW LEVEL SECURITY;
-- Users can read rules that apply to them so the client can filter model pickers.
CREATE POLICY "Users can view applicable model rules"
  ON public.iam_model_rules FOR SELECT
  USING (
    public.is_superadmin(auth.uid())
    OR (principal_type = 'user' AND principal_id = auth.uid())
    OR (
      principal_type = 'group'
      AND principal_id IN (
        SELECT m.group_id FROM public.iam_group_members m WHERE m.user_id = auth.uid()
      )
    )
  );
CREATE POLICY "Superadmins manage model rules"
  ON public.iam_model_rules FOR ALL
  USING (public.is_superadmin(auth.uid()))
  WITH CHECK (public.is_superadmin(auth.uid()));

ALTER TABLE public.iam_resource_grants ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view applicable grants"
  ON public.iam_resource_grants FOR SELECT
  USING (
    public.is_superadmin(auth.uid())
    OR (principal_type = 'user' AND principal_id = auth.uid())
    OR (
      principal_type = 'group'
      AND principal_id IN (
        SELECT m.group_id FROM public.iam_group_members m WHERE m.user_id = auth.uid()
      )
    )
  );
CREATE POLICY "Superadmins manage grants"
  ON public.iam_resource_grants FOR ALL
  USING (public.is_superadmin(auth.uid()))
  WITH CHECK (public.is_superadmin(auth.uid()));

ALTER TABLE public.iam_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can read settings"
  ON public.iam_settings FOR SELECT
  TO authenticated
  USING (true);
CREATE POLICY "Superadmins update settings"
  ON public.iam_settings FOR UPDATE
  USING (public.is_superadmin(auth.uid()))
  WITH CHECK (public.is_superadmin(auth.uid()));

-- ── Read-only sharing: widened SELECT policies on shareable resources ────────
-- Additional permissive policies (OR'd with the existing owner-only ones).
-- Write policies are untouched, so shared access is read-only by construction.

CREATE POLICY "Shared knowledge bases are readable"
  ON public.knowledge_bases FOR SELECT
  USING (public.has_resource_access('knowledge_base', id, auth.uid()));

CREATE POLICY "Shared KB documents are readable"
  ON public.knowledge_documents FOR SELECT
  USING (public.has_resource_access('knowledge_base', knowledge_base_id, auth.uid()));

CREATE POLICY "Shared KB sources are readable"
  ON public.kb_sources FOR SELECT
  USING (public.has_resource_access('knowledge_base', knowledge_base_id, auth.uid()));

CREATE POLICY "Shared KB chunks are readable"
  ON public.kb_chunks FOR SELECT
  USING (public.has_resource_access('knowledge_base', knowledge_base_id, auth.uid()));

CREATE POLICY "Shared KB graph entities are readable"
  ON public.kb_graph_entities FOR SELECT
  USING (public.has_resource_access('knowledge_base', knowledge_base_id, auth.uid()));

CREATE POLICY "Shared KB graph relations are readable"
  ON public.kb_graph_relations FOR SELECT
  USING (public.has_resource_access('knowledge_base', knowledge_base_id, auth.uid()));
-- kb_graph_mentions inherits via its "read mentions if entity readable" policy.

CREATE POLICY "Shared data tables are readable"
  ON public.user_data_tables FOR SELECT
  USING (public.has_resource_access('data_table', id, auth.uid()));

CREATE POLICY "Shared data rows are readable"
  ON public.user_data_rows FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.user_data_tables t
      WHERE t.id = table_id
        AND public.has_resource_access('data_table', t.id, auth.uid())
    )
  );

-- ── Signup gate: invite-only mode ────────────────────────────────────────────
-- Same body as 20260719000000_fix_new_user_seed_provider.sql, with a guard
-- prepended: when public signup is disabled, only invited users (invited_at
-- set by auth.admin.inviteUserByEmail) and admin-provisioned users
-- (app_metadata.provisioned_by = 'admin' set by auth.admin.createUser) may
-- register.

CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF (SELECT NOT allow_public_signup FROM public.iam_settings LIMIT 1)
     AND NEW.invited_at IS NULL
     AND COALESCE(NEW.raw_app_meta_data->>'provisioned_by', '') <> 'admin'
  THEN
    RAISE EXCEPTION 'signups_disabled';
  END IF;

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
