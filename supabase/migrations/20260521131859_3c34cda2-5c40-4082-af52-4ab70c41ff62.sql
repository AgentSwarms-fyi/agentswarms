CREATE OR REPLACE FUNCTION public.prune_deleted_mcp_server_refs()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.agents AS a
  SET tools = jsonb_set(
    a.tools,
    '{mcpServerNames}',
    COALESCE((
      SELECT jsonb_agg(to_jsonb(server_name))
      FROM jsonb_array_elements_text(COALESCE(a.tools->'mcpServerNames', '[]'::jsonb)) AS selected(server_name)
      WHERE selected.server_name <> OLD.name
    ), '[]'::jsonb),
    true
  )
  WHERE a.user_id = OLD.user_id
    AND jsonb_typeof(a.tools->'mcpServerNames') = 'array'
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(a.tools->'mcpServerNames') AS selected(server_name)
      WHERE selected.server_name = OLD.name
    );

  UPDATE public.swarms AS s
  SET nodes = pruned.nodes
  FROM (
    SELECT
      sw.id,
      COALESCE(
        jsonb_agg(
          CASE
            WHEN jsonb_typeof(node_item.node #> '{data,toolConfigs,mcp_server_names}') = 'array' THEN
              jsonb_set(
                node_item.node,
                '{data,toolConfigs,mcp_server_names}',
                COALESCE((
                  SELECT jsonb_agg(to_jsonb(server_name))
                  FROM jsonb_array_elements_text(node_item.node #> '{data,toolConfigs,mcp_server_names}') AS selected(server_name)
                  WHERE selected.server_name <> OLD.name
                ), '[]'::jsonb),
                true
              )
            ELSE node_item.node
          END
          ORDER BY node_item.ord
        ),
        '[]'::jsonb
      ) AS nodes
    FROM public.swarms AS sw
    CROSS JOIN LATERAL jsonb_array_elements(sw.nodes) WITH ORDINALITY AS node_item(node, ord)
    WHERE sw.user_id = OLD.user_id
    GROUP BY sw.id
  ) AS pruned
  WHERE s.id = pruned.id
    AND s.user_id = OLD.user_id
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(s.nodes) AS node_item(node)
      WHERE jsonb_typeof(node_item.node #> '{data,toolConfigs,mcp_server_names}') = 'array'
        AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(node_item.node #> '{data,toolConfigs,mcp_server_names}') AS selected(server_name)
          WHERE selected.server_name = OLD.name
        )
    );

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS prune_deleted_mcp_server_refs_on_delete ON public.mcp_servers;
CREATE TRIGGER prune_deleted_mcp_server_refs_on_delete
AFTER DELETE ON public.mcp_servers
FOR EACH ROW
EXECUTE FUNCTION public.prune_deleted_mcp_server_refs();

-- One-time cleanup for selections that already point to missing or disconnected MCP servers.
UPDATE public.agents AS a
SET tools = jsonb_set(
  a.tools,
  '{mcpServerNames}',
  COALESCE((
    SELECT jsonb_agg(to_jsonb(server_name))
    FROM jsonb_array_elements_text(COALESCE(a.tools->'mcpServerNames', '[]'::jsonb)) AS selected(server_name)
    WHERE EXISTS (
      SELECT 1
      FROM public.mcp_servers AS m
      WHERE m.user_id = a.user_id
        AND m.name = selected.server_name
        AND m.status = 'connected'
    )
  ), '[]'::jsonb),
  true
)
WHERE jsonb_typeof(a.tools->'mcpServerNames') = 'array';

UPDATE public.swarms AS s
SET nodes = cleaned.nodes
FROM (
  SELECT
    sw.id,
    COALESCE(
      jsonb_agg(
        CASE
          WHEN jsonb_typeof(node_item.node #> '{data,toolConfigs,mcp_server_names}') = 'array' THEN
            jsonb_set(
              node_item.node,
              '{data,toolConfigs,mcp_server_names}',
              COALESCE((
                SELECT jsonb_agg(to_jsonb(server_name))
                FROM jsonb_array_elements_text(node_item.node #> '{data,toolConfigs,mcp_server_names}') AS selected(server_name)
                WHERE EXISTS (
                  SELECT 1
                  FROM public.mcp_servers AS m
                  WHERE m.user_id = sw.user_id
                    AND m.name = selected.server_name
                    AND m.status = 'connected'
                )
              ), '[]'::jsonb),
              true
            )
          ELSE node_item.node
        END
        ORDER BY node_item.ord
      ),
      '[]'::jsonb
    ) AS nodes
  FROM public.swarms AS sw
  CROSS JOIN LATERAL jsonb_array_elements(sw.nodes) WITH ORDINALITY AS node_item(node, ord)
  GROUP BY sw.id
) AS cleaned
WHERE s.id = cleaned.id;