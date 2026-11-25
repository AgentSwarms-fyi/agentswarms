# AgentSwarms on AWS

Three ways to run AgentSwarms on AWS, from the same Terraform modules under
[`deploy/aws/terraform`](../../deploy/aws/terraform):

| Target                         | Directory | The app runs on                                                                            | Users' code runs on                      | Pick it when                                               |
| ------------------------------ | --------- | ------------------------------------------------------------------------------------------ | ---------------------------------------- | ---------------------------------------------------------- |
| **VMs behind a load balancer** | `vm/`     | An Auto Scaling group of EC2 instances, every service on each with Docker                  | Fargate, one task per sandbox            | You want plain VMs you can SSH into (through SSM)          |
| **Amazon ECS**                 | `ecs/`    | ECS services on an EC2 Auto Scaling group; docgen and js-sandbox on Fargate                | Fargate, one task per sandbox            | You want AWS to run and roll the containers                |
| **Amazon EKS**                 | `eks/`    | Kubernetes, from the Helm chart [`deploy/helm/agentswarms`](../../deploy/helm/agentswarms) | Pods on a tainted node pool of their own | You run Kubernetes, or want the same chart elsewhere later |

All three share:

- the VPC (public, app, sandbox and data subnets in 2 or 3 AZs);
- RDS PostgreSQL 17 (Multi-AZ above the `dev` size);
- two S3 buckets (the lake, and Supabase Storage), versioned, KMS-encrypted and TLS-only;
- one KMS key;
- one Secrets Manager secret;
- the load balancer, with HTTPS from your domain's certificate, or from CloudFront's own name without one.

Supabase's services (GoTrue, PostgREST, storage-api) run beside the app. Realtime stays off on RDS, which has no true superuser to give it, and the app polls instead.

## Before you start

- An AWS account and a role with administrator rights. Sign in with
  `aws sso login --profile <yours>` and `export AWS_PROFILE=<yours>`.
- Terraform 1.6 or later (or OpenTofu 1.6+).
- For `vm` and `ecs`: Docker with buildx, and the AWS CLI, where you run
  Terraform. The sandbox image is copied into your account's ECR: a Fargate
  sandbox has no route to the internet, so it cannot pull from ghcr.io. Or copy
  it yourself and pass `sandbox_image_override`.
- For `eks`: nothing more. Terraform installs the charts itself.
- A published release, e.g. `1.7.0` (see [Releasing](../RELEASING.md)).

## Deploy

```bash
cd deploy/aws/terraform/ecs        # or vm, or eks
terraform init
terraform apply -var release=1.7.0 -var admin_email=you@example.com -var size=dev -var deletion_protection=false
```

`size` picks a tier from [`deploy/aws/spec/sizes.json`](../../deploy/aws/spec/sizes.json):

| Size     | For                | Highly available                | Base cost, a month (us-east-1)          |
| -------- | ------------------ | ------------------------------- | --------------------------------------- |
| `dev`    | trying it out      | no: one NAT, single-AZ database | about $260 (vm), $300 (ecs), $400 (eks) |
| `small`  | 10 to 50 users     | yes, 2 AZs                      | about $500 to $650                      |
| `medium` | 50 to 250 users    | yes, 3 AZs                      | about $1,200 to $1,400                  |
| `large`  | 250 to 1,000 users | yes, 3 AZs                      | about $3,800 to $4,100                  |

Sandboxes, data through the NAT, logs and S3 come on top. Every value in a tier
can be overridden; `monthly_budget_usd` adds an AWS Budget that e-mails
`admin_email` at 80% spent and at 100% forecast. `deletion_protection=false`
makes `terraform destroy` remove everything, the database and buckets
included: use it for a test, not for anything you want to keep.

An apply takes 25 to 40 minutes, most of it RDS and, on EKS, the cluster. In order:

1. The secrets are made, in AWS, by a Lambda; Terraform's state never holds them.
2. The database, the buckets and the load balancer come up.
3. A one-off deploy task (a Helm hook Job on EKS) prepares the database for
   Supabase, lets GoTrue and storage-api install their schemas, applies the
   migrations, and creates the first admin with a confirmed address.
4. Only then do the app's services start.

Then:

```bash
terraform output url
terraform output -raw admin_password_command | sh     # the admin's password
```

Sign in as `admin_email` with that password, and change it.

