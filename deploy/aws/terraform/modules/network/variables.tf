variable "name" {
  description = "Name prefix for everything this creates, and the agentswarms:stack tag."
  type        = string
}

variable "region" {
  description = "AWS region, for the VPC endpoints' service names."
  type        = string
}

variable "cidr" {
  description = "The VPC's address range; a /16 is split into /20 subnets."
  type        = string
  default     = "10.40.0.0/16"
  validation {
    condition     = can(cidrhost(var.cidr, 0)) && tonumber(split("/", var.cidr)[1]) <= 16
    error_message = "cidr must be a /16 or larger, such as 10.40.0.0/16."
  }
}

variable "az_count" {
  description = "Availability zones to spread over: 2 or 3."
  type        = number
  default     = 2
  validation {
    condition     = contains([2, 3], var.az_count)
    error_message = "az_count must be 2 or 3."
  }
}

variable "single_nat" {
  description = "One NAT gateway for every AZ instead of one each: about $33 a month less per AZ, but an AZ outage there cuts the others off from the internet."
  type        = bool
  default     = false
}

variable "interface_endpoints" {
  description = "Interface VPC endpoints to create in the sandbox subnets. Fargate sandboxes need ecr.api, ecr.dkr and logs to start without a route out."
  type        = list(string)
  default     = ["ecr.api", "ecr.dkr", "logs"]
}

variable "interface_endpoint_azs" {
  description = "How many AZs get the interface endpoints' ENIs: 1 for a test, every AZ for high availability."
  type        = number
  default     = 3
}

variable "public_subnet_tags" {
  description = "Extra tags for the public subnets (EKS: kubernetes.io/role/elb)."
  type        = map(string)
  default     = {}
}

variable "app_subnet_tags" {
  description = "Extra tags for the app subnets (EKS: kubernetes.io/role/internal-elb, karpenter.sh/discovery)."
  type        = map(string)
  default     = {}
}

variable "tags" {
  description = "Tags for every resource."
  type        = map(string)
  default     = {}
}
