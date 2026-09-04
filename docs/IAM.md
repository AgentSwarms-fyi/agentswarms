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

## What it manages

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

## Use cases

Every walkthrough below uses the tabs on **Admin → IAM**: _Users_, _Groups_,
_Access_, _Attributes_, _Budgets_, _SSO_ and _Settings_.

### Contractors may only use one inexpensive model

You have a group of external contractors who should build and test agents but
never run the frontier models the rest of the company pays for.

1. **Settings → Default model access → Deny by default.** From now on a user
   with no rules can call no models at all. Nobody who already has rules is
   affected, and superadmins bypass deny mode, so you cannot lock yourself out.
2. **Groups →** create _Contractors_ and add the accounts.
3. **Access →** add a model rule on the _Contractors_ group. A rule is a
   pattern: `*`, a provider prefix such as `openai/*`, or one exact model id.
   Grant the single model you are willing to pay for.

The rule is enforced on the server for every call the contractor's work
makes — the playground, saved agents, swarm nodes, the API, and a public embed
of their agent, which runs its owner's stored model and is re-checked against
the owner's rules on every anonymous request. The model pickers only show what
the rules allow, so the restriction is visible before it is enforced.

### Give the team a warehouse without giving anyone its password

A data engineer owns the production Postgres connection and the whole
analytics group needs to query it from agents and the SQL workbench.

1. The owner creates the connection once under **Integrations → Data
   Sources** and tests it.
2. On **Admin → IAM → Access** the owner (or a superadmin) shares the
   connection with the _Analytics_ group, read-only.
3. Each analyst's agents can now query it. The credential never leaves the
   server: a shared connection runs **as its owner** — the owner's stored
   secret is decrypted server-side and the grantee's queries run against the
   owner's warehouse. Revoking the share stops the access; nothing needs to
   be rotated, because nothing was handed out.

### Regional analysts see only their own rows

One `sales` table, three regions, and each regional lead may see only their
region — and never the `margin` column.

1. Share the dataset with each lead (or with a per-region group) on
   **Access**, adding a **row filter** on `region` and a **column mask** that
   removes `margin`.
2. For a single grant that adapts to whoever is looking, set each viewer's
   region on the **Attributes** tab and reference the attribute in the filter:
   one grant, per-viewer rows.

Both restrictions are enforced **inside the database**: a grantee cannot read
the raw table at all, every read goes through a security-definer function that
applies the filter and mask first, so the result is the same through the SQL
workbench, an agent tool or the REST API. When someone holds two grants, rows
combine (any allowing grant admits the row) and masks intersect (a column is
hidden only when every grant hides it) — a second grant never reduces access.

### Work accounts only

Security wants every login to go through the corporate identity provider.

1. Enable SAML on your Supabase project first (hosted: **Authentication →
   Sign In / Up → SSO (SAML 2.0)**; self-hosted GoTrue: `GOTRUE_SAML_ENABLED`
   and a private key). The **SSO** tab tells you if this is still missing.
2. On **SSO**, copy the ACS URL and Entity ID into the IdP's SAML app, then
   paste the IdP's metadata URL or XML and list the email domains it covers.
   The login page gains _Continue with single sign-on_.
3. Once a superadmin has signed in through the IdP successfully, turn on
   **Require SSO**. Email/password and social login disappear from the login
   page; `/login?native=1` stays as the superadmin escape hatch, so a broken
   IdP cannot lock the instance.

SSO-provisioned users get in even when the instance is **invite-only**
(Settings), so you can close public signup at the same time.
