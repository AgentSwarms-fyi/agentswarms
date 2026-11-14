# AgentSwarms on Amazon EKS: the Helm chart (deploy/helm/agentswarms) on a
# cluster with two node pools (the app's, and a tainted one users' code runs
# on), RDS PostgreSQL and S3 underneath, and the same load balancer, HTTPS and
# secrets as the ECS and VM targets. See docs/deploy/AWS.md.
#
#   terraform init
#   terraform apply -var admin_email=you@example.com -var release=1.7.0
#
# Autoscaling: the HPA scales the web tier on CPU; Cluster Autoscaler adds and
# removes nodes in both pools as pods wait or nodes empty.

locals {
  tier    = jsondecode(file("${path.module}/../../spec/sizes.json")).tiers[var.size]
  name    = var.name
  tags    = merge(var.tags, { "agentswarms:stack" = var.name, "agentswarms:target" = "eks" })
  app_ns  = "agentswarms"
  sbx_ns  = "agentswarms-sandboxes"
  ami     = var.architecture == "ARM64" ? "AL2023_ARM_64_STANDARD" : "AL2023_x86_64_STANDARD"
  sbx_tag = "agentswarms.io/sandbox"
}

data "aws_caller_identity" "this" {}
data "aws_partition" "this" {}

module "network" {
  source                 = "../modules/network"
  name                   = local.name
  region                 = var.region
  cidr                   = var.vpc_cidr
  az_count               = local.tier.azs
  single_nat             = coalesce(var.single_nat, local.tier.single_nat)
  interface_endpoint_azs = 0
  interface_endpoints    = []
  public_subnet_tags     = { "kubernetes.io/role/elb" = "1" }
  app_subnet_tags        = { "kubernetes.io/role/internal-elb" = "1" }
  tags                   = local.tags
}

module "data" {
  source              = "../modules/data"
  name                = local.name
  vpc_id              = module.network.vpc_id
  data_subnet_ids     = module.network.data_subnet_ids
  db_instance_class   = local.tier.rds.instance_class
  multi_az            = local.tier.rds.multi_az
  db_storage_gb       = local.tier.rds.storage_gb
  db_max_storage_gb   = local.tier.rds.max_storage_gb
  deletion_protection = var.deletion_protection
  valkey_node_type    = null
  db_clients          = { eks = aws_eks_cluster.this.vpc_config[0].cluster_security_group_id }
  tags                = local.tags
}

module "secrets" {
  source               = "../modules/secrets"
  name                 = local.name
  kms_key_arn          = module.data.kms_key_arn
  recovery_window_days = var.deletion_protection ? 30 : 0
  tags                 = local.tags
}

module "edge" {
  source              = "../modules/edge"
  name                = local.name
  vpc_id              = module.network.vpc_id
  vpc_cidr            = module.network.vpc_cidr
  public_subnet_ids   = module.network.public_subnet_ids
  target_type         = "ip"
  domain_name         = var.domain_name
  certificate_arn     = var.certificate_arn
  route53_zone_id     = var.route53_zone_id
  deletion_protection = var.deletion_protection
  tags                = local.tags
}

# ── The cluster ─────────────────────────────────────────────────────────────

resource "aws_iam_role" "cluster" {
  name = "${local.name}-eks-cluster"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = ["sts:AssumeRole", "sts:TagSession"], Principal = { Service = "eks.amazonaws.com" } }]
  })
  tags = local.tags
}

resource "aws_iam_role_policy_attachment" "cluster" {
  role       = aws_iam_role.cluster.name
  policy_arn = "arn:${data.aws_partition.this.partition}:iam::aws:policy/AmazonEKSClusterPolicy"
}

resource "aws_eks_cluster" "this" {
  name     = local.name
  version  = var.kubernetes_version
  role_arn = aws_iam_role.cluster.arn
  vpc_config {
    subnet_ids              = module.network.app_subnet_ids
    endpoint_private_access = true
    endpoint_public_access  = true
    public_access_cidrs     = var.api_allowed_cidrs
  }
  access_config {
    authentication_mode                         = "API"
    bootstrap_cluster_creator_admin_permissions = true
  }
  encryption_config {
    resources = ["secrets"]
    provider {
      key_arn = module.data.kms_key_arn
    }
  }
  enabled_cluster_log_types = ["api", "audit", "authenticator"]
  tags                      = local.tags
  depends_on                = [aws_iam_role_policy_attachment.cluster]
}

