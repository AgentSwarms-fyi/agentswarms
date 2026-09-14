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
  Table,
} from "@/components/docs/DocsShell";

export const Route = createFileRoute("/docs/self-hosting_/kubernetes")({
  head: () => ({
    meta: [
      { title: "Install & deploy · Kubernetes — AgentSwarms Documentation" },
      {
        name: "description",
        content:
          "Running the platform on Kubernetes: what each manifest is for, then Amazon EKS, Google GKE, Azure AKS and Oracle OKE step by step, and how to verify any of them.",
      },
      {
        property: "og:title",
        content: "Install & deploy · Kubernetes — AgentSwarms Documentation",
      },
      {
        property: "og:description",
        content: "Manifests, then EKS, GKE, AKS and OKE step by step.",
      },
      { property: "og:url", content: "https://agentswarms.fyi/docs/self-hosting/kubernetes" },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: "https://agentswarms.fyi/docs/self-hosting/kubernetes" }],
  }),
  component: SelfHostingKubernetesPage,
});

function SelfHostingKubernetesPage() {
  return (
    <>
      <DocsHeader
        eyebrow="Self-hosting"
        title="Install & deploy · Kubernetes"
        description="Running the platform on Kubernetes: what each manifest is for, then Amazon EKS, Google GKE, Azure AKS and Oracle OKE step by step, and how to verify any of them."
      />
      <P>
        Part of the <DocLink to="/docs/self-hosting">Install &amp; deploy</DocLink> guide. This page
        is the Kubernetes path: what each manifest is for, then Amazon EKS, Google GKE, Azure AKS
        and Oracle OKE step by step, and how to verify any of them.
      </P>

      <H2 id="kubernetes-overview">Kubernetes</H2>
      <P>
        The manifests, what each one is for, and a walk-through per cloud. The other targets —
        Docker Compose, a plain VM, a PaaS — are on the{" "}
        <DocLink to="/docs/self-hosting#deploy-targets">deployment targets</DocLink> section of the
        install guide.
      </P>

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
      <P>
        Those decisions land differently on each managed cluster. <C>docs/DEPLOYMENT.md</C> has a
        step-by-step runbook per cloud — cluster creation, the registry, storage, policy
        enforcement, ingress and TLS, the managed Postgres and object storage the lakehouse prefers,
        and a GPU pool if you train — under &ldquo;Managed clusters: AWS, GCP, Azure, OCI&rdquo;.
        The short version:
      </P>
      <Table
        headers={["Cloud", "Registry", "Storage", "Policy enforcement", "Ingress"]}
        rows={[
          [
            "AWS (EKS)",
            "ECR",
            "Install the EBS CSI add-on, then mark a gp3 class default — a new cluster has none that works, and every claim sits in Pending",
            "VPC CNI with enableNetworkPolicy",
            "AWS Load Balancer Controller + ACM",
          ],
          [
            "GCP (GKE)",
            "Artifact Registry",
            "standard-rwo, default already",
            "Dataplane V2 — chosen at creation, not after",
            "GKE Ingress + ManagedCertificate",
          ],
          [
            "Azure (AKS)",
            "ACR, attached with --attach-acr so no pull secret is needed",
            "Azure Disks, default already",
            "--network-policy at creation",
            "App Routing add-on (managed NGINX)",
          ],
          [
            "OCI (OKE)",
            "OCIR, with an auth token as the password",
            "oci-bv, default already",
            "Calico, installed by you",
            "Native ingress controller, or NGINX",
          ],
        ]}
      />
      <P>
        Push <strong>five</strong> images, not three, if you use the developer workspace, ETL or the
        ML platform: the notebook gateway (<C>./services/notebook-gateway</C>) is named in{" "}
        <C>deploy/k8s/notebooks/notebook-runtime.yaml</C>, and the runtime image (
        <C>./docker/notebook-runtime</C>) in <C>NOTEBOOK_RUNTIME_IMAGE</C>. Training, prediction and
        pipeline runs are all batch pods in that namespace. The build loop is the same everywhere;
        only the registry host changes.
      </P>
      <Code lang="bash">{`export REGISTRY=<your registry host and path>
export TAG=1.4.0
docker build -t "$REGISTRY/agentswarms:$TAG" .
docker build -t "$REGISTRY/docgen:$TAG" ./docgen-service
docker build -t "$REGISTRY/js-sandbox:$TAG" ./services/js-sandbox
docker build -t "$REGISTRY/notebook-gateway:$TAG" ./services/notebook-gateway
docker build -t "$REGISTRY/notebook-runtime:$TAG" ./docker/notebook-runtime
for i in agentswarms docgen js-sandbox notebook-gateway notebook-runtime; do docker push "$REGISTRY/$i:$TAG"; done`}</Code>
      <Callout title="Building on an Apple Silicon laptop">
        An arm64 image on an amd64 node pool crash-loops with <C>exec format error</C> and nothing
        else. Build for the cluster:{" "}
        <C>
          docker buildx build --platform linux/amd64 -t &quot;$REGISTRY/agentswarms:$TAG&quot;
          --push .
        </C>
      </Callout>

      <H3 id="k8s-eks">Amazon EKS, step by step</H3>
      <P>
        Needs <C>aws</C> v2, <C>eksctl</C>, <C>kubectl</C> and <C>helm</C>, and an IAM principal
        that can create EKS clusters, IAM roles, ECR repositories, RDS instances and S3 buckets.
      </P>
      <Code lang="bash">{`export AWS_REGION=us-east-1
export CLUSTER=agentswarms
export ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
export REGISTRY="$ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com"

# 1. The cluster. --with-oidc is required: every add-on below uses IRSA.
eksctl create cluster --name "$CLUSTER" --region "$AWS_REGION" --version 1.31 \
  --nodegroup-name app --node-type m6i.xlarge --nodes 3 --managed --with-oidc

# 2. A working default StorageClass. EKS ships gp2 with no driver behind it,
#    so every PersistentVolumeClaim sits in Pending for ever without this.
eksctl create iamserviceaccount --cluster "$CLUSTER" --region "$AWS_REGION" \
  --namespace kube-system --name ebs-csi-controller-sa --role-name AgentSwarmsEBSCSIRole \
  --attach-policy-arn arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy \
  --approve --role-only
eksctl create addon --cluster "$CLUSTER" --region "$AWS_REGION" --name aws-ebs-csi-driver \
  --service-account-role-arn "arn:aws:iam::$ACCOUNT:role/AgentSwarmsEBSCSIRole" --force
kubectl annotate storageclass gp2 storageclass.kubernetes.io/is-default-class- --overwrite

# 3. Network policy, or the JS sandbox's egress ban is inert.
aws eks update-addon --cluster-name "$CLUSTER" --region "$AWS_REGION" --addon-name vpc-cni \
  --resolve-conflicts PRESERVE --configuration-values '{"enableNetworkPolicy":"true"}'

# 4. Registry.
for r in agentswarms docgen js-sandbox notebook-gateway notebook-runtime; do
  aws ecr create-repository --repository-name "$r" --region "$AWS_REGION" >/dev/null || true
done
aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$REGISTRY"

# 5. Install, then watch.
AGENTSWARMS_IMAGE="$REGISTRY/agentswarms:$TAG" DOCGEN_IMAGE="$REGISTRY/docgen:$TAG" \
  JS_SANDBOX_IMAGE="$REGISTRY/js-sandbox:$TAG" \
  ADMIN_EMAIL=you@corp.com ADMIN_PASSWORD='...' bash scripts/setup-k8s.sh
kubectl -n agentswarms get pods -w`}</Code>
      <P>
        A <C>gp3</C> StorageClass marked default has to exist as well — the full manifest, the AWS
        Load Balancer Controller install with its IAM policy, the ACM certificate and the Ingress
        are in <C>docs/DEPLOYMENT.md</C>. The two that catch people: health-check{" "}
        <C>/api/health/ready</C> rather than <C>/api/health</C>, and leave{" "}
        <C>LAKEHOUSE_S3_ENDPOINT</C> unset for real S3 — it exists for MinIO, and pointing it at an
        AWS host is the usual reason a lakehouse cannot read its own Parquet.
      </P>
      <Code lang="bash">{`# 9-10. Managed Postgres for the catalog, S3 for the lake.
aws rds create-db-instance --db-instance-identifier agentswarms-catalog --engine postgres \
  --engine-version 16.4 --db-instance-class db.t4g.medium --allocated-storage 50 \
  --storage-encrypted --master-username lakehouse --master-user-password '<password>' \
  --db-name lakehouse_catalog --no-publicly-accessible --region "$AWS_REGION"
aws s3api create-bucket --bucket agentswarms-lake --region "$AWS_REGION"
kubectl -n agentswarms patch secret agentswarms-env --type merge -p '{"stringData":{
  "LAKEHOUSE_CATALOG_URL":"postgres://lakehouse:<password>@<endpoint>:5432/lakehouse_catalog",
  "LAKEHOUSE_DATA_URL":"s3://agentswarms-lake/main",
  "LAKEHOUSE_S3_URL_STYLE":"vhost","LAKEHOUSE_S3_USE_SSL":"true"}}'`}</Code>

      <H3 id="k8s-gke">Google GKE, step by step</H3>
      <P>
        <strong>Dataplane V2 is chosen at creation and cannot be added later.</strong> It is what
        enforces <C>NetworkPolicy</C>; a cluster without it needs rebuilding, not patching.
      </P>
      <Code lang="bash">{`export PROJECT=$(gcloud config get-value project)
export REGION=us-central1
export REGISTRY="$REGION-docker.pkg.dev/$PROJECT/agentswarms"
gcloud services enable container.googleapis.com artifactregistry.googleapis.com \
  sqladmin.googleapis.com storage.googleapis.com

# 1. Cluster. --num-nodes is per zone, so a regional cluster gives three.
gcloud container clusters create agentswarms --region "$REGION" --num-nodes 1 \
  --machine-type e2-standard-4 --enable-dataplane-v2 --enable-ip-alias \
  --workload-pool="$PROJECT.svc.id.goog" --release-channel regular
gcloud container clusters get-credentials agentswarms --region "$REGION"

# 2. Storage needs nothing: standard-rwo is already the default.
# 3. Registry.
gcloud artifacts repositories create agentswarms --repository-format=docker --location="$REGION"
gcloud auth configure-docker "$REGION-docker.pkg.dev"

# 5. A static address first, so the DNS record outlives the Ingress.
gcloud compute addresses create agentswarms-ip --global
gcloud compute addresses describe agentswarms-ip --global --format='value(address)'

# 6-7. Cloud SQL for the catalog; GCS speaks S3 with an HMAC key.
gcloud sql instances create agentswarms-catalog --database-version=POSTGRES_16 \
  --tier=db-custom-2-7680 --region="$REGION"
gcloud storage buckets create gs://agentswarms-lake --location="$REGION"
gcloud storage hmac create <service-account-email>`}</Code>
      <P>
        The Ingress wants three objects: a <C>ManagedCertificate</C>, a <C>BackendConfig</C> whose
        health check is <C>/api/health/ready</C>, and the Ingress itself annotated with the static
        IP and the certificate. The certificate stays <C>Provisioning</C> until the A record
        resolves, which takes tens of minutes on first issue. For GCS set{" "}
        <C>LAKEHOUSE_S3_ENDPOINT</C> to <C>storage.googleapis.com</C> with{" "}
        <C>LAKEHOUSE_S3_URL_STYLE=path</C>.
      </P>

      <H3 id="k8s-aks">Azure AKS, step by step</H3>
      <Code lang="bash">{`export RG=agentswarms-rg LOCATION=eastus ACR=agentswarmsacr
az group create --name "$RG" --location "$LOCATION"

# 1. The dataplane is chosen at creation, like GKE's.
az aks create --resource-group "$RG" --name agentswarms --node-count 3 \
  --node-vm-size Standard_D4s_v5 --network-plugin azure --network-dataplane cilium \
  --network-policy cilium --enable-managed-identity --generate-ssh-keys
az aks get-credentials --resource-group "$RG" --name agentswarms

# 3. Registry, attached so no imagePullSecret is needed anywhere.
az acr create --resource-group "$RG" --name "$ACR" --sku Standard
az aks update --resource-group "$RG" --name agentswarms --attach-acr "$ACR"
az acr login --name "$ACR"

# 5. Managed NGINX with its own public IP.
az aks approuting enable --resource-group "$RG" --name agentswarms
kubectl -n app-routing-system get service nginx -o jsonpath='{.status.loadBalancer.ingress[0].ip}'

# 6. Managed Postgres for the catalog.
az postgres flexible-server create --resource-group "$RG" --name agentswarms-catalog \
  --location "$LOCATION" --tier Burstable --sku-name Standard_B2s --version 16 \
  --admin-user lakehouse --admin-password '<password>' --public-access None --yes`}</Code>
      <Callout title="Two things are AKS-specific">
        Set <C>nginx.ingress.kubernetes.io/proxy-read-timeout: &quot;300&quot;</C> on the Ingress:
        an analyst turn takes 30–95 seconds and NGINX cuts it off at 60 with a 504. And{" "}
        <strong>Azure Blob is not S3-compatible</strong>, so the lakehouse&rsquo;s own storage is
        either MinIO in the cluster or an S3 endpoint elsewhere. Mounting Blob or ADLS Gen2 as a
        read-only <em>data lake</em> is a different feature and works natively.
      </Callout>

      <H3 id="k8s-oke">Oracle OKE, step by step</H3>
      <P>
        OKE&rsquo;s <strong>Quick create</strong> in the console builds the VCN, subnets and node
        pool in one pass; the CLI needs those OCIDs to exist already. Two OCI-specific credentials
        catch people out: the registry password is an <strong>auth token</strong>, and the lake
        needs a <strong>Customer Secret Key</strong> — they are different things, and neither is
        your console password.
      </P>
      <Code lang="bash">{`export OCI_REGION=us-ashburn-1 REGION_KEY=iad
export NAMESPACE=$(oci os ns get --query data --raw-output)
export REGISTRY="$REGION_KEY.ocir.io/$NAMESPACE/agentswarms"

oci ce cluster create-kubeconfig --cluster-id <cluster OCID> --file "$HOME/.kube/config" \
  --region "$OCI_REGION" --token-version 2.0.0

# 4. OCIR. The password is an auth token from the console.
docker login "$REGION_KEY.ocir.io" --username "$NAMESPACE/oracleidentitycloudservice/you@corp.com"
kubectl create secret docker-registry ocir --namespace agentswarms \
  --docker-server="$REGION_KEY.ocir.io" \
  --docker-username="$NAMESPACE/oracleidentitycloudservice/you@corp.com" \
  --docker-password='<auth-token>'
kubectl -n agentswarms patch serviceaccount default \
  -p '{"imagePullSecrets":[{"name":"ocir"}]}'

# 8. Object Storage through its S3 compatibility endpoint.
oci os bucket create --compartment-id "$COMPARTMENT" --name agentswarms-lake`}</Code>
      <P>
        OKE ships <C>oci-bv</C> as the default StorageClass, so storage needs nothing — but block
        volumes are zonal, so keep the lakehouse catalog in one availability domain or move it to
        managed Postgres. <strong>Install Calico</strong> if you want the sandbox&rsquo;s egress ban
        enforced: OKE&rsquo;s flannel and VCN-native pod networking do not enforce{" "}
        <C>NetworkPolicy</C>, and the policy applies cleanly and does nothing without it.
      </P>

      <H3 id="k8s-verify">After any of them</H3>
      <P>
        Seven checks catch every decision above. The one worth running first is the sandbox, because
        its failure is silent:
      </P>
      <Code lang="bash">{`kubectl -n agentswarms exec deploy/agentswarms-js-sandbox -- \
  sh -c 'wget -qO- --timeout=5 https://example.com || echo DENIED'`}</Code>
      <P>
        <C>DENIED</C> is the pass. Anything else means the CNI is not enforcing policy and
        user-supplied code can reach the internet. Then: every pod Running and Ready; the Office
        renderer actually has a pod (a <C>restricted</C> namespace refuses it quietly);{" "}
        <C>resources.limits.cpu</C> set on the web Deployment, because the worker count follows it;
        the load balancer health-checking <C>/api/health/ready</C>; <C>PUBLIC_APP_URL</C> matching
        the hostname people type; and a <C>CREATE TABLE smoke.t AS SELECT 1</C> in the Lakehouse SQL
        editor, which exercises the catalog Postgres and the object store together.
      </P>
      <Table
        headers={["Symptom", "Cause"]}
        rows={[
          [
            "Every PVC Pending, no capacity events",
            "No usable default StorageClass. On EKS the gp2 class exists with no driver behind it.",
          ],
          [
            "ImagePullBackOff on a cloud cluster",
            "The images are still only on your laptop, or the pull secret is missing. Five images, not three.",
          ],
          [
            "CrashLoopBackOff with exec format error",
            "An arm64 image on an amd64 node pool. Rebuild with docker buildx --platform linux/amd64.",
          ],
          [
            "Every pod fails readiness with Invalid supabaseUrl",
            "The Secret was built from a .env with the quotes left on.",
          ],
          [
            "The analyst answers in the app but 504s through the ingress",
            "The proxy read timeout. A turn takes 30–95 seconds; NGINX defaults to 60.",
          ],
          [
            "A training job fails with DuckDB's Authentication Failure",
            "The object store's host is not in the notebook egress allow-list. The app log names it.",
          ],
          [
            "The sandbox reaches the internet",
            "The CNI is not enforcing NetworkPolicy. On GKE and AKS that is decided at cluster creation.",
          ],
        ]}
      />
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

      <NextPrev current="/docs/self-hosting/kubernetes" />
    </>
  );
}
