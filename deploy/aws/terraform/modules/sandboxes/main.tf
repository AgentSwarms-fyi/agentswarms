# Where user code runs on AWS when the app runs on ECS or on VMs: one Fargate
# task per sandbox (NOTEBOOK_RUNTIME_BACKEND=ecs, R477), in subnets with no
# route out, reaching only the egress proxy (also here), the app, and the VPC
# endpoints.
#
# The sandbox image is copied into this account's ECR (aws_ecr_repository +
# the copy below): a Fargate task pulls through its own network, which has no
# route to ghcr.io, and reaches ECR through the endpoints.

locals {
  tags            = merge(var.tags, { "agentswarms:stack" = var.name })
  sandbox_image   = coalesce(var.sandbox_image_override, "${aws_ecr_repository.runtime.repository_url}:${var.release}")
  container_name  = "kernel"
  stream_prefix   = "nb"
  egress_dns_name = "egress.${aws_service_discovery_private_dns_namespace.this.name}"
}

data "aws_region" "this" {}

resource "aws_ecs_cluster" "this" {
  name = var.name
  setting {
    name  = "containerInsights"
    value = var.container_insights ? "enhanced" : "disabled"
  }
  tags = local.tags
}

# The cluster's capacity providers are one resource per cluster: on ECS the
# app's module owns it (it adds its EC2 provider and must order its services
# after it); elsewhere this one does.
resource "aws_ecs_cluster_capacity_providers" "this" {
  count              = var.manage_capacity_providers ? 1 : 0
  cluster_name       = aws_ecs_cluster.this.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]
  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }
}

# Names inside the VPC: egress.<namespace> for the sandboxes' proxy, and
# whatever the app tier registers.
resource "aws_service_discovery_private_dns_namespace" "this" {
  name        = "${var.name}.internal"
  description = "AgentSwarms ${var.name} services"
  vpc         = var.vpc_id
  tags        = local.tags
}

# ── Security groups ──────────────────────────────────────────────────────────

resource "aws_security_group" "sandbox" {
  name        = "${var.name}-sandbox"
  description = "Sandboxes: in from the app and gateway on 8888; out only to the proxy, the app and the endpoints"
  vpc_id      = var.vpc_id
  tags        = merge(local.tags, { Name = "${var.name}-sandbox" })
}

resource "aws_security_group" "egress" {
  name        = "${var.name}-egress-proxy"
  description = "The sandbox egress proxy: 3128 from sandboxes; out to the internet"
  vpc_id      = var.vpc_id
  tags        = merge(local.tags, { Name = "${var.name}-egress-proxy" })
}

resource "aws_vpc_security_group_ingress_rule" "sandbox_from_app" {
  for_each                     = var.sandbox_clients
  security_group_id            = aws_security_group.sandbox.id
  referenced_security_group_id = each.value
  from_port                    = 8888
  to_port                      = 8888
  ip_protocol                  = "tcp"
  description                  = "kernel and MCP port from ${each.key}"
}

resource "aws_vpc_security_group_egress_rule" "sandbox_to_proxy" {
  security_group_id            = aws_security_group.sandbox.id
  referenced_security_group_id = aws_security_group.egress.id
  from_port                    = 3128
  to_port                      = 3128
  ip_protocol                  = "tcp"
  description                  = "the egress proxy"
}

resource "aws_vpc_security_group_egress_rule" "sandbox_to_app" {
  for_each                     = var.app_callback_targets
  security_group_id            = aws_security_group.sandbox.id
  referenced_security_group_id = each.value.security_group_id
  from_port                    = each.value.port
  to_port                      = each.value.port
  ip_protocol                  = "tcp"
  description                  = "callbacks to ${each.key}"
}

resource "aws_vpc_security_group_egress_rule" "sandbox_to_endpoints" {
  for_each                     = var.endpoints_security_groups
  security_group_id            = aws_security_group.sandbox.id
  referenced_security_group_id = each.value
  from_port                    = 443
  to_port                      = 443
  ip_protocol                  = "tcp"
  description                  = "ECR, Logs: the VPC interface endpoints"
}

# Image layers come from S3 through the gateway endpoint.
resource "aws_vpc_security_group_egress_rule" "sandbox_to_s3" {
  security_group_id = aws_security_group.sandbox.id
  prefix_list_id    = var.s3_prefix_list_id
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  description       = "S3: image layers, and the lake"
}

resource "aws_vpc_security_group_egress_rule" "sandbox_dns" {
  security_group_id = aws_security_group.sandbox.id
  cidr_ipv4         = "${cidrhost(var.vpc_cidr, 2)}/32"
  from_port         = 53
  to_port           = 53
  ip_protocol       = "udp"
  description       = "the VPC resolver"
}

resource "aws_vpc_security_group_ingress_rule" "egress_from_sandbox" {
  security_group_id            = aws_security_group.egress.id
  referenced_security_group_id = aws_security_group.sandbox.id
  from_port                    = 3128
  to_port                      = 3128
  ip_protocol                  = "tcp"
  description                  = "sandboxes"
}

