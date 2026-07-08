terraform {
  required_version = ">= 1.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

data "terraform_remote_state" "exp" {
  backend = "local"

  config = {
    path = "${path.module}/../../experiment/terraform.tfstate"
  }
}

resource "aws_apigatewayv2_api" "api" {
  name          = data.terraform_remote_state.exp.outputs.project_name
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.api.id
  name        = "$default"
  auto_deploy = true
}

output "aws_apigatewayv2_api" {
  value = aws_apigatewayv2_api.api
}

data "aws_region" "current" {}

output "AWS_LAMBDA_ENDPOINT" {
  value = "https://${aws_apigatewayv2_api.api.id}.execute-api.${data.aws_region.current.name}.amazonaws.com"
}
