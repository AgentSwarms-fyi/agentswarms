output "vpc_id" {
  value = aws_vpc.this.id
}

output "vpc_cidr" {
  value = aws_vpc.this.cidr_block
}

output "azs" {
  value = local.azs
}

output "public_subnet_ids" {
  value = aws_subnet.public[*].id
}

output "app_subnet_ids" {
  value = aws_subnet.app[*].id
}

output "sandbox_subnet_ids" {
  value = aws_subnet.sandbox[*].id
}

output "sandbox_subnet_cidrs" {
  value = aws_subnet.sandbox[*].cidr_block
}

output "data_subnet_ids" {
  value = aws_subnet.data[*].id
}

output "s3_prefix_list_id" {
  description = "The S3 gateway endpoint's prefix list, for security group rules."
  value       = aws_vpc_endpoint.s3.prefix_list_id
}

# Keyed by a name known at plan time, so a caller can for_each over it before
# the group exists: a count on whether its id is null cannot be planned on a
# first apply (found rehearsing on AWS Emulator, R484).
output "endpoints_security_groups" {
  description = "The interface endpoints' security group as { endpoints = id }, or {} without interface endpoints."
  value       = length(aws_security_group.endpoints) > 0 ? { endpoints = aws_security_group.endpoints[0].id } : {}
}
