output "url" {
  description = "Where to sign in."
  value       = module.edge.public_url
}

output "admin_password_command" {
  description = "Reads the first admin's password (change it after signing in)."
  value       = "aws secretsmanager get-secret-value --region ${var.region} --secret-id ${module.secrets.secret_name} --query SecretString --output text | jq -r .admin_password"
}

output "load_balancer" {
  value = module.edge.alb_dns_name
}

output "cluster" {
  value = module.sandboxes.cluster_name
}

output "database" {
  value = module.data.db_address
}

output "buckets" {
  value = { lake = module.data.lake_bucket, storage = module.data.storage_bucket }
}

output "logs" {
  value = {
    app      = module.app.log_group
    supabase = module.supabase.log_group
  }
}

output "monthly_usd_estimate" {
  description = "The tier's base, us-east-1 list prices; sandboxes, NAT data, logs and S3 on top."
  value       = jsondecode(file("${path.module}/../../spec/sizes.json")).tiers[var.size].monthly_usd.ecs
}

output "secrets_added" {
  description = "Secret keys the last apply generated (names only)."
  value       = module.secrets.added
}
