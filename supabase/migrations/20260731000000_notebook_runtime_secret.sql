-- Server-generated signing secret for notebook-runtime session tokens.
--
-- Kept in its OWN table rather than notebook_runtime_settings because that table
-- is deliberately readable by every authenticated user (the notebook editor needs
-- to know whether the runtime is enabled). A signing key must never reach a
-- client, so this table has RLS enabled and NO policies at all: only the service
-- role (which bypasses RLS) can read or write it.
--
-- This removes the manual NOTEBOOK_RUNTIME_SECRET step — the app generates one on
-- first use. An explicit env var still wins when set, for operators who prefer to
-- manage it themselves or need the same value across replicas they control.
CREATE TABLE public.notebook_runtime_secrets (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  signing_secret text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.notebook_runtime_secrets ENABLE ROW LEVEL SECURITY;
-- (Intentionally no policies — service-role only.)