resource "aws_iam_role" "node" {
  name = "${local.name}-eks-node"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = "sts:AssumeRole", Principal = { Service = "ec2.amazonaws.com" } }]
  })
  tags = local.tags
}

resource "aws_iam_role_policy_attachment" "node" {
  for_each = toset([
    "AmazonEKSWorkerNodePolicy",
    "AmazonEKS_CNI_Policy",
    "AmazonEC2ContainerRegistryReadOnly",
    "AmazonSSMManagedInstanceCore",
  ])
  role       = aws_iam_role.node.name
  policy_arn = "arn:${data.aws_partition.this.partition}:iam::aws:policy/${each.value}"
}

# The app, Supabase's services, the gateways.
resource "aws_eks_node_group" "app" {
  cluster_name    = aws_eks_cluster.this.name
  node_group_name = "app"
  node_role_arn   = aws_iam_role.node.arn
  subnet_ids      = module.network.app_subnet_ids
  ami_type        = local.ami
  instance_types  = [coalesce(var.instance_type, local.tier.eks.instance_type)]
  disk_size       = 60
  scaling_config {
    min_size     = local.tier.eks.min
    max_size     = local.tier.eks.max
    desired_size = local.tier.eks.desired
  }
  update_config {
    max_unavailable = 1
  }
  labels = { "agentswarms.io/pool" = "app" }
  tags   = local.tags
  lifecycle {
    ignore_changes = [scaling_config[0].desired_size]
  }
  depends_on = [aws_iam_role_policy_attachment.node]
}

# Users' code, and nothing else: the taint keeps every other pod off.
resource "aws_eks_node_group" "sandboxes" {
  cluster_name    = aws_eks_cluster.this.name
  node_group_name = "sandboxes"
  node_role_arn   = aws_iam_role.node.arn
  subnet_ids      = module.network.app_subnet_ids
  ami_type        = local.ami
  instance_types  = [local.tier.eks.sandbox_instance_type]
  disk_size       = 60
  scaling_config {
    min_size     = 1
    max_size     = local.tier.eks.sandbox_max
    desired_size = 1
  }
  update_config {
    max_unavailable = 1
  }
  labels = { "agentswarms.io/pool" = "sandboxes" }
  taint {
    key    = local.sbx_tag
    value  = "true"
    effect = "NO_SCHEDULE"
  }
  tags = local.tags
  lifecycle {
    ignore_changes = [scaling_config[0].desired_size]
  }
  depends_on = [aws_iam_role_policy_attachment.node]
}

# The VPC CNI enforces NetworkPolicy: the sandboxes' namespace relies on it.
resource "aws_eks_addon" "this" {
  for_each = {
    "vpc-cni"                = jsonencode({ enableNetworkPolicy = "true" })
    "coredns"                = null
    "kube-proxy"             = null
    "eks-pod-identity-agent" = null
  }
  cluster_name                = aws_eks_cluster.this.name
  addon_name                  = each.key
  configuration_values        = each.value
  resolve_conflicts_on_create = "OVERWRITE"
  resolve_conflicts_on_update = "OVERWRITE"
  tags                        = local.tags
  depends_on                  = [aws_eks_node_group.app]
}

# ── Pod Identity: an IAM role per Kubernetes service account ────────────────

