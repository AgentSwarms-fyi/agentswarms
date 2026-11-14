# The app on Amazon ECS: its own containers on EC2 (an Auto Scaling group the
# cluster scales through a capacity provider), the code it runs for users on
# Fargate (modules/sandboxes), and the two services that handle untrusted
# input, docgen and js-sandbox, on Fargate too.
#
#   web        the UI and every /api route; behind the load balancer;
#              autoscaled on CPU; DISABLE_INPROCESS_SCHEDULER=1
#   analytics  the same image with APP_ROLE=analytics: runs the scheduler
#              (one lease across the fleet, R463) and heavy jobs, out of the
#              request path; two, in two AZs
#   gateway    the notebook websocket gateway, /nbgw
#   docgen, js-sandbox   internal only, by name in Cloud Map
#
# EC2 tasks reach neither the instance's metadata (ECS_AWSVPC_BLOCK_IMDS) nor
# each other's credentials: each task has its own ENI and role, and user code
# never runs on these hosts.

locals {
  tags     = merge(var.tags, { "agentswarms:stack" = var.name })
  region   = data.aws_region.this.region
  ns       = var.namespace_name
  image    = "${var.source_registry}/agentswarms:${var.release}"
  ami_path = var.architecture == "ARM64" ? "/aws/service/ecs/optimized-ami/amazon-linux-2023/arm64/recommended/image_id" : "/aws/service/ecs/optimized-ami/amazon-linux-2023/recommended/image_id"
  s        = { for k in var.secret_keys : k => "${var.secret_arn}:${k}::" }
  log = { for svc in ["web", "analytics", "gateway", "docgen", "js-sandbox"] : svc => {
    logDriver = "awslogs"
    options = {
      awslogs-group         = aws_cloudwatch_log_group.this.name
      awslogs-region        = local.region
      awslogs-stream-prefix = svc
    }
  } }

  catalog_url = "postgres://lakehouse@${var.db_host}:${var.db_port}/lakehouse_catalog?sslmode=require"

  app_env = [for k, v in merge(
    {
      PORT                     = "8080"
      PUBLIC_APP_URL           = var.public_url
      SITE_URL                 = var.public_url
      SUPABASE_URL             = var.public_url
      PUBLIC_SUPABASE_URL      = var.public_url
      PUBLIC_SUPABASE_REALTIME = "off"
      ADMIN_EMAIL              = coalesce(var.admin_email, "")
      PUBLIC_ADMIN_EMAIL       = coalesce(var.admin_email, "")
      NOTEBOOK_RUNTIME_ENABLED = "true"
      NOTEBOOK_GATEWAY_URL     = "wss://${var.public_host}/nbgw"
      DOCGEN_SERVICE_URL       = "http://docgen.${local.ns}:8099"
      JS_SANDBOX_URL           = "http://js-sandbox.${local.ns}:8091"
      VECTOR_STORE             = "pgvector"
      LAKEHOUSE_CATALOG_URL    = local.catalog_url
      LAKEHOUSE_DATA_URL       = "s3://${var.lake_bucket}/main"
      LAKEHOUSE_S3_REGION      = local.region
      LAKEHOUSE_S3_URL_STYLE   = "vhost"
      LAKEHOUSE_SSE_KMS        = var.kms_key_arn
      AWS_REGION               = local.region
      TRUSTED_PROXY_HOPS       = var.behind_cloudfront ? "2" : "1"
      # CloudFront gives up on a first byte after 60 s; a slow chat turn sends its
      # headers at 45 (R481). Empty elsewhere: off.
      EARLY_HEADERS_AFTER_MS    = var.behind_cloudfront ? "45000" : ""
      HTTP_KEEPALIVE_TIMEOUT_MS = "125000"
      SCHEDULER_LEASE_TTL_MS    = "120000"
    },
    var.sandbox_env,
    var.extra_env,
  ) : { name = k, value = v }]

  app_secrets = concat([
    { name = "SUPABASE_PUBLISHABLE_KEY", valueFrom = local.s.anon_key },
    { name = "PUBLIC_SUPABASE_PUBLISHABLE_KEY", valueFrom = local.s.anon_key },
    { name = "SUPABASE_SERVICE_ROLE_KEY", valueFrom = local.s.service_role_key },
    { name = "PROVIDER_CREDS_SECRET", valueFrom = local.s.provider_creds_secret },
    { name = "INTERNAL_RUN_SECRET", valueFrom = local.s.internal_run_secret },
    { name = "NOTEBOOK_RUNTIME_SECRET", valueFrom = local.s.notebook_runtime_secret },
    { name = "NOTEBOOK_EGRESS_PULL_TOKEN", valueFrom = local.s.egress_pull_token },
    { name = "DOCGEN_TOKEN", valueFrom = local.s.docgen_token },
    { name = "PROVENANCE_SIGNING_SECRET", valueFrom = local.s.provenance_signing_secret },
    { name = "METRICS_TOKEN", valueFrom = local.s.metrics_token },
    { name = "LAKEHOUSE_CATALOG_PASSWORD", valueFrom = local.s.lakehouse_catalog_password },
  ], var.valkey_url_secret_arn == null ? [] : [{ name = "FEATURE_STORE_URL", valueFrom = var.valkey_url_secret_arn }])

  app_health = {
    command     = ["CMD", "node", "-e", "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
    interval    = 15
    timeout     = 5
    retries     = 4
    startPeriod = 120
  }
}

data "aws_region" "this" {}

resource "aws_cloudwatch_log_group" "this" {
  name              = "/agentswarms/${var.name}/app"
  retention_in_days = var.log_retention_days
  tags              = local.tags
}

# ── EC2 capacity ─────────────────────────────────────────────────────────────

data "aws_ssm_parameter" "ami" {
  name = local.ami_path
}

data "aws_iam_policy_document" "assume_ec2" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "instance" {
  name               = "${var.name}-ecs-instance"
  assume_role_policy = data.aws_iam_policy_document.assume_ec2.json
  tags               = local.tags
}

resource "aws_iam_role_policy_attachment" "instance" {
  for_each = toset([
    "arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role",
    "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
  ])
  role       = aws_iam_role.instance.name
  policy_arn = each.value
}

resource "aws_iam_instance_profile" "instance" {
  name = "${var.name}-ecs-instance"
  role = aws_iam_role.instance.name
}

resource "aws_security_group" "instance" {
  name        = "${var.name}-ecs-instance"
  description = "ECS container instances: nothing in (tasks have their own ENIs); out for the ECS agent and image pulls"
  vpc_id      = var.vpc_id
  tags        = merge(local.tags, { Name = "${var.name}-ecs-instance" })
}

resource "aws_vpc_security_group_egress_rule" "instance" {
  security_group_id = aws_security_group.instance.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

# Many tasks per instance each need an ENI; trunking raises the number an
# instance may hold. It is an account default, so it changes this region's
# default for every new instance: turn it off if that is not yours to change.
resource "aws_ecs_account_setting_default" "trunking" {
  count = var.enable_awsvpc_trunking ? 1 : 0
  name  = "awsvpcTrunking"
  value = "enabled"
}

resource "aws_launch_template" "this" {
  name_prefix   = "${var.name}-ecs-"
  image_id      = data.aws_ssm_parameter.ami.value
  instance_type = var.instance_type
  iam_instance_profile {
    arn = aws_iam_instance_profile.instance.arn
  }
  vpc_security_group_ids = [aws_security_group.instance.id]
  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }
  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_size = 40
      volume_type = "gp3"
      encrypted   = true
    }
  }
  user_data = base64encode(<<-EOT
    #!/bin/bash
    cat >>/etc/ecs/ecs.config <<'CFG'
    ECS_CLUSTER=${var.cluster_name}
    ECS_AWSVPC_BLOCK_IMDS=true
    ECS_ENABLE_CONTAINER_METADATA=true
    ECS_CONTAINER_STOP_TIMEOUT=60s
    CFG
  EOT
  )
  tag_specifications {
    resource_type = "instance"
    tags          = merge(local.tags, { Name = "${var.name}-ecs" })
  }
  tags = local.tags
}

