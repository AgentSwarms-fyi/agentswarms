# AgentSwarms on Amazon ECS: the app's containers on EC2 behind a load
# balancer, Supabase's services beside them, the code users run on Fargate,
# RDS PostgreSQL and S3 underneath. See docs/deploy/AWS.md.
#
#   terraform init
#   terraform apply -var admin_email=you@example.com -var release=1.7.0
#
# The order an apply follows, so nothing starts on a schema it does not know:
# the secrets are made (in AWS, never in this state), the database and the
# load balancer come up, the deploy task migrates and creates the admin, and
# only then do the services start (or roll).

locals {
  tier = jsondecode(file("${path.module}/../../spec/sizes.json")).tiers[var.size]
  name = var.name
  tags = merge(var.tags, { "agentswarms:stack" = var.name, "agentswarms:target" = "ecs" })
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
  valkey_node_type    = try(local.tier.valkey.node_type, null)
  valkey_replicas     = try(local.tier.valkey.replicas, 0)
  db_clients = {
    app      = module.app.app_security_group_id
    supabase = module.supabase.security_group_id
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
  target_type         = "ip"
  domain_name         = var.domain_name
  certificate_arn     = var.certificate_arn
  route53_zone_id     = var.route53_zone_id
  deletion_protection = var.deletion_protection
  tags                = local.tags
}

module "sandboxes" {
  source                    = "../modules/sandboxes"
  name                      = local.name
  release                   = var.release
  source_registry           = var.source_registry
  sandbox_image_override    = var.sandbox_image_override
  architecture              = var.architecture
  vpc_id                    = module.network.vpc_id
  vpc_cidr                  = module.network.vpc_cidr
  app_subnet_ids            = module.network.app_subnet_ids
  sandbox_subnet_ids        = module.network.sandbox_subnet_ids
  s3_prefix_list_id         = module.network.s3_prefix_list_id
  endpoints_security_groups = module.network.endpoints_security_groups
  sandbox_clients = {
    app     = module.app.app_security_group_id
    gateway = module.app.gateway_security_group_id
  }
  app_callback_targets = {
    app = { security_group_id = module.app.app_security_group_id, port = 8080 }
  }
  app_internal_url          = "http://app.${local.name}.internal:8080"
  secret_arn                = module.secrets.secret_arn
  kms_key_arn               = module.data.kms_key_arn
  egress_count              = local.tier.ecs.egress_count
  manage_capacity_providers = false
  force_delete              = !var.deletion_protection
  tags                      = local.tags
}

module "supabase" {
  source               = "../modules/supabase"
  name                 = local.name
  release              = var.release
  source_registry      = var.source_registry
  architecture         = var.architecture
  public_url           = module.edge.public_url
  vpc_id               = module.network.vpc_id
  subnet_ids           = module.network.app_subnet_ids
  cluster_arn          = module.sandboxes.cluster_arn
  namespace_id         = module.sandboxes.namespace_id
  namespace_name       = module.sandboxes.namespace_name
  gateway_clients      = { alb = module.edge.alb_security_group_id, app = module.app.app_security_group_id }
  db_host              = module.data.db_address
  db_master_username   = module.data.db_master_username
  db_master_secret_arn = module.data.db_master_secret_arn
  secret_arn           = module.secrets.secret_arn
  kms_key_arn          = module.data.kms_key_arn
  storage_bucket       = module.data.storage_bucket
  storage_bucket_arn   = module.data.storage_bucket_arn
  admin_email          = var.admin_email
  smtp                 = var.smtp
  create_service       = true
  service_launch       = module.app.capacity_provider_name
  service_count        = local.tier.ecs.supabase.count
  service_cpu          = local.tier.ecs.supabase.cpu
  service_memory       = local.tier.ecs.supabase.memory
  target_group_arn     = module.edge.target_group_arns.supabase
  tags                 = local.tags
  # The secrets must exist (the Lambda filled them) before the deploy task reads them.
  depends_on = [module.secrets]
}

module "app" {
  source                = "../modules/app-ecs"
  name                  = local.name
  release               = var.release
  source_registry       = var.source_registry
  architecture          = var.architecture
  public_url            = module.edge.public_url
  public_host           = module.edge.public_host
  behind_cloudfront     = var.domain_name == null
  admin_email           = var.admin_email
  vpc_id                = module.network.vpc_id
  subnet_ids            = module.network.app_subnet_ids
  cluster_name          = module.sandboxes.cluster_name
  cluster_arn           = module.sandboxes.cluster_arn
  namespace_id          = module.sandboxes.namespace_id
  namespace_name        = module.sandboxes.namespace_name
  alb_security_group_id = module.edge.alb_security_group_id
  target_group_arns     = module.edge.target_group_arns
  app_clients = {
    sandboxes = module.sandboxes.sandbox_security_group_id
    egress    = module.sandboxes.egress_security_group_id
  }
  db_host               = module.data.db_address
  lake_bucket           = module.data.lake_bucket
  lake_bucket_arn       = module.data.lake_bucket_arn
  kms_key_arn           = module.data.kms_key_arn
  secret_arn            = module.secrets.secret_arn
  secret_keys           = keys(module.secrets.value_from)
  valkey_url_secret_arn = module.data.valkey_url_secret_arn
  sandbox_env           = module.sandboxes.app_env
  sandbox_policy_json   = module.sandboxes.app_policy_json
  extra_env             = var.app_env
  extra_app_policy_arns = var.app_policy_arns
  instance_type         = coalesce(var.instance_type, local.tier.ecs.instance_type)
  instances             = local.tier.ecs.instances
  web                   = local.tier.ecs.web
  analytics             = local.tier.ecs.analytics
  gateway_count         = local.tier.ecs.gateway_count
  internal_count        = local.tier.ecs.internal_count
  # The app's task definitions name the deploy run that migrated the schema
  # they run on: they cannot be registered, and no service rolls, before it.
  schema_deploy = module.supabase.deployed
  tags          = local.tags
}

# A monthly budget for the account, with an e-mail at 80% spent and at 100%
# forecast. Account-wide: a budget on this stack's tag sees nothing until the
# tag is activated in Billing, which only the account's owner can do.
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