locals {
  pod_identity_trust = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = ["sts:AssumeRole", "sts:TagSession"]
      Principal = { Service = "pods.eks.amazonaws.com" }
    }]
  })
  roles = {
    app = {
      namespace = local.app_ns
      sa        = "agentswarms"
      policy = jsonencode({
        Version = "2012-10-17"
        Statement = [
          { Effect = "Allow", Action = ["s3:ListBucket", "s3:GetBucketLocation"], Resource = module.data.lake_bucket_arn },
          {
            Effect   = "Allow"
            Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"]
            Resource = "${module.data.lake_bucket_arn}/*"
          },
          { Effect = "Allow", Action = ["kms:Decrypt", "kms:GenerateDataKey", "kms:Encrypt"], Resource = module.data.kms_key_arn },
        ]
      })
    }
    storage = {
      namespace = local.app_ns
      sa        = "agentswarms-storage"
      policy = jsonencode({
        Version = "2012-10-17"
        Statement = [
          { Effect = "Allow", Action = ["s3:ListBucket", "s3:GetBucketLocation"], Resource = module.data.storage_bucket_arn },
          {
            Effect   = "Allow"
            Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"]
            Resource = "${module.data.storage_bucket_arn}/*"
          },
          { Effect = "Allow", Action = ["kms:Decrypt", "kms:GenerateDataKey"], Resource = module.data.kms_key_arn },
        ]
      })
    }
    external-secrets = {
      namespace = "external-secrets"
      sa        = "external-secrets"
      policy = jsonencode({
        Version = "2012-10-17"
        Statement = [
          {
            Effect   = "Allow"
            Action   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
            Resource = [module.secrets.secret_arn, module.data.db_master_secret_arn]
          },
          { Effect = "Allow", Action = ["kms:Decrypt"], Resource = module.data.kms_key_arn },
        ]
      })
    }
    load-balancer-controller = {
      namespace = "kube-system"
      sa        = "aws-load-balancer-controller"
      policy    = file("${path.module}/lbc-iam-policy.json")
    }
    cluster-autoscaler = {
      namespace = "kube-system"
      sa        = "cluster-autoscaler"
      policy = jsonencode({
        Version = "2012-10-17"
        Statement = [
          {
            Effect = "Allow"
            Action = [
              "autoscaling:DescribeAutoScalingGroups", "autoscaling:DescribeAutoScalingInstances",
              "autoscaling:DescribeLaunchConfigurations", "autoscaling:DescribeScalingActivities",
              "autoscaling:DescribeTags", "ec2:DescribeImages", "ec2:DescribeInstanceTypes",
              "ec2:DescribeLaunchTemplateVersions", "ec2:GetInstanceTypesFromInstanceRequirements",
              "eks:DescribeNodegroup",
            ]
            Resource = "*"
          },
          {
            Effect    = "Allow"
            Action    = ["autoscaling:SetDesiredCapacity", "autoscaling:TerminateInstanceInAutoScalingGroup"]
            Resource  = "*"
            Condition = { StringEquals = { "aws:ResourceTag/eks:cluster-name" = local.name } }
          },
        ]
      })
    }
  }
}

resource "aws_iam_role" "pod" {
  for_each           = local.roles
  name               = "${local.name}-${each.key}"
  assume_role_policy = local.pod_identity_trust
  tags               = local.tags
}

resource "aws_iam_role_policy" "pod" {
  for_each = local.roles
  name     = each.key
  role     = aws_iam_role.pod[each.key].id
  policy   = each.value.policy
}

resource "aws_eks_pod_identity_association" "this" {
  for_each        = local.roles
  cluster_name    = aws_eks_cluster.this.name
  namespace       = each.value.namespace
  service_account = each.value.sa
  role_arn        = aws_iam_role.pod[each.key].arn
  tags            = local.tags
  depends_on      = [aws_eks_addon.this]
}

# ── The platform's own charts ───────────────────────────────────────────────

resource "helm_release" "metrics_server" {
  name       = "metrics-server"
  namespace  = "kube-system"
  repository = "https://kubernetes-sigs.github.io/metrics-server/"
  chart      = "metrics-server"
  version    = "3.14.0"
  depends_on = [aws_eks_addon.this]
}

resource "helm_release" "load_balancer_controller" {
  name       = "aws-load-balancer-controller"
  namespace  = "kube-system"
  repository = "https://aws.github.io/eks-charts"
  chart      = "aws-load-balancer-controller"
  version    = "3.6.1"
  values = [yamlencode({
    clusterName    = aws_eks_cluster.this.name
    region         = var.region
    vpcId          = module.network.vpc_id
    replicaCount   = 2
    serviceAccount = { create = true, name = "aws-load-balancer-controller" }
  })]
  depends_on = [aws_eks_pod_identity_association.this, aws_eks_addon.this]
}

