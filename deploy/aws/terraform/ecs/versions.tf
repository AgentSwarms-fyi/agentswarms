# Exact provider versions, each released at least two weeks before it was
# adopted (docs/RELEASING.md); .terraform.lock.hcl holds their checksums.
terraform {
  required_version = ">= 1.6.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.71.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "3.9.1"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "2.8.1"
    }
  }
  # State is local unless you add a backend: for a team, an S3 bucket with
  # use_lockfile = true (see docs/deploy/AWS.md).
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { "agentswarms:stack" = var.name }
  }
}
