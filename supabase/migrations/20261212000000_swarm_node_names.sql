-- The names inside a swarm's graph: each node's name, and each start-form
-- field's name and label on its input node.
--
-- None of them had a rule. The canvas's inspector wrote whatever its fields
-- held, so a node could be named '' or '   ' (a blank title on the canvas, a
-- nameless step in the run's timeline, "Approve step: " on its approval) or be
-- any length; and a start-form field could have no name, or the same name as
-- another field. A run stores a field's value under the field's name, so an
-- unnamed field's value went where no prompt could read it, and two fields of
-- one name shared one value in the Run panel.
--
-- The inspector now applies the rules as you type (src/lib/swarmNames.ts), but
-- the browser writes a swarm's graph straight to its row under the owner's
-- FOR ALL policy, so a client can skip the inspector: the table has to hold
-- the same rules. swarmNodesProblem() in that file is this function in
-- TypeScript, and repairSwarmNodes() is the repair below.
--
-- A node is an element of `nodes` whose `data` is an object (anything else is
-- not a node the canvas can show, and is left alone). Its rules:
--   data.label            a string of 1 to 120 characters, something visible
-- A start-form field is an object in the node's data.inputFields. Its rules:
--   name                  letters, digits and _, 1 to 64 characters, and no
--                         other field of the same node has it
--   label                 absent, null, '', or a string of 1 to 120
--                         characters with something visible in it
-- `~ '\S'` rather than btrim(x) <> '', as in 20261129000000: btrim removes
-- only spaces, so a name of tabs or newlines would pass it.

CREATE OR REPLACE FUNCTION public.swarm_nodes_named(p_nodes jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT jsonb_typeof(p_nodes) IS DISTINCT FROM 'array' OR NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_nodes) AS n(node)
    WHERE jsonb_typeof(n.node -> 'data') = 'object'
      AND (
        -- The node's name.
        jsonb_typeof(n.node -> 'data' -> 'label') IS DISTINCT FROM 'string'
        OR (n.node -> 'data' ->> 'label') !~ '\S'
        OR char_length(n.node -> 'data' ->> 'label') > 120
        -- Its start-form fields.
        OR (
          jsonb_typeof(n.node -> 'data' -> 'inputFields') = 'array'
          AND (
            EXISTS (
              SELECT 1
              FROM jsonb_array_elements(n.node -> 'data' -> 'inputFields') AS f(field)
              WHERE jsonb_typeof(f.field) = 'object'
                AND (
                  jsonb_typeof(f.field -> 'name') IS DISTINCT FROM 'string'
                  OR (f.field ->> 'name') !~ '^[A-Za-z0-9_]{1,64}$'
                  OR (
                    coalesce(jsonb_typeof(f.field -> 'label'), 'null') <> 'null'
                    AND (f.field -> 'label') <> '""'::jsonb
                    AND (
                      jsonb_typeof(f.field -> 'label') <> 'string'
                      OR (f.field ->> 'label') !~ '\S'
                      OR char_length(f.field ->> 'label') > 120
                    )
                  )
                )
            )
            OR EXISTS (
              SELECT 1
              FROM jsonb_array_elements(n.node -> 'data' -> 'inputFields') AS f(field)
              WHERE jsonb_typeof(f.field) = 'object'
              GROUP BY f.field ->> 'name'
              HAVING count(*) > 1
            )
          )
        )
      )
  )
$$;