resource "helm_release" "external_secrets" {
  name             = "external-secrets"
  namespace        = "external-secrets"
  create_namespace = true
  repository       = "https://charts.external-secrets.io"
  chart            = "external-secrets"
  version          = "2.14.0"
  values = [yamlencode({
    installCRDs    = true
    serviceAccount = { create = true, name = "external-secrets" }
  })]
  depends_on = [aws_eks_pod_identity_association.this, aws_eks_addon.this]
}

resource "helm_release" "cluster_autoscaler" {
  name       = "cluster-autoscaler"
  namespace  = "kube-system"
  repository = "https://kubernetes.github.io/autoscaler"
  chart      = "cluster-autoscaler"
  version    = "9.59.0"
  values = [yamlencode({
    autoDiscovery = { clusterName = aws_eks_cluster.this.name }
    awsRegion     = var.region
    rbac          = { serviceAccount = { create = true, name = "cluster-autoscaler" } }
    extraArgs = {
      "balance-similar-node-groups"   = true
      "skip-nodes-with-local-storage" = false
      "expander"                      = "least-waste"
    }
  })]
  depends_on = [aws_eks_pod_identity_association.this, aws_eks_addon.this]
}

# ── AgentSwarms ─────────────────────────────────────────────────────────────

resource "helm_release" "agentswarms" {
  name             = "agentswarms"
  namespace        = local.app_ns
  create_namespace = true
  chart            = "${path.module}/../../../helm/agentswarms"
  # The deploy Job (migrations, the first admin) runs before anything rolls;
  # a failed upgrade rolls back.
  atomic  = true
  wait    = true
  timeout = 1800
  values = [yamlencode({
    release    = var.release
    registry   = var.source_registry
    publicUrl  = module.edge.public_url
    adminEmail = coalesce(var.admin_email, "")
    secrets = {
      name = "agentswarms"
      externalSecrets = {
        enabled                 = true
        createStore             = true
        storeRef                = { kind = "ClusterSecretStore", name = "aws-secrets-manager" }
        remoteKey               = module.secrets.secret_name
        databaseMasterRemoteKey = module.data.db_master_secret_arn
      }
    }
    database = { host = module.data.db_address, masterUsername = module.data.db_master_username }
    aws = {
      region        = var.region
      storageBucket = module.data.storage_bucket
      lakeBucket    = module.data.lake_bucket
      kmsKeyArn     = module.data.kms_key_arn
    }
    web = {
      replicas    = local.tier.ecs.web.min
      workers     = local.tier.ecs.web.workers
      autoscaling = { enabled = true, min = local.tier.ecs.web.min, max = local.tier.ecs.web.max, cpu = 60 }
    }
    analytics       = { replicas = local.tier.ecs.analytics.count, workers = local.tier.ecs.analytics.workers }
    notebookGateway = { replicas = local.tier.ecs.gateway_count }
    docgen          = { replicas = local.tier.ecs.internal_count }
    jsSandbox       = { replicas = local.tier.ecs.internal_count }
    supabase        = { replicas = local.tier.ecs.supabase.count }
    sandboxes = {
      namespace    = local.sbx_ns
      nodeSelector = { "agentswarms.io/pool" = "sandboxes" }
      tolerations  = [{ key = local.sbx_tag, operator = "Exists", effect = "NoSchedule" }]
      egressProxy  = { replicas = local.tier.ecs.egress_count }
    }
    ingress = { enabled = false }
    targetGroupBindings = {
      enabled            = true
      app                = module.edge.target_group_arns.app
      supabase           = module.edge.target_group_arns.supabase
      gateway            = module.edge.target_group_arns.gateway
      albSecurityGroupId = module.edge.alb_security_group_id
    }
    extraEnv = merge(var.app_env, {
      TRUSTED_PROXY_HOPS     = var.domain_name == null ? "2" : "1"
      EARLY_HEADERS_AFTER_MS = var.domain_name == null ? "45000" : ""
    })
  })]
  depends_on = [
    helm_release.load_balancer_controller,
    helm_release.external_secrets,
    helm_release.metrics_server,
    aws_eks_node_group.sandboxes,
    aws_eks_pod_identity_association.this,
  ]
}

resource "aws_budgets_budget" "this" {
  count        = var.monthly_budget_usd > 0 && var.admin_email != null ? 1 : 0
  name         = "${local.name}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.admin_email]
  }
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.admin_email]
  }
}
