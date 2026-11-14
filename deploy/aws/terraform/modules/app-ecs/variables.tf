variable "name" {
  type = string
}

variable "release" {
  type = string
}

variable "source_registry" {
  type    = string
  default = "ghcr.io/agentswarms-fyi"
}

variable "architecture" {
  type    = string
  default = "ARM64"
}

variable "public_url" {
  type = string
}

variable "public_host" {
  type = string
}

variable "behind_cloudfront" {
  description = "CloudFront in front of the load balancer: one more proxy hop to trust for the client's address."
  type        = bool
  default     = false
}

variable "admin_email" {
  type    = string
  default = null
}

variable "vpc_id" {
  type = string
}

variable "subnet_ids" {
  type = list(string)
}

variable "cluster_name" {
  type = string
}

variable "cluster_arn" {
  type = string
}

variable "namespace_id" {
  type = string
}

variable "namespace_name" {
  type = string
}

variable "alb_security_group_id" {
  type = string
}

variable "target_group_arns" {
  type = object({ app = string, supabase = string, gateway = string })
}

variable "app_clients" {
  description = "Other security groups that reach the app on 8080, by name: the sandboxes (callbacks), the egress proxy (its list)."
  type        = map(string)
}

variable "db_host" {
  type = string
}

variable "db_port" {
  type    = number
  default = 5432
}

variable "lake_bucket" {
  type = string
}

variable "lake_bucket_arn" {
  type = string
}

variable "kms_key_arn" {
  type = string
}

variable "secret_arn" {
  type = string
}

variable "secret_keys" {
  description = "Keys of the deployment's secret (modules/secrets)."
  type        = list(string)
}

variable "valkey_url_secret_arn" {
  type    = string
  default = null
}

variable "sandbox_env" {
  description = "The ECS sandbox backend's settings (modules/sandboxes app_env)."
  type        = map(string)
}

variable "sandbox_policy_json" {
  description = "What the app's role needs to run sandboxes (modules/sandboxes app_policy_json)."
  type        = string
}

variable "extra_env" {
  description = "More app settings (.env.example), e.g. OPENROUTER_BASE_URL or a limit."
  type        = map(string)
  default     = {}
}

variable "extra_app_policy_arns" {
  description = "Managed policies for the app's role: Glue, Athena or Redshift Data API access for those connectors."
  type        = list(string)
  default     = []
}

variable "instance_type" {
  type    = string
  default = "r7g.large"
}

variable "instances" {
  description = "The EC2 Auto Scaling group the app's containers run on."
  type        = object({ min = number, max = number, desired = number })
  default     = { min = 2, max = 4, desired = 2 }
}

variable "enable_awsvpc_trunking" {
  description = "Turn on ENI trunking (an account-wide ECS default in this region), so an instance holds more than two or three tasks."
  type        = bool
  default     = true
}

variable "web" {
  description = "The interactive tier. cpu is a share (1024 = one vCPU), memory a hard limit in MiB; workers are the Node processes per task."
  type        = object({ cpu = number, memory = number, min = number, max = number, workers = number })
  default     = { cpu = 1024, memory = 4096, min = 2, max = 4, workers = 2 }
}

variable "web_cpu_target" {
  description = "Average CPU (%) the web tier scales to keep."
  type        = number
  default     = 60
}

variable "analytics" {
  type    = object({ cpu = number, memory = number, count = number, workers = number })
  default = { cpu = 1024, memory = 4096, count = 2, workers = 1 }
}

variable "gateway_count" {
  type    = number
  default = 2
}

variable "internal_count" {
  description = "docgen and js-sandbox tasks each."
  type        = number
  default     = 2
}

variable "schema_deploy" {
  description = "The deploy task's result (modules/supabase deployed): the app's task definitions wait for it."
  type        = string
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "tags" {
  type    = map(string)
  default = {}
}