resource "aws_autoscaling_group" "this" {
  name_prefix           = "${var.name}-ecs-"
  min_size              = var.instances.min
  max_size              = var.instances.max
  desired_capacity      = var.instances.desired
  vpc_zone_identifier   = var.subnet_ids
  protect_from_scale_in = true
  launch_template {
    id      = aws_launch_template.this.id
    version = "$Latest"
  }
  instance_refresh {
    strategy = "Rolling"
    preferences {
      min_healthy_percentage = 50
    }
  }
  tag {
    key                 = "AmazonECSManaged"
    value               = "true"
    propagate_at_launch = true
  }
  dynamic "tag" {
    for_each = local.tags
    content {
      key                 = tag.key
      value               = tag.value
      propagate_at_launch = true
    }
  }
  lifecycle {
    ignore_changes = [desired_capacity]
  }
}

resource "aws_ecs_capacity_provider" "this" {
  name = "${var.name}-ec2"
  auto_scaling_group_provider {
    auto_scaling_group_arn         = aws_autoscaling_group.this.arn
    managed_termination_protection = "ENABLED"
    managed_draining               = "ENABLED"
    managed_scaling {
      status                    = "ENABLED"
      target_capacity           = 100
      minimum_scaling_step_size = 1
      maximum_scaling_step_size = 2
    }
  }
  tags = local.tags
}

