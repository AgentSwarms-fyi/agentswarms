# The way in: one public Application Load Balancer, and HTTPS in front of it.
#
# One hostname serves everything, as the hosted service does:
#   /auth/v1/*  /rest/v1/*  /storage/v1/*   -> the Supabase gateway (nginx)
#   /nbgw*                                  -> the notebook gateway (websocket)
#   everything else                         -> the app
#
# HTTPS, one of two ways:
#   - a domain: give certificate_arn (an ACM certificate in this region), or
#     route53_zone_id to have one made and validated here; the ALB serves 443.
#   - no domain: CloudFront's own *.cloudfront.net name and certificate in
#     front of the ALB. The ALB then answers only CloudFront (its origin-facing
#     addresses, and a header only CloudFront sends).
#
# No stickiness: the app is stateless (docs/DEPLOYMENT.md). The deregistration
# delay outlasts a long chat turn, so a rolling deploy does not cut one off.

locals {
  tags           = merge(var.tags, { "agentswarms:stack" = var.name })
  use_domain     = var.domain_name != null
  make_cert      = local.use_domain && var.certificate_arn == null && var.route53_zone_id != null
  cert_arn       = local.make_cert ? aws_acm_certificate_validation.this[0].certificate_arn : var.certificate_arn
  use_cloudfront = !local.use_domain
  public_host    = local.use_domain ? var.domain_name : aws_cloudfront_distribution.this[0].domain_name
}

resource "random_password" "origin_header" {
  count   = local.use_cloudfront ? 1 : 0
  length  = 40
  special = false
}

# ── Security group ──────────────────────────────────────────────────────────

data "aws_ec2_managed_prefix_list" "cloudfront" {
  count = local.use_cloudfront ? 1 : 0
  name  = "com.amazonaws.global.cloudfront.origin-facing"
}

resource "aws_security_group" "alb" {
  name        = "${var.name}-alb"
  description = "The public load balancer"
  vpc_id      = var.vpc_id
  tags        = merge(local.tags, { Name = "${var.name}-alb" })
}

resource "aws_vpc_security_group_ingress_rule" "https" {
  count             = local.use_domain ? 1 : 0
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  description       = "HTTPS"
}

resource "aws_vpc_security_group_ingress_rule" "http_redirect" {
  count             = local.use_domain ? 1 : 0
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"
  description       = "HTTP, redirected to HTTPS"
}

resource "aws_vpc_security_group_ingress_rule" "from_cloudfront" {
  count             = local.use_cloudfront ? 1 : 0
  security_group_id = aws_security_group.alb.id
  prefix_list_id    = data.aws_ec2_managed_prefix_list.cloudfront[0].id
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"
  description       = "CloudFront only"
}

resource "aws_vpc_security_group_egress_rule" "to_targets" {
  for_each          = toset([tostring(var.app_port), tostring(var.supabase_port), tostring(var.gateway_port)])
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = var.vpc_cidr
  from_port         = tonumber(each.value)
  to_port           = tonumber(each.value)
  ip_protocol       = "tcp"
  description       = "targets in the VPC"
}

# ── Load balancer ───────────────────────────────────────────────────────────

resource "aws_lb" "this" {
  name                       = substr(var.name, 0, 32)
  load_balancer_type         = "application"
  internal                   = false
  subnets                    = var.public_subnet_ids
  security_groups            = [aws_security_group.alb.id]
  idle_timeout               = 120
  drop_invalid_header_fields = true
  enable_deletion_protection = var.deletion_protection
  tags                       = local.tags
}

