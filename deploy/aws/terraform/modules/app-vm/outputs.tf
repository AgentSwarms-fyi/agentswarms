output "security_group_id" {
  value = aws_security_group.instance.id
}

output "internal_url" {
  description = "The app for sandboxes and the egress proxy."
  value       = "http://${aws_lb.internal.dns_name}"
}

output "internal_lb_security_group_id" {
  value = aws_security_group.internal_lb.id
}

output "autoscaling_group" {
  value = aws_autoscaling_group.this.name
}

output "log_group" {
  value = aws_cloudwatch_log_group.this.name
}
