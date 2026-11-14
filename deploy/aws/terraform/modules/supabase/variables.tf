variable "name" {
  type = string
}

variable "release" {
  description = "The AgentSwarms release: its db-migrate image holds that release's migrations."
  type        = string
}

variable "source_registry" {
  type    = string
  default = "ghcr.io/agentswarms-fyi"
}

variable "images" {
  description = "Supabase's service images: the versions deploy/ci/rds-like proves against RDS, by digest."
  type = object({
    gotrue    = string
    postgrest = string
    storage   = string
    nginx     = string
  })
  default = {
    gotrue    = "supabase/gotrue:v2.197.0@sha256:1736a63078f5922b198c4cbe50f80ab9a2d3b54fe8b7b6cfb2e9dc5dbbc12c6b"
    postgrest = "postgrest/postgrest:v14.18@sha256:c7cd7e265a85b05248abf53f4473fcec7e327c282d0bd0cf60f1551996d09fcf"
    storage   = "supabase/storage-api:v1.89.12@sha256:8526956cb462e9f7d392e9848ec77133b2769982ed614e9753cc687e8e4339a6"
    nginx     = "nginx:1.30.5-alpine@sha256:0985e772fb9f729e6fa0980da05fca5d9c468e870eed43071545afa9d2e27d94"
  }
}

variable "architecture" {
  type    = string
  default = "ARM64"
}

variable "public_url" {
  description = "https://<host>: where people reach the app, and GoTrue's site URL."
  type        = string
}

variable "vpc_id" {
  type = string
}

variable "subnet_ids" {
  description = "The app subnets: the deploy task and the services pull images through their NAT."
  type        = list(string)
}

variable "cluster_arn" {
  type = string
}

variable "namespace_id" {
  description = "Cloud Map namespace: the services register as supabase.<namespace>."
  type        = string
}

variable "namespace_name" {
  type = string
}

variable "gateway_clients" {
  description = "Security groups that reach the gateway on 8000: the load balancer, the app."
  type        = map(string)
}

variable "db_host" {
  type = string
}

variable "db_port" {
  type    = number
  default = 5432
}

variable "db_master_username" {
  type = string
}

variable "db_master_secret_arn" {
  description = "The RDS-managed secret with the master password (JSON: username, password)."
  type        = string
}

variable "secret_arn" {
  description = "The deployment's secret (modules/secrets)."
  type        = string
}

variable "kms_key_arn" {
  type = string
}

variable "storage_bucket" {
  type = string
}

variable "storage_bucket_arn" {
  type = string
}

variable "file_size_limit" {
  description = "Largest upload storage-api accepts, in bytes."
  type        = number
  default     = 52428800
}

variable "admin_email" {
  description = "The first admin, created by the deploy task with a confirmed address; the password is admin_password in the deployment's secret. Null: none is created."
  type        = string
  default     = null
}

variable "mailer_autoconfirm" {
  description = "Confirm new sign-ups without an e-mail. Off: with no SMTP, only the admin (and people the admin adds) can sign in."
  type        = bool
  default     = false
}

variable "smtp" {
  description = "Mail for sign-up confirmations and password resets (Amazon SES SMTP, for one). Null: none."
  type = object({
    host                = string
    port                = number
    user                = string
    from                = string
    password_secret_arn = string
  })
  default = null
}

variable "create_service" {
  description = "Run the services here (ECS). False on VMs, which run them in Compose; the deploy task still runs here."
  type        = bool
  default     = true
}

variable "service_launch" {
  description = "FARGATE, or the name of an EC2 capacity provider."
  type        = string
  default     = "FARGATE"
}

variable "service_count" {
  type    = number
  default = 2
}

variable "service_cpu" {
  type    = number
  default = 1024
}

variable "service_memory" {
  type    = number
  default = 2048
}

variable "target_group_arn" {
  description = "The load balancer's Supabase target group."
  type        = string
  default     = null
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "tags" {
  type    = map(string)
  default = {}
}
