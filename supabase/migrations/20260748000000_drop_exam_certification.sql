-- Remove the exam / certification feature.
--
-- AgentSwarms is an agent + BI platform; the exam question sets, attempts and
-- issued certificates were leftovers from an unrelated product. Nothing in the
-- app referenced them any more except a public /verify/<code> page and an
-- LLM-backed generator hook that was reachable with the (public) anon key —
-- i.e. an unauthenticated way to spend the operator's OpenRouter credits.
--
-- Dropping in dependency order; CASCADE also removes the RLS policies,
-- indexes and triggers attached to each table.
DROP TABLE IF EXISTS public.certificates CASCADE;
DROP TABLE IF EXISTS public.exam_attempts CASCADE;
DROP TABLE IF EXISTS public.exam_question_sets CASCADE;
