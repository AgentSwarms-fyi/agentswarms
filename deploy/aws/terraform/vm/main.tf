# AgentSwarms on plain VMs behind a load balancer: an Auto Scaling group of
# EC2 instances, each running the whole app with Docker; RDS PostgreSQL and S3
# underneath; the code users run on Fargate. See docs/deploy/AWS.md.
#
#   terraform init
#   terraform apply -var admin_email=you@example.com -var release=1.7.0
#
# The deploy task (migrations, the first admin) runs on Fargate before the
# instances are (re)launched, as on ECS.

locals {
  tier = jsondecode(file("${path.module}/../../spec/sizes.json")).tiers[var.size]
  name = var.name
  tags = merge(var.tags, { "agentswarms:stack" = var.name, "agentswarms:target" = "vm" })
  supabase_images = {
    gotrue    = "supabase/gotrue:v2.197.0@sha256:1736a63078f5922b198c4cbe50f80ab9a2d3b54fe8b7b6cfb2e9dc5dbbc12c6b"
    postgrest = "postgrest/postgrest:v14.18@sha256:c7cd7e265a85b05248abf53f4473fcec7e327c282d0bd0cf60f1551996d09fcf"
    storage   = "supabase/storage-api:v1.89.12@sha256:8526956cb462e9f7d392e9848ec77133b2769982ed614e9753cc687e8e4339a6"
    nginx     = "nginx:1.30.5-alpine@sha256:0985e772fb9f729e6fa0980da05fca5d9c468e870eed43071545afa9d2e27d94"
  }
}

module "network" {
  source                 = "../modules/network"
  name                   = local.name
  region                 = var.region
  cidr                   = var.vpc_cidr
  az_count               = local.tier.azs
  single_nat             = coalesce(var.single_nat, local.tier.single_nat)
  interface_endpoint_azs = local.tier.interface_endpoint_azs
  tags                   = local.tags
}

module "data" {
  source              = "../modules/data"
  name                = local.name
  vpc_id              = module.network.vpc_id
  data_subnet_ids     = module.network.data_subnet_ids
  db_instance_class   = local.tier.rds.instance_class
  multi_az            = local.tier.rds.multi_az
  db_storage_gb       = local.tier.rds.storage_gb
  db_max_storage_gb   = local.tier.rds.max_storage_gb
  deletion_protection = var.deletion_protection
  valkey_node_type    = null
  db_clients = {
    vm     = module.app.security_group_id
    deploy = module.supabase.security_group_id
  }
  tags = local.tags
}

module "secrets" {
  source               = "../modules/secrets"
  name                 = local.name
  kms_key_arn          = module.data.kms_key_arn
  recovery_window_days = var.deletion_protection ? 30 : 0
  tags                 = local.tags
}

module "edge" {
  source              = "../modules/edge"
  name                = local.name
  vpc_id              = module.network.vpc_id
  vpc_cidr            = module.network.vpc_cidr
  public_subnet_ids   = module.network.public_subnet_ids
  target_type         = "instance"
  domain_name         = var.domain_name
  certificate_arn     = var.certificate_arn
  route53_zone_id     = var.route53_zone_id
  deletion_protection = var.deletion_protection
  tags                = local.tags
}

module "sandboxes" {
  source                      = "../modules/sandboxes"
  name                        = local.name
  release                     = var.release
  source_registry             = var.source_registry
  sandbox_image_override      = var.sandbox_image_override
  architecture                = var.architecture
  vpc_id                      = module.network.vpc_id
  vpc_cidr                    = module.network.vpc_cidr
  app_subnet_ids              = module.network.app_subnet_ids
  sandbox_subnet_ids          = module.network.sandbox_subnet_ids
  s3_prefix_list_id           = module.network.s3_prefix_list_id
  endpoints_security_group_id = module.network.endpoints_security_group_id
  # The app opens sandboxes from the VMs, the notebook gateway too.
  sandbox_clients = { vm = module.app.security_group_id }
  app_callback_targets = {
    app = { security_group_id = module.app.internal_lb_security_group_id, port = 80 }
  }
  app_internal_url = module.app.internal_url
  secret_arn       = module.secrets.secret_arn
  kms_key_arn      = module.data.kms_key_arn
  egress_count     = local.tier.ecs.egress_count
  force_delete     = !var.deletion_protection
  tags             = local.tags
}

# The deploy task only: Supabase's services run on the VMs.
module "supabase" {
  source               = "../modules/supabase"
  name                 = local.name
  release              = var.release
  source_registry      = var.source_registry
  images               = local.supabase_images
  architecture         = var.architecture
  public_url           = module.edge.public_url
  vpc_id               = module.network.vpc_id
  subnet_ids           = module.network.app_subnet_ids
  cluster_arn          = module.sandboxes.cluster_arn
  namespace_id         = module.sandboxes.namespace_id
  namespace_name       = module.sandboxes.namespace_name
  gateway_clients      = {}
  db_host              = module.data.db_address
  db_master_username   = module.data.db_master_username
  db_master_secret_arn = module.data.db_master_secret_arn
  secret_arn           = module.secrets.secret_arn
  kms_key_arn          = module.data.kms_key_arn
  storage_bucket       = module.data.storage_bucket
  storage_bucket_arn   = module.data.storage_bucket_arn
  admin_email          = var.admin_email
  smtp                 = var.smtp
  create_service       = false
  tags                 = local.tags
  depends_on           = [module.secrets]
}

module "app" {
  source                = "../modules/app-vm"
  name                  = local.name
  release               = var.release
  source_registry       = var.source_registry
  images                = local.supabase_images
  architecture          = var.architecture
  public_url            = module.edge.public_url
  public_host           = module.edge.public_host
  behind_cloudfront     = var.domain_name == null
  admin_email           = var.admin_email
  smtp                  = var.smtp
  vpc_id                = module.network.vpc_id
  subnet_ids            = module.network.app_subnet_ids
  alb_security_group_id = module.edge.alb_security_group_id
  target_group_arns     = module.edge.target_group_arns
  app_clients = {
    sandboxes = module.sandboxes.sandbox_security_group_id
    egress    = module.sandboxes.egress_security_group_id
  }
  db_host             = module.data.db_address
  lake_bucket         = module.data.lake_bucket
  lake_bucket_arn     = module.data.lake_bucket_arn
  storage_bucket      = module.data.storage_bucket
  storage_bucket_arn  = module.data.storage_bucket_arn
  kms_key_arn         = module.data.kms_key_arn
  secret_arn          = module.secrets.secret_arn
  sandbox_env         = module.sandboxes.app_env
  sandbox_policy_json = module.sandboxes.app_policy_json
  extra_env = merge(var.app_env, {
    # Which deploy run migrated the schema these instances run on: a new one
    # is a new launch template version, so instances roll only after it.
    AGENTSWARMS_SCHEMA_DEPLOY = try(jsondecode(module.supabase.deployed).task_arn, "")
  })
  extra_app_policy_arns = var.app_policy_arns
  instance_type         = coalesce(var.instance_type, local.tier.vm.instance_type)
  instances             = { min = local.tier.vm.min, max = local.tier.vm.max, desired = local.tier.vm.desired }
  tags                  = local.tags
}

resource "aws_budgets_budget" "this" {
  count        = var.monthly_budget_usd > 0 && var.admin_email != null ? 1 : 0
  name         = "${local.name}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.admin_email]
  }
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.admin_email]
  }
}
