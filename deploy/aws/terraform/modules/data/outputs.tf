output "kms_key_arn" {
  value = aws_kms_key.this.arn
}

output "db_address" {
  value = aws_db_instance.this.address
}

output "db_port" {
  value = aws_db_instance.this.port
}

output "db_master_username" {
  value = aws_db_instance.this.username
}

output "db_master_secret_arn" {
  description = "Secrets Manager secret RDS keeps the master password in (JSON: username, password)."
  value       = aws_db_instance.this.master_user_secret[0].secret_arn
}

output "db_security_group_id" {
  value = aws_security_group.db.id
}

output "lake_bucket" {
  value = aws_s3_bucket.this["lake"].bucket
}

output "lake_bucket_arn" {
  value = aws_s3_bucket.this["lake"].arn
}

output "storage_bucket" {
  value = aws_s3_bucket.this["storage"].bucket
}

output "storage_bucket_arn" {
  value = aws_s3_bucket.this["storage"].arn
}

output "valkey_url_secret_arn" {
  description = "The secret holding the rediss:// URL with its AUTH token, or null without Valkey."
  value       = length(aws_secretsmanager_secret.valkey) == 0 ? null : aws_secretsmanager_secret.valkey[0].arn
  depends_on  = [aws_secretsmanager_secret_version.valkey]
}
