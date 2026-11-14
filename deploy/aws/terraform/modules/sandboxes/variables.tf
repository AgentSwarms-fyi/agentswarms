variable "name" {
  type = string
}

variable "release" {
  description = "The AgentSwarms release whose images run, e.g. 1.7.0."
  type        = string
}

variable "source_registry" {
  description = "Where the release's images are published."
  type        = string
  default     = "ghcr.io/agentswarms-fyi"
}

variable "sandbox_image_override" {
  description = "A sandbox image already in an ECR this account can pull from; skips the copy (which needs docker and the AWS CLI where Terraform runs)."
  type        = string
  default     = null
}

variable "architecture" {
  description = "ARM64 (Graviton, cheaper) or X86_64."
  type        = string
  default     = "ARM64"
  validation {
    condition     = contains(["ARM64", "X86_64"], var.architecture)
    error_message = "architecture is ARM64 or X86_64."
  }
}

variable "vpc_id" {
  type = string
}

variable "vpc_cidr" {
  type = string
}

variable "app_subnet_ids" {
  description = "Where the egress proxy runs: the only subnets here with a route out."
  type        = list(string)
}

variable "sandbox_subnet_ids" {
  type = list(string)
}

variable "s3_prefix_list_id" {
  type = string
}

variable "endpoints_security_groups" {
  description = "The interface endpoints' security group, keyed by a name known at plan time (the network module's endpoints_security_groups); {} without interface endpoints."
  type        = map(string)
  default     = {}
}

variable "sandbox_clients" {
  description = "Security groups that open sandboxes (the app, the notebook gateway), by a name known at plan time."
  type        = map(string)
}

variable "app_callback_targets" {
  description = "What a sandbox may call back: { app = { security_group_id, port } }."
  type        = map(object({ security_group_id = string, port = number }))
}

variable "app_internal_url" {
  description = "The app as the sandboxes and the egress proxy reach it, e.g. http://app.<name>.internal:8080."
  type        = string
}

variable "secret_arn" {
  type = string
}

variable "kms_key_arn" {
  type = string
}

variable "egress_count" {
  description = "Egress proxy tasks; 2 for one in each of two AZs."
  type        = number
  default     = 2
}

variable "manage_capacity_providers" {
  description = "Set the cluster's capacity providers (FARGATE, FARGATE_SPOT) here. False when the app's module sets them with its own EC2 provider (ECS)."
  type        = bool
  default     = true
}

variable "container_insights" {
  type    = bool
  default = false
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "force_delete" {
  description = "Let destroy remove the ECR repository with its images."
  type        = bool
  default     = false
}

variable "tags" {
  type    = map(string)
  default = {}
}
