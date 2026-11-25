output "url" {
  description = "Where to sign in."
  value       = module.edge.public_url
}

output "admin_password_command" {
  description = "Reads the first admin's password (change it after signing in)."
  value       = "aws secretsmanager get-secret-value --region ${var.region} --secret-id ${module.secrets.secret_name} --query SecretString --output text | jq -r .admin_password"
}

output "kubeconfig_command" {
  value = "aws eks update-kubeconfig --region ${var.region} --name ${aws_eks_cluster.this.name}"
}

output "cluster" {
  value = aws_eks_cluster.this.name
}

output "load_balancer" {
  value = module.edge.alb_dns_name
}

output "database" {
  value = module.data.db_address
}

output "buckets" {
  value = { lake = module.data.lake_bucket, storage = module.data.storage_bucket }
}

output "monthly_usd_estimate" {
  description = "The tier's base, us-east-1 list prices; sandboxes, NAT data, logs and S3 on top."
  value       = jsondecode(file("${path.module}/../../spec/sizes.json")).tiers[var.size].monthly_usd.eks
}

output "secrets_added" {
  value = module.secrets.added
}

output "gpu_pool" {
  description = "The GPU node pool (R537), when gpu_node_max is above 0: what to check while testing GPU training (docs/deploy/AWS.md, \"GPU training\")."
  value = var.gpu_node_max > 0 ? {
    node_group     = aws_eks_node_group.gpu[0].node_group_name
    instance_types = var.gpu_instance_types
    max_nodes      = var.gpu_node_max
    gpus_per_node  = local.gpus_per_node
    nodes_command  = "kubectl get nodes -l agentswarms.io/pool=gpu -o custom-columns=NAME:.metadata.name,GPUS:.status.allocatable.nvidia\\.com/gpu"
  } : null
}