resource "aws_vpc_security_group_egress_rule" "egress_out" {
  for_each          = toset(["80", "443", "9000", "19000"])
  security_group_id = aws_security_group.egress.id
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = tonumber(each.value)
  to_port           = tonumber(each.value)
  ip_protocol       = "tcp"
  description       = "what the squid Safe_ports allow"
}

resource "aws_vpc_security_group_egress_rule" "egress_dns" {
  security_group_id = aws_security_group.egress.id
  cidr_ipv4         = "${cidrhost(var.vpc_cidr, 2)}/32"
  from_port         = 53
  to_port           = 53
  ip_protocol       = "udp"
  description       = "the VPC resolver"
}

# ── The sandbox image, in this account ──────────────────────────────────────

resource "aws_ecr_repository" "runtime" {
  name                 = "${var.name}/notebook-runtime"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = var.force_delete
  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = var.kms_key_arn
  }
  image_scanning_configuration {
    scan_on_push = true
  }
  tags = local.tags
}

resource "aws_ecr_lifecycle_policy" "runtime" {
  repository = aws_ecr_repository.runtime.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "keep the last 5 releases"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 5 }
      action       = { type = "expire" }
    }]
  })
}

# Registry to registry, both architectures, nothing pulled to this machine:
# needs docker (with buildx) and the AWS CLI where Terraform runs. Set
# sandbox_image_override to an image already in a reachable ECR to skip it.
resource "terraform_data" "copy_runtime" {
  count            = var.sandbox_image_override == null ? 1 : 0
  triggers_replace = [var.release, aws_ecr_repository.runtime.repository_url]
  provisioner "local-exec" {
    interpreter = ["bash", "-c"]
    command     = "bash '${path.module}/../../../scripts/copy-image.sh' '${var.source_registry}/notebook-runtime:${var.release}' '${aws_ecr_repository.runtime.repository_url}:${var.release}' '${data.aws_region.this.region}'"
  }
}

# ── Logs ────────────────────────────────────────────────────────────────────

resource "aws_cloudwatch_log_group" "sandboxes" {
  name              = "/agentswarms/${var.name}/sandboxes"
  retention_in_days = var.log_retention_days
  tags              = local.tags
}

resource "aws_cloudwatch_log_group" "egress" {
  name              = "/agentswarms/${var.name}/egress-proxy"
  retention_in_days = var.log_retention_days
  tags              = local.tags
}

# ── Roles ───────────────────────────────────────────────────────────────────

data "aws_iam_policy_document" "assume_tasks" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# ECS's own role for starting a sandbox: pull the image, write its logs. The
# sandbox gets NO task role, so there are no AWS credentials inside it to
# steal (the task metadata endpoint has none to give).
resource "aws_iam_role" "sandbox_execution" {
  name               = "${var.name}-sandbox-execution"
  assume_role_policy = data.aws_iam_policy_document.assume_tasks.json
  tags               = local.tags
}

resource "aws_iam_role_policy_attachment" "sandbox_execution" {
  role       = aws_iam_role.sandbox_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "sandbox_execution_kms" {
  name = "ecr-kms"
  role = aws_iam_role.sandbox_execution.id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = ["kms:Decrypt"], Resource = var.kms_key_arn }]
  })
}

resource "aws_iam_role" "egress_execution" {
  name               = "${var.name}-egress-execution"
  assume_role_policy = data.aws_iam_policy_document.assume_tasks.json
  tags               = local.tags
}

resource "aws_iam_role_policy_attachment" "egress_execution" {
  role       = aws_iam_role.egress_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "egress_execution_secret" {
  name = "pull-token"
  role = aws_iam_role.egress_execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = var.secret_arn },
      { Effect = "Allow", Action = ["kms:Decrypt"], Resource = var.kms_key_arn },
    ]
  })
}

# ── The sandbox task definition ─────────────────────────────────────────────

