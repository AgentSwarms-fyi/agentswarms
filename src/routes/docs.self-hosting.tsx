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
      <Code lang="bash">{`./scripts/setup.sh --docker`}</Code>
      <Code lang="powershell">{`powershell -ExecutionPolicy Bypass -File scripts\\setup.ps1`}</Code>
      <P>
        Add <C>--dev</C> for a local dev server instead of containers, <C>--docgen</C> for the
        server-side Office renderer, and <C>--notebooks</C> for the Developer-workspace runtime.
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
          [<C key="f">SUPABASE_PROJECT_ID</C>, "Project ref, used by the CLI for migrations"],
          [<C key="g">VITE_SUPABASE_PROJECT_ID</C>, "Same, client side"],
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
          [<C key="d">OPENAI_API_KEY</C>, "Workspace-wide OpenAI key"],
          [
            <C key="e">FIRECRAWL_API_KEY</C>,
            "Workspace-wide web search and page fetching for the web_search / web_browse tools",
          ],
        ]}
      />

      <H3 id="env-email">Email delivery</H3>
      <P>
        Needed for invitations, alert notifications and scheduled reports. Use{" "}
        <strong>either</strong> Resend or SMTP.
      </P>
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
        ]}
      />
      <Callout kind="info">
        These limits are counted <strong>per application process</strong>. Behind a load balancer
        with N instances the effective limit is N times the value.
      </Callout>

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
        ]}
      />
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
        ]}
      />
      <Code lang="bash">{`docker compose --profile docgen --profile notebooks up -d --build`}</Code>
      <P>
        Both are optional. Without the renderer, documents are generated in the browser and Deep
        mode is greyed out with the reason. Without the notebook runtime, notebooks fall back to the
        in-browser Python runtime.
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
            name: "Cloudflare Workers",
            body: "Supported for the app tier. Note that Workers cannot host the optional Python services, so document generation stays in-browser and the notebook runtime is unavailable.",
          },
          {
            name: "Kubernetes",
            body: "Manifests are provided for the app and the notebook runtime, including the egress policy that keeps kernels off the open internet.",
          },
        ]}
      />

      <H2 id="scaling">Scaling</H2>
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
          <strong>Per-process limits.</strong> Rate and concurrency limits are counted per process,
          so N instances means N times the limit. Use{" "}
          <DocLink to="/docs/budgets">budget caps</DocLink> for the ceiling that actually holds.
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
            body: "Supabase holds all durable state. Use its backups, and store PROVIDER_CREDS_SECRET separately — a database backup without it is unreadable for credentials.",
          },
          {
            name: "Upgrades",
            body: "Pull, rebuild, then push migrations. Migrations are additive; check the release notes before skipping several versions.",
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
