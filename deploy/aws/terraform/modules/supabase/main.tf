# Supabase's services on ECS, against RDS: GoTrue (auth), PostgREST (rest),
# storage-api (storage, on S3), behind one nginx gateway that strips the
# /auth/v1, /rest/v1 and /storage/v1 prefixes the load balancer cannot.
#
# Two task definitions:
#   deploy   run ONCE per apply, before anything is updated (the run-task
#            Lambda waits for it): db-migrate bootstrap (roles, schemas), then
#            GoTrue and storage-api start and install their own schemas, then
#            db-migrate deploy applies the app's migrations and creates the
#            admin with a confirmed address. The order deploy/ci/rds-like
#            proves.
#   service  GoTrue, PostgREST, storage-api and the gateway, long-running,
#            in one task: they talk over localhost. Optional: on VMs the same
#            services run in Compose instead (create_service = false).
#
# Every database connection is TLS (rds.force_ssl). sslmode=require encrypts
# but does not verify the server's certificate: the upstream images do not
# carry the RDS certificate authority.

locals {
  tags   = merge(var.tags, { "agentswarms:stack" = var.name })
  region = data.aws_region.this.region
  db     = "${var.db_host}:${var.db_port}/postgres?sslmode=require"
  s = { for k in [
    "jwt_secret", "anon_key", "service_role_key", "authenticator_password",
    "auth_admin_password", "storage_admin_password", "admin_password",
  ] : k => "${var.secret_arn}:${k}::" }

  log = {
    logDriver = "awslogs"
    options = {
      awslogs-group         = aws_cloudwatch_log_group.this.name
      awslogs-region        = data.aws_region.this.region
      awslogs-stream-prefix = "supabase"
    }
  }

  gotrue_env = concat([
    { name = "GOTRUE_API_HOST", value = "0.0.0.0" },
    { name = "GOTRUE_API_PORT", value = "9999" },
    { name = "API_EXTERNAL_URL", value = "${var.public_url}/auth/v1" },
    { name = "GOTRUE_DB_DRIVER", value = "postgres" },
    { name = "GOTRUE_DB_DATABASE_URL", value = "postgres://supabase_auth_admin@${local.db}" },
    { name = "GOTRUE_SITE_URL", value = var.public_url },
    { name = "GOTRUE_URI_ALLOW_LIST", value = "${var.public_url}/**" },
    { name = "GOTRUE_JWT_AUD", value = "authenticated" },
    { name = "GOTRUE_JWT_DEFAULT_GROUP_NAME", value = "authenticated" },
    { name = "GOTRUE_JWT_ADMIN_ROLES", value = "service_role" },
    { name = "GOTRUE_JWT_EXP", value = "3600" },
    { name = "GOTRUE_EXTERNAL_EMAIL_ENABLED", value = "true" },
    { name = "GOTRUE_MAILER_AUTOCONFIRM", value = tostring(var.mailer_autoconfirm) },
    ], var.smtp == null ? [] : [
    { name = "GOTRUE_SMTP_HOST", value = var.smtp.host },
    { name = "GOTRUE_SMTP_PORT", value = tostring(var.smtp.port) },
    { name = "GOTRUE_SMTP_USER", value = var.smtp.user },
    { name = "GOTRUE_SMTP_ADMIN_EMAIL", value = var.smtp.from },
    { name = "GOTRUE_SMTP_SENDER_NAME", value = "AgentSwarms" },
  ])
  gotrue_secrets = concat([
    { name = "GOTRUE_JWT_SECRET", valueFrom = local.s.jwt_secret },
    { name = "PGPASSWORD", valueFrom = local.s.auth_admin_password },
  ], var.smtp == null ? [] : [{ name = "GOTRUE_SMTP_PASS", valueFrom = var.smtp.password_secret_arn }])

  rest_env = [
    { name = "PGRST_DB_URI", value = "postgres://authenticator@${local.db}" },
    { name = "PGRST_DB_SCHEMAS", value = "public,storage" },
    { name = "PGRST_DB_ANON_ROLE", value = "anon" },
    { name = "PGRST_SERVER_PORT", value = "3000" },
  ]
  rest_secrets = [
    { name = "PGRST_JWT_SECRET", valueFrom = local.s.jwt_secret },
    { name = "PGPASSWORD", valueFrom = local.s.authenticator_password },
  ]

  storage_env = [
    { name = "POSTGREST_URL", value = "http://127.0.0.1:3000" },
    { name = "DATABASE_URL", value = "postgres://supabase_storage_admin@${local.db}" },
    { name = "STORAGE_BACKEND", value = "s3" },
    { name = "GLOBAL_S3_BUCKET", value = var.storage_bucket },
    { name = "REGION", value = local.region },
    { name = "TENANT_ID", value = "stub" },
    { name = "FILE_SIZE_LIMIT", value = tostring(var.file_size_limit) },
    { name = "SERVER_PORT", value = "5000" },
  ]
  storage_secrets = [
    { name = "ANON_KEY", valueFrom = local.s.anon_key },
    { name = "SERVICE_KEY", valueFrom = local.s.service_role_key },
    { name = "AUTH_JWT_SECRET", valueFrom = local.s.jwt_secret },
    { name = "PGPASSWORD", valueFrom = local.s.storage_admin_password },
  ]

  health = {
    auth    = { command = ["CMD-SHELL", "wget -q --spider http://127.0.0.1:9999/health || exit 1"], interval = 10, timeout = 5, retries = 6, startPeriod = 60 }
    storage = { command = ["CMD-SHELL", "wget -q --spider http://127.0.0.1:5000/status || exit 1"], interval = 10, timeout = 5, retries = 6, startPeriod = 90 }
  }

  migrate_image = "${var.source_registry}/db-migrate:${var.release}"
  admin_db_url  = "postgres://${var.db_master_username}@${local.db}"
}

