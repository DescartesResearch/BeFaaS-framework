variable "use_persistent_cognito" {
  description = "Use persistent Cognito pool from services/cognito instead of creating new one"
  type        = bool
  default     = true
}

data "terraform_remote_state" "cognito" {
  count   = var.use_persistent_cognito ? 1 : 0
  backend = "local"

  config = {
    path = "${path.module}/../services/cognito/terraform.tfstate"
  }
}

# Per-experiment Cognito pool (when use_persistent_cognito = false)
resource "aws_cognito_user_pool" "main" {
  count = var.use_persistent_cognito ? 0 : 1
  name  = "${local.project_name}-user-pool"

  password_policy {
    minimum_length                   = 8
    require_lowercase                = true
    require_uppercase                = true
    require_numbers                  = true
    require_symbols                  = false
    temporary_password_validity_days = 7
  }

  tags = {
    Project      = local.project_name
    DeploymentId = local.deployment_id
  }
}

resource "aws_cognito_user_pool_client" "main" {
  count        = var.use_persistent_cognito ? 0 : 1
  name         = "${local.project_name}-client"
  user_pool_id = aws_cognito_user_pool.main[0].id

  access_token_validity  = 60
  id_token_validity      = 60
  refresh_token_validity = 30

  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }

  explicit_auth_flows = [
    "ALLOW_USER_PASSWORD_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
    "ALLOW_USER_SRP_AUTH"
  ]

  generate_secret                      = false
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code", "implicit"]
  allowed_oauth_scopes                 = ["email", "openid", "profile"]
  callback_urls                        = ["http://localhost:3000/callback"]
  logout_urls                          = ["http://localhost:3000/logout"]
  enable_token_revocation              = true
  prevent_user_existence_errors        = "ENABLED"
}

resource "aws_cognito_user_pool_domain" "main" {
  count        = var.use_persistent_cognito ? 0 : 1
  domain       = "${local.project_name}-${local.deployment_id}"
  user_pool_id = aws_cognito_user_pool.main[0].id
}

locals {
  cognito_user_pool_id       = var.use_persistent_cognito ? data.terraform_remote_state.cognito[0].outputs.cognito_user_pool_id : aws_cognito_user_pool.main[0].id
  cognito_client_id          = var.use_persistent_cognito ? data.terraform_remote_state.cognito[0].outputs.cognito_client_id : aws_cognito_user_pool_client.main[0].id
  cognito_user_pool_arn      = var.use_persistent_cognito ? data.terraform_remote_state.cognito[0].outputs.cognito_user_pool_arn : aws_cognito_user_pool.main[0].arn
  cognito_user_pool_endpoint = var.use_persistent_cognito ? data.terraform_remote_state.cognito[0].outputs.cognito_user_pool_endpoint : aws_cognito_user_pool.main[0].endpoint
  cognito_domain             = var.use_persistent_cognito ? data.terraform_remote_state.cognito[0].outputs.cognito_domain : aws_cognito_user_pool_domain.main[0].domain
}

output "cognito_user_pool_id" {
  description = "Cognito User Pool ID"
  value       = local.cognito_user_pool_id
}

output "cognito_user_pool_arn" {
  description = "Cognito User Pool ARN"
  value       = local.cognito_user_pool_arn
}

output "cognito_client_id" {
  description = "Cognito User Pool Client ID"
  value       = local.cognito_client_id
}

output "cognito_user_pool_endpoint" {
  description = "Cognito User Pool Endpoint"
  value       = local.cognito_user_pool_endpoint
}

output "cognito_domain" {
  description = "Cognito Hosted UI Domain"
  value       = local.cognito_domain
}

output "COGNITO_USER_POOL_ID" {
  description = "Cognito User Pool ID (for Lambda environment)"
  value       = local.cognito_user_pool_id
}

output "COGNITO_CLIENT_ID" {
  description = "Cognito Client ID (for Lambda environment)"
  value       = local.cognito_client_id
}