-- The check runs as whoever writes the row: the browser (authenticated) and
-- the server (service_role).
GRANT EXECUTE ON FUNCTION public.swarm_nodes_named(jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.swarm_nodes_named(jsonb) IS
  'True when every node of a swarm graph has a name, and every start-form field a unique name (see 20261212000000_swarm_node_names.sql).';

-- Repair stored graphs first, so the constraint can be validated rather than
-- added NOT VALID: a NOT VALID check still applies to every later UPDATE of an
-- old row, so a swarm with an old blank node name could no longer be saved,
-- deployed or run (each writes the row) until someone found and fixed it.
-- The repair changes names only, and only those that break a rule:
--   a node's blank name         'Untitled'
--   a node's long name          cut to 120 ('Untitled' if what is left is blank)
--   a field's name              its letters, digits and _, cut to 64; 'field_N'
--                               (N its position) when nothing is left, and
--                               '<name>_2', '_3'... when an earlier field has it
--   a field's blank label       removed (a field with no label shows its name)
--   a field's long label        cut to 120 (removed if what is left is blank)
-- It is a session-only function: it is needed once, here.
CREATE OR REPLACE FUNCTION pg_temp.repair_swarm_nodes(p_nodes jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_out jsonb := '[]'::jsonb;
  v_node jsonb;
  v_data jsonb;
  v_label text;
  v_fields jsonb;
  v_field jsonb;
  v_names text[];
  v_taken text[];
  v_name text;
  v_base text;
  v_n int;
  v_i int;
BEGIN
  IF jsonb_typeof(p_nodes) IS DISTINCT FROM 'array' THEN
    RETURN p_nodes;
  END IF;
  FOR v_node IN SELECT value FROM jsonb_array_elements(p_nodes) LOOP
    IF jsonb_typeof(v_node -> 'data') IS DISTINCT FROM 'object' THEN
      v_out := v_out || jsonb_build_array(v_node);
      CONTINUE;
    END IF;
    v_data := v_node -> 'data';

    -- The node's name.
    v_label := CASE
      WHEN jsonb_typeof(v_data -> 'label') = 'string' THEN left(v_data ->> 'label', 120)
    END;
    IF v_label IS NULL OR v_label !~ '\S' THEN
      v_label := 'Untitled';
    END IF;
    v_data := jsonb_set(v_data, '{label}', to_jsonb(v_label));

    -- Its start-form fields.
    IF jsonb_typeof(v_data -> 'inputFields') = 'array' THEN
      SELECT coalesce(array_agg(
               CASE WHEN jsonb_typeof(value -> 'name') = 'string'
                 THEN left(regexp_replace(value ->> 'name', '[^A-Za-z0-9_]', '', 'g'), 64)
                 ELSE '' END
               ORDER BY ord), '{}')
        INTO v_names
        FROM jsonb_array_elements(v_data -> 'inputFields') WITH ORDINALITY AS t(value, ord);
      v_taken := '{}';
      v_fields := '[]'::jsonb;
      v_i := 0;
      FOR v_field IN SELECT value FROM jsonb_array_elements(v_data -> 'inputFields') LOOP
        v_i := v_i + 1;
        IF jsonb_typeof(v_field) IS DISTINCT FROM 'object' THEN
          v_fields := v_fields || jsonb_build_array(v_field);
          CONTINUE;
        END IF;
        v_name := v_names[v_i];
        IF v_name = '' OR v_name = ANY (v_taken) THEN
          v_base := CASE WHEN v_name = '' THEN 'field' ELSE left(v_name, 60) END;
          v_n := CASE WHEN v_name = '' THEN v_i ELSE 2 END;
          WHILE (v_base || '_' || v_n) = ANY (v_taken) OR (v_base || '_' || v_n) = ANY (v_names) LOOP
            v_n := v_n + 1;
          END LOOP;
          v_name := v_base || '_' || v_n;
        END IF;
        v_taken := v_taken || v_name;
        v_field := jsonb_set(v_field, '{name}', to_jsonb(v_name));

        IF coalesce(jsonb_typeof(v_field -> 'label'), 'null') <> 'null'
           AND (v_field -> 'label') <> '""'::jsonb THEN
          v_label := CASE
            WHEN jsonb_typeof(v_field -> 'label') = 'string' THEN left(v_field ->> 'label', 120)
          END;
          IF v_label IS NULL OR v_label !~ '\S' THEN
            v_field := v_field - 'label';
          ELSE
            v_field := jsonb_set(v_field, '{label}', to_jsonb(v_label));
          END IF;
        END IF;
        v_fields := v_fields || jsonb_build_array(v_field);
      END LOOP;
      v_data := jsonb_set(v_data, '{inputFields}', v_fields);
    END IF;

    v_out := v_out || jsonb_build_array(jsonb_set(v_node, '{data}', v_data));
  END LOOP;
  RETURN v_out;
END;
$$;

UPDATE public.swarms
SET nodes = pg_temp.repair_swarm_nodes(nodes)
WHERE NOT public.swarm_nodes_named(nodes);

ALTER TABLE public.swarms DROP CONSTRAINT IF EXISTS swarms_nodes_named;
ALTER TABLE public.swarms
  ADD CONSTRAINT swarms_nodes_named CHECK (public.swarm_nodes_named(nodes));
