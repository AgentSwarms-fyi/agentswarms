# The app on plain VMs: an Auto Scaling group of Amazon Linux 2023 instances,
# each running every service of the app with Docker (boot.sh.tftpl), behind
# the public load balancer. Stateless: any instance serves any request, and
# the scheduler's lease keeps scheduled work to one at a time (R463).
#
# A new release or setting is a new launch template version, rolled out by an
# instance refresh that keeps at least half the instances serving.
#
# An internal load balancer in front of the same instances is the address
# sandboxes (on Fargate) call back on, and the egress proxy fetches its list
# from: sandboxes have no route to the public one.

locals {
  tags   = merge(var.tags, { "agentswarms:stack" = var.name })
  region = data.aws_region.this.region
  ami    = var.architecture == "ARM64" ? "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64" : "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"

  app_env = merge(
    {
      PORT                      = "8080"
      PUBLIC_APP_URL            = var.public_url
      SITE_URL                  = var.public_url
      SUPABASE_URL              = var.public_url
      PUBLIC_SUPABASE_URL       = var.public_url
      PUBLIC_SUPABASE_REALTIME  = "off"
      ADMIN_EMAIL               = coalesce(var.admin_email, "")
      PUBLIC_ADMIN_EMAIL        = coalesce(var.admin_email, "")
      NOTEBOOK_RUNTIME_ENABLED  = "true"
      NOTEBOOK_GATEWAY_URL      = "wss://${var.public_host}/nbgw"
      DOCGEN_SERVICE_URL        = "http://docgen:8099"
      JS_SANDBOX_URL            = "http://js-sandbox:8091"
      VECTOR_STORE              = "pgvector"
      LAKEHOUSE_CATALOG_URL     = "postgres://lakehouse@${var.db_host}:5432/lakehouse_catalog?sslmode=require"
      LAKEHOUSE_DATA_URL        = "s3://${var.lake_bucket}/main"
      LAKEHOUSE_S3_REGION       = local.region
      LAKEHOUSE_S3_URL_STYLE    = "vhost"
      LAKEHOUSE_SSE_KMS         = var.kms_key_arn
      AWS_REGION                = local.region
      TRUSTED_PROXY_HOPS        = var.behind_cloudfront ? "2" : "1"
      EARLY_HEADERS_AFTER_MS    = var.behind_cloudfront ? "45000" : ""
      HTTP_KEEPALIVE_TIMEOUT_MS = "125000"
      WEB_CONCURRENCY           = tostring(var.workers)
    },
    var.sandbox_env,
    { NOTEBOOK_APP_INTERNAL_URL = "http://${aws_lb.internal.dns_name}" },
    var.extra_env,
  )

  boot = templatefile("${path.module}/boot.sh.tftpl", {
    region             = local.region
    secret_arn         = var.secret_arn
    release            = var.release
    source_registry    = var.source_registry
    public_url         = var.public_url
    db_host            = var.db_host
    storage_bucket     = var.storage_bucket
    log_group          = aws_cloudwatch_log_group.this.name
    mailer_autoconfirm = tostring(var.mailer_autoconfirm)
    gotrue_smtp = var.smtp == null ? "" : join("\n", [
      "GOTRUE_SMTP_HOST=${var.smtp.host}",
      "GOTRUE_SMTP_PORT=${var.smtp.port}",
      "GOTRUE_SMTP_USER=${var.smtp.user}",
      "GOTRUE_SMTP_ADMIN_EMAIL=${var.smtp.from}",
      "GOTRUE_SMTP_PASS=$(aws secretsmanager get-secret-value --region ${local.region} --secret-id ${var.smtp.password_secret_arn} --query SecretString --output text)",
    ])
    app_env = join("\n", [for k, v in local.app_env : "${k}=${v}"])
    gateway_conf = templatefile("${path.module}/../../../../helm/agentswarms/files/supabase-gateway.conf.template", {
      AUTH_UPSTREAM    = "auth:9999"
      REST_UPSTREAM    = "rest:3000"
      STORAGE_UPSTREAM = "storage:5000"
    })
    gotrue_image    = var.images.gotrue
    postgrest_image = var.images.postgrest
    storage_image   = var.images.storage
    nginx_image     = var.images.nginx
  })
}

data "aws_region" "this" {}

data "aws_ssm_parameter" "ami" {
  name = local.ami
}

resource "aws_cloudwatch_log_group" "this" {
  name              = "/agentswarms/${var.name}/vm"
  retention_in_days = var.log_retention_days
  tags              = local.tags
}

# ── The instances' role ─────────────────────────────────────────────────────

resource "aws_iam_role" "instance" {
  name = "${var.name}-vm"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = "sts:AssumeRole", Principal = { Service = "ec2.amazonaws.com" } }]
  })
  tags = local.tags
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.instance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "instance" {
  name = "agentswarms"
  role = aws_iam_role.instance.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = compact([var.secret_arn, try(var.smtp.password_secret_arn, null)])
      },
      { Effect = "Allow", Action = ["kms:Decrypt", "kms:GenerateDataKey", "kms:Encrypt"], Resource = var.kms_key_arn },
      { Effect = "Allow", Action = ["s3:ListBucket", "s3:GetBucketLocation"], Resource = [var.lake_bucket_arn, var.storage_bucket_arn] },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"]
        Resource = ["${var.lake_bucket_arn}/*", "${var.storage_bucket_arn}/*"]
      },
      { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.this.arn}:*" },
    ]
  })
}

