variable "handler" {
  default = "index.lambdaHandler"
}

variable "memory_size" {
  default = 256
}

variable "timeout" {
  default = 60
}

variable "fn_env" {
  type    = map(string)
  default = {}
}

variable "edge_public_key" {
  description = "Ed25519 public key for edge authentication (base64 encoded)"
  type        = string
  default     = ""
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

variable "auth_granularity" {
  description = "Where token verification happens: per-function (legacy) or per-service. For FaaS each function is its own boundary, so this is informational only."
  type        = string
  default     = "per-function"
  validation {
    condition     = contains(["per-function", "per-service"], var.auth_granularity)
    error_message = "auth_granularity must be one of: per-function, per-service"
  }
}
