-- Share warehouse and app connections with users and groups.
--
-- Until now a connection was single-user: every analyst on a team had to
-- create their own Snowflake connection with their own credentials. That is
-- the difference between a personal tool and a team platform, and it is a
-- missing concept rather than a hardening gap.
--
-- A SHARED CONNECTION RUNS AS ITS OWNER. The credential IS the connection —
-- a grantee has none of their own — so the owner's credential is decrypted
-- server-side and used on the grantee's behalf. Same model as a shared
-- semantic model, and the only coherent one here.
--
-- DELIBERATELY NO RLS POLICY ON THE CONNECTION TABLES. Unlike semantic_models,
-- these rows carry `credentials` / `config`: the AES-GCM blob. An RLS SELECT
-- policy for grantees would let them fetch that ciphertext straight from
-- PostgREST with their own JWT. Grantees therefore get NO direct table access;
-- the grant is resolved server-side and the row is loaded with the service
-- role, so a grantee can USE a connection without ever receiving it.

ALTER TABLE public.iam_resource_grants
  DROP CONSTRAINT IF EXISTS iam_resource_grants_resource_type_check;

ALTER TABLE public.iam_resource_grants
  ADD CONSTRAINT iam_resource_grants_resource_type_check
  CHECK (
    resource_type IN (
      'knowledge_base',
      'data_table',
      'secret',
      'bi_dashboard',
      'semantic_model',
      'catalog_source',
      'integration',
      'provider_credential',
      -- New: databases/warehouses, and SaaS app sources.
      'warehouse_connection',
      'saas_connection'
    )
  );