resource "aws_iam_role_policy" "sandboxes" {
  name   = "sandboxes"
  role   = aws_iam_role.instance.id
  policy = var.sandbox_policy_json
}

resource "aws_iam_role_policy_attachment" "extra" {
  for_each   = toset(var.extra_app_policy_arns)
  role       = aws_iam_role.instance.name
  policy_arn = each.value
}

resource "aws_iam_instance_profile" "this" {
  name = "${var.name}-vm"
  role = aws_iam_role.instance.name
}

# ── Security groups ─────────────────────────────────────────────────────────

resource "aws_security_group" "instance" {
  name        = "${var.name}-vm"
  description = "App VMs: the app, Supabase's gateway and the notebook gateway from the load balancers"
  vpc_id      = var.vpc_id
  tags        = merge(local.tags, { Name = "${var.name}-vm" })
}

resource "aws_vpc_security_group_ingress_rule" "public" {
  for_each                     = { app = 8080, supabase = 8000, gateway = 8090 }
  security_group_id            = aws_security_group.instance.id
  referenced_security_group_id = var.alb_security_group_id
  from_port                    = each.value
  to_port                      = each.value
  ip_protocol                  = "tcp"
  description                  = "${each.key} from the public load balancer"
}

resource "aws_vpc_security_group_ingress_rule" "internal" {
  security_group_id            = aws_security_group.instance.id
  referenced_security_group_id = aws_security_group.internal_lb.id
  from_port                    = 8080
  to_port                      = 8080
  ip_protocol                  = "tcp"
  description                  = "the app, from the internal load balancer"
}

resource "aws_vpc_security_group_egress_rule" "instance" {
  security_group_id = aws_security_group.instance.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_security_group" "internal_lb" {
  name        = "${var.name}-internal-lb"
  description = "The app for sandboxes and the egress proxy"
  vpc_id      = var.vpc_id
  tags        = merge(local.tags, { Name = "${var.name}-internal-lb" })
}

resource "aws_vpc_security_group_ingress_rule" "internal_lb" {
  for_each                     = var.app_clients
  security_group_id            = aws_security_group.internal_lb.id
  referenced_security_group_id = each.value
  from_port                    = 80
  to_port                      = 80
  ip_protocol                  = "tcp"
  description                  = "from ${each.key}"
}

resource "aws_vpc_security_group_egress_rule" "internal_lb" {
  security_group_id            = aws_security_group.internal_lb.id
  referenced_security_group_id = aws_security_group.instance.id
  from_port                    = 8080
  to_port                      = 8080
  ip_protocol                  = "tcp"
  description                  = "to the app"
}

# ── Internal load balancer ──────────────────────────────────────────────────

resource "aws_lb" "internal" {
  name               = substr("${var.name}-internal", 0, 32)
  load_balancer_type = "application"
  internal           = true
  subnets            = var.subnet_ids
  security_groups    = [aws_security_group.internal_lb.id]
  idle_timeout       = 300
  tags               = local.tags
}

resource "aws_lb_target_group" "internal" {
  name                 = substr("${var.name}-app-int", 0, 32)
  port                 = 8080
  protocol             = "HTTP"
  target_type          = "instance"
  vpc_id               = var.vpc_id
  deregistration_delay = 120
  health_check {
    path    = "/api/health/ready?scope=local"
    matcher = "200"
  }
  tags = local.tags
}

resource "aws_lb_listener" "internal" {
  load_balancer_arn = aws_lb.internal.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.internal.arn
  }
}

# ── Instances ───────────────────────────────────────────────────────────────

resource "aws_launch_template" "this" {
  name_prefix   = "${var.name}-vm-"
  image_id      = data.aws_ssm_parameter.ami.value
  instance_type = var.instance_type
  iam_instance_profile {
    arn = aws_iam_instance_profile.this.arn
  }
  vpc_security_group_ids = [aws_security_group.instance.id]
  # Hop limit 2: the app's container signs S3 and ECS calls with the
  # instance's role. Containers on the internal network have no route to it.
  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 2
  }
  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_size = var.disk_gb
      volume_type = "gp3"
      encrypted   = true
    }
  }
  user_data = base64gzip(local.boot)
  tag_specifications {
    resource_type = "instance"
    tags          = merge(local.tags, { Name = "${var.name}-vm" })
  }
  tags = local.tags
}

resource "aws_autoscaling_group" "this" {
  name_prefix               = "${var.name}-vm-"
  min_size                  = var.instances.min
  max_size                  = var.instances.max
  desired_capacity          = var.instances.desired
  vpc_zone_identifier       = var.subnet_ids
  health_check_type         = "ELB"
  health_check_grace_period = 600
  target_group_arns = [
    var.target_group_arns.app,
    var.target_group_arns.supabase,
    var.target_group_arns.gateway,
    aws_lb_target_group.internal.arn,
  ]
  launch_template {
    id      = aws_launch_template.this.id
    version = aws_launch_template.this.latest_version
  }
  instance_refresh {
    strategy = "Rolling"
    preferences {
      min_healthy_percentage = 50
      instance_warmup        = 300
    }
  }
  dynamic "tag" {
    for_each = merge(local.tags, { Name = "${var.name}-vm" })
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

resource "aws_autoscaling_policy" "cpu" {
  name                   = "${var.name}-vm-cpu"
  autoscaling_group_name = aws_autoscaling_group.this.name
  policy_type            = "TargetTrackingScaling"
  target_tracking_configuration {
    target_value = var.cpu_target
    predefined_metric_specification {
      predefined_metric_type = "ASGAverageCPUUtilization"
    }
  }
}