data "aws_region" "this" {}

resource "aws_cloudwatch_log_group" "this" {
  name              = "/agentswarms/${var.name}/supabase"
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

resource "aws_iam_role" "execution" {
  name               = "${var.name}-supabase-execution"
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
        Resource = compact([var.secret_arn, var.db_master_secret_arn, try(var.smtp.password_secret_arn, null)])
      },
      { Effect = "Allow", Action = ["kms:Decrypt"], Resource = var.kms_key_arn },
    ]
  })
}

# storage-api's own role: the storage bucket and its key, nothing else.
resource "aws_iam_role" "storage" {
  name               = "${var.name}-supabase-storage"
  assume_role_policy = data.aws_iam_policy_document.assume_tasks.json
  tags               = local.tags
}

resource "aws_iam_role_policy" "storage" {
  name = "storage-bucket"
  role = aws_iam_role.storage.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:ListBucket", "s3:GetBucketLocation"]
        Resource = var.storage_bucket_arn
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"]
        Resource = "${var.storage_bucket_arn}/*"
      },
      {
        Effect   = "Allow"
        Action   = ["kms:Decrypt", "kms:GenerateDataKey"]
        Resource = var.kms_key_arn
      },
    ]
  })
}

# ── Security group ──────────────────────────────────────────────────────────

resource "aws_security_group" "this" {
  name        = "${var.name}-supabase"
  description = "Supabase's services: the gateway on 8000 from the load balancer and the app"
  vpc_id      = var.vpc_id
  tags        = merge(local.tags, { Name = "${var.name}-supabase" })
}

resource "aws_vpc_security_group_ingress_rule" "gateway" {
  for_each                     = var.gateway_clients
  security_group_id            = aws_security_group.this.id
  referenced_security_group_id = each.value
  from_port                    = 8000
  to_port                      = 8000
  ip_protocol                  = "tcp"
  description                  = "the gateway, from ${each.key}"
}

resource "aws_vpc_security_group_egress_rule" "all" {
  security_group_id = aws_security_group.this.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
  description       = "RDS, S3, image pulls"
}

# ── The deploy task: bootstrap, schemas, migrations, admin ──────────────────

