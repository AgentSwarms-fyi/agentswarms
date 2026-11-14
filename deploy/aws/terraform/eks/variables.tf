variable "name" {
  description = "Name for everything this creates (and the agentswarms:stack tag). Lowercase letters, digits and hyphens."
  type        = string
  default     = "agentswarms"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,20}$", var.name))
    error_message = "name is 3-21 lowercase letters, digits or hyphens, starting with a letter."
  }
}

variable "region" {
  type    = string
  default = "us-east-1"
}

variable "release" {
  description = "The AgentSwarms release to run, e.g. 1.7.0. Upgrading is changing it and applying; rolling back is the previous one."
  type        = string
}

variable "size" {
  description = "dev, small, medium or large (deploy/aws/spec/sizes.json)."
  type        = string
  default     = "dev"
  validation {
    condition     = contains(["dev", "small", "medium", "large"], var.size)
    error_message = "size is dev, small, medium or large."
  }
}

variable "admin_email" {
  description = "The first admin, created by the deploy with a confirmed address. The password is admin_password in the secret <name>/app; the budget e-mails go here too."
  type        = string
  default     = null
}

variable "domain_name" {
  description = "Serve on this hostname, with an ACM certificate. Null: CloudFront's *.cloudfront.net name, no domain needed."
  type        = string
  default     = null
}

variable "certificate_arn" {
  type    = string
  default = null
}

variable "route53_zone_id" {
  type    = string
  default = null
}

variable "source_registry" {
  type    = string
  default = "ghcr.io/agentswarms-fyi"
}

variable "architecture" {
  description = "ARM64 (Graviton) or X86_64 nodes."
  type        = string
  default     = "ARM64"
}

variable "instance_type" {
  description = "Override the tier's EC2 instance type."
  type        = string
  default     = null
}

variable "vpc_cidr" {
  type    = string
  default = "10.40.0.0/16"
}

variable "single_nat" {
  description = "Override the tier: one NAT gateway for every AZ."
  type        = bool
  default     = null
}

variable "deletion_protection" {
  description = "Protect the database, the load balancer and the secret. Off for a throwaway test, so destroy removes everything."
  type        = bool
  default     = true
}

variable "smtp" {
  description = "Mail for sign-up confirmation and password reset (Amazon SES SMTP, say); password_secret_arn is a Secrets Manager secret holding the SMTP password."
  type = object({
    host                = string
    port                = number
    user                = string
    from                = string
    password_secret_arn = string
  })
  default = null
}

variable "app_env" {
  description = "More app settings (see .env.example)."
  type        = map(string)
  default     = {}
}

variable "app_policy_arns" {
  description = "Managed policies for the app's role, e.g. arn:aws:iam::aws:policy/AWSGlueConsoleFullAccess for the Glue catalog connector."
  type        = list(string)
  default     = []
}

variable "monthly_budget_usd" {
  description = "An AWS Budget with e-mail alerts to admin_email; 0 for none."
  type        = number
  default     = 0
}

variable "tags" {
  type    = map(string)
  default = {}
}

variable "kubernetes_version" {
  description = "EKS Kubernetes version; Cluster Autoscaler's chart (9.59.0, autoscaler 1.35) matches it."
  type        = string
  default     = "1.35"
}

variable "api_allowed_cidrs" {
  description = "Who may reach the cluster's API endpoint from the internet (kubectl, Terraform's Helm releases). Narrow it to your own address."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}
