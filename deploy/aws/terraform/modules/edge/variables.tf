variable "name" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "vpc_cidr" {
  type = string
}

variable "public_subnet_ids" {
  type = list(string)
}

variable "target_type" {
  description = "ip (ECS tasks, awsvpc) or instance (VMs)."
  type        = string
  default     = "ip"
}

variable "app_port" {
  type    = number
  default = 8080
}

variable "supabase_port" {
  description = "The Supabase gateway (nginx)."
  type        = number
  default     = 8000
}

variable "gateway_port" {
  description = "The notebook gateway."
  type        = number
  default     = 8090
}

variable "domain_name" {
  description = "The hostname to serve, e.g. agentswarms.example.com. Null: CloudFront's own *.cloudfront.net name, no domain needed (a quick start; between CloudFront and the load balancer the traffic is then plain HTTP)."
  type        = string
  default     = null
}

variable "certificate_arn" {
  description = "An ACM certificate in this region for domain_name. Null with route53_zone_id: one is made and validated."
  type        = string
  default     = null
}

variable "route53_zone_id" {
  description = "The Route 53 hosted zone of domain_name: for the certificate's validation and the alias record. Null: point the name at the load balancer yourself."
  type        = string
  default     = null
}

variable "deletion_protection" {
  type    = bool
  default = true
}

variable "tags" {
  type    = map(string)
  default = {}
}