resource "aws_ecs_task_definition" "deploy" {
  family                   = "${var.name}-deploy"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "1024"
  memory                   = "2048"
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.storage.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.architecture
  }
  container_definitions = jsonencode([
    {
      name        = "bootstrap"
      image       = local.migrate_image
      essential   = false
      command     = ["bootstrap"]
      environment = [{ name = "DATABASE_URL", value = local.admin_db_url }]
      secrets = [
        { name = "PGPASSWORD", valueFrom = "${var.db_master_secret_arn}:password::" },
        { name = "AUTHENTICATOR_PASSWORD", valueFrom = local.s.authenticator_password },
        { name = "AUTH_ADMIN_PASSWORD", valueFrom = local.s.auth_admin_password },
        { name = "STORAGE_ADMIN_PASSWORD", valueFrom = local.s.storage_admin_password },
      ]
      logConfiguration = local.log
    },
    {
      name             = "auth"
      image            = var.images.gotrue
      essential        = false
      dependsOn        = [{ containerName = "bootstrap", condition = "SUCCESS" }]
      environment      = local.gotrue_env
      secrets          = local.gotrue_secrets
      healthCheck      = local.health.auth
      logConfiguration = local.log
    },
    {
      name             = "rest"
      image            = var.images.postgrest
      essential        = false
      dependsOn        = [{ containerName = "bootstrap", condition = "SUCCESS" }]
      environment      = local.rest_env
      secrets          = local.rest_secrets
      logConfiguration = local.log
    },
    {
      name             = "storage"
      image            = var.images.storage
      essential        = false
      dependsOn        = [{ containerName = "bootstrap", condition = "SUCCESS" }]
      environment      = local.storage_env
      secrets          = local.storage_secrets
      healthCheck      = local.health.storage
      logConfiguration = local.log
    },
    {
      # The one that decides how the task ends: when it exits, ECS stops the rest.
      name      = "deploy"
      image     = local.migrate_image
      essential = true
      command   = ["deploy"]
      dependsOn = [
        { containerName = "bootstrap", condition = "SUCCESS" },
        { containerName = "auth", condition = "HEALTHY" },
        { containerName = "storage", condition = "HEALTHY" },
      ]
      environment = concat(
        [
          { name = "DATABASE_URL", value = local.admin_db_url },
          { name = "GOTRUE_URL", value = "http://127.0.0.1:9999" },
        ],
        var.admin_email == null ? [] : [{ name = "ADMIN_EMAIL", value = var.admin_email }],
      )
      secrets = concat(
        [
          { name = "PGPASSWORD", valueFrom = "${var.db_master_secret_arn}:password::" },
          { name = "SERVICE_ROLE_KEY", valueFrom = local.s.service_role_key },
        ],
        var.admin_email == null ? [] : [{ name = "ADMIN_PASSWORD", valueFrom = local.s.admin_password }],
      )
      logConfiguration = local.log
    },
  ])
  tags = local.tags
}

data "archive_file" "run_task" {
  type        = "zip"
  source_file = "${path.module}/../../../lambda/run-task/run_task.py"
  output_path = "${path.root}/.terraform/run-task.zip"
}

resource "aws_iam_role" "run_task" {
  name = "${var.name}-run-deploy-task"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = "sts:AssumeRole", Principal = { Service = "lambda.amazonaws.com" } }]
  })
  tags = local.tags
}

resource "aws_cloudwatch_log_group" "run_task" {
  name              = "/aws/lambda/${var.name}-run-deploy-task"
  retention_in_days = 30
  tags              = local.tags
}

resource "aws_iam_role_policy" "run_task" {
  name = "run-deploy-task"
  role = aws_iam_role.run_task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Allow"
        Action    = ["ecs:RunTask"]
        Resource  = "${aws_ecs_task_definition.deploy.arn_without_revision}:*"
        Condition = { ArnEquals = { "ecs:cluster" = var.cluster_arn } }
      },
      {
        Effect    = "Allow"
        Action    = ["ecs:DescribeTasks", "ecs:StopTask"]
        Resource  = "*"
        Condition = { ArnEquals = { "ecs:cluster" = var.cluster_arn } }
      },
      { Effect = "Allow", Action = ["ecs:DescribeTaskDefinition"], Resource = "*" },
      {
        Effect   = "Allow"
        Action   = ["iam:PassRole"]
        Resource = [aws_iam_role.execution.arn, aws_iam_role.storage.arn]
      },
      { Effect = "Allow", Action = ["logs:GetLogEvents"], Resource = "${aws_cloudwatch_log_group.this.arn}:*" },
      { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.run_task.arn}:*" },
    ]
  })
}

