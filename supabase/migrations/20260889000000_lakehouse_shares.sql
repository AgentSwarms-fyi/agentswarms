-- Sharing lakehouse tables with people outside the platform, over the
-- Delta Sharing protocol.
--
-- A share is a named bundle of an owner's tables. A recipient holds a token
-- bound to one share and reads through /api/delta-sharing: the listing, the
-- schema, and presigned URLs to Parquet files. The files are never the
-- lakehouse's own: each read serves a governed snapshot materialised from
-- the table through the owner's policies (row filters, masks, tag rules)
-- plus the share's own, with DuckLake's deletes applied — so a recipient
-- gets exactly what a grantee inside the platform would, and nothing that
-- was deleted.

CREATE TABLE public.lakehouse_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- The name in the URL; recipients address it without knowing the owner.
  name text NOT NULL UNIQUE CHECK (name ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.lakehouse_share_tables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  share_id uuid NOT NULL REFERENCES public.lakehouse_shares(id) ON DELETE CASCADE,
  schema_name text NOT NULL,
  table_name text NOT NULL,
  -- The table's name inside the share; defaults to its own.
  shared_as text NOT NULL CHECK (shared_as ~ '^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$'),
  -- The share's own rule on top of the table's policy: rows the recipient
  -- may see, columns that are masked. Both combine with the table's policy
  -- the way tag rules do — filters AND, masks union.
  row_filter text,
  masked_columns text[] NOT NULL DEFAULT '{}',
  mask_style text NOT NULL DEFAULT 'null' CHECK (mask_style IN ('null', 'hash')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (share_id, schema_name, table_name),
  UNIQUE (share_id, shared_as)
);

CREATE TABLE public.lakehouse_share_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  share_id uuid NOT NULL REFERENCES public.lakehouse_shares(id) ON DELETE CASCADE,
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),
  -- Who holds it; binds @me in a row filter. Optional.
  recipient_email text,
  token_hash text NOT NULL UNIQUE,
  token_prefix text NOT NULL,
  expires_at timestamptz,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  use_count bigint NOT NULL DEFAULT 0,
  revoked_at timestamptz
);

-- A materialised, governed snapshot of one shared table: which lakehouse
-- files it was built from (the fingerprint), under which policy, and the
-- Parquet objects written for recipients. One row per (table, version,
-- policy); the current one is served until the table or the policy changes.
CREATE TABLE public.lakehouse_share_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  share_table_id uuid NOT NULL REFERENCES public.lakehouse_share_tables(id) ON DELETE CASCADE,
  fingerprint text NOT NULL,
  policy_hash text NOT NULL,
  snapshot_id text NOT NULL,
  prefix text NOT NULL,
  files jsonb NOT NULL DEFAULT '[]'::jsonb,
  columns jsonb NOT NULL DEFAULT '[]'::jsonb,
  row_count bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (share_table_id, fingerprint, policy_hash)
);

ALTER TABLE public.lakehouse_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lakehouse_share_tables ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lakehouse_share_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lakehouse_share_snapshots ENABLE ROW LEVEL SECURITY;

-- Owners see their own shares and what hangs off them; every write goes
-- through the service role from server functions that check ownership.
CREATE POLICY "Owners view their shares"
  ON public.lakehouse_shares FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Owners view their share tables"
  ON public.lakehouse_share_tables FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.lakehouse_shares s WHERE s.id = share_id AND s.user_id = auth.uid()));
CREATE POLICY "Owners view their share tokens"
  ON public.lakehouse_share_tokens FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.lakehouse_shares s WHERE s.id = share_id AND s.user_id = auth.uid()));
CREATE POLICY "Owners view their share snapshots"
  ON public.lakehouse_share_snapshots FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.lakehouse_share_tables t
    JOIN public.lakehouse_shares s ON s.id = t.share_id
    WHERE t.id = share_table_id AND s.user_id = auth.uid()
  ));

CREATE INDEX lakehouse_share_tables_share_idx ON public.lakehouse_share_tables (share_id);
CREATE INDEX lakehouse_share_tokens_share_idx ON public.lakehouse_share_tokens (share_id);
CREATE INDEX lakehouse_share_snapshots_table_idx ON public.lakehouse_share_snapshots (share_table_id);