# The cluster's providers: Fargate for sandboxes and the internal services,
# this group for the app. Services name it, so they wait for it.
resource "aws_ecs_cluster_capacity_providers" "this" {
  cluster_name       = var.cluster_name
  capacity_providers = ["FARGATE", "FARGATE_SPOT", aws_ecs_capacity_provider.this.name]
  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }
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

resource "aws_iam_role" "execution" {
  name               = "${var.name}-app-execution"
  assume_role_policy = data.aws_iam_policy_document.assume_tasks.json
  tags               = local.tags
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "execution_secrets" {
  name = "secrets"
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = compact([var.secret_arn, var.valkey_url_secret_arn])
      },
      { Effect = "Allow", Action = ["kms:Decrypt"], Resource = var.kms_key_arn },
    ]
  })
}

# The app's own identity: the lake, its key, the sandboxes, and whatever the
# operator adds (Glue, Athena, Redshift Data API for the connectors).
resource "aws_iam_role" "app" {
  name               = "${var.name}-app"
  assume_role_policy = data.aws_iam_policy_document.assume_tasks.json
  tags               = local.tags
}

resource "aws_iam_role_policy" "app_lake" {
  name = "lake"
  role = aws_iam_role.app.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["s3:ListBucket", "s3:GetBucketLocation"], Resource = var.lake_bucket_arn },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"]
        Resource = "${var.lake_bucket_arn}/*"
      },
      { Effect = "Allow", Action = ["kms:Decrypt", "kms:GenerateDataKey", "kms:Encrypt"], Resource = var.kms_key_arn },
    ]
  })
}

resource "aws_iam_role_policy" "app_sandboxes" {
  name   = "sandboxes"
  role   = aws_iam_role.app.id
  policy = var.sandbox_policy_json
}

resource "aws_iam_role_policy_attachment" "app_extra" {
  for_each   = toset(var.extra_app_policy_arns)
  role       = aws_iam_role.app.name
  policy_arn = each.value
}

# ── Security groups ─────────────────────────────────────────────────────────

resource "aws_security_group" "app" {
  name        = "${var.name}-app"
  description = "The app (web, analytics): 8080 from the load balancer, the sandboxes and the egress proxy"
  vpc_id      = var.vpc_id
  tags        = merge(local.tags, { Name = "${var.name}-app" })
}

resource "aws_vpc_security_group_ingress_rule" "app" {
  for_each                     = merge({ alb = var.alb_security_group_id }, var.app_clients)
  security_group_id            = aws_security_group.app.id
  referenced_security_group_id = each.value
  from_port                    = 8080
  to_port                      = 8080
  ip_protocol                  = "tcp"
  description                  = "from ${each.key}"
}

resource "aws_security_group" "gateway" {
  name        = "${var.name}-notebook-gateway"
  description = "The notebook gateway: 8090 from the load balancer"
  vpc_id      = var.vpc_id
  tags        = merge(local.tags, { Name = "${var.name}-notebook-gateway" })
}

resource "aws_vpc_security_group_ingress_rule" "gateway" {
  security_group_id            = aws_security_group.gateway.id
  referenced_security_group_id = var.alb_security_group_id
  from_port                    = 8090
  to_port                      = 8090
  ip_protocol                  = "tcp"
  description                  = "from the load balancer"
}

resource "aws_security_group" "internal" {
  for_each    = { docgen = 8099, "js-sandbox" = 8091 }
  name        = "${var.name}-${each.key}"
  description = "${each.key}: from the app only; out only to pull its image"
  vpc_id      = var.vpc_id
  tags        = merge(local.tags, { Name = "${var.name}-${each.key}" })
}

resource "aws_vpc_security_group_ingress_rule" "internal" {
  for_each                     = { docgen = 8099, "js-sandbox" = 8091 }
  security_group_id            = aws_security_group.internal[each.key].id
  referenced_security_group_id = aws_security_group.app.id
  from_port                    = each.value
  to_port                      = each.value
  ip_protocol                  = "tcp"
  description                  = "from the app"
}