### HTTPS

- **Your domain** (`domain_name`): give `route53_zone_id` and a certificate is
  made, validated and the name pointed at the load balancer; or give
  `certificate_arn` for an ACM certificate you have, and point the name
  yourself. The load balancer serves 443 and redirects 80.
- **No domain** (the default): CloudFront's `*.cloudfront.net` name, with its
  certificate, in front of the load balancer. The load balancer answers only
  CloudFront. Between the two the traffic is plain HTTP, so this is for trying
  it out; use a domain for anything real. CloudFront gives up on an answer
  whose first byte takes over 60 s, so a long chat turn sends its headers at
  45 s and streams the rest (`EARLY_HEADERS_AFTER_MS`, set for you).

### Mail

Without SMTP the admin can sign in, and sign-ups wait for a confirmation that
never arrives. For Amazon SES, pass `smtp = { host, port, user, from,
password_secret_arn }`, the SMTP password in a Secrets Manager secret of its own.

## Day two

- **Upgrade**: `terraform apply -var release=<new>`. The deploy task migrates
  first, then the services roll. ECS rolls back by itself when the new tasks
  fail their health checks, and EKS when the deploy Job or the pods fail
  (`helm --atomic`). VMs are replaced by an instance refresh that keeps half
  of them serving.
- **Roll back**: apply the previous release. Migrations are written to be read
  by the release before them (docs/RELEASING.md), so the older app runs on the
  newer schema. A migration that went wrong is a restore: RDS point-in-time
  recovery to just before the upgrade.
- **Scale**: the web tier scales on CPU (target tracking on ECS and VMs, the
  HPA on EKS). ECS adds instances through its capacity provider; EKS adds
  nodes with Cluster Autoscaler, in the app pool and the sandbox pool apart.
- **Logs**: CloudWatch Logs, under `/agentswarms/<name>/`.
- **Shell**: `aws ssm start-session --target <instance>`. No SSH ports are open.
- **Tear down**: `terraform destroy`. With `deletion_protection` on, the
  database keeps a final snapshot and the buckets and secret stay.

## What it builds, and why

### Network

Four subnets per AZ:

- **public**: the load balancer and the NAT gateways;
- **app**: the app, Supabase's services and the egress proxy;
- **sandbox**: users' code, with no route out at all;
- **data**: RDS and Valkey, with no route out.

A sandbox reaches three things: the egress proxy, the app (for its callbacks),
and the VPC endpoints for ECR, Logs and S3, which is how it starts.

### Sandboxes

- **VM and ECS**: a Fargate task per sandbox (`NOTEBOOK_RUNTIME_BACKEND=ecs`).
  - The task has no IAM role, a read-only root, and every capability dropped.
  - It starts with a one-time nonce, never its secrets: CloudTrail records the
    `RunTask` request. The sandbox trades the nonce at the app for its
    environment, once ([the runtime doc](../DEVELOPER_WORKSPACE_RUNTIME.md)).
- **EKS**: a pod per sandbox on a node pool that is tainted for them.
  - The pods sit in a namespace with a quota.
  - A NetworkPolicy, enforced by the VPC CNI, lets them reach DNS, the egress
    proxy and the app, and nothing else.

### Model serving

A deployed model's warm endpoint is, by default, sandboxes the app starts and
scales: Fargate tasks on VM and ECS, pods on EKS. On EKS,
`serving_kserve = true` installs cert-manager and KServe v0.21.0 (Standard
mode, no ingress) and turns on the chart's `serving.kserve`. Each endpoint is
then an InferenceService whose pods a HorizontalPodAutoscaler scales on CPU,
with the Cluster Autoscaler adding nodes underneath.

- Predictor pods have no IAM role and no route to S3. A pod asks the app for
  its own model, proving which endpoint it is with that endpoint's port token,
  because it runs the model's own code.
- The `agentswarms-serving` namespace has a quota, and a NetworkPolicy lets
  predictors be reached by the app and reach only the app.

