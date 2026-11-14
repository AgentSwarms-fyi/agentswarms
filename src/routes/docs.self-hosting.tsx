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
      <Code lang="bash">{`bash scripts/setup.sh`}</Code>
      <Code lang="powershell">{`powershell -ExecutionPolicy Bypass -File scripts\\setup.ps1`}</Code>
      <P>
        <strong>Every service is installed and wired</strong> — the Office renderer, the JS sandbox,
        the Developer-workspace Python runtime and its egress proxy, the lakehouse catalog and its
        object store, the vector store, the feature store and the Spark cluster — and <C>.env</C>{" "}
        points at all of them. There are no profiles and nothing to opt into: a feature that depends
        on which flag an installer was given is a feature most installs never see. Budget about 5 GB
        of images and 8 GB of RAM. <C>--dev</C> runs the app on this host with a dev server and
        starts the same services beside it, reached on loopback.
      </P>
      <P>
        It cannot create your Supabase project or guess its keys — it writes the <C>.env</C>, tells
        you which values to fill in, and you re-run it.
      </P>

      <H2 id="release">Run a release, or build from source</H2>
      <P>
        Each release publishes its images to <C>ghcr.io/agentswarms-fyi</C>, for amd64 and arm64,
        signed and with an SBOM and build provenance. Set <C>AGENTSWARMS_VERSION</C> in <C>.env</C>{" "}
        to run one: the setup script then pulls that release&apos;s images and starts them, and
        never builds. Leave it empty and the images are built from your checkout. Check out the
        release&apos;s tag either way, since the migrations come from the checkout.
      </P>
      <Code lang="bash">{`git fetch --tags && git checkout v1.7.0
# in .env:  AGENTSWARMS_VERSION="1.7.0"
bash scripts/setup.sh`}</Code>
      <P>
        A version that cannot be pulled stops the setup rather than building your checkout under the
        release&apos;s name, and for the same reason never pass <C>--build</C> to Docker Compose
        while a version is set. <C>AGENTSWARMS_REGISTRY</C> points at your own mirror for an
        air-gapped install. Observability → Monitoring shows which release each instance runs, or
        &ldquo;built from source&rdquo;. To check a signature:
      </P>
      <Code lang="bash">{`cosign verify ghcr.io/agentswarms-fyi/agentswarms:1.7.0 \\
  --certificate-identity-regexp '^https://github\\.com/AgentSwarms-fyi/agentswarms/\\.github/workflows/release\\.yml@refs/tags/v' \\
  --certificate-oidc-issuer https://token.actions.githubusercontent.com`}</Code>
      <P>
        Upgrading and rolling back are under{" "}
        <DocLink to="/docs/self-hosting/operations" hash="operations">
          Operations
        </DocLink>
        .
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
            body: "The settings for each way of running it, explained.",
          },
          {
            to: "/docs/self-hosting/settings",
            title: "All settings",
            body: "Every variable the server reads, from .env.example, with a filter.",
          },
          {
            to: "/docs/self-hosting/kubernetes",
            title: "Kubernetes",
            body: "The Helm chart and the manifests, then EKS, GKE, AKS and OKE step by step.",
          },
          {
            to: "/docs/self-hosting/aws",
            title: "AWS",
            body: "VMs, ECS or EKS with Terraform, and a local rehearsal on AWS Emulator.",
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
                <C>npx supabase link --project-ref &lt;ref&gt;</C> then{" "}
                <C>npx supabase db push --remote</C>. This creates every table, policy and storage
                bucket.
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
        setting has nowhere to save. After any upgrade, run <C>npx supabase db push --remote</C>{" "}
        before concluding a feature is broken.
      </Callout>
      <Callout kind="info" title="Rebuild every image after an upgrade">
        <C>docker compose up -d --build</C> with no service name rebuilds them all. Naming one, such
        as <C>agentswarms</C>, rebuilds only that image: the document renderer and the notebook
        kernel image keep the Python packages they were built with, security fixes included. The
        changelog says which images a release needs rebuilt.
      </Callout>
      <P>
        Each image starts from a base pinned by digest, so rebuilding alone never changes the
        operating system underneath. A base&apos;s security update arrives as a Dependabot pull
        request that moves the digest, and the repository&apos;s weekly image scan fails when an
        image has a critical CVE with a fix, unless <C>.github/grype-baseline.yaml</C> lists it with
        a reason. The running containers have no <C>npm</C>; run npm commands on the host.
      </P>
      <H2 id="services">The services</H2>
      <Table
        headers={["Service", "Container", "What it adds"]}
        rows={[
          [
            "Doc-gen renderer",
            <C key="p1">docgen</C>,
            'Server-side PowerPoint/Word/Excel via python-pptx, python-docx, openpyxl and LibreOffice — the "Deep" generation mode.',
          ],
          [
            "Notebook runtime",
            <C key="p2">notebook-gateway</C>,
            "Real Python kernels for the Developer workspace, with a gateway and a default-deny egress proxy.",
          ],
          [
            "JS sandbox",
            <C key="p3">js-sandbox</C>,
            "Runs Function nodes and custom components in deployed and scheduled swarms, in a locked-down container instead of next to the app's credentials.",
          ],
          [
            "Lakehouse catalog",
            <C key="p4">lakehouse-catalog</C>,
            "A Postgres of its own holding the lakehouse's table definitions. Without one — this, or your own in LAKEHOUSE_CATALOG_URL — the lakehouse, SQL models and ML stay off.",
          ],
          [
            "Object store",
            <C key="p8">minio</C>,
            "Where the lakehouse Parquet files live. Replace it with S3, R2 or GCS by pointing LAKEHOUSE_S3_* at them.",
          ],
          [
            "Spark cluster",
            <C key="p5">spark-connect</C>,
            "A Spark Connect endpoint for the ETL Spark engine and lakehouse queries on Spark. Idle until SPARK_CONNECT_URL names it; the image is about a gigabyte and it downloads its connector jars on first use.",
          ],
          [
            "Vector store",
            <C key="p6">qdrant</C>,
            "Qdrant, for deployments whose knowledge-base index has outgrown the application database. Idle until VECTOR_STORE=qdrant names it, and retrieval stays on pgvector until it does.",
          ],
          [
            "Online feature store",
            <C key="p7">valkey</C>,
            "Valkey, holding a feature view's latest row per key so a prediction answers in milliseconds instead of reading the lakehouse. Idle until FEATURE_STORE_URL names it; every lookup reads the lakehouse until it does, which is correct and about sixty times slower.",
          ],
        ]}
      />
      <Code lang="bash">{`docker compose up -d --build`}</Code>
      <P>
        Or let the setup script start everything: <C>bash scripts/setup.sh</C> (
        <C>powershell -File scripts\setup.ps1</C> on Windows).
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
            body: "The default. Every service on one host, started by one command. Good to a substantial team on one host.",
          },
          {
            name: "Node behind a reverse proxy",
            body: "Build and run the server directly. Terminate TLS at your proxy.",
          },
          {
            name: "Autoscaled VMs behind a load balancer",
            body: (
              <>
                The app tier is stateless, so run as many identical containers as you need. Run the
                scheduler on two or more of them (an analytics pair with <C>APP_ROLE=analytics</C>,
                or any two) and set <C>DISABLE_INPROCESS_SCHEDULER=1</C> on the rest: a lease in the
                database keeps it to one pass at a time across the fleet.
              </>
            ),
          },
          {
            name: "AWS, with Terraform",
            body: (
              <>
                VMs behind a load balancer, Amazon ECS or Amazon EKS, each with RDS, S3, HTTPS and
                sandboxes on Fargate or a node pool of their own, from <C>deploy/aws/terraform</C>.
                See <DocLink to="/docs/self-hosting/aws">AWS</DocLink>.
              </>
            ),
          },
          {
            name: "Kubernetes",
            body: (
              <>
                The Helm chart <C>deploy/helm/agentswarms</C> installs the app, Supabase&apos;s
                services against your own PostgreSQL, and sandboxes in a namespace of their own (the
                AWS EKS target installs it for you). Reference manifests also ship for the app (
                <C>deploy/k8s/app/</C>) and the notebook runtime (<C>deploy/k8s/notebooks/</C>),
                including the egress policy that keeps kernels off the open internet. Three things
                bite in practice: set <C>resources.limits.cpu</C>, because the worker count follows
                it; probe liveness on <C>/api/health</C> and readiness on <C>/api/health/ready</C>,
                which answer different questions; and strip the quotes from <C>.env</C> before{" "}
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