resource "aws_lb_target_group" "app" {
  name                 = substr("${var.name}-app", 0, 32)
  port                 = var.app_port
  protocol             = "HTTP"
  target_type          = var.target_type
  vpc_id               = var.vpc_id
  deregistration_delay = 120
  # Local readiness only: a database failover must not take every target out
  # of the pool at once (R463).
  health_check {
    path                = "/api/health/ready?scope=local"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
  tags = local.tags
}

resource "aws_lb_target_group" "supabase" {
  name                 = substr("${var.name}-supabase", 0, 32)
  port                 = var.supabase_port
  protocol             = "HTTP"
  target_type          = var.target_type
  vpc_id               = var.vpc_id
  deregistration_delay = 60
  health_check {
    path    = "/gateway/health"
    matcher = "200"
  }
  tags = local.tags
}

resource "aws_lb_target_group" "gateway" {
  name                 = substr("${var.name}-nbgw", 0, 32)
  port                 = var.gateway_port
  protocol             = "HTTP"
  target_type          = var.target_type
  vpc_id               = var.vpc_id
  deregistration_delay = 120
  health_check {
    path    = "/"
    matcher = "200"
  }
  tags = local.tags
}

# ── Listeners ───────────────────────────────────────────────────────────────

resource "aws_lb_listener" "https" {
  count             = local.use_domain ? 1 : 0
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = local.cert_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"
  # With a domain, port 80 only redirects. Behind CloudFront it is the origin,
  # and refuses anything that did not come through CloudFront.
  default_action {
    type = local.use_domain ? "redirect" : "fixed-response"
    dynamic "redirect" {
      for_each = local.use_domain ? [1] : []
      content {
        port        = "443"
        protocol    = "HTTPS"
        status_code = "HTTP_301"
      }
    }
    dynamic "fixed_response" {
      for_each = local.use_domain ? [] : [1]
      content {
        content_type = "text/plain"
        message_body = "Forbidden"
        status_code  = "403"
      }
    }
  }
}

locals {
  serving_listener = local.use_domain ? aws_lb_listener.https[0].arn : aws_lb_listener.http.arn
  # Behind CloudFront every rule also requires CloudFront's header.
  origin_condition = local.use_cloudfront ? [{
    name  = "X-Origin-Verify"
    value = random_password.origin_header[0].result
  }] : []
  routes = {
    supabase = { priority = 10, paths = ["/auth/v1/*", "/rest/v1/*", "/storage/v1/*"], tg = aws_lb_target_group.supabase.arn }
    gateway  = { priority = 20, paths = ["/nbgw", "/nbgw/*"], tg = aws_lb_target_group.gateway.arn }
    app      = { priority = 100, paths = ["/*"], tg = aws_lb_target_group.app.arn }
  }
}

resource "aws_lb_listener_rule" "route" {
  for_each     = local.routes
  listener_arn = local.serving_listener
  priority     = each.value.priority
  action {
    type             = "forward"
    target_group_arn = each.value.tg
  }
  condition {
    path_pattern {
      values = each.value.paths
    }
  }
  dynamic "condition" {
    for_each = local.origin_condition
    content {
      http_header {
        http_header_name = condition.value.name
        values           = [condition.value.value]
      }
    }
  }
  tags = local.tags
}

# ── Certificate (a domain in Route 53) ──────────────────────────────────────

resource "aws_acm_certificate" "this" {
  count             = local.make_cert ? 1 : 0
  domain_name       = var.domain_name
  validation_method = "DNS"
  lifecycle {
    create_before_destroy = true
  }
  tags = local.tags
}

resource "aws_route53_record" "validation" {
  for_each = local.make_cert ? {
    for o in aws_acm_certificate.this[0].domain_validation_options : o.domain_name => o
  } : {}
  zone_id = var.route53_zone_id
  name    = each.value.resource_record_name
  type    = each.value.resource_record_type
  records = [each.value.resource_record_value]
  ttl     = 300
}

resource "aws_acm_certificate_validation" "this" {
  count                   = local.make_cert ? 1 : 0
  certificate_arn         = aws_acm_certificate.this[0].arn
  validation_record_fqdns = [for r in aws_route53_record.validation : r.fqdn]
}

resource "aws_route53_record" "alias" {
  count   = local.use_domain && var.route53_zone_id != null ? 1 : 0
  zone_id = var.route53_zone_id
  name    = var.domain_name
  type    = "A"
  alias {
    name                   = aws_lb.this.dns_name
    zone_id                = aws_lb.this.zone_id
    evaluate_target_health = true
  }
}

# ── CloudFront (no domain) ──────────────────────────────────────────────────

data "aws_cloudfront_cache_policy" "disabled" {
  count = local.use_cloudfront ? 1 : 0
  name  = "Managed-CachingDisabled"
}

data "aws_cloudfront_origin_request_policy" "all_viewer" {
  count = local.use_cloudfront ? 1 : 0
  name  = "Managed-AllViewer"
}

resource "aws_cloudfront_distribution" "this" {
  count           = local.use_cloudfront ? 1 : 0
  enabled         = true
  comment         = "AgentSwarms ${var.name}"
  is_ipv6_enabled = true
  price_class     = "PriceClass_100"
  http_version    = "http2and3"

  origin {
    origin_id   = "alb"
    domain_name = aws_lb.this.dns_name
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "http-only"
      origin_ssl_protocols   = ["TLSv1.2"]
      # 60 s is CloudFront's ceiling without a quota increase; the app sends a
      # response's headers before a long chat turn's tool rounds (R481).
      origin_read_timeout      = 60
      origin_keepalive_timeout = 60
    }
    custom_header {
      name  = "X-Origin-Verify"
      value = random_password.origin_header[0].result
    }
  }

  default_cache_behavior {
    target_origin_id         = "alb"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = data.aws_cloudfront_cache_policy.disabled[0].id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer[0].id
    compress                 = true
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  tags = local.tags
}