See [Warm endpoints on KServe](../DEPLOYMENT.md#warm-endpoints-on-kserve).

### GPU training

On EKS, `gpu_node_max = 2` (any number above 0) adds a third node pool, of GPU
instances (`gpu_instance_types`, default `g6.xlarge`: one NVIDIA L4, 24 GB).
Fargate has no GPUs, so the VM and ECS targets train on CPUs only.

- **It scales from zero.** No GPU node runs until a training job asks for a
  GPU. Cluster Autoscaler then adds one, which takes a few minutes. The job's
  log says it is waiting for a node with a free GPU, quoting the scheduler.
  The pool's Auto Scaling group carries the autoscaler's node-template tags,
  because from zero there is no node for the autoscaler to read.
- **Only GPU work lands there.** The pool carries the sandbox taint and an
  `nvidia.com/gpu` taint, so the app and CPU sandboxes stay off it.
- **The NVIDIA device plugin** (chart 0.20.1) runs on the pool only. EKS's
  NVIDIA AMI (`AL2023_x86_64_NVIDIA`) brings the driver and the container
  toolkit.
- **What uses the GPU.** A classification or regression search adds XGBoost as
  a candidate, trained on the GPU.
  - With the search spread over several workers, only the worker dealt XGBoost
    asks for a GPU.
  - Imports, forecasts, predictions and the other candidates never ask for one.
  - The model is saved to answer on a CPU, so warm endpoints, KServe and batch
    predictions need no GPU.
- **`train_gpus`** (default 1) is how many GPUs that sandbox asks for. Admin →
  Developer runtime → Training GPUs overrides it.

[Testing GPU training](#testing-gpu-training) is the checklist for a first
apply.

### Egress

The proxy fetches the allow-list from the app (`NOTEBOOK_EGRESS_MODE=pull`).
Unlike Compose's proxy, it refuses private addresses unless they are listed by
IP. In a VPC those are the database and the app.

### The scheduler

The analytics tier runs it (`APP_ROLE=analytics`), and a lease in the database
keeps it to one at a time across the fleet. The web tier never runs it.

### Health checks

The load balancer asks `/api/health/ready?scope=local`, which does not depend on
the database. A database failover then does not take every target out of the
pool at once.

### Database TLS

RDS refuses unencrypted connections (`rds.force_ssl`). The clients use
`sslmode=require`: encrypted, but without checking the server's certificate,
because Supabase's images do not carry Amazon's certificate authority.

### Lakehouse

The DuckLake catalog is a second database (`lakehouse_catalog`) on the same RDS,
with its own role. The data is in the lake bucket, signed with the app's
role: no access keys.

## Rehearsing it on AWS Emulator

Before an apply on a real account, run it against
[AWS Emulator](https://github.com/aws/aws-emulator) on your own machine. Every
call goes to an emulated account (`000000000000`), nothing reaches AWS, and
nothing costs anything:

```bash
bash deploy/aws/emulator/run.sh ecs apply /tmp/emu-ecs      # or vm, or eks; then destroy
```

It needs Docker, Terraform, curl and Python 3.9 or later. It builds the
emulator's image once (a pinned package, its signature checked), starts it, and
applies a copy of the root; the repository is never changed. It finds what
`terraform validate` cannot:

- requests AWS refuses, such as a character a field does not allow;
- a plan that only works once something exists;
- resources in an order that does not work, on the way up and on the way down.

Its first run found two, both fixed in R484 with a test each: a count that
could not be planned before the network existed, and security group
descriptions with an apostrophe, which EC2 refuses. Then `ecs` applied all 169
resources, `vm` all 139, and `eks` its 96 AWS ones.

What it cannot show: containers starting, DNS, certificates, or anything inside
Kubernetes. On `eks` it applies only the AWS resources, not the Helm releases.
The emulator is not AWS either, and where it differs, the work copy bends
instead of the roots. Each override is in `deploy/aws/emulator`:

| Difference                                                                                                                       | What the rehearsal does                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Revoking a new security group's default egress rule fails ([aws/aws-emulator#46](https://github.com/aws/aws-emulator/issues/46)) | `shim.py`, a local proxy, drops the ports AWS ignores                                                                                |
| S3 bucket tags go to an unresolvable host ([aws/aws-emulator#56](https://github.com/aws/aws-emulator/issues/56))                 | Terraform reaches the emulator only through that proxy                                                                               |
| No AWS-managed CloudFront prefix list                                                                                            | `seed.tf.tmpl` makes a stand-in, and the edge module reads it                                                                        |
| Cloud Map answers health-check settings empty, so every plan would replace the services                                          | `overrides/` ignores that drift                                                                                                      |
| A Lambda cannot call ECS, and no container runs                                                                                  | The deploy task's Lambda is a stand-in that checks its input and answers success                                                     |
| RDS does not report log exports or the Performance Insights key                                                                  | Nothing: every plan shows one in-place change to the database                                                                        |
| ECS cannot delete a capacity provider                                                                                            | Nothing: an `ecs` destroy stops there, with the cluster, its instances' group and the VPC left                                       |
| Auto Scaling cannot delete a scaling policy                                                                                      | Nothing: a `vm` destroy stops there. `terraform state rm module.app.aws_autoscaling_policy.cpu` in the work copy, then destroy again |

The proxy changes signed requests, so the emulator runs with request signing
checks off. Delete each override when the emulator fixes what it is for.

## Testing it

What to check after an apply:

1. **Sign in.** Then Admin → Developer runtime → Run preflight: every check passes.
2. **A sandbox.** A notebook runs a cell. A batch job (an ETL run on the Python
   engine) succeeds, and its logs show in Runs.
3. **The lake.** Upload a CSV to the lakehouse and query it.
4. **Autoscaling.**
   - Put load on the web tier (k6, or hey, against `/`) and watch it scale out,
     in ECS service events or `kubectl get hpa`.
   - Watch new instances or nodes arrive when tasks or pods cannot be placed.
5. **Failover.** Reboot RDS with failover (Multi-AZ sizes). Sign-ins resume
   within about two minutes, and no task is replaced.

## Testing GPU training

GPU training is unit-tested and driven without a GPU: on Docker with no NVIDIA
runtime, and with XGBoost's CUDA build on a CPU. That shows what happens when
there is no GPU. Only a real GPU node shows the rest, so on the first EKS apply
with a GPU pool, check each of these. Expect about $1 an hour while a
`g6.xlarge` runs, and nothing while the pool is at zero.

1. **Quota first.** A new account's GPU quota is often 0, and a node group with
   no quota applies fine and then never starts a node:

   ```bash
   bash deploy/aws/scripts/gpu-preflight.sh us-east-1 g6.xlarge 2
   ```

   It checks the type (an NVIDIA GPU, x86), that the cluster's zones offer it,
   and the "Running On-Demand G and VT instances" vCPU quota. When the quota is
   short, it prints the increase request to send.

2. **Apply** with `gpu_node_max = 2` (and `gpu_capacity_type = "SPOT"` to pay
   less). Then
   `kubectl get nodes -l agentswarms.io/pool=gpu` lists no nodes, and
   `kubectl -n kube-system get ds nvidia-device-plugin` shows 0 desired.
3. **A training job.** Train a classification model on a few thousand rows of
   a sample dataset (Machine learning → New model).
   - The job's log says `waiting to start: Waiting for a node with a free GPU`
     for a few minutes while a node joins.
   - `kubectl get nodes -l agentswarms.io/pool=gpu` shows it, and once the
     device plugin is up, `.status.allocatable` lists `nvidia.com/gpu: 1`.
4. **The log names the GPU.** For example:
   `GPU: 1 requested, 1x NVIDIA L4 (22 GiB each, driver 580.xx); training uses it`.
   - The leaderboard has an `xgboost` row marked **GPU**.
   - The version's Lineage card shows the GPU, and which candidate trained on it.
5. **It answers on a CPU.** Promote the version if XGBoost won, then:
   - Try it on the Overview tab;
   - deploy a warm endpoint;
   - run a batch prediction.

   None of them runs on the GPU pool:
   `kubectl get pods -n agentswarms-sandboxes -o wide` shows them on the sandbox
   nodes.

6. **The pool empties.** 10 to 20 minutes after the job (Cluster Autoscaler's
   scale-down delays), the GPU node goes, and the pool is back to zero.
7. **Waiting ends cleanly.**
   - **Cancel a job while it waits:** its pending pod goes, and no GPU node
     stays up for it.
   - **Ask for more GPUs than there is quota for:** run two training jobs at
     once with `gpu_node_max` above what the quota allows. The second job's
     log keeps saying it is waiting, and the node group's Auto Scaling activity
     names the quota.

If step 4 says the GPU was not usable, the note after it is XGBoost's or
nvidia-smi's own words. The usual causes:

- the device plugin is not running on the node;
- the AMI's driver is older than 525, which XGBoost's CUDA 12 build needs.
