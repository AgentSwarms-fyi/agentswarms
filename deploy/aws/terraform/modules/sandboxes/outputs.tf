output "cluster_name" {
  value = aws_ecs_cluster.this.name
}

output "cluster_arn" {
  value = aws_ecs_cluster.this.arn
}

output "namespace_id" {
  value = aws_service_discovery_private_dns_namespace.this.id
}

output "namespace_name" {
  value = aws_service_discovery_private_dns_namespace.this.name
}

output "sandbox_security_group_id" {
  value = aws_security_group.sandbox.id
}

output "egress_security_group_id" {
  value = aws_security_group.egress.id
}

output "sandbox_image" {
  value = local.sandbox_image
}

output "app_policy_json" {
  description = "IAM policy the app's role needs to run sandboxes here."
  value       = data.aws_iam_policy_document.app_runs_sandboxes.json
}

output "app_env" {
  description = "The app's settings for the ECS backend and the pulled egress list (R477, R478)."
  value = {
    NOTEBOOK_RUNTIME_BACKEND             = "ecs"
    NOTEBOOK_ECS_CLUSTER                 = aws_ecs_cluster.this.name
    NOTEBOOK_ECS_TASK_DEFINITION         = aws_ecs_task_definition.sandbox.family
    NOTEBOOK_ECS_SUBNETS                 = join(",", var.sandbox_subnet_ids)
    NOTEBOOK_ECS_SECURITY_GROUPS         = aws_security_group.sandbox.id
    NOTEBOOK_ECS_CAPACITY_PROVIDER       = "FARGATE"
    NOTEBOOK_ECS_BATCH_CAPACITY_PROVIDER = "FARGATE_SPOT"
    NOTEBOOK_ECS_CONTAINER               = local.container_name
    NOTEBOOK_ECS_LOG_GROUP               = aws_cloudwatch_log_group.sandboxes.name
    NOTEBOOK_ECS_LOG_STREAM_PREFIX       = local.stream_prefix
    NOTEBOOK_RUNTIME_IMAGE               = local.sandbox_image
    NOTEBOOK_APP_INTERNAL_URL            = var.app_internal_url
    NOTEBOOK_EGRESS_PROXY                = "http://${local.egress_dns_name}:3128"
    NOTEBOOK_EGRESS_MODE                 = "pull"
  }
}
