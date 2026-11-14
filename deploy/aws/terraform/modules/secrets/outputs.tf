output "secret_arn" {
  value = aws_secretsmanager_secret.app.arn
}

output "secret_name" {
  value = aws_secretsmanager_secret.app.name
}

output "value_from" {
  description = "ECS valueFrom per key: { jwt_secret = \"<arn>:jwt_secret::\", ... }."
  value       = { for k in local.keys : k => "${aws_secretsmanager_secret.app.arn}:${k}::" }
  # Only after the Lambda has filled the secret: a task started before would
  # find the key missing.
  depends_on = [aws_lambda_invocation.bootstrap]
}

output "added" {
  description = "Names the last invocation added; empty once everything exists."
  value       = jsondecode(aws_lambda_invocation.bootstrap.result).added
}
