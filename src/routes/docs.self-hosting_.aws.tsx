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

export const Route = createFileRoute("/docs/self-hosting_/aws")({
  head: () => ({
    meta: [
      { title: "Install & deploy · AWS — AgentSwarms Documentation" },
      {
        name: "description",
        content:
          "Deploy AgentSwarms on AWS with Terraform: VMs behind a load balancer, Amazon ECS, or Amazon EKS, with RDS, S3, HTTPS and sandboxes kept apart. Rehearse it locally on AWS Emulator first.",
      },
      { property: "og:title", content: "Install & deploy · AWS — AgentSwarms Documentation" },
      {
        property: "og:description",
        content: "Three Terraform targets on AWS, and a local rehearsal.",
      },
      { property: "og:url", content: "https://agentswarms.fyi/docs/self-hosting/aws" },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: "https://agentswarms.fyi/docs/self-hosting/aws" }],
  }),
  component: SelfHostingAwsPage,
});

function SelfHostingAwsPage() {
  return (
    <>
      <DocsHeader
        eyebrow="Self-hosting"
        title="Install & deploy · AWS"
        description="Deploy AgentSwarms on AWS with Terraform: VMs behind a load balancer, Amazon ECS, or Amazon EKS, with RDS, S3, HTTPS and sandboxes kept apart. Rehearse it locally on AWS Emulator first."
      />
      <P>
        Part of the <DocLink to="/docs/self-hosting">Install &amp; deploy</DocLink> guide. Three
        ways to run AgentSwarms on AWS come from the same Terraform modules, under{" "}
        <C>deploy/aws/terraform</C>. The full reference, with every input, is{" "}
        <C>docs/deploy/AWS.md</C> in the repository.
      </P>
      <Table
        headers={["Target", "Directory", "The app runs on", "Users' code runs on", "Pick it when"]}
        rows={[
          [
            "VMs behind a load balancer",
            <C key="d">vm/</C>,
            "An Auto Scaling group of EC2 instances, every service on each with Docker",
            "Fargate, one task per sandbox",
            "You want plain VMs you can reach (through SSM)",
          ],
          [
            "Amazon ECS",
            <C key="d">ecs/</C>,
            "ECS services on an EC2 Auto Scaling group; docgen and js-sandbox on Fargate",
            "Fargate, one task per sandbox",
            "You want AWS to run and roll the containers",
          ],
          [
            "Amazon EKS",
            <C key="d">eks/</C>,
            <>
              Kubernetes, from the Helm chart <C>deploy/helm/agentswarms</C>
            </>,
            "Pods on a tainted node pool of their own",
            "You run Kubernetes, or want the same chart elsewhere later",
          ],
        ]}
      />
      <P>
        All three share the VPC (public, app, sandbox and data subnets in 2 or 3 Availability
        Zones), RDS PostgreSQL 17 (Multi-AZ above the <C>dev</C> size), two versioned, encrypted S3
        buckets (the lake, and Supabase Storage), one KMS key, one Secrets Manager secret, and the
        load balancer. Supabase&apos;s services run beside the app. Realtime stays off on RDS, which
        has no true superuser to give it, and the app polls instead.
      </P>

      <H2 id="before">Before you start</H2>
      <UL>
        <li>
          An AWS account and a role with administrator rights, signed in with <C>aws sso login</C>.
        </li>
        <li>Terraform 1.6 or later, or OpenTofu 1.6 or later.</li>
        <li>
          For <C>vm</C> and <C>ecs</C>: Docker with buildx and the AWS CLI where you run Terraform.
          The sandbox image is copied into your account&apos;s ECR, because a Fargate sandbox has no
          route to the internet and cannot pull from ghcr.io. Or copy it yourself and pass{" "}
          <C>sandbox_image_override</C>.
        </li>
        <li>
          For <C>eks</C>: nothing more. Terraform installs the charts itself.
        </li>
        <li>A published release, such as 1.7.0.</li>
      </UL>

      <H2 id="deploy">Deploy</H2>
      <Code lang="bash">{`cd deploy/aws/terraform/ecs        # or vm, or eks
terraform init
terraform apply -var release=1.7.0 -var admin_email=you@example.com -var size=dev -var deletion_protection=false`}</Code>
      <P>
        <C>size</C> picks a tier from <C>deploy/aws/spec/sizes.json</C>. Every value in a tier can
        be overridden.
      </P>
      <Table
        headers={["Size", "For", "Highly available", "Base cost a month (us-east-1)"]}
        rows={[
          [
            <C key="s">dev</C>,
            "Trying it out",
            "No: one NAT, single-AZ database",
            "About $260 (vm), $300 (ecs), $400 (eks)",
          ],
          [<C key="s">small</C>, "10 to 50 users", "Yes, 2 AZs", "About $500 to $650"],
          [<C key="s">medium</C>, "50 to 250 users", "Yes, 3 AZs", "About $1,200 to $1,400"],
          [<C key="s">large</C>, "250 to 1,000 users", "Yes, 3 AZs", "About $3,800 to $4,100"],
        ]}
      />
      <P>
        Sandboxes, data through the NAT, logs and S3 come on top. <C>monthly_budget_usd</C> adds an
        AWS Budget that e-mails <C>admin_email</C> at 80% spent and at 100% forecast.{" "}
        <C>deletion_protection=false</C> makes <C>terraform destroy</C> remove everything, the
        database and buckets included: use it for a test, not for anything you want to keep.
      </P>
      <P>An apply takes 25 to 40 minutes, most of it RDS and, on EKS, the cluster. In order:</P>
      <Steps
        items={[
          {
            title: "The secrets are made, in AWS, by a Lambda",
            body: "Terraform's state holds the secret's ARN and the names it added, never a value.",
          },
          { title: "The database, the buckets and the load balancer come up" },
          {
            title: "A one-off deploy task prepares the database",
            body: "It lets GoTrue and storage-api install their schemas, applies the migrations, and creates the first admin with a confirmed address. On EKS this is a Helm hook Job.",
          },
          { title: "Only then do the app's services start" },
        ]}
      />
      <Code lang="bash">{`terraform output url
terraform output -raw admin_password_command | sh     # the admin's password`}</Code>
      <P>
        Sign in as <C>admin_email</C> with that password, and change it.
      </P>

      <H3 id="https">HTTPS</H3>
      <UL>
        <li>
          <strong>Your domain</strong> (<C>domain_name</C>): give <C>route53_zone_id</C> and a
          certificate is made, validated and the name pointed at the load balancer; or give{" "}
          <C>certificate_arn</C> for a certificate you have, and point the name yourself.
        </li>
        <li>
          <strong>No domain</strong> (the default): CloudFront&apos;s <C>*.cloudfront.net</C> name
          and certificate, in front of a load balancer that answers only CloudFront. Between the two
          the traffic is plain HTTP, so this is for trying it out. CloudFront gives up on an answer
          whose first byte takes over 60 seconds, so a long chat turn sends its headers at 45
          seconds and streams the rest (<C>EARLY_HEADERS_AFTER_MS</C>, set for you).
        </li>
      </UL>
      <H3 id="mail">Mail</H3>
      <P>
        Without SMTP the admin can sign in, and sign-ups wait for a confirmation that never arrives.
        For Amazon SES, pass <C>smtp</C> with its host, port, user, sender, and the ARN of a Secrets
        Manager secret holding the SMTP password.
      </P>

      <H2 id="rehearse">Rehearse it locally first</H2>
      <P>
        Before an apply on a real account, run it against AWS Emulator on your own machine. Every
        call goes to an emulated account, nothing reaches AWS, and nothing costs anything:
      </P>
      <Code lang="bash">{`bash deploy/aws/emulator/run.sh ecs apply /tmp/emu-ecs      # or vm, or eks; then destroy`}</Code>
      <P>
        It needs Docker, Terraform, curl and Python 3.9 or later, and it applies a copy of the root:
        the repository is never changed. It finds what <C>terraform validate</C> cannot: a request
        AWS refuses, a plan that only works once something exists, an order that fails on the way up
        or down. Its first run found two such bugs, both fixed in R484. It cannot show containers
        starting, DNS, certificates or anything inside Kubernetes, and where the emulator differs
        from AWS the copy bends, never the roots; <C>docs/deploy/AWS.md</C> lists each difference.
      </P>

      <H2 id="after-apply">After the apply</H2>
      <UL>
        <li>
          Sign in, then open Admin, Developer runtime, and run the preflight: every check passes.
        </li>
        <li>A notebook runs a cell, and an ETL run on the Python engine succeeds.</li>
        <li>Upload a CSV to the lakehouse and query it.</li>
        <li>
          Put load on the web tier and watch it scale out: in ECS service events, or with{" "}
          <C>kubectl get hpa</C>.
        </li>
        <li>
          On a Multi-AZ size, reboot RDS with failover. Sign-ins resume within about two minutes,
          and no task is replaced.
        </li>
      </UL>

      <H2 id="day-two">Day two</H2>
      <FieldList
        items={[
          {
            name: "Upgrade",
            body: (
              <>
                <C>terraform apply -var release=&lt;new&gt;</C>. The deploy task migrates first,
                then the services roll. ECS rolls back by itself when new tasks fail their health
                checks, and EKS when the deploy Job or the pods fail. VMs are replaced by an
                instance refresh that keeps half of them serving.
              </>
            ),
          },
          {
            name: "Roll back",
            body: "Apply the previous release: migrations are written so the release before them can run on the newer schema. A migration that went wrong is a restore, RDS point-in-time recovery to just before the upgrade.",
          },
          {
            name: "Scale",
            body: "The web tier scales on CPU. ECS adds instances through its capacity provider; EKS adds nodes with Cluster Autoscaler, the app pool and the sandbox pool apart.",
          },
          {
            name: "Logs and shell",
            body: (
              <>
                CloudWatch Logs, under <C>/agentswarms/&lt;name&gt;/</C>. A shell is{" "}
                <C>aws ssm start-session</C>: no SSH port is open.
              </>
            ),
          },
          {
            name: "Tear down",
            body: (
              <>
                <C>terraform destroy</C>. With <C>deletion_protection</C> on, the database keeps a
                final snapshot and the buckets and the secret stay.
              </>
            ),
          },
        ]}
      />

      <H2 id="what-it-builds">What it builds, and why</H2>
      <FieldList
        items={[
          {
            name: "Network",
            body: "Four subnets per AZ: public (the load balancer and NAT), app, sandbox (no route out at all) and data (RDS and Valkey). A sandbox reaches the egress proxy, the app for its callbacks, and the VPC endpoints for ECR, Logs and S3.",
          },
          {
            name: "Sandboxes",
            body: (
              <>
                On VMs and ECS, a Fargate task per sandbox (<C>NOTEBOOK_RUNTIME_BACKEND=ecs</C>),
                with no IAM role, a read-only root and every capability dropped. It starts with a
                one-time nonce, never its secrets, and trades it at the app for its environment
                once. On EKS, a pod per sandbox on a tainted node pool, in a namespace with a quota,
                behind a NetworkPolicy the VPC CNI enforces.
              </>
            ),
          },
          {
            name: "Egress",
            body: (
              <>
                The proxy fetches the allow-list from the app (<C>NOTEBOOK_EGRESS_MODE=pull</C>)
                and, unlike the Docker Compose proxy, refuses private addresses unless they are
                listed by IP.
              </>
            ),
          },
          {
            name: "Scheduler",
            body: (
              <>
                The analytics tier runs it (<C>APP_ROLE=analytics</C>), and a lease in the database
                keeps it to one at a time. The web tier never runs it.
              </>
            ),
          },
          {
            name: "Health checks",
            body: (
              <>
                The load balancer asks <C>/api/health/ready?scope=local</C>, which does not depend
                on the database, so a failover does not empty the pool.
              </>
            ),
          },
          {
            name: "Database TLS",
            body: (
              <>
                RDS refuses unencrypted connections. The clients use <C>sslmode=require</C>:
                encrypted, without checking the certificate, because Supabase&apos;s images do not
                carry Amazon&apos;s certificate authority.
              </>
            ),
          },
          {
            name: "Lakehouse",
            body: "The DuckLake catalog is a second database on the same RDS, with its own role. The data is in the lake bucket, signed with the app's role: no access keys.",
          },
        ]}
      />
      <Callout kind="info">
        The sandbox, egress and node-pool settings these targets set for you are listed with the
        rest on <DocLink to="/docs/self-hosting/settings">All settings</DocLink>.
      </Callout>

      <NextPrev current="/docs/self-hosting/aws" />
    </>
  );
}
