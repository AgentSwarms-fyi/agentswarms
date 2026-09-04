import { createFileRoute } from "@tanstack/react-router";
import {
  C,
  Callout,
  Code,
  DocLink,
  DocsHeader,
  FieldList,
  H2,
  H3,
  H4,
  NextPrev,
  P,
  Steps,
  Table,
  UL,
} from "@/components/docs/DocsShell";

export const Route = createFileRoute("/docs/self-hosting")({
  head: () => ({
    meta: [
      { title: "Install & deploy — AgentSwarms Documentation" },
      {
        name: "description",
        content:
          "Run AgentSwarms yourself: Docker or local dev, required environment, database migrations, optional services, scaling and backups.",
      },
      { property: "og:title", content: "Install & deploy — AgentSwarms Documentation" },
      { property: "og:description", content: "Self-host the platform, end to end." },
      { property: "og:url", content: "https://agentswarms.fyi/docs/self-hosting" },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: "https://agentswarms.fyi/docs/self-hosting" }],
  }),
  component: SelfHostingPage,
});

function SelfHostingPage() {
  return (
    <>
      <DocsHeader
        eyebrow="Self-hosting"
        title="Install & deploy"
        description="Run the whole platform on your own infrastructure. You need a Supabase project for the database and auth, and either Docker or Node."
      />

      <H2 id="quick">One-command setup</H2>
      <P>
        The setup script scaffolds <C>.env</C>, generates the encryption secrets, applies database
        migrations and starts the stack.
      </P>
      <Code lang="bash">{`./scripts/setup.sh --all`}</Code>
      <Code lang="powershell">{`powershell -ExecutionPolicy Bypass -File scripts\\setup.ps1 -All`}</Code>
      <P>
        <C>--all</C> brings up <em>every</em> service and is the right default for a full install.
        Without it you get the app alone: add <C>--docgen</C> for the server-side Office renderer,{" "}
        <C>--notebooks</C> for the Developer-workspace Python runtime, or <C>--sandbox</C> for
        custom code in deployed swarms. <C>--dev</C> runs a local dev server instead of containers.
      </P>
      <P>
        It cannot create your Supabase project or guess its keys — it writes the <C>.env</C>, tells
        you which values to fill in, and you re-run it.
      </P>

      <H2 id="manual">Manual setup</H2>
      <Steps
        items={[
          {
            title: "Create a Supabase project",
            body: "It provides Postgres, authentication and storage. Note the project URL, publishable key and service-role key.",
          },
          {
            title: "Fill in .env",
            body: (
              <>
                Copy <C>.env.example</C> and set the required values below.
              </>
            ),
          },
          {
            title: "Apply migrations",
            body: (
              <>
                <C>npx supabase link --project-ref &lt;ref&gt;</C> then <C>npx supabase db push</C>.
                This creates every table, policy and storage bucket.
              </>
            ),
          },
          {
            title: "Start it",
            body: (
              <>
                <C>docker compose up -d --build</C>, or <C>npm install &amp;&amp; npm run dev</C>.
                Open <C>http://localhost:8080</C>.
              </>
            ),
          },
        ]}
      />
      <Callout kind="warn" title="Migrations are not optional">
        Features whose migrations haven't been applied fail quietly rather than loudly — a storage
        bucket that doesn't exist means uploads silently don't persist, and a missing column means a
        setting has nowhere to save. After any upgrade, run <C>npx supabase db push</C> before
        concluding a feature is broken.
      </Callout>

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
            <C key="d">OPENAI_API_KEY</C>,
            "Workspace-wide OpenAI key for chat. NOT needed for Knowledge Base embeddings — those use whichever provider is connected.",
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
        contact form. Use <strong>either</strong> Resend or SMTP. Auth emails (confirmation,
        password reset) are separate — Supabase sends those, configured in its own dashboard.
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

      <H2 id="optional-services">Optional services</H2>
      <Table
        headers={["Service", "Profile", "What it adds"]}
        rows={[
          [
            "Doc-gen renderer",
            <C key="p1">--profile docgen</C>,
            'Server-side PowerPoint/Word/Excel via python-pptx, python-docx, openpyxl and LibreOffice — the "Deep" generation mode.',
          ],
          [
            "Notebook runtime",
            <C key="p2">--profile notebooks</C>,
            "Real Python kernels for the Developer workspace, with a gateway and a default-deny egress proxy.",
          ],
          [
            "JS sandbox",
            <C key="p3">--profile sandbox</C>,
            "Runs Function nodes and custom components in deployed and scheduled swarms, in a locked-down container instead of next to the app's credentials.",
          ],
        ]}
      />
      <Code lang="bash">{`docker compose --profile docgen --profile notebooks --profile sandbox up -d --build`}</Code>
      <P>
        Or let the setup script start everything: <C>bash scripts/setup.sh --all</C> (
        <C>powershell -File scripts\setup.ps1 -All</C> on Windows).
      </P>
      <P>
        All three are optional, and each degrades to something rather than breaking. Without the
        renderer, documents are generated in the browser and Deep mode is greyed out with the
        reason. Without the notebook runtime, notebooks fall back to the in-browser Python runtime.
        Without the sandbox, custom code still runs on the canvas and the Deploy dialog says plainly
        that it will fail in headless runs.
      </P>
      <P>
        <strong>Observability → Monitoring</strong> (superadmin) shows which of these are actually
        up on this deployment, with the address that answered and live CPU, memory and disk. A
        profile you chose not to start reads &ldquo;Not running&rdquo; rather than as a failure.
      </P>

      <H2 id="deploy-targets">Deployment targets</H2>
      <FieldList
        items={[
          {
            name: "Docker Compose",
            body: "The default. One app container plus whichever optional profiles you enable. Good to a substantial team on one host.",
          },
          {
            name: "Node behind a reverse proxy",
            body: "Build and run the server directly. Terminate TLS at your proxy.",
          },
          {
            name: "Autoscaled VMs behind a load balancer",
            body: "The app tier is stateless, so run as many identical containers as you need. Set DISABLE_INPROCESS_SCHEDULER=1 and drive background work from one external cron.",
          },
          {
            name: "Kubernetes",
            body: (
              <>
                Reference manifests ship for the app (<C>deploy/k8s/app/</C>) and the notebook
                runtime (<C>deploy/k8s/notebooks/</C>), including the egress policy that keeps
                kernels off the open internet. Three things bite in practice: set{" "}
                <C>resources.limits.cpu</C>, because the worker count follows it; probe liveness on{" "}
                <C>/api/health</C> and readiness on <C>/api/health/ready</C>, which answer different
                questions; and strip the quotes from <C>.env</C> before{" "}
                <C>kubectl create secret --from-env-file</C> — unlike Docker Compose it keeps them,
                and every pod then fails readiness with <C>Invalid supabaseUrl</C>.
              </>
            ),
          },
        ]}
      />

      <H3 id="kubernetes">Kubernetes, in detail</H3>
      <P>
        <strong>Fully self-hosted, one command.</strong> Supabase runs in your cluster too — nothing
        leaves it, and nothing is optional:
      </P>
      <Code lang="bash">{`ADMIN_EMAIL=you@corp.com ADMIN_PASSWORD='...' bash scripts/setup-k8s.sh
kubectl -n agentswarms port-forward svc/agentswarms 8080:80`}</Code>
      <P>
        Needs <C>kubectl</C>, <C>helm</C> and a cluster. It generates every secret — including the
        anon and service-role keys <strong>signed</strong> from the JWT secret, since they are JWTs
        and a random string there gives you a stack that starts and then rejects every request —
        installs Supabase, applies the schema, creates your admin user, then starts the app with the
        Office renderer, the JS sandbox and the lakehouse catalog. Re-running is safe.
      </P>
      <Callout title="Supabase comes from the community Helm chart, on purpose">
        Self-hosted Supabase is a dozen services whose bootstrap SQL, roles and per-service
        environment change between versions. An earlier version of this page shipped hand-written
        manifests for them; it took five fixes before Postgres would start, the last being the role
        bootstrap (<C>authenticator</C>, <C>anon</C>, <C>supabase_auth_admin</C>) that a bare{" "}
        <C>supabase/postgres</C> image does not create. That is upstream&rsquo;s wiring, and
        maintaining a second copy of it guarantees falling behind. The chart is pinned by{" "}
        <C>SUPABASE_CHART_VERSION</C>; our own four Deployments stay as plain manifests.
      </Callout>
      <P>
        <strong>Deploying to a cloud cluster? Push the images first.</strong> The command above
        defaults to the three images this repo builds locally. A local cluster — Docker Desktop,
        kind, minikube, k3d — shares the machine&rsquo;s image store and runs them as they are. No
        other cluster can: its nodes pull from a registry, and an image that exists only on your
        laptop ends in <C>ImagePullBackOff</C>. Push all three and name them:
      </P>
      <Code lang="bash">{`AGENTSWARMS_IMAGE=ghcr.io/you/agentswarms:1.2.3 \\
DOCGEN_IMAGE=ghcr.io/you/docgen:1.2.3 \\
JS_SANDBOX_IMAGE=ghcr.io/you/js-sandbox:1.2.3 \\
ADMIN_EMAIL=you@corp.com ADMIN_PASSWORD='...' bash scripts/setup-k8s.sh`}</Code>
      <P>
        The installer substitutes all three as it applies the manifests, and warns before it starts
        if the current context does not look local while the images still do. Beyond that, the
        manifests use only core APIs and name no <C>StorageClass</C>, so every volume takes the
        cluster&rsquo;s default. What still needs a decision per cloud: an Ingress or{" "}
        <C>LoadBalancer</C> in front of <C>svc/agentswarms</C> and Kong; a CNI that actually
        enforces <C>NetworkPolicy</C> (Calico, Cilium, GKE Dataplane V2, AKS or EKS with policy
        enabled) or the sandbox&rsquo;s egress ban is inert; and roughly 3 CPU and 6 GiB of requests
        for our pods before the Supabase chart&rsquo;s own.
      </P>
      <Callout title="The Office renderer is the one pod a `restricted` cluster refuses">
        Every workload was applied to a namespace enforcing the <C>restricted</C> Pod Security
        Standard. Web, analytics, the JS sandbox, the lakehouse catalog and the BI CronJob were all
        admitted — the sandbox reached Ready, the catalog ran as uid 999, the cron pod as uid 100
        with writes to <C>/</C> refused. <C>agentswarms-docgen</C> was rejected: its image runs as
        root, so it cannot assert <C>runAsNonRoot</C>. The failure is quiet — <C>kubectl apply</C>{" "}
        only warns, the Deployment is created, and then no pod ever appears. Until the image is
        fixed, give that one Deployment a namespace at <C>baseline</C>, or drop it and lose Office
        export while everything else keeps working.
      </Callout>
      <P>
        <strong>Bringing your own Supabase</strong> (Cloud, or one you already run)?{" "}
        <C>deploy/k8s/app/agentswarms.yaml</C> is the app on its own — namespace, web{" "}
        <C>Deployment</C>, optional analytics <C>Deployment</C>, <C>Service</C>, an HPA and the cron{" "}
        <C>CronJob</C>. It has been applied to a real cluster; the notes below are what failed
        there.
      </P>
      <Code lang="bash">{`# kubectl keeps the quotes docker compose strips
sed -E 's/^([A-Za-z_][A-Za-z0-9_]*)="(.*)"$/\\1=\\2/' .env > .env.k8s
kubectl create secret generic agentswarms-env -n agentswarms --from-env-file=.env.k8s && rm .env.k8s
kubectl apply -f deploy/k8s/app/agentswarms.yaml`}</Code>
      <FieldList
        items={[
          {
            name: "Strip quotes from .env first",
            body: (
              <>
                Docker Compose removes the quotes around a value; <C>kubectl create secret</C> keeps
                them, so <C>SUPABASE_URL</C> arrives as a literal <C>&quot;https://…&quot;</C>.
                Every pod then fails readiness with <C>Invalid supabaseUrl</C> and the Service ends
                up with no endpoints at all.
              </>
            ),
          },
          {
            name: "Always set resources.limits.cpu",
            body: (
              <>
                The worker count follows the pod&rsquo;s CPU limit. With no limit, a pod on a
                64-core node forks 64 workers at ~0.5&ndash;1 GB each and is OOMKilled — a crash
                loop with no obvious cause. Measured on an 8-core node: <C>cpu: &quot;2&quot;</C>{" "}
                gives two workers, <C>cpu: 500m</C> gives one.
              </>
            ),
          },
          {
            name: "Probe liveness and readiness separately",
            body: (
              <>
                Liveness on <C>/api/health</C> decides restarts; readiness on{" "}
                <C>/api/health/ready</C> decides routing. A pool that probes only liveness keeps
                sending traffic to pods that cannot reach the database.
              </>
            ),
          },
          {
            name: "No readiness probe on analytics pods",
            body: (
              <>
                <C>APP_ROLE=analytics</C> answers readiness 503 for ever, and Kubernetes gates
                rollout progress on readiness — so a new pod never becomes Ready, the old one is
                never retired, and <C>kubectl rollout status</C> hangs on &ldquo;1 old replicas are
                pending termination&rdquo;. Exclude those pods from the <C>Service</C> by label
                instead, as the shipped manifest does.
              </>
            ),
          },
          {
            name: "Add what Compose was defaulting for you",
            body: (
              <>
                <C>docker-compose.yml</C> fills a dozen values with <C>${"{VAR:-default}"}</C> and
                Kubernetes has no equivalent, so a Secret built from that <C>.env</C> is missing
                them and the pod stops with <C>couldn&apos;t find key … in Secret</C>. Three matter:{" "}
                <C>BI_CRON_TOKEN</C> (the CronJob), <C>INTERNAL_RUN_SECRET</C> (the JS sandbox,
                which Compose defaulted to the service-role key) and{" "}
                <C>LAKEHOUSE_CATALOG_PASSWORD</C> (the catalog, which Compose defaulted to{" "}
                <C>change-me</C>).
              </>
            ),
          },
          {
            name: "Optional services get their own pods",
            body: (
              <>
                <C>deploy/k8s/app/services.yaml</C> covers the Office renderer, the JS sandbox and
                the lakehouse catalog — each its own Deployment and <C>Service</C>, found by the
                same name the app uses under Compose. The catalog is a <C>StatefulSet</C> with a
                volume rather than a Deployment, because it holds the one part of the lakehouse that
                cannot be rebuilt from object storage; in production prefer a managed Postgres. The
                notebook runtime is separate again, in <C>deploy/k8s/notebooks/</C>.
              </>
            ),
          },
          {
            name: "Hardened by default",
            body: (
              <>
                The image drops to a non-root user, and both app Deployments run <C>runAsNonRoot</C>{" "}
                with a read-only root filesystem, all capabilities dropped and no Kubernetes API
                token mounted — <C>/tmp</C> is an <C>emptyDir</C> because the lakehouse engine
                spills there. The JS sandbox, which runs user-supplied code, adds a{" "}
                <C>NetworkPolicy</C> denying it egress outright (your CNI has to enforce policy —
                Docker Desktop&rsquo;s default does not).
              </>
            ),
          },
          {
            name: "Monitoring shows one pod, not the fleet",
            body: (
              <>
                <strong>Observability → Monitoring</strong> reports the replica that answered — the
                page names it, and on Kubernetes that name is the pod. For fleet-wide numbers use
                your cluster metrics; this page is for looking at one instance and at what is down.
              </>
            ),
          },
        ]}
      />

      <H2 id="scaling">Scaling</H2>
      <H3 id="scaling-up">One machine, all of it</H3>
      <P>
        A single instance already uses the whole machine. The container entrypoint forks{" "}
        <strong>one worker per available CPU</strong> and they share the port, so a 16- or 64-core
        host is used without configuration. Rendering a page costs roughly 30 ms of CPU, and that is
        what the extra workers buy — static assets were never the bottleneck.
      </P>
      <P>
        &quot;Available&quot; means the CPU quota, not the host: in a container the count is capped
        by the cgroup limit, so <C>--cpus=2</C> forks two however large the machine underneath is.
        Override with <C>WEB_CONCURRENCY</C> only on purpose — <C>1</C> is the right value when you
        run many small one-core containers instead, so workers don&apos;t fight over a fraction of a
        CPU. The number chosen is logged at startup.
      </P>
      <P>
        Two things behave differently once workers multiply. The scheduler does <strong>not</strong>{" "}
        — it holds a fleet-wide lease, so exactly one sweep runs no matter how many workers or
        replicas exist. The lakehouse query engine <strong>does</strong>: it lives in each process,
        so its memory limit applies per worker. A 16-core host at <C>LAKEHOUSE_MEMORY_LIMIT=16GB</C>{" "}
        is 256 GB of intent, not 16 — size that limit against host RAM divided by workers. It is a
        ceiling rather than a reservation, so idle workers hold nothing, but the worst case is what
        an out-of-memory kill needs.
      </P>
      <H3 id="scaling-analytics">Analytics-only nodes</H3>
      <P>
        A heavy lakehouse query and a page render share one Node process, so a thirty-second{" "}
        <C>GROUP BY</C> can stall interactive traffic on the node running it. Set{" "}
        <C>APP_ROLE=analytics</C> on the nodes you want kept out of the request path. Such a node
        reports <strong>not ready</strong> at <C>/api/health/ready</C> while staying{" "}
        <strong>alive</strong> at <C>/api/health</C> — readiness decides routing and liveness
        decides restarts, so it drains itself out of the interactive pool with no load-balancer
        feature required, and nothing restarts it. Point your readiness check at{" "}
        <C>/api/health/ready</C> for this to work.
      </P>
      <P>
        It also defaults to a <strong>single worker</strong>, because the engine is per process:
        forking would split the large memory limit you set into independent copies that could each
        claim the whole figure. <C>WEB_CONCURRENCY</C> still overrides. Scheduled work — BI
        refreshes, materialized-view rebuilds — still runs there, which is the point; pair it with{" "}
        <C>DISABLE_INPROCESS_SCHEDULER</C> on the interactive tier. The role is a routing
        declaration, not access control, so pointing a browser straight at one still works.
      </P>
      <H3 id="scaling-out">Then more machines</H3>
      <P>
        The app tier is stateless — no sticky sessions needed, so put as many instances behind a
        load balancer as you like. Two things need attention when you do:
      </P>
      <UL>
        <li>
          <strong>The scheduler.</strong> Alerts, refreshes and purges run in-process. A
          cross-instance lease prevents double-firing, but the tidier arrangement is{" "}
          <C>DISABLE_INPROCESS_SCHEDULER</C> on the web tier and one external cron hitting the cron
          endpoint.
        </li>
        <li>
          <strong>Limits hold across the fleet.</strong> Rate limits and concurrency slots are
          counted in Postgres, so the number you configure is the number you get however many
          instances are running. If the database is briefly unreachable an instance falls back to
          counting locally and logs that it has — the limit weakens rather than vanishing. Budget
          caps are the other ceiling, and they are counted the same way; see{" "}
          <DocLink to="/docs/budgets">Budgets</DocLink>.
        </li>
        <li>
          <strong>Set the proxy depth.</strong> <C>TRUSTED_PROXY_HOPS</C> must match how many
          proxies of yours sit in front — <C>1</C> for a load balancer alone, <C>2</C> with a CDN in
          front of it. MCP key IP allow-lists are checked against the address it selects.
        </li>
      </UL>
      <P>
        The notebook Docker runtime is single-host by design — it launches containers on the host it
        runs on. Use the Kubernetes orchestrator to spread it.
      </P>

      <H2 id="operations">Operations</H2>
      <FieldList
        items={[
          {
            name: "Health",
            body: <>A health endpoint reports process liveness — point your load balancer at it.</>,
          },
          {
            name: "Backups",
            body: "A self-hosted install has four things that cannot be regenerated: the application database, the lakehouse catalog (a separate Postgres that knows which Parquet files make up each table and every snapshot), the lakehouse data (Parquet in your bucket) and the secrets in .env. `npm run backup` captures the first three into backups/<timestamp>/ and lists the fourth by name — PROVIDER_CREDS_SECRET decrypts every stored credential and PROVENANCE_SIGNING_SECRET verifies every Answer Passport, so store both in your secret manager; values are never written to a backup. Give it a database credential (--db-url for self-hosted Supabase, SUPABASE_DB_PASSWORD for a linked hosted project) or that step is skipped and recorded in manifest.json — it never prompts, so it is safe to schedule. Rehearse before you need it: `npm run restore -- backups/<timestamp> --drill` restores into scratch targets, compares, cleans up and prints DRILL PASSED. Real restores opt into --catalog, --lake and --supabase and require --yes. Full runbook, including the order for a host migration, in docs/DEPLOYMENT.md.",
          },
          {
            name: "Upgrades",
            body: "Take a backup first (npm run backup), then pull, rebuild (docker compose up -d --build) and run npx supabase db push --include-all. Migrations only add and are never reverted, so the rollback is the backup plus a git checkout of the previous tag. Check the release notes before skipping several versions.",
          },
          {
            name: "Logs",
            body: "Container logs for the platform; in-app Traces for what agents did. They answer different questions — reach for Traces first when an agent misbehaves.",
          },
        ]}
      />

      <H3 id="hardening">Before you expose it</H3>
      <UL>
        <li>
          Turn off public signup, or enforce SSO — <DocLink to="/docs/iam">Access control</DocLink>.
        </li>
        <li>
          Set <C>ENFORCE_BUDGET_CAP</C> and give every embed and API key a cap.
        </li>
        <li>Serve over TLS; the service-role key must never reach a browser.</li>
        <li>Restrict embed keys to your own domains.</li>
        <li>Review retention windows for chats, transcripts and audit.</li>
        <li>
          Back up <C>PROVIDER_CREDS_SECRET</C> somewhere you can actually retrieve it.
        </li>
      </UL>

      <Callout kind="info">
        Install problems and their fixes are collected in <C>docs/INSTALL.md</C> in the repository,
        which is kept up to date as issues are found.
      </Callout>

      <NextPrev current="/docs/self-hosting" />
    </>
  );
}
