-- Agent, swarm and knowledge-base names: at most 120 characters.
--
-- Nothing bounded them: the forms took any length (hundreds of characters ran
-- the Agent Chat picker off the screen), and all three tables are written
-- straight from the browser under each owner's FOR ALL policy, so a client
-- could store a name of any size and every list and picker would load it.
-- 120 is the limit the other named objects already have (bi_dashboards,
-- bi_reports, workflows, data_monitors, ai_analysts). The forms now enforce
-- the same number (src/lib/visibleName.ts); char_length counts characters,
-- as the forms do, so an emoji is one.
--
-- Knowledge bases also get the not-blank rule agents and swarms got in
-- 20261129000000: their form refused a blank name, the table did not.

-- Existing names are fixed first, so the constraints can be validated rather
-- than added NOT VALID (a NOT VALID check still applies to every later UPDATE
-- of an old row, so a long-named knowledge base could no longer be re-indexed
-- and a long-named swarm no longer deployed). A long name is cut to 120; if
-- what is left is blank (a name that began with 120 spaces), it gets the same
-- placeholder a blank name gets.
UPDATE public.agents
SET name = CASE WHEN left(name, 120) ~ '\S' THEN left(name, 120) ELSE 'Untitled agent' END
WHERE char_length(name) > 120;

UPDATE public.swarms
SET name = CASE WHEN left(name, 120) ~ '\S' THEN left(name, 120) ELSE 'Untitled Swarm' END
WHERE char_length(name) > 120;

UPDATE public.knowledge_bases
SET name = CASE
  WHEN left(name, 120) ~ '\S' THEN left(name, 120)
  ELSE 'Untitled knowledge base'
END
WHERE char_length(name) > 120 OR name !~ '\S';

ALTER TABLE public.agents DROP CONSTRAINT IF EXISTS agents_name_max_length;
ALTER TABLE public.agents
  ADD CONSTRAINT agents_name_max_length CHECK (char_length(name) <= 120);

ALTER TABLE public.swarms DROP CONSTRAINT IF EXISTS swarms_name_max_length;
ALTER TABLE public.swarms
  ADD CONSTRAINT swarms_name_max_length CHECK (char_length(name) <= 120);

ALTER TABLE public.knowledge_bases DROP CONSTRAINT IF EXISTS knowledge_bases_name_max_length;
ALTER TABLE public.knowledge_bases
  ADD CONSTRAINT knowledge_bases_name_max_length CHECK (char_length(name) <= 120);

ALTER TABLE public.knowledge_bases DROP CONSTRAINT IF EXISTS knowledge_bases_name_not_blank;
ALTER TABLE public.knowledge_bases
  ADD CONSTRAINT knowledge_bases_name_not_blank CHECK (name ~ '\S');
