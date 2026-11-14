# The VPC every AWS deployment of AgentSwarms runs in (VM, ECS and EKS).
#
# Four tiers of subnet, one of each per AZ:
#   public    the load balancer and the NAT gateways
#   app       the app, Supabase's services, the gateways, the egress proxy
#   sandbox   user code (Fargate tasks or tainted EKS nodes): NO route out
#             at all; it reaches the egress proxy, the app's internal load
#             balancer and the VPC endpoints, and nothing else
#   data      RDS and Valkey; no route out
#
# Sandboxes having no route is the boundary, not the proxy: code that ignores
# HTTPS_PROXY has nowhere to go.

data "aws_availability_zones" "available" {
  state = "available"
  filter {
    name   = "opt-in-status"
    values = ["opt-in-not-required"]
  }
}

locals {
  azs = slice(data.aws_availability_zones.available.names, 0, var.az_count)
  # /16 split into /20s: public 0-2, app 4-6, sandbox 8-10, data 12-14.
  public_cidrs  = [for i in range(var.az_count) : cidrsubnet(var.cidr, 4, i)]
  app_cidrs     = [for i in range(var.az_count) : cidrsubnet(var.cidr, 4, 4 + i)]
  sandbox_cidrs = [for i in range(var.az_count) : cidrsubnet(var.cidr, 4, 8 + i)]
  data_cidrs    = [for i in range(var.az_count) : cidrsubnet(var.cidr, 4, 12 + i)]
  nat_count     = var.single_nat ? 1 : var.az_count
  tags          = merge(var.tags, { "agentswarms:stack" = var.name })
}

resource "aws_vpc" "this" {
  cidr_block           = var.cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = merge(local.tags, { Name = var.name })
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = merge(local.tags, { Name = var.name })
}

resource "aws_subnet" "public" {
  count                   = var.az_count
  vpc_id                  = aws_vpc.this.id
  cidr_block              = local.public_cidrs[count.index]
  availability_zone       = local.azs[count.index]
  map_public_ip_on_launch = false
  tags = merge(local.tags, var.public_subnet_tags, {
    Name               = "${var.name}-public-${local.azs[count.index]}"
    "agentswarms:tier" = "public"
  })
}

resource "aws_subnet" "app" {
  count             = var.az_count
  vpc_id            = aws_vpc.this.id
  cidr_block        = local.app_cidrs[count.index]
  availability_zone = local.azs[count.index]
  tags = merge(local.tags, var.app_subnet_tags, {
    Name               = "${var.name}-app-${local.azs[count.index]}"
    "agentswarms:tier" = "app"
  })
}

resource "aws_subnet" "sandbox" {
  count             = var.az_count
  vpc_id            = aws_vpc.this.id
  cidr_block        = local.sandbox_cidrs[count.index]
  availability_zone = local.azs[count.index]
  tags = merge(local.tags, {
    Name               = "${var.name}-sandbox-${local.azs[count.index]}"
    "agentswarms:tier" = "sandbox"
  })
}

resource "aws_subnet" "data" {
  count             = var.az_count
  vpc_id            = aws_vpc.this.id
  cidr_block        = local.data_cidrs[count.index]
  availability_zone = local.azs[count.index]
  tags = merge(local.tags, {
    Name               = "${var.name}-data-${local.azs[count.index]}"
    "agentswarms:tier" = "data"
  })
}

resource "aws_eip" "nat" {
  count  = local.nat_count
  domain = "vpc"
  tags   = merge(local.tags, { Name = "${var.name}-nat-${count.index}" })
}

resource "aws_nat_gateway" "this" {
  count         = local.nat_count
  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id
  tags          = merge(local.tags, { Name = "${var.name}-nat-${local.azs[count.index]}" })
  depends_on    = [aws_internet_gateway.this]
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }
  tags = merge(local.tags, { Name = "${var.name}-public" })
}

resource "aws_route_table_association" "public" {
  count          = var.az_count
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# One per AZ, each to its own AZ's NAT (or the single one): losing an AZ
# does not take the others' way out with it.
resource "aws_route_table" "app" {
  count  = var.az_count
  vpc_id = aws_vpc.this.id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.this[var.single_nat ? 0 : count.index].id
  }
  tags = merge(local.tags, { Name = "${var.name}-app-${local.azs[count.index]}" })
}

resource "aws_route_table_association" "app" {
  count          = var.az_count
  subnet_id      = aws_subnet.app[count.index].id
  route_table_id = aws_route_table.app[count.index].id
}

# No default route: the VPC and its endpoints only.
resource "aws_route_table" "isolated" {
  vpc_id = aws_vpc.this.id
  tags   = merge(local.tags, { Name = "${var.name}-isolated" })
}

resource "aws_route_table_association" "sandbox" {
  count          = var.az_count
  subnet_id      = aws_subnet.sandbox[count.index].id
  route_table_id = aws_route_table.isolated.id
}

resource "aws_route_table_association" "data" {
  count          = var.az_count
  subnet_id      = aws_subnet.data[count.index].id
  route_table_id = aws_route_table.isolated.id
}

# S3 through a gateway endpoint, free: the lake's reads and writes, and image
# layers from ECR, stay off the NAT's per-GB charge.
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = concat(aws_route_table.app[*].id, [aws_route_table.isolated.id])
  tags              = merge(local.tags, { Name = "${var.name}-s3" })
}

# What a Fargate sandbox needs to start with no route out: its image from
# ECR, its logs to CloudWatch. Interface endpoints cost about $7.30 a month
# each per AZ, so they are on only where something needs them.
resource "aws_security_group" "endpoints" {
  count       = length(var.interface_endpoints) > 0 ? 1 : 0
  name        = "${var.name}-endpoints"
  description = "VPC interface endpoints: HTTPS from inside the VPC"
  vpc_id      = aws_vpc.this.id
  ingress {
    description = "HTTPS from the VPC"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = [var.cidr]
  }
  tags = local.tags
}

resource "aws_vpc_endpoint" "interface" {
  for_each            = toset(var.interface_endpoints)
  vpc_id              = aws_vpc.this.id
  service_name        = "com.amazonaws.${var.region}.${each.value}"
  vpc_endpoint_type   = "Interface"
  private_dns_enabled = true
  # Each AZ is another ENI per endpoint and another $7.30 a month; a sandbox
  # in an AZ without one uses the others' (and pays cross-AZ data for it).
  subnet_ids         = slice(aws_subnet.sandbox[*].id, 0, min(var.interface_endpoint_azs, var.az_count))
  security_group_ids = [aws_security_group.endpoints[0].id]
  tags               = merge(local.tags, { Name = "${var.name}-${each.value}" })
}
