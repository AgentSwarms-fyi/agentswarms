import { createFileRoute } from "@tanstack/react-router";
import {
  C,
  Callout,
  CardGrid,
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
      <Code lang="bash">{`bash scripts/setup.sh --all`}</Code>
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
      <H2 id="guide">In this guide</H2>
      <P>
        Setup and the deployment targets are on this page. The reference and the operating detail
        have pages of their own.
      </P>
      <CardGrid
        items={[
          {
            to: "/docs/self-hosting/configuration",
            title: "Configuration",
            body: "Every variable, and the settings for each way of running it.",
          },
          {
            to: "/docs/self-hosting/kubernetes",
            title: "Kubernetes",
            body: "Manifests, then EKS, GKE, AKS and OKE step by step.",
          },
          {
            to: "/docs/self-hosting/operations",
            title: "Operations",
            body: "Scaling, availability, residency, hardening.",
          },
        ]}
      />

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
          [
            "Lakehouse catalog",
            <C key="p4">--profile lakehouse</C>,
            "A Postgres of its own holding the lakehouse's table definitions. Without one — this, or your own in LAKEHOUSE_CATALOG_URL — the lakehouse, SQL models and ML stay off.",
          ],
          [
            "Spark cluster",
            <C key="p5">--profile spark</C>,
            "A Spark Connect endpoint for the ETL Spark engine and lakehouse queries on Spark. Idle until SPARK_CONNECT_URL names it; the image is about a gigabyte and it downloads its connector jars on first use.",
          ],
          [
            "Vector store",
            <C key="p6">--profile vectors</C>,
            "Qdrant, for deployments whose knowledge-base index has outgrown the application database. Idle until VECTOR_STORE=qdrant names it, and retrieval stays on pgvector until it does.",
          ],
          [
            "Online feature store",
            <C key="p7">--profile featurestore</C>,
            "Valkey, holding a feature view's latest row per key so a prediction answers in milliseconds instead of reading the lakehouse. Idle until FEATURE_STORE_URL names it; every lookup reads the lakehouse until it does, which is correct and about sixty times slower.",
          ],
        ]}
      />
      <Code lang="bash">{`docker compose --profile all up -d --build`}</Code>
      <P>
        Or let the setup script start everything: <C>bash scripts/setup.sh --all</C> (
        <C>powershell -File scripts\setup.ps1 -All</C> on Windows).
      </P>
      <P>
        Every one is optional, and each degrades to something rather than breaking. Without the
        renderer, documents are generated in the browser and Deep mode is greyed out with the
        reason. Without the notebook runtime, opening a notebook shows a panel saying a runtime is
        required — there is no in-browser fallback. Without the sandbox, custom code still runs on
        the canvas and the Deploy dialog says plainly that it will fail in headless runs. Without
        the feature store, feature lookups read the lakehouse exactly as they did before it existed.
        The last four are inert until an environment variable points at them: start the Spark or
        vector profile without setting <C>SPARK_CONNECT_URL</C> or <C>VECTOR_STORE</C> and the
        container runs while nothing uses it.
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
      <P>
        Kubernetes — the manifests and a walk-through per cloud — has{" "}
        <DocLink to="/docs/self-hosting/kubernetes">its own page</DocLink>.
      </P>
      <Callout kind="info">
        Install problems and their fixes are collected in <C>docs/INSTALL.md</C> in the repository,
        which is kept up to date as issues are found.
      </Callout>

      <NextPrev current="/docs/self-hosting" />
    </>
  );
}