resource "aws_vpc_security_group_egress_rule" "internal_https" {
  for_each          = aws_security_group.internal
  security_group_id = each.value.id
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  description       = "image pulls and logs"
}

resource "aws_vpc_security_group_egress_rule" "all" {
  for_each          = { app = aws_security_group.app.id, gateway = aws_security_group.gateway.id }
  security_group_id = each.value
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
  description       = "the database, Supabase, sandboxes, model providers"
}

# ── Task definitions ────────────────────────────────────────────────────────

resource "aws_ecs_task_definition" "app" {
  for_each                 = { web = var.web, analytics = var.analytics }
  family                   = "${var.name}-${each.key}"
  requires_compatibilities = ["EC2"]
  network_mode             = "awsvpc"
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.app.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.architecture
  }
  volume {
    name = "tmp"
  }
  container_definitions = jsonencode([{
    name              = "app"
    image             = local.image
    essential         = true
    cpu               = each.value.cpu
    memory            = each.value.memory
    memoryReservation = floor(each.value.memory * 3 / 4)
    portMappings      = [{ containerPort = 8080, protocol = "tcp" }]
    # Its workers follow this, not the host's core count (deploy/k8s note 1).
    environment = concat(local.app_env, [
      { name = "WEB_CONCURRENCY", value = tostring(each.value.workers) },
      { name = "APP_ROLE", value = each.key },
      { name = "DISABLE_INPROCESS_SCHEDULER", value = each.key == "web" ? "1" : "" },
      # Which deploy run migrated the schema this revision runs on.
      { name = "AGENTSWARMS_SCHEMA_DEPLOY", value = try(jsondecode(var.schema_deploy).task_arn, "") },
    ])
    secrets          = local.app_secrets
    healthCheck      = local.app_health
    stopTimeout      = 60
    mountPoints      = [{ sourceVolume = "tmp", containerPath = "/tmp", readOnly = false }]
    logConfiguration = local.log[each.key]
  }])
  tags = local.tags
}

resource "aws_ecs_task_definition" "gateway" {
  family                   = "${var.name}-notebook-gateway"
  requires_compatibilities = ["EC2"]
  network_mode             = "awsvpc"
  execution_role_arn       = aws_iam_role.execution.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.architecture
  }
  container_definitions = jsonencode([{
    name                   = "gateway"
    image                  = "${var.source_registry}/notebook-gateway:${var.release}"
    essential              = true
    cpu                    = 256
    memory                 = 512
    readonlyRootFilesystem = true
    portMappings           = [{ containerPort = 8090, protocol = "tcp" }]
    environment = [
      { name = "PORT", value = "8090" },
      { name = "SUPABASE_URL", value = var.public_url },
      { name = "HTTP_KEEPALIVE_TIMEOUT_MS", value = "125000" },
    ]
    secrets = [
      { name = "SUPABASE_SERVICE_ROLE_KEY", valueFrom = local.s.service_role_key },
      { name = "NOTEBOOK_RUNTIME_SECRET", valueFrom = local.s.notebook_runtime_secret },
    ]
    logConfiguration = local.log.gateway
  }])
  tags = local.tags
}

resource "aws_ecs_task_definition" "internal" {
  for_each = {
    docgen = {
      image   = "${var.source_registry}/docgen:${var.release}"
      port    = 8099
      cpu     = 1024
      memory  = 2048
      health  = ["CMD", "python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8099/health', timeout=5).status == 200 else 1)"]
      secrets = [{ name = "DOCGEN_TOKEN", valueFrom = local.s.docgen_token }]
      env     = []
    }
    "js-sandbox" = {
      image   = "${var.source_registry}/js-sandbox:${var.release}"
      port    = 8091
      cpu     = 512
      memory  = 1024
      health  = ["CMD", "node", "-e", "fetch('http://127.0.0.1:8091/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      secrets = [{ name = "INTERNAL_RUN_SECRET", valueFrom = local.s.internal_run_secret }]
      env     = [{ name = "PORT", value = "8091" }]
    }
  }
  family                   = "${var.name}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(each.value.cpu)
  memory                   = tostring(each.value.memory)
  execution_role_arn       = aws_iam_role.execution.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.architecture
  }
  container_definitions = jsonencode([{
    name             = each.key
    image            = each.value.image
    essential        = true
    portMappings     = [{ containerPort = each.value.port, protocol = "tcp" }]
    environment      = each.value.env
    secrets          = each.value.secrets
    healthCheck      = { command = each.value.health, interval = 30, timeout = 10, retries = 3, startPeriod = 60 }
    logConfiguration = local.log[each.key]
  }])
  tags = local.tags
}

