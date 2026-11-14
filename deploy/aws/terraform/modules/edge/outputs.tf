output "public_url" {
  description = "Where people sign in."
  value       = "https://${local.public_host}"
}

output "public_host" {
  value = local.public_host
}

output "alb_arn" {
  value = aws_lb.this.arn
}

output "alb_arn_suffix" {
  value = aws_lb.this.arn_suffix
}

output "alb_dns_name" {
  value = aws_lb.this.dns_name
}

output "alb_security_group_id" {
  value = aws_security_group.alb.id
}

output "target_group_arns" {
  value = {
    app      = aws_lb_target_group.app.arn
    supabase = aws_lb_target_group.supabase.arn
    gateway  = aws_lb_target_group.gateway.arn
  }
}

output "app_target_group_arn_suffix" {
  value = aws_lb_target_group.app.arn_suffix
}

output "listener_rules" {
  description = "For depends_on: a service attached to a target group before its rule exists fails to register."
  value       = [for r in aws_lb_listener_rule.route : r.arn]
}
