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

output "autoscaling_group" {
  value = module.app.autoscaling_group
}

output "sandbox_cluster" {
  value = module.sandboxes.cluster_name
}

output "database" {
  value = module.data.db_address
}

output "buckets" {
  value = { lake = module.data.lake_bucket, storage = module.data.storage_bucket }
}

output "logs" {
  value = { vm = module.app.log_group, deploy = module.supabase.log_group }
}

output "monthly_usd_estimate" {
  description = "The tier's base, us-east-1 list prices; sandboxes, NAT data, logs and S3 on top."
  value       = jsondecode(file("${path.module}/../../spec/sizes.json")).tiers[var.size].monthly_usd.vm
}

output "secrets_added" {
  value = module.secrets.added
}