resource "aws_lambda_function" "run_task" {
  function_name    = "${var.name}-run-deploy-task"
  role             = aws_iam_role.run_task.arn
  runtime          = "python3.13"
  architectures    = ["arm64"]
  handler          = "run_task.handler"
  filename         = data.archive_file.run_task.output_path
  source_code_hash = data.archive_file.run_task.output_base64sha256
  timeout          = 900
  memory_size      = 128
  tags             = local.tags
  depends_on       = [aws_iam_role_policy.run_task, aws_cloudwatch_log_group.run_task]
}

# Once per new deploy task revision (a release, a setting): the services wait
# for it (depends_on in the callers), so they never start on a schema they do
# not know. A failure here fails the apply, with the container's last lines.
resource "aws_lambda_invocation" "deploy" {
  function_name = aws_lambda_function.run_task.function_name
  input = jsonencode({
    cluster         = var.cluster_arn
    task_definition = aws_ecs_task_definition.deploy.arn
    subnets         = var.subnet_ids
    security_groups = [aws_security_group.this.id]
    container       = "deploy"
    timeout_s       = 780
  })
}

# ── The long-running services ───────────────────────────────────────────────

resource "aws_ecs_task_definition" "service" {
  count                    = var.create_service ? 1 : 0
  family                   = "${var.name}-supabase"
  requires_compatibilities = [var.service_launch == "FARGATE" ? "FARGATE" : "EC2"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.service_cpu)
  memory                   = tostring(var.service_memory)
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.storage.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.architecture
  }
  container_definitions = jsonencode([
    { name = "auth", image = var.images.gotrue, essential = true, environment = local.gotrue_env, secrets = local.gotrue_secrets, healthCheck = local.health.auth, logConfiguration = local.log },
    { name = "rest", image = var.images.postgrest, essential = true, environment = local.rest_env, secrets = local.rest_secrets, logConfiguration = local.log },
    { name = "storage", image = var.images.storage, essential = true, environment = local.storage_env, secrets = local.storage_secrets, healthCheck = local.health.storage, logConfiguration = local.log },
    {
      name         = "gateway"
      image        = var.images.nginx
      essential    = true
      portMappings = [{ containerPort = 8000, protocol = "tcp" }]
      # The image renders /etc/nginx/templates at start; ECS has no files to
      # mount, so the rendered configuration arrives in the environment.
      entryPoint = ["/bin/sh", "-c"]
      command    = ["printf '%s' \"$GATEWAY_CONF\" > /etc/nginx/conf.d/default.conf && exec nginx -g 'daemon off;'"]
      environment = [{
        name = "GATEWAY_CONF"
        value = templatefile("${path.module}/../../../../helm/agentswarms/files/supabase-gateway.conf.template", {
          AUTH_UPSTREAM    = "127.0.0.1:9999"
          REST_UPSTREAM    = "127.0.0.1:3000"
          STORAGE_UPSTREAM = "127.0.0.1:5000"
        })
      }]
      dependsOn = [
        { containerName = "auth", condition = "HEALTHY" },
        { containerName = "storage", condition = "HEALTHY" },
      ]
      logConfiguration = local.log
    },
  ])
  tags = local.tags
}

resource "aws_service_discovery_service" "this" {
  count = var.create_service ? 1 : 0
  name  = "supabase"
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

resource "aws_ecs_service" "this" {
  count                              = var.create_service ? 1 : 0
  name                               = "supabase"
  cluster                            = var.cluster_arn
  task_definition                    = aws_ecs_task_definition.service[0].arn
  desired_count                      = var.service_count
  deployment_minimum_healthy_percent = 50
  deployment_maximum_percent         = 200
  health_check_grace_period_seconds  = 120
  dynamic "capacity_provider_strategy" {
    for_each = var.service_launch == "FARGATE" ? [] : [1]
    content {
      capacity_provider = var.service_launch
      weight            = 1
    }
  }
  launch_type = var.service_launch == "FARGATE" ? "FARGATE" : null
  network_configuration {
    subnets         = var.subnet_ids
    security_groups = [aws_security_group.this.id]
  }
  load_balancer {
    target_group_arn = var.target_group_arn
    container_name   = "gateway"
    container_port   = 8000
  }
  service_registries {
    registry_arn = aws_service_discovery_service.this[0].arn
  }
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  propagate_tags = "SERVICE"
  tags           = local.tags
  depends_on     = [aws_lambda_invocation.deploy]
}
