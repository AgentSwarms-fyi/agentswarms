variable "name" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "data_subnet_ids" {
  type = list(string)
}

variable "db_clients" {
  description = "Security groups that may reach PostgreSQL (and Valkey), by a name known at plan time: { app = sg-..., supabase = sg-... }."
  type        = map(string)
}

variable "postgres_version" {
  description = "RDS PostgreSQL engine version. 17 is what deploy/ci/rds-like proves the schema against."
  type        = string
  default     = "17"
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.large"
}

variable "multi_az" {
  description = "A standby in a second AZ that RDS fails over to (in about 1-2 minutes)."
  type        = bool
  default     = true
}

variable "db_storage_gb" {
  type    = number
  default = 50
}

variable "db_max_storage_gb" {
  description = "Storage autoscaling ceiling."
  type        = number
  default     = 500
}

variable "backup_retention_days" {
  type    = number
  default = 7
}

variable "deletion_protection" {
  description = "Refuse to delete the database and keep a final snapshot; buckets are kept with their data. Off for a throwaway test."
  type        = bool
  default     = true
}

variable "noncurrent_version_days" {
  description = "How long S3 keeps an overwritten or deleted object's old version."
  type        = number
  default     = 30
}

variable "valkey_node_type" {
  description = "ElastiCache Valkey node type, or null for none (the app works without it)."
  type        = string
  default     = null
}

variable "valkey_replicas" {
  type    = number
  default = 1
}

variable "tags" {
  type    = map(string)
  default = {}
}
