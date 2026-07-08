variable "aws_region" {
  description = "Primary AWS region"
  type        = string
  default     = "us-east-1"
}

variable "project_name" {
  description = "Project name for resource naming"
  type        = string
}

variable "origin_domain" {
  description = "Domain name of the origin (API Gateway or ALB)"
  type        = string
}

variable "origin_http_port" {
  description = "HTTP port on the origin"
  type        = number
  default     = 80
}

variable "origin_https_port" {
  description = "HTTPS port on the origin"
  type        = number
  default     = 443
}

variable "origin_protocol_policy" {
  description = "Protocol policy for origin requests (http-only, https-only, match-viewer)"
  type        = string
  default     = "https-only"
}

variable "cloudfront_secret" {
  description = "Secret header value to identify requests from CloudFront"
  type        = string
  default     = ""
  sensitive   = true
}
