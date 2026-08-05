# Access control (IAM) & SSO

> Part of the [AgentSwarms docs](../README.md#documentation).

The account whose email matches `ADMIN_EMAIL` is the instance's **bootstrap
superadmin** — sign in with it and open **Admin → IAM** (`/admin/iam`) to
manage everything else.

> **Claim it before the instance is reachable.** The bootstrap account is
> identified by an email address, and an address is a claim rather than a
> credential. Public signup is on by default, so whoever registers that address
> first becomes superadmin — and the IAM page then refuses to demote it. The
> server requires the address to be **confirmed**, so make sure Supabase is
> verifying email (Auth → Providers → Email → _Confirm email_); with
> confirmations off, every address is marked confirmed at signup and that
> defence does nothing. See
> [DEPLOYMENT.md → Bootstrap the operator](./DEPLOYMENT.md#bootstrap-the-operator).

It manages:

- **Users** — invite by email (Supabase sends the invitation) or create
  accounts with a temporary password; ban/unban; delete; promote additional
  superadmins. The bootstrap superadmin can never be demoted, and the last
  superadmin is protected.
- **Groups** — organize users; model rules and resource shares can target a
  whole group at once.
- **Model access** — allow rules on a user or group define what they may call
  (patterns: `*`, `openai/*`, or an exact model id; the allowed set is the
  union of all applicable rules). What **no rules** means is an instance
  policy, set under Settings → **Default model access**:
  - **Allow by default** (the default) — a user with no rules is unrestricted.
  - **Deny by default** — a user with no rules can call **no models** until a
    rule allow-lists them. Superadmins bypass deny mode, so the people who
    administer the allow-lists cannot lock themselves out. Flipping the
    toggle changes nothing for anyone who already has rules.

  Enforced server-side on every LLM call — playground, saved agents, swarm
  nodes, the API, and **public embeds**, which run their owner's stored model
  for anonymous visitors and are checked against the owner's effective rules
  on every request — and reflected in the model pickers.

- **Shares** — grant users or groups **read-only** access to any knowledge
  base, SQL data table, secret, BI dashboard, semantic model, catalog source,
  LLM key/credential, **database & warehouse connection** or **app source**;
  recipients' agents can search/query them but never modify them. A shared
  **connection** runs as its OWNER: the owner's credential is decrypted
  server-side and the grantee's queries run against the owner's warehouse, so
  a grantee gains the use of a connection without ever receiving its
  credential — see [Data sources](./DATA_SOURCES.md#sharing-a-connection-with-your-team). Dataset and dashboard grants also
  take a **row filter** (only rows whose column matches the listed values) and
  a **column mask** (named columns are removed entirely, not blanked). Both
  are enforced **inside the database** — a grantee cannot read a shared
  dataset's raw rows at all; every read goes through a security-definer
  function that applies the restriction first, so masks hold whether the data
  is reached through the SQL workbench, an agent tool, or the REST API. When
  several grants apply to the same person the effect is **union of access**:
  row filters combine (any allowing grant admits the row) and column masks
  intersect (a column is hidden only when _every_ grant hides it), so holding
  two grants never leaves someone with less access than one alone.

  One deliberate exception to "grants only add": knowledge-base documents
  synced from a connected service (Google Drive, Notion, SharePoint, Dropbox)
  can carry a per-source **access scope** — _Only me_, or _Match source
  permissions_ (sharing mirrored per document from the provider). That scope
  filters retrieval **inside** a granted knowledge base and belongs to the
  source's owner, not to the grant. See
  [Knowledge bases](./KNOWLEDGE_BASES.md#access-control).

  Everything above is **deny-by-default**: every resource table is owner-only
  under row-level security, grants are strictly additive read-only SELECT
  policies, and the headless execution paths (swarms, schedulers, embeds)
  re-derive the same grant set explicitly rather than trusting the caller.
  The deliberate exceptions are the public demo samples and public metadata
  (profiles, the model registry).

- **Settings** — flip the instance to **invite-only**: public self-signup
  (including OAuth) is rejected at the database level, while invited,
  admin-created, and SSO-provisioned users still get in.
- **SSO** — connect enterprise identity providers (Okta, Auth0, Microsoft
  Entra ID, or any SAML 2.0 IdP) so users sign in with their work account.
  The tab shows the two values to paste into your IdP's SAML app (ACS URL
  and Entity ID), takes the IdP's metadata URL/XML plus the email domains it
  covers, and adds a "Continue with single sign-on" flow to the login page.
  Optionally **require SSO**, hiding email/password and social login
  (`/login?native=1` remains as a superadmin escape hatch).

  > SAML SSO must be enabled on your Supabase project first: hosted Supabase
  > → **Authentication → Sign In / Up → SSO (SAML 2.0)** — a Pro-plan
  > feature; self-hosted GoTrue → set `GOTRUE_SAML_ENABLED=true` with a
  > `GOTRUE_SAML_PRIVATE_KEY`. The SSO tab detects and explains this if it's
  > not enabled yet.