resource "aws_ecs_task_definition" "sandbox" {
  family                   = "${var.name}-sandbox"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  # The smallest size; RunTask overrides CPU and memory per sandbox.
  cpu                = "1024"
  memory             = "2048"
  execution_role_arn = aws_iam_role.sandbox_execution.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.architecture
  }
  ephemeral_storage {
    size_in_gib = 30
  }
  volume {
    name = "local"
  }
  volume {
    name = "work"
  }
  volume {
    name = "tmp"
  }
  container_definitions = jsonencode([
    # Fargate's scratch volumes start owned by root, and the kernel runs as
    # uid 1000: this hands them over, as the Docker backend's tmpfs mode=1777
    # does, and exits. A fixed command; no user code runs in it.
    {
      name                   = "prepare"
      image                  = local.sandbox_image
      essential              = false
      user                   = "0"
      readonlyRootFilesystem = true
      entryPoint             = ["/bin/sh", "-c"]
      command                = ["chown 1000:1000 /mnt/local /mnt/work && chmod 1777 /mnt/tmp"]
      mountPoints = [
        { sourceVolume = "local", containerPath = "/mnt/local", readOnly = false },
        { sourceVolume = "work", containerPath = "/mnt/work", readOnly = false },
        { sourceVolume = "tmp", containerPath = "/mnt/tmp", readOnly = false },
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.sandboxes.name
          awslogs-region        = data.aws_region.this.region
          awslogs-stream-prefix = local.stream_prefix
        }
      }
    },
    {
      name      = local.container_name
      image     = local.sandbox_image
      essential = true
      dependsOn = [{ containerName = "prepare", condition = "SUCCESS" }]
      # Hardened as the Docker backend's are (docs/DEVELOPER_WORKSPACE_RUNTIME.md
      # §5.1): the image's own user (runner, 1000), a read-only root, every
      # capability dropped, writable only where the kernel writes.
      readonlyRootFilesystem = true
      user                   = "1000:1000"
      linuxParameters = {
        capabilities       = { drop = ["ALL"] }
        initProcessEnabled = true
      }
      mountPoints = [
        { sourceVolume = "local", containerPath = "/home/runner/.local", readOnly = false },
        { sourceVolume = "work", containerPath = "/home/runner/work", readOnly = false },
        { sourceVolume = "tmp", containerPath = "/tmp", readOnly = false },
      ]
      portMappings = [{ containerPort = 8888, protocol = "tcp" }]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.sandboxes.name
          awslogs-region        = data.aws_region.this.region
          awslogs-stream-prefix = local.stream_prefix
        }
      }
    },
  ])
  tags       = local.tags
  depends_on = [terraform_data.copy_runtime]
}

# ── The egress proxy ────────────────────────────────────────────────────────

resource "aws_ecs_task_definition" "egress" {
  family                   = "${var.name}-egress-proxy"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.egress_execution.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.architecture
  }
  container_definitions = jsonencode([{
    name                   = "egress-proxy"
    image                  = "${var.source_registry}/egress-proxy:${var.release}"
    essential              = true
    readonlyRootFilesystem = false
    portMappings           = [{ containerPort = 3128, protocol = "tcp" }]
    environment = [
      { name = "EGRESS_PULL_URL", value = "${var.app_internal_url}/api/notebook/runtime/egress" },
      { name = "EGRESS_PULL_INTERVAL", value = "30" },
    ]
    secrets = [{ name = "EGRESS_PULL_TOKEN", valueFrom = "${var.secret_arn}:egress_pull_token::" }]
    healthCheck = {
      command     = ["CMD-SHELL", "nc -z 127.0.0.1 3128 || exit 1"]
      interval    = 15
      timeout     = 5
      retries     = 3
      startPeriod = 90
    }
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.egress.name
        awslogs-region        = data.aws_region.this.region
        awslogs-stream-prefix = "egress"
      }
    }
  }])
  tags = local.tags
}

resource "aws_service_discovery_service" "egress" {
  name = "egress"
  dns_config {
    namespace_id   = aws_service_discovery_private_dns_namespace.this.id
    routing_policy = "MULTIVALUE"
    dns_records {
      type = "A"
      ttl  = 10
    }
  }
  health_check_custom_config {}
  tags = local.tags
}

resource "aws_ecs_service" "egress" {
  name            = "egress-proxy"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.egress.arn
  desired_count   = var.egress_count
  launch_type     = "FARGATE"
  # In the app subnets: it is the one thing here with a way out (the NAT).
  network_configuration {
    subnets          = var.app_subnet_ids
    security_groups  = [aws_security_group.egress.id]
    assign_public_ip = false
  }
  service_registries {
    registry_arn = aws_service_discovery_service.egress.arn
  }
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  propagate_tags = "SERVICE"
  tags           = local.tags
}

# ── What the app needs to run sandboxes ─────────────────────────────────────

data "aws_iam_policy_document" "app_runs_sandboxes" {
  statement {
    sid       = "StartSandboxes"
    actions   = ["ecs:RunTask"]
    resources = ["arn:aws:ecs:${data.aws_region.this.region}:*:task-definition/${aws_ecs_task_definition.sandbox.family}:*"]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.this.arn]
    }
  }
  statement {
    sid       = "TagThem"
    actions   = ["ecs:TagResource"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "ecs:CreateAction"
      values   = ["RunTask"]
    }
  }
  statement {
    sid       = "WatchAndStopThem"
    actions   = ["ecs:DescribeTasks", "ecs:StopTask"]
    resources = ["arn:aws:ecs:${data.aws_region.this.region}:*:task/${aws_ecs_cluster.this.name}/*"]
  }
  statement {
    sid       = "TheCluster"
    actions   = ["ecs:DescribeClusters"]
    resources = [aws_ecs_cluster.this.arn]
  }
  statement {
    sid       = "PassOnlyTheSandboxExecutionRole"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.sandbox_execution.arn]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
  statement {
    sid       = "ReadTheirLogs"
    actions   = ["logs:GetLogEvents"]
    resources = ["${aws_cloudwatch_log_group.sandboxes.arn}:log-stream:*"]
  }
}
