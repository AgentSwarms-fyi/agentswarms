import { createFileRoute } from "@tanstack/react-router";
import {
  C,
  Callout,
  Code,
  DocLink,
  DocsHeader,
  H2,
  H3,
  H4,
  NextPrev,
  P,
  Table,
} from "@/components/docs/DocsShell";

export const Route = createFileRoute("/docs/self-hosting_/configuration")({
  head: () => ({
    meta: [
      { title: "Install & deploy · Configuration — AgentSwarms Documentation" },
      {
        name: "description",
        content:
          "Every environment variable, grouped by what it configures, and the settings that fit each way of running the platform — a laptop, one team, public embeds, a regulated network, a fleet behind a load balancer.",
      },
      {
        property: "og:title",
        content: "Install & deploy · Configuration — AgentSwarms Documentation",
      },
      {
        property: "og:description",
        content: "Every variable, and the settings for each way of running it.",
      },
      { property: "og:url", content: "https://agentswarms.fyi/docs/self-hosting/configuration" },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: "https://agentswarms.fyi/docs/self-hosting/configuration" }],
  }),
  component: SelfHostingConfigurationPage,
});

function SelfHostingConfigurationPage() {
  return (
    <>
      <DocsHeader
        eyebrow="Self-hosting"
        title="Install & deploy · Configuration"
        description="Every environment variable, grouped by what it configures, and the settings that fit each way of running the platform — a laptop, one team, public embeds, a regulated network, a fleet behind a load balancer."
      />
      <P>
        Part of the <DocLink to="/docs/self-hosting">Install &amp; deploy</DocLink> guide. This page
        is the reference: every environment variable, grouped by what it configures, then the
        settings that fit each way of running the platform.
      </P>

      <H2 id="env">Environment reference</H2>
      <P>
        Every variable the app reads, grouped by what it does. Only the first group is required;
        everything else changes behaviour you may not need.
      </P>

      <H3 id="env-required">Required — Supabase and identity</H3>
      <Table
        headers={["Variable", "Purpose"]}
        rows={[
          [<C key="a">SUPABASE_URL</C>, "Project URL, server side"],
          [<C key="b">SUPABASE_PUBLISHABLE_KEY</C>, "Anon key, server side"],
          [
            <C key="c">SUPABASE_SERVICE_ROLE_KEY</C>,
            "Service role. Server only — must never reach a browser.",
          ],
          [<C key="d">VITE_SUPABASE_URL</C>, "Same URL, inlined into the client bundle"],
          [<C key="e">VITE_SUPABASE_PUBLISHABLE_KEY</C>, "Same anon key, client side"],
          [<C key="h">ADMIN_EMAIL</C>, "Bootstrap superadmin account"],
          [<C key="i">VITE_ADMIN_EMAIL</C>, "Same address, for client-side admin affordances"],
          [
            <C key="j">PROVIDER_CREDS_SECRET</C>,
            "Encryption key for every stored credential. Back this up — see the warning below.",
          ],
          [<C key="k">INTERNAL_RUN_SECRET</C>, "Signs internal service-to-service calls"],
        ]}
      />
      <Callout kind="warn" title="PROVIDER_CREDS_SECRET is not recoverable">
        Every stored credential is encrypted with it, and it lives in the environment rather than
        the database — so a database dump alone yields no secrets. Lose it and every connector,
        provider key and MCP token must be re-entered. Keep it wherever you keep your other
        break-glass secrets, and back it up separately from the database.
      </Callout>

      <H3 id="env-models">Models and search</H3>
      <Table
        headers={["Variable", "Purpose"]}
        rows={[
          [
            <C key="a">OPENROUTER_API_KEY</C>,
            "Zero-config model fallback so a fresh workspace works before anyone connects their own provider.",
          ],
          [<C key="b">OPENROUTER_DEFAULT_MODEL</C>, "Model used for that fallback"],
          [
            <C key="c">OPENROUTER_BASE_URL</C>,
            "Point at a compatible gateway instead of OpenRouter",
          ],
          [
            <C key="e">FIRECRAWL_API_KEY</C>,
            "Workspace-wide web search and JavaScript-rendered page fetching for web_search / web_browse. Optional: without it, web_browse uses the built-in fetcher (server-rendered pages only) and web_search falls back to DuckDuckGo entity lookups.",
          ],
        ]}
      />

      <H3 id="env-connections">Data connections</H3>
      <P>
        None of these are required — the defaults are the recommended settings. They exist for
        tuning against a particular warehouse or network.
      </P>
      <Table
        headers={["Variable", "Default", "Purpose"]}
        rows={[
          [<C key="a">WAREHOUSE_MAX_ROWS</C>, "1000", "Rows returned when a caller asks for none"],
          [<C key="b">WAREHOUSE_ABS_MAX_ROWS</C>, "5000", "Hard ceiling no caller can exceed"],
          [<C key="c">WAREHOUSE_QUERY_TIMEOUT_MS</C>, "60000", "Wall-clock budget for one query"],
          [<C key="d">WAREHOUSE_MAX_CONCURRENT</C>, "8", "Queries in flight, per instance"],
          [<C key="e">WAREHOUSE_MAX_CONCURRENT_PER_USER</C>, "3", "Per tenant"],
          [
            <C key="f">WAREHOUSE_POOL</C>,
            "on",
            <>
              Connection pooling for PostgreSQL/MySQL-family sources. Set <C key="off">off</C> for a
              connection per query.
            </>,
          ],
          [
            <C key="g">WAREHOUSE_POOL_MAX</C>,
            "4",
            "Sockets per credential set — see the sizing note below",
          ],
          [<C key="h">WAREHOUSE_POOL_MAX_KEYS</C>, "64", "Distinct credential sets held at once"],
          [
            <C key="i">HTTPS_PROXY</C>,
            "—",
            "Forward proxy for all outbound connector traffic. NO_PROXY takes a bypass list.",
          ],
          [<C key="j">CONNECTOR_MAX_RETRIES</C>, "2", "Retries on 429/503 and transport errors"],
          [
            <C key="k">CONNECTOR_RETRY_500</C>,
            "off",
            "Also retry 500s — only for providers that use 500 for throttling",
          ],
          [<C key="l">CONNECTION_HEALTH_HOURS</C>, "12", "Credential re-validation cadence"],
          [<C key="m">CREDENTIAL_MAX_AGE_DAYS</C>, "90", "When a credential is badged as old"],
        ]}
      />
      <Callout kind="warn" title="Size the pool against your database, not this page">
        Sockets held is roughly <C>WAREHOUSE_POOL_MAX</C> &times; <C>WAREHOUSE_POOL_MAX_KEYS</C>{" "}
        &times; your replica count, and each replica keeps its own pools. Check that product against
        the database&rsquo;s <C>max_connections</C> before raising either number. Pooling is worth
        having — it took a query from 30.7ms to 2.9ms in measurement — but an oversized pool
        exhausts a warehouse&rsquo;s connection limit instead.
      </Callout>

      <H3 id="env-email">Email delivery</H3>
      <P>
        Carries welcome mail, budget alerts, BI alerts, scheduled reports, approval requests and the
        contact form. Auth emails (confirmation, password reset) are separate — Supabase sends
        those, configured in its own dashboard.
      </P>
      <P>
        <strong>No third-party account is required.</strong> SMTP is built in — nodemailer is a
        dependency of the app, not something to install — so any relay you already have works with
        four variables and nothing signed up for. Set <C>SMTP_HOST</C>, <C>SMTP_PORT</C>,
        <C>SMTP_USER</C> and <C>SMTP_PASS</C>, plus <C>EMAIL_FROM</C>. Port 587 with STARTTLS is the
        default; 465 turns on implicit TLS automatically. Leave <C>SMTP_USER</C> empty for a relay
        that authenticates by IP.
      </P>
      <Code lang="bash">{`SMTP_HOST="smtp.your-company.com"
SMTP_PORT="587"
SMTP_USER="apikey-or-username"
SMTP_PASS="..."
EMAIL_FROM="AgentSwarms <noreply@your-company.com>"`}</Code>
      <P>
        <strong>Resend</strong> is the alternative for a deployment with no relay to point at. It
        takes precedence when both are configured.
      </P>
      <P>
        <strong>Resend needs a verified domain, not just a key.</strong> In Resend: create an API
        key for <C>RESEND_API_KEY</C>, then <em>Domains → Add Domain</em>, publish the SPF and DKIM
        records it gives you at your DNS host, and press Verify. Then set <C>EMAIL_FROM</C> to an
        address on that domain.
      </P>
      <Code lang="bash">{`RESEND_API_KEY="re_..."
EMAIL_FROM="AgentSwarms <noreply@your-company.com>"
SITE_URL="https://your-domain.com"`}</Code>
      <Callout kind="warn" title="Two ways email fails without looking broken">
        Leaving <C>EMAIL_FROM</C> empty falls back to <C>noreply@example.com</C>, which Resend
        rejects — every app email fails while the app carries on normally. And until your domain is
        verified, Resend sends only from <C>onboarding@resend.dev</C> and delivers only to the
        address that owns the Resend account; mail to anyone else is accepted by the API and never
        arrives. Both outcomes are recorded in <C>email_send_log</C>, which is where to look when
        nobody is receiving anything.
      </Callout>
      <Table
        headers={["Variable", "Purpose"]}
        rows={[
          [<C key="a">RESEND_API_KEY</C>, "Resend delivery"],
          [<C key="b">SMTP_HOST</C>, "SMTP delivery"],
          [<C key="c">SMTP_PORT</C>, "—"],
          [<C key="d">SMTP_USER</C>, "—"],
          [<C key="e">SMTP_PASS</C>, "—"],
          [<C key="f">SMTP_SECURE</C>, "TLS on/off"],
          [<C key="g">EMAIL_FROM</C>, "From address on outgoing mail"],
          [<C key="h">SITE_URL</C>, "Base URL used in links inside emails"],
          [<C key="i">PUBLIC_APP_URL</C>, "Public base URL of this instance"],
        ]}
      />

      <H3 id="env-limits">Run limits and cost</H3>
      <Table
        headers={["Variable", "Purpose"]}
        rows={[
          [
            <C key="a">SWARM_RUN_RATE_LIMIT_PER_MIN</C>,
            "Requests per API key per minute, then 429",
          ],
          [<C key="b">SWARM_RUN_MAX_CONCURRENT</C>, "Simultaneous runs per key"],
          [<C key="c">SWARM_RUN_TIMEOUT_MS</C>, "Wall-clock ceiling for one run"],
          [
            <C key="d">ENFORCE_BUDGET_CAP</C>,
            <>
              Makes budget caps BLOCK rather than only alert. Accepts <C key="v">1</C>,{" "}
              <C key="t">true</C>, <C key="y">yes</C>. Set this on any instance with a public embed
              — see{" "}
              <DocLink key="b" to="/docs/budgets">
                Budgets
              </DocLink>
              .
            </>,
          ],
          [
            <C key="e">BUDGET_FAIL_CLOSED</C>,
            <>
              What to do when the spend <em key="i">lookup itself</em> fails, as opposed to coming
              back under cap. Unset (the default) allows the call — governance should not be the
              reason legitimate work breaks. Set <C key="t2">true</C> when the cap must hold even if
              the figure cannot be established. Either way the failure is logged.
            </>,
          ],
        ]}
      />
      <Callout kind="info">
        These limits are counted <strong>in Postgres, shared by every instance</strong>, so the
        number you set is the number you get however many copies of the app are running. If the
        database is briefly unreachable each instance falls back to counting locally and logs that
        it has done so — the limit degrades rather than disappearing.
      </Callout>

      <H3 id="env-tuning">Performance and concurrency tuning</H3>
      <P>
        Every value here has a working default; an instance runs without setting any of them. They
        exist for the two situations where the defaults stop fitting — a small box that needs
        ceilings lowered, and a busy instance where one user's work should not crowd out everyone
        else's. The defaults below are the ones the code applies when the variable is unset.
      </P>
      <Table
        headers={["Variable", "Default", "Purpose"]}
        rows={[
          [<C key="a">SWARM_LEVEL_CONCURRENCY</C>, "4", "Nodes run in parallel per graph level."],
          [
            <C key="b">MCP_MAX_CONCURRENT_PER_SERVER</C>,
            "8",
            "In-flight calls to one published MCP server.",
          ],
          [
            <C key="c">BI_DIRECT_QUERY_RATE_PER_MIN</C>,
            "120",
            "Live warehouse queries per dashboard OWNER — a shared dashboard bills its owner's budget, so the limit follows the owner rather than the viewer.",
          ],
          [<C key="d">UPLOAD_PER_MINUTE</C>, "10", "Dataset uploads per user."],
          [
            <C key="e">INTEGRATION_TEST_PER_MINUTE</C>,
            "10",
            'Presses of "Test connection" per user.',
          ],
          [
            <C key="f">NOTEBOOK_CELL_TIMEOUT_SECONDS</C>,
            "120",
            "Wall-clock ceiling on one notebook cell.",
          ],
        ]}
      />

      <H4>Local query engine</H4>
      <P>
        The server-side engine that runs local datasets and scheduled refreshes. Lower these on a
        small VM; raising them past what the host has does not make queries faster, it makes them
        fail later.
      </P>
      <Table
        headers={["Variable", "Default", "Purpose"]}
        rows={[
          [<C key="a">LOCAL_ENGINE_MEMORY_MB</C>, "512", "Memory ceiling for one query."],
          [<C key="b">LOCAL_ENGINE_THREADS</C>, "2", "Threads per query."],
          [<C key="c">LOCAL_ENGINE_TIMEOUT_MS</C>, "30000", "Wall-clock ceiling for one query."],
        ]}
      />

      <H4>Warehouse connection pool</H4>
      <Table
        headers={["Variable", "Default", "Purpose"]}
        rows={[
          [<C key="a">WAREHOUSE_POOL_IDLE_MS</C>, "30000", "Before an idle socket is closed."],
          [<C key="b">WAREHOUSE_POOL_TTL_MS</C>, "300000", "Before a whole pool is dropped."],
          [
            <C key="c">WAREHOUSE_QUEUE_TIMEOUT_MS</C>,
            "30000",
            "How long a query waits for a free slot before failing.",
          ],
          [
            <C key="d">CONNECTOR_RETRY_BASE_MS</C>,
            "400",
            "First backoff step on a retryable error.",
          ],
          [<C key="e">CONNECTOR_RETRY_MAX_MS</C>, "8000", "Caps any single backoff wait."],
          [
            <C key="f">HTTP_PROXY</C>,
            "unset",
            "Routes outbound connector traffic through a proxy.",
          ],
        ]}
      />

      <H4>Parquet mirror</H4>
      <P>
        Optional. Large local datasets can be mirrored to Parquet so repeat queries read a columnar
        file instead of re-reading rows. Unset, nothing is mirrored and everything still works.
      </P>
      <Table
        headers={["Variable", "Default", "Purpose"]}
        rows={[
          [<C key="a">PARQUET_MIRROR</C>, "off", "Enables mirroring."],
          [<C key="b">PARQUET_MIN_ROWS</C>, "5000", "Below this a table is not worth mirroring."],
          [<C key="c">PARQUET_MAX_ROWS</C>, "5000000", "Above this a table is not mirrored."],
          [<C key="d">PARQUET_CACHE_DIR</C>, "temp dir", "Where mirrored files live."],
          [<C key="e">PARQUET_CACHE_MAX_BYTES</C>, "2 GiB", "Cache ceiling on disk."],
          [<C key="f">MIRROR_BUDGET_BYTES</C>, "unlimited", "Total bytes mirroring may write."],
        ]}
      />

      <H4>JavaScript sandbox</H4>
      <P>
        Backs the swarm <C>function</C> node. User-authored code never runs in the app process,
        which holds the service-role key and every decrypted provider credential. Leaving{" "}
        <C>JS_SANDBOX_URL</C> unset does not mean in-process: the app probes{" "}
        <C>http://js-sandbox:8091</C>, then <C>http://127.0.0.1:8091</C>, and uses whichever
        answers. Set the variable only to point somewhere else. If nothing answers, the node is
        refused with a message explaining how to enable it.
      </P>
      <Table
        headers={["Variable", "Default", "Purpose"]}
        rows={[
          [
            <C key="a">JS_SANDBOX_URL</C>,
            "unset (auto-discovered)",
            "External sandbox service. Without one, function nodes are refused.",
          ],
          [<C key="b">JS_SANDBOX_MAX_TIMEOUT_MS</C>, "5000", "Ceiling on one function node."],
          [<C key="c">JS_SANDBOX_MAX_CONCURRENT</C>, "4", "Simultaneous executions."],
          [<C key="d">JS_SANDBOX_MEM_MB</C>, "128", "Memory ceiling per execution."],
          [<C key="e">JS_SANDBOX_MAX_BODY_BYTES</C>, "1000000", "Largest payload in or out."],
        ]}
      />

      <H3 id="env-network">Network egress</H3>
      <Table
        headers={["Variable", "Purpose"]}
        rows={[
          [
            <C key="a">BLOCK_PRIVATE_NETWORK_FETCH</C>,
            "Refuse outbound requests to private, loopback and link-local addresses, including cloud metadata endpoints.",
          ],
          [
            <C key="b">ALLOW_PRIVATE_NETWORK_FETCH</C>,
            "The escape hatch, for when a warehouse or MCP server genuinely lives on a private network.",
          ],
          [
            <C key="c">TRUSTED_PROXY_HOPS</C>,
            <>
              How many reverse proxies of <em key="i">yours</em> sit in front of the app. Decides
              which entry of <C key="x">X-Forwarded-For</C> is treated as the caller — the header is
              appended to, so only the entries your own proxies added cannot be forged. Default{" "}
              <C key="1">1</C> (a single reverse proxy); use <C key="2">2</C> behind a CDN in front
              of that proxy. Only MCP key IP allow-lists depend on it.
            </>,
          ],
        ]}
      />
      <Callout kind="warn">
        Set <C>TRUSTED_PROXY_HOPS</C> to match your actual topology before relying on an MCP key's
        IP allow-list. Too low reads your proxy's address instead of the caller's and the allow-list
        never matches; too high reads a value the caller supplied, which is the bypass the setting
        exists to close. It is clamped to the length of the chain, so it can never walk past the
        end.
      </Callout>
      <Callout kind="warn">
        Allowing private-network fetches means a URL chosen by a model — from <C>web_browse</C>, a
        swarm HTTP node, or a prompt-injected instruction — can reach inside your network. If you
        must enable it, do so on an instance with no public embeds.
      </Callout>

      <H3 id="env-observability">Observability and audit</H3>
      <Table
        headers={["Variable", "Purpose"]}
        rows={[
          [<C key="a">METRICS_TOKEN</C>, "Bearer token guarding the metrics endpoint"],
          [<C key="b">OTEL_EXPORTER_OTLP_ENDPOINT</C>, "OTLP collector endpoint"],
          [<C key="c">OTEL_EXPORTER_OTLP_TRACES_ENDPOINT</C>, "Traces-specific override"],
          [<C key="d">OTEL_EXPORTER_OTLP_HEADERS</C>, "Extra headers for the collector"],
          [<C key="e">OTEL_SERVICE_NAME</C>, "Service name reported in traces"],
          [
            <C key="f">AUDIT_ARCHIVE_ON_PURGE</C>,
            "Archive audit events instead of dropping them at retention",
          ],
          [
            <C key="g">PERSIST_PROMPT_BODIES</C>,
            "Whether full prompt and response bodies are stored on traces. Rich for debugging, heavier and more sensitive — decide deliberately.",
          ],
        ]}
      />

      <H3 id="env-scheduling">Scheduling</H3>
      <Table
        headers={["Variable", "Purpose"]}
        rows={[
          [
            <C key="a">DISABLE_INPROCESS_SCHEDULER</C>,
            "Turn off the in-process scheduler on the web tier — see scaling below.",
          ],
          [<C key="b">BI_CRON_TOKEN</C>, "Token an external cron presents to the BI cron endpoint"],
          [<C key="c">NOTEBOOK_CRON_TOKEN</C>, "Same, for the notebook reaper"],
        ]}
      />

      <H3 id="env-docgen">Document renderer</H3>
      <Table
        headers={["Variable", "Purpose"]}
        rows={[
          [
            <C key="a">DOCGEN_SERVICE_URL</C>,
            "Only when the renderer runs somewhere unusual. Leave empty — the app probes docgen:8099 and localhost:8099 and uses whichever answers.",
          ],
          [<C key="b">DOCGEN_TOKEN</C>, "Shared bearer token between the app and the renderer"],
        ]}
      />

      <H3 id="env-notebooks">Notebook runtime</H3>
      <Table
        headers={["Variable", "Purpose"]}
        rows={[
          [<C key="a">NOTEBOOK_RUNTIME_ENABLED</C>, "Turn the server runtime on"],
          [
            <C key="b">NOTEBOOK_RUNTIME_SECRET</C>,
            "Session-token signing key. Omit and the server generates one.",
          ],
          [<C key="c">NOTEBOOK_RUNTIME_BACKEND</C>, "docker | k8s | e2b"],
          [<C key="d">NOTEBOOK_RUNTIME_IMAGE</C>, "Kernel image to launch"],
          [<C key="e">NOTEBOOK_GATEWAY_URL</C>, "Websocket gateway address"],
        ]}
      />

      <H2 id="recipes">Configuration by use case</H2>
      <P>
        The reference above lists every setting. These are the combinations that actually go
        together, as complete blocks you can paste into <C>.env</C>. Each one names the risk it is
        answering, because the defaults are chosen for a single trusted operator and stop being
        right as soon as anyone else can reach the instance.
      </P>

      <H3 id="recipe-eval">Evaluating it on a laptop</H3>
      <P>
        Nothing is exposed, so nothing needs hardening. This is the default and you can ignore every
        other recipe until someone else can reach the app.
      </P>
      <Code lang="bash">{`SUPABASE_URL="https://<project>.supabase.co"
SUPABASE_SERVICE_ROLE_KEY="..."
SUPABASE_PUBLISHABLE_KEY="..."
VITE_SUPABASE_URL="https://<project>.supabase.co"
VITE_SUPABASE_PUBLISHABLE_KEY="..."

# One key and you can use everything; per-user keys can come later.
OPENROUTER_API_KEY="sk-or-..."

ADMIN_EMAIL="you@example.com"
VITE_ADMIN_EMAIL="you@example.com"`}</Code>

      <H3 id="recipe-team">An internal tool for one team</H3>
      <P>
        Reachable on your network or a private domain, no anonymous visitors. The work here is
        closing signup and making sure a runaway agent cannot bill you indefinitely.
      </P>
      <Code lang="bash">{`SITE_URL="https://agents.internal.example.com"
PUBLIC_APP_URL="https://agents.internal.example.com"

# Encrypts stored warehouse/SaaS credentials. Generate once and keep it;
# rotating needs PROVIDER_CREDS_SECRET_OLD (see below).  openssl rand -hex 32
PROVIDER_CREDS_SECRET="..."

# Caps stop being advisory.
ENFORCE_BUDGET_CAP="true"

# One reverse proxy in front (Caddy/nginx).
TRUSTED_PROXY_HOPS="1"

# Self-hosted Ollama or an in-cluster MCP server lives on a private address,
# so leave private-network fetches allowed — cloud metadata stays blocked
# either way.`}</Code>
      <Callout kind="info">
        Then turn on <strong>invite-only</strong> under Admin → IAM so the login page stops
        accepting new signups. See <DocLink to="/docs/iam">Access control</DocLink>.
      </Callout>

      <H3 id="recipe-public">Public embeds on a marketing site</H3>
      <P>
        The hardest case, because anonymous visitors spend <em>your</em> credits and you cannot
        authenticate them. Every setting here bounds what a stranger — or a leaked embed key — can
        cost you.
      </P>
      <Code lang="bash">{`SITE_URL="https://www.example.com"
PUBLIC_APP_URL="https://app.example.com"
PROVIDER_CREDS_SECRET="..."

# Refuse calls past the cap instead of emailing about them afterwards.
ENFORCE_BUDGET_CAP="true"
# If spend cannot be established, refuse rather than assume zero.
BUDGET_FAIL_CLOSED="true"

# A public embed has no reason to reach anything inside your network.
BLOCK_PRIVATE_NETWORK_FETCH="true"

TRUSTED_PROXY_HOPS="1"

# Tighten the public surface below the defaults (30/min chat, 10/min ask).
MCP_RATE_LIMIT_PER_MIN="30"
SWARM_RUN_RATE_LIMIT_PER_MIN="10"
SWARM_RUN_MAX_CONCURRENT="2"`}</Code>
      <Callout kind="warn">
        Give every embed key and swarm API key its own cap under{" "}
        <DocLink to="/docs/budgets">Budgets</DocLink>. The per-user cap is not enough on its own: it
        is what a leaked key drains, and a per-credential cap is what stops it.
      </Callout>

      <H3 id="recipe-regulated">Regulated or air-gapped</H3>
      <P>
        No outbound anything, evidence retained, and the audit trail shipped somewhere the app
        cannot rewrite.
      </P>
      <Code lang="bash">{`BLOCK_PRIVATE_NETWORK_FETCH="true"
ENFORCE_BUDGET_CAP="true"
BUDGET_FAIL_CLOSED="true"

# Traces to your own collector; nothing leaves for a vendor.
OTEL_EXPORTER_OTLP_ENDPOINT="http://otel-collector.internal:4318"
OTEL_SERVICE_NAME="agentswarms-prod"

# Expiring audit rows are printed as NDJSON before deletion, so a log
# shipper keeps them past the database's own retention.
AUDIT_ARCHIVE_ON_PURGE="1"

# No model prices are fetched at runtime; the table is vendored in the repo
# and refreshed deliberately with:  npm run prices:refresh`}</Code>
      <Callout kind="info">
        Audit retention is set in the product, not the environment — Admin → IAM, default 365 days.
        Deleting a user no longer deletes their trail: the row is kept with the actor's email so an
        investigation still has something to read.
      </Callout>

      <Callout kind="info" title="Rotating the credential key is supported">
        Changing <C>PROVIDER_CREDS_SECRET</C> on its own does strand everything already encrypted,
        which is why the snippet above says to set it once. Rotating it properly needs no downtime:
        move the outgoing value to <C>PROVIDER_CREDS_SECRET_OLD</C> (comma-separated, accepted for
        decryption only), put the new one in <C>PROVIDER_CREDS_SECRET</C>, restart, then run{" "}
        <strong>Admin → IAM → Settings → Re-encrypt to current key</strong>. Clear{" "}
        <C>PROVIDER_CREDS_SECRET_OLD</C> once nothing is left on the old key. Stored ciphertext
        carries a fingerprint of the key that wrote it, so the platform knows which secret decrypts
        which row.
      </Callout>

      <Callout kind="info" title="Or keep the key in Vault">
        With <C>KMS_PROVIDER=vault</C> the key that encrypts credentials is a data key wrapped by a
        HashiCorp Vault Transit key that never leaves Vault, unwrapped once per process start — the
        app holds a permission to decrypt, not the key, and a process that cannot unwrap refuses to
        start. Set <C>KMS_KEY_REF</C> and the <C>VAULT_*</C> variables, create the data key on{" "}
        <strong>Admin → IAM → Settings → Credential encryption key</strong>, then switch the
        provider and run the same re-encrypt sweep; the env secret keeps decrypting old rows until
        it has moved them. Details and the failure modes in <C>docs/KEY_MANAGEMENT.md</C>.
      </Callout>

      <H3 id="recipe-fleet">Autoscaled behind a load balancer</H3>
      <P>
        Several app instances against one Supabase project. Rate limits and concurrency slots are
        counted in Postgres, so the numbers you set are the numbers you get — but two settings need
        to match the topology.
      </P>
      <Code lang="bash">{`# MUST be set: instances resolve their own origin from this, never from the
# request's Host header.
PUBLIC_APP_URL="https://app.example.com"

# A dedicated secret for server-to-server calls, so the database master key
# stays out of outbound headers.  openssl rand -hex 32
INTERNAL_RUN_SECRET="..."

# CDN in front of the load balancer? Then two hops, not one.
TRUSTED_PROXY_HOPS="2"

# Alerts, refreshes and purges run in-process. A cross-instance lease stops
# them double-firing, but the tidier arrangement on a fleet is to disable
# them on the web tier and drive /api/bi/cron from one external scheduler.
DISABLE_INPROCESS_SCHEDULER="true"
BI_CRON_TOKEN="..."`}</Code>

      <NextPrev current="/docs/self-hosting/configuration" />
    </>
  );
}
