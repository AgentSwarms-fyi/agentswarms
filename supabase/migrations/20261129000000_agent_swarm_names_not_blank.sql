-- An agent's and a swarm's name must have something a person can see.
--
-- NOT NULL stops a missing name, not one made only of spaces. The agent form
-- and the swarm canvas saved such names on create and on update, and they
-- then showed as blank rows in every list, picker and trash toast. The forms
-- now refuse them (src/lib/visibleName.ts), but both tables are written
-- straight from the browser under each owner's FOR ALL policy, so a client
-- can skip the form: the database has to hold the same rule.
--
-- `name ~ '\S'` (at least one non-whitespace character) rather than
-- btrim(name) <> '': btrim removes only spaces, so a name of tabs or newlines
-- would pass it.

-- Repair rows that already have a blank name first, so the constraints can be
-- validated rather than added NOT VALID: a NOT VALID check still applies to
-- every later UPDATE of an old row, so a blank-named swarm could no longer be
-- deployed, scheduled or run (each writes the row) until someone renamed it.
UPDATE public.agents SET name = 'Untitled agent' WHERE name !~ '\S';
UPDATE public.swarms SET name = 'Untitled Swarm' WHERE name !~ '\S';

ALTER TABLE public.agents DROP CONSTRAINT IF EXISTS agents_name_not_blank;
ALTER TABLE public.agents ADD CONSTRAINT agents_name_not_blank CHECK (name ~ '\S');

ALTER TABLE public.swarms DROP CONSTRAINT IF EXISTS swarms_name_not_blank;
ALTER TABLE public.swarms ADD CONSTRAINT swarms_name_not_blank CHECK (name ~ '\S');
