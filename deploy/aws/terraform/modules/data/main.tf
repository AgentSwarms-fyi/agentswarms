# State: the database, the buckets, the key, and (optionally) Valkey.
#
# RDS PostgreSQL 17 holds Supabase's schemas (auth, storage, public) and the
# DuckLake catalog database. Plain RDS has no superuser: db-migrate's
# `bootstrap` creates the roles Supabase expects (deploy/aws/spec/bootstrap,
# proved by deploy/ci/rds-like), and Realtime stays off (R468).

locals {
  tags = merge(var.tags, { "agentswarms:stack" = var.name })
}

data "aws_caller_identity" "this" {}

resource "aws_kms_key" "this" {
  description             = "${var.name}: RDS, S3, Secrets Manager and logs"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  tags                    = local.tags
}

resource "aws_kms_alias" "this" {
  name          = "alias/${var.name}"
  target_key_id = aws_kms_key.this.key_id
}

# ── PostgreSQL ───────────────────────────────────────────────────────────────

resource "aws_db_subnet_group" "this" {
  name       = var.name
  subnet_ids = var.data_subnet_ids
  tags       = local.tags
}

resource "aws_security_group" "db" {
  name        = "${var.name}-db"
  description = "RDS: PostgreSQL from the app tier only"
  vpc_id      = var.vpc_id
  tags        = local.tags
}

resource "aws_vpc_security_group_ingress_rule" "db" {
  for_each                     = var.db_clients
  security_group_id            = aws_security_group.db.id
  referenced_security_group_id = each.value
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  description                  = "PostgreSQL from ${each.key}"
}

resource "aws_db_parameter_group" "this" {
  name   = "${var.name}-pg17"
  family = "postgres17"
  # TLS from every client. Nothing else differs from the default group: no
  # pg_cron, since retention runs in the app (R467), as deploy/ci/rds-like
  # proves the schema without it.
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
  tags = local.tags
}

resource "aws_db_instance" "this" {
  identifier     = var.name
  engine         = "postgres"
  engine_version = var.postgres_version
  instance_class = var.db_instance_class

  allocated_storage     = var.db_storage_gb
  max_allocated_storage = var.db_max_storage_gb
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = aws_kms_key.this.arn

  db_name  = "postgres"
  username = "agentswarms_admin"
  # RDS keeps the master password in Secrets Manager and rotates it; nothing
  # here ever holds it.
  manage_master_user_password   = true
  master_user_secret_kms_key_id = aws_kms_key.this.key_id

  multi_az               = var.multi_az
  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.db.id]
  parameter_group_name   = aws_db_parameter_group.this.name
  publicly_accessible    = false

  backup_retention_period         = var.backup_retention_days
  copy_tags_to_snapshot           = true
  deletion_protection             = var.deletion_protection
  skip_final_snapshot             = !var.deletion_protection
  final_snapshot_identifier       = var.deletion_protection ? "${var.name}-final" : null
  performance_insights_enabled    = true
  performance_insights_kms_key_id = aws_kms_key.this.arn
  enabled_cloudwatch_logs_exports = ["postgresql"]
  auto_minor_version_upgrade      = true
  apply_immediately               = false

  tags = local.tags
}

# ── Object storage ───────────────────────────────────────────────────────────

# lake: the lakehouse's Parquet and DuckLake data. storage: Supabase Storage
# (uploads, chat documents). Separate, so each has its own policy and life.
resource "aws_s3_bucket" "this" {
  for_each      = toset(["lake", "storage"])
  bucket        = "${var.name}-${each.value}-${data.aws_caller_identity.this.account_id}"
  force_destroy = !var.deletion_protection
  tags          = merge(local.tags, { "agentswarms:bucket" = each.value })
}

resource "aws_s3_bucket_public_access_block" "this" {
  for_each                = aws_s3_bucket.this
  bucket                  = each.value.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "this" {
  for_each = aws_s3_bucket.this
  bucket   = each.value.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  for_each = aws_s3_bucket.this
  bucket   = each.value.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.this.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_versioning" "this" {
  for_each = aws_s3_bucket.this
  bucket   = each.value.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "this" {
  for_each = aws_s3_bucket.this
  bucket   = each.value.id
  rule {
    id     = "old-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_version_days
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

# TLS only, for every caller.
resource "aws_s3_bucket_policy" "this" {
  for_each = aws_s3_bucket.this
  bucket   = each.value.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "TlsOnly"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [each.value.arn, "${each.value.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
  depends_on = [aws_s3_bucket_public_access_block.this]
}

# ── Valkey (optional) ────────────────────────────────────────────────────────

resource "aws_security_group" "valkey" {
  count       = var.valkey_node_type == null ? 0 : 1
  name        = "${var.name}-valkey"
  description = "Valkey: from the app tier only"
  vpc_id      = var.vpc_id
  tags        = local.tags
}

resource "aws_vpc_security_group_ingress_rule" "valkey" {
  for_each                     = var.valkey_node_type == null ? {} : var.db_clients
  security_group_id            = aws_security_group.valkey[0].id
  referenced_security_group_id = each.value
  from_port                    = 6379
  to_port                      = 6379
  ip_protocol                  = "tcp"
  description                  = "Valkey from ${each.key}"
}

resource "aws_elasticache_subnet_group" "this" {
  count      = var.valkey_node_type == null ? 0 : 1
  name       = var.name
  subnet_ids = var.data_subnet_ids
}

resource "random_password" "valkey" {
  count   = var.valkey_node_type == null ? 0 : 1
  length  = 48
  special = false
}

resource "aws_elasticache_replication_group" "this" {
  count                      = var.valkey_node_type == null ? 0 : 1
  replication_group_id       = var.name
  description                = "${var.name} feature store and caches"
  engine                     = "valkey"
  engine_version             = "8.1"
  node_type                  = var.valkey_node_type
  num_cache_clusters         = 1 + var.valkey_replicas
  automatic_failover_enabled = var.valkey_replicas > 0
  multi_az_enabled           = var.valkey_replicas > 0
  subnet_group_name          = aws_elasticache_subnet_group.this[0].name
  security_group_ids         = [aws_security_group.valkey[0].id]
  transit_encryption_enabled = true
  at_rest_encryption_enabled = true
  kms_key_id                 = aws_kms_key.this.arn
  auth_token                 = random_password.valkey[0].result
  tags                       = local.tags
}

# The URL carries the AUTH token, so the app gets it from a secret, never in
# its task definition's plain environment.
resource "aws_secretsmanager_secret" "valkey" {
  count                   = var.valkey_node_type == null ? 0 : 1
  name                    = "${var.name}/valkey-url"
  kms_key_id              = aws_kms_key.this.arn
  recovery_window_in_days = var.deletion_protection ? 30 : 0
  tags                    = local.tags
}

resource "aws_secretsmanager_secret_version" "valkey" {
  count     = var.valkey_node_type == null ? 0 : 1
  secret_id = aws_secretsmanager_secret.valkey[0].id
  secret_string = format(
    "rediss://:%s@%s:6379",
    random_password.valkey[0].result,
    aws_elasticache_replication_group.this[0].primary_endpoint_address,
  )
}
