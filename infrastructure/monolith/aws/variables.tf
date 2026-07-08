variable "aws_region" {
  description = "AWS region for deployment"
  type        = string
  default     = "us-east-1"
}

variable "image_tag" {
  description = "Docker image tag to deploy"
  type        = string
  default     = "latest"
}

variable "cpu" {
  description = "CPU units for the ECS task (1024 = 1 vCPU)"
  type        = number
  default     = 512
}

variable "memory" {
  description = "Memory in MB for the ECS task"
  type        = number
  default     = 1024
}

variable "desired_count" {
  description = "Initial number of monolith instances to run"
  type        = number
  default     = 3
}

# Auto-Scaling Configuration
variable "min_capacity" {
  description = "Minimum number of tasks for auto-scaling"
  type        = number
  default     = 2
}

variable "max_capacity" {
  description = "Maximum number of tasks for auto-scaling"
  type        = number
  default     = 100
}

variable "target_cpu_utilization" {
  description = "Target CPU utilization percentage for auto-scaling"
  type        = number
  default     = 70
}

variable "target_request_count" {
  description = "Target ALB requests per target per minute for auto-scaling"
  type        = number
  default     = 2500
}

variable "scale_out_cooldown" {
  description = "Scale-out cooldown period in seconds (Fast Response)"
  type        = number
  default     = 60
}

variable "scale_in_cooldown" {
  description = "Scale-in cooldown period in seconds (Slow Shrinkage) - Monolith: 300s"
  type        = number
  default     = 300
}

variable "scaling_mode" {
  description = "Auto-scaling mode: request_count (default), latency, or none"
  type        = string
  default     = "request_count"
  validation {
    condition     = contains(["request_count", "latency", "none"], var.scaling_mode)
    error_message = "scaling_mode must be one of: request_count, latency, none"
  }
}

variable "target_response_time" {
  description = "Target average response time in seconds for latency-based scaling"
  type        = number
  default     = 0.3
}

variable "edge_public_key" {
  description = "Ed25519 public key for edge authentication (base64 encoded)"
  type        = string
  default     = ""
}

variable "auth_granularity" {
  description = "Where token verification happens: per-function (legacy) or per-service (entry-point boundary)"
  type        = string
  default     = "per-function"
  validation {
    condition     = contains(["per-function", "per-service"], var.auth_granularity)
    error_message = "auth_granularity must be one of: per-function, per-service"
  }
}

variable "jwt_private_key" {
  description = "Ed25519 private key for JWT signing (base64-encoded PEM)"
  type        = string
  default     = ""
  sensitive   = true
}

variable "jwt_public_key" {
  description = "Ed25519 public key for JWT verification (base64-encoded PEM)"
  type        = string
  default     = ""
}