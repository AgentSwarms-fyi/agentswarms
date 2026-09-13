-- Which schemas a user may read, in ONE round trip instead of N + 1.
--
-- FOUND BY MEASURING THE FEATURE STORE. Every governed lakehouse statement
-- calls accessibleSchemas before it does anything else, and that function read
-- every schema and then asked `has_resource_access` about each one it did not
-- own — one RPC per foreign schema, sequentially, in the application.
--
-- Against a HOSTED database that is not a detail. Measured from inside the app
-- container, a round trip to Supabase is 85 ms at the median. A deployment
-- where nobody shares anything pays one of those per statement, which is most
-- of the 127 ms floor every lakehouse read was measured to have. A deployment
-- with twenty shared schemas pays twenty-one, sequentially, before the query
-- starts: about 1.8 seconds on every read in the product, including the ones
-- behind a live prediction.
--
-- It is a cliff rather than a slope, and it is invisible on the deployment of
-- the person who writes the code, because they own all their own schemas.
--
-- THE RULE IS NOT REIMPLEMENTED HERE. This calls has_resource_access, the same
-- function the loop called, once per row inside one statement. Copying its
-- predicate into a join would have been faster to write and would have created
-- a second definition of who may read what — and the two would diverge on the
-- first change to grants, silently, in the permissive direction.
CREATE OR REPLACE FUNCTION public.accessible_lakehouse_schemas(uid uuid)
RETURNS SETOF public.lakehouse_schemas
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT s.*
    FROM public.lakehouse_schemas s
   WHERE s.user_id = uid
      OR public.has_resource_access('lakehouse_schema', s.id, uid)
   ORDER BY s.name;
$$;

COMMENT ON FUNCTION public.accessible_lakehouse_schemas(uuid) IS
  'Schemas the user owns or has been granted, ordered by name. One statement rather than one round trip per foreign schema; the grant rule itself stays in has_resource_access.';

-- SECURITY DEFINER with a uid ARGUMENT is a function that will answer about
-- anybody, so it must not be reachable by anybody. The app calls it with the
-- service role, exactly as it called has_resource_access.
REVOKE ALL ON FUNCTION public.accessible_lakehouse_schemas(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.accessible_lakehouse_schemas(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.accessible_lakehouse_schemas(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.accessible_lakehouse_schemas(uuid) TO service_role;
