terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

variable "aws_region" {
  description = "AWS region"
  default     = "us-east-1"
}

variable "pool_name" {
  description = "Name for the Cognito User Pool"
  default     = "befaas-persistent-pool"
}

resource "aws_cognito_user_pool" "main" {
  name = var.pool_name

  password_policy {
    minimum_length                   = 8
    require_lowercase                = true
    require_uppercase                = true
    require_numbers                  = true
    require_symbols                  = false
    temporary_password_validity_days = 7
  }

  lifecycle {
    prevent_destroy = false
  }

  tags = {
    Name    = var.pool_name
    Purpose = "BeFaaS persistent user pool"
  }
}

resource "aws_cognito_user_pool_client" "main" {
  name         = "${var.pool_name}-client"
  user_pool_id = aws_cognito_user_pool.main.id

  access_token_validity  = 60 # minutes
  id_token_validity      = 60 # minutes
  refresh_token_validity = 30 # days

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

  generate_secret = false

  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code", "implicit"]
  allowed_oauth_scopes                 = ["email", "openid", "profile"]

  callback_urls = ["http://localhost:3000/callback"]
  logout_urls   = ["http://localhost:3000/logout"]

  enable_token_revocation       = true
  prevent_user_existence_errors = "ENABLED"
}

resource "aws_cognito_user_pool_domain" "main" {
  domain       = var.pool_name
  user_pool_id = aws_cognito_user_pool.main.id
}

output "cognito_user_pool_id" {
  description = "Cognito User Pool ID"
  value       = aws_cognito_user_pool.main.id
}

output "cognito_user_pool_arn" {
  description = "Cognito User Pool ARN"
  value       = aws_cognito_user_pool.main.arn
}

output "cognito_client_id" {
  description = "Cognito User Pool Client ID"
  value       = aws_cognito_user_pool_client.main.id
}

output "cognito_user_pool_endpoint" {
  description = "Cognito User Pool Endpoint"
  value       = aws_cognito_user_pool.main.endpoint
}

output "cognito_domain" {
  description = "Cognito Hosted UI Domain"
  value       = aws_cognito_user_pool_domain.main.domain
}

output "COGNITO_USER_POOL_ID" {
  description = "Cognito User Pool ID (for Lambda environment)"
  value       = aws_cognito_user_pool.main.id
}

output "COGNITO_CLIENT_ID" {
  description = "Cognito Client ID (for Lambda environment)"
  value       = aws_cognito_user_pool_client.main.id
}