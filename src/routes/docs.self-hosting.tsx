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

      <H2 id="env">Required environment</H2>
      <Table
        headers={["Variable", "Purpose"]}
        rows={[
          [<C key="a">SUPABASE_URL</C>, "Project URL (server side)"],
          [<C key="b">SUPABASE_PUBLISHABLE_KEY</C>, "Anon key (server side)"],
          [
            <C key="c">SUPABASE_SERVICE_ROLE_KEY</C>,
            "Service role — server only, never exposed to the browser",
          ],
          [<C key="d">VITE_SUPABASE_URL</C>, "Same URL, inlined into the client bundle"],
          [<C key="e">VITE_SUPABASE_PUBLISHABLE_KEY</C>, "Same anon key, client side"],
          [<C key="f">ADMIN_EMAIL</C>, "Bootstrap superadmin account"],
          [<C key="g">VITE_ADMIN_EMAIL</C>, "Same address, for client-side admin affordances"],
          [
            <C key="h">PROVIDER_CREDS_SECRET</C>,
            "Encryption key for stored credentials — back this up",
          ],
          [<C key="i">INTERNAL_RUN_SECRET</C>, "Signs internal service-to-service calls"],
        ]}
      />
      <Callout kind="warn" title="PROVIDER_CREDS_SECRET is not recoverable">
        Every stored credential is encrypted with it. Lose it and every connector, provider key and
        MCP token must be re-entered. Keep it wherever you keep your other break-glass secrets.
      </Callout>

      <H3 id="optional-env">Useful optional settings</H3>
      <FieldList
        items={[
          {
            name: "OPENROUTER_API_KEY",
            body: "Zero-config model fallback so a fresh workspace works before anyone connects their own provider.",
          },
          { name: "FIRECRAWL_API_KEY", body: "Workspace-wide web search and page fetching." },
          {
            name: "ENFORCE_BUDGET_CAP",
            body: "Makes budget caps actually block rather than only alert. Set this on any instance with a public embed.",
          },
          {
            name: "DISABLE_INPROCESS_SCHEDULER",
            body: "For multi-instance deployments — see scaling below.",
          },
          {
            name: "DOCGEN_SERVICE_URL",
            body: "Only if the Office renderer runs somewhere unusual; it is auto-discovered otherwise.",
          },
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