# ── Names inside the VPC ────────────────────────────────────────────────────

resource "aws_service_discovery_service" "this" {
  for_each = toset(["app", "docgen", "js-sandbox"])
  name     = each.value
  dns_config {
    namespace_id   = var.namespace_id
    routing_policy = "MULTIVALUE"
    dns_records {
      type = "A"
      ttl  = 10
    }
  }
  health_check_custom_config {}
  tags = local.tags
}

# ── Services ────────────────────────────────────────────────────────────────

resource "aws_ecs_service" "web" {
  name                               = "web"
  cluster                            = var.cluster_arn
  task_definition                    = aws_ecs_task_definition.app["web"].arn
  desired_count                      = var.web.min
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  health_check_grace_period_seconds  = 180
  capacity_provider_strategy {
    capacity_provider = aws_ecs_capacity_provider.this.name
    weight            = 1
  }
  network_configuration {
    subnets         = var.subnet_ids
    security_groups = [aws_security_group.app.id]
  }
  load_balancer {
    target_group_arn = var.target_group_arns.app
    container_name   = "app"
    container_port   = 8080
  }
  service_registries {
    registry_arn = aws_service_discovery_service.this["app"].arn
  }
  ordered_placement_strategy {
    type  = "spread"
    field = "attribute:ecs.availability-zone"
  }
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  propagate_tags = "SERVICE"
  depends_on     = [aws_ecs_cluster_capacity_providers.this]
  tags           = local.tags
  lifecycle {
    ignore_changes = [desired_count]
  }
}

resource "aws_ecs_service" "analytics" {
  name                               = "analytics"
  cluster                            = var.cluster_arn
  task_definition                    = aws_ecs_task_definition.app["analytics"].arn
  desired_count                      = var.analytics.count
  deployment_minimum_healthy_percent = 50
  deployment_maximum_percent         = 200
  capacity_provider_strategy {
    capacity_provider = aws_ecs_capacity_provider.this.name
    weight            = 1
  }
  network_configuration {
    subnets         = var.subnet_ids
    security_groups = [aws_security_group.app.id]
  }
  ordered_placement_strategy {
    type  = "spread"
    field = "attribute:ecs.availability-zone"
  }
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  propagate_tags = "SERVICE"
  depends_on     = [aws_ecs_cluster_capacity_providers.this]
  tags           = local.tags
}

resource "aws_ecs_service" "gateway" {
  name                               = "notebook-gateway"
  cluster                            = var.cluster_arn
  task_definition                    = aws_ecs_task_definition.gateway.arn
  desired_count                      = var.gateway_count
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  health_check_grace_period_seconds  = 60
  capacity_provider_strategy {
    capacity_provider = aws_ecs_capacity_provider.this.name
    weight            = 1
  }
  network_configuration {
    subnets         = var.subnet_ids
    security_groups = [aws_security_group.gateway.id]
  }
  load_balancer {
    target_group_arn = var.target_group_arns.gateway
    container_name   = "gateway"
    container_port   = 8090
  }
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  propagate_tags = "SERVICE"
  depends_on     = [aws_ecs_cluster_capacity_providers.this]
  tags           = local.tags
}

resource "aws_ecs_service" "internal" {
  for_each        = aws_ecs_task_definition.internal
  name            = each.key
  cluster         = var.cluster_arn
  task_definition = each.value.arn
  desired_count   = var.internal_count
  launch_type     = "FARGATE"
  network_configuration {
    subnets         = var.subnet_ids
    security_groups = [aws_security_group.internal[each.key].id]
  }
  service_registries {
    registry_arn = aws_service_discovery_service.this[each.key].arn
  }
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  propagate_tags = "SERVICE"
  tags           = local.tags
}

# ── Autoscaling (web) ───────────────────────────────────────────────────────

resource "aws_appautoscaling_target" "web" {
  service_namespace  = "ecs"
  resource_id        = "service/${var.cluster_name}/${aws_ecs_service.web.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = var.web.min
  max_capacity       = var.web.max
}

resource "aws_appautoscaling_policy" "web_cpu" {
  name               = "${var.name}-web-cpu"
  service_namespace  = "ecs"
  resource_id        = aws_appautoscaling_target.web.resource_id
  scalable_dimension = aws_appautoscaling_target.web.scalable_dimension
  policy_type        = "TargetTrackingScaling"
  target_tracking_scaling_policy_configuration {
    target_value       = var.web_cpu_target
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}
