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

variable "images" {
  description = "Supabase's service images and the gateway's nginx (as modules/supabase)."
  type = object({
    gotrue    = string
    postgrest = string
    storage   = string
    nginx     = string
  })
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
  type    = bool
  default = false
}

variable "admin_email" {
  type    = string
  default = null
}

variable "mailer_autoconfirm" {
  type    = bool
  default = false
}

variable "smtp" {
  type = object({
    host                = string
    port                = number
    user                = string
    from                = string
    password_secret_arn = string
  })
  default = null
}

variable "vpc_id" {
  type = string
}

variable "subnet_ids" {
  type = list(string)
}

variable "alb_security_group_id" {
  type = string
}

variable "target_group_arns" {
  type = object({ app = string, supabase = string, gateway = string })
}

variable "app_clients" {
  description = "Security groups that reach the app through the internal load balancer: the sandboxes, the egress proxy."
  type        = map(string)
}

variable "db_host" {
  type = string
}

variable "lake_bucket" {
  type = string
}

variable "lake_bucket_arn" {
  type = string
}

variable "storage_bucket" {
  type = string
}

variable "storage_bucket_arn" {
  type = string
}

variable "kms_key_arn" {
  type = string
}

variable "secret_arn" {
  type = string
}

variable "sandbox_env" {
  type = map(string)
}

variable "sandbox_policy_json" {
  type = string
}

variable "extra_env" {
  type    = map(string)
  default = {}
}

variable "extra_app_policy_arns" {
  type    = list(string)
  default = []
}

variable "instance_type" {
  type    = string
  default = "r7g.large"
}

variable "instances" {
  type    = object({ min = number, max = number, desired = number })
  default = { min = 2, max = 4, desired = 2 }
}

variable "workers" {
  description = "Node workers of the app per VM; the vCPUs it may use."
  type        = number
  default     = 2
}

variable "cpu_target" {
  type    = number
  default = 60
}

variable "disk_gb" {
  description = "Root volume: images, and the app's temporary files (lakehouse spills)."
  type        = number
  default     = 60
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "tags" {
  type    = map(string)
  default = {}
}
