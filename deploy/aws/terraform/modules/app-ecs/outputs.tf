output "capacity_provider_name" {
  description = "The EC2 capacity provider, once the cluster has it."
  value       = aws_ecs_capacity_provider.this.name
  depends_on  = [aws_ecs_cluster_capacity_providers.this]
}

output "app_security_group_id" {
  value = aws_security_group.app.id
}

output "gateway_security_group_id" {
  value = aws_security_group.gateway.id
}

output "app_role_arn" {
  value = aws_iam_role.app.arn
}

output "log_group" {
  value = aws_cloudwatch_log_group.this.name
}

output "service_names" {
  value = concat(
    [aws_ecs_service.web.name, aws_ecs_service.analytics.name, aws_ecs_service.gateway.name],
    [for s in aws_ecs_service.internal : s.name],
  )
}
