import { createFileRoute } from "@tanstack/react-router";
import {
  C,
  Callout,
  DocLink,
  DocsHeader,
  FieldList,
  H2,
  H3,
  NextPrev,
  P,
  UL,
} from "@/components/docs/DocsShell";

export const Route = createFileRoute("/docs/self-hosting_/operations")({
  head: () => ({
    meta: [
      { title: "Install & deploy · Operations — AgentSwarms Documentation" },
      {
        name: "description",
        content:
          "Scaling from one machine to many, keeping every service available, data residency, and the checks to make before exposing an instance.",
      },
      {
        property: "og:title",
        content: "Install & deploy · Operations — AgentSwarms Documentation",
      },
      { property: "og:description", content: "Scaling, availability, residency, hardening." },
      { property: "og:url", content: "https://agentswarms.fyi/docs/self-hosting/operations" },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: "https://agentswarms.fyi/docs/self-hosting/operations" }],
  }),
  component: SelfHostingOperationsPage,
});

function SelfHostingOperationsPage() {
  return (
    <>
      <DocsHeader
        eyebrow="Self-hosting"
        title="Install & deploy · Operations"
        description="Scaling from one machine to many, keeping every service available, data residency, and the checks to make before exposing an instance."
      />
      <P>
        Part of the <DocLink to="/docs/self-hosting">Install &amp; deploy</DocLink> guide. This page
        is for running the platform after it is up: scaling from one machine to many, keeping every
        service available, data residency, and the checks before exposing an instance.
      </P>

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
        It also defaults to a <strong>single worker</strong>, because each worker carries its own
        engine: forking would split the large memory limit you set into independent copies that
        could each claim the whole figure. <C>WEB_CONCURRENCY</C> still overrides. Scheduled work —
        BI refreshes, materialized-view rebuilds — still runs there, which is the point; pair it
        with <C>DISABLE_INPROCESS_SCHEDULER</C> on the interactive tier. The role is a routing
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

      <H3 id="high-availability">Keeping every service available</H3>
      <P>
        Two promises worth separating: <strong>availability</strong> is the service still answering
        when one instance is lost, and <strong>durability</strong> is the data still being there
        afterwards. Replicas buy the first and never the second. A single host has neither — what it
        does have is a restart policy and a health check on every service that can answer for
        itself, so a crashed <em>or wedged</em> container comes back on its own. Losing the host is
        a restore, not a failover.
      </P>
      <P>
        On Kubernetes every stateless tier already ships with <strong>two replicas</strong>, a
        topology spread so they do not share a node, and a <strong>PodDisruptionBudget</strong> so a
        drain or cluster upgrade cannot evict them all at once: the web tier, the analytics tier
        that carries the scheduler, the Office renderer, the JS sandbox, the notebook gateway and
        the sandbox egress proxy. Running the scheduler on more than one is safe because each pass
        is claimed through a lease with an atomic conditional update.
      </P>
      <Callout kind="warn" title="Three things need a decision from you">
        The <strong>lakehouse catalog</strong> and <strong>Supabase</strong> are Postgres databases
        that nothing else can rebuild — without the catalog, the Parquet in your bucket is files
        nobody can name. Point both at managed Postgres with a standby and delete the in-cluster
        StatefulSet. <strong>Object storage</strong> needs durability rather than replicas: S3, GCS
        or R2 in production, never the single-node MinIO the local setup uses.
      </Callout>
      <P>
        Verify with <C>kubectl -n agentswarms get deploy,statefulset,pdb</C>: every Deployment
        should report at least two ready, each with a budget beside it. The full per-service table,
        including what breaks when each one is lost, is in <C>docs/DEPLOYMENT.md</C> under High
        availability.
      </P>

      <H3 id="residency">Data residency: one deployment per region</H3>
      <P>
        "Multi-region" gets asked for in two quite different senses. <strong>Failover</strong> — a
        second region already holding the same data, serving it the moment the first one goes —
        needs a database that is multi-master across regions, and this platform does not do it; the
        answer there is the restore runbook. <strong>Residency</strong> — this customer's data must
        stay inside this jurisdiction — is the one enterprises usually mean, has nothing to do with
        failover, and is supported today by the plainest mechanism available:{" "}
        <strong>run a separate deployment in each region</strong>.
      </P>
      <P>
        Nothing ties one install to another. A deployment is pinned to its data entirely by
        environment — <C>SUPABASE_URL</C>, the lake bucket and catalog, the key ring — and there is
        no notion of a region, an instance id or a registry of peers anywhere in the code. Two
        deployments are two installs that happen to run the same image, each deployed, upgraded,
        backed up and restored exactly as a single one is. Route people to theirs with DNS, or from
        your identity provider: one SAML/OIDC application per deployment, which is also what gives
        each region its own SCIM sync.
      </P>
      <P>
        What you get is that data written in a region stays there — rows, files, traces, audit,
        embeddings — with no replication link to switch off and no setting to get wrong, because
        there is no connection between them to begin with. What you give up is worth deciding on
        before you choose the shape:
      </P>
      <UL>
        <li>
          <strong>No cross-region anything.</strong> A query, dashboard, agent or knowledge base in
          one deployment cannot see another's data. A report spanning both is assembled outside the
          platform.
        </li>
        <li>
          <strong>No single pane of glass.</strong> Users, agents, IAM groups, budgets and audit are
          per deployment, and an administrator manages each one.
        </li>
        <li>
          <strong>A region's outage is that region's outage.</strong> Residency is not availability.
        </li>
        <li>
          <strong>Upgrades are per deployment</strong>, so versions drift unless you drive them
          together.
        </li>
      </UL>
      <Callout kind="warn" title="Residency for your data is not residency for your prompts">
        Every model call leaves for whatever endpoint that provider is configured with, and most
        vendors' default endpoints are global. If the requirement covers content sent for inference
        — in a regulated setting it usually does — configure a regional model endpoint as well:
        Bedrock takes a <C>region</C>, Azure OpenAI a resource endpoint of its own, Vertex a
        location. A deployment can be perfectly resident and still stream every prompt to another
        continent.
      </Callout>

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

      <NextPrev current="/docs/self-hosting/operations" />
    </>
  );
}
