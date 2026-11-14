output "security_group_id" {
  value = aws_security_group.this.id
}

output "internal_url" {
  description = "Supabase as the app's server reaches it, past the load balancer."
  value       = var.create_service ? "http://supabase.${var.namespace_name}:8000" : null
}

output "deploy_task_definition_arn" {
  value = aws_ecs_task_definition.deploy.arn
}

output "deployed" {
  description = "For depends_on: the deploy task has run and the schema is this release's."
  value       = aws_lambda_invocation.deploy.result
}

output "storage_role_arn" {
  value = aws_iam_role.storage.arn
}

output "log_group" {
  value = aws_cloudwatch_log_group.this.name
}
