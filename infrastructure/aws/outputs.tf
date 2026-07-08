output "lambda_function_names" {
  description = "Map of function names to their full AWS function names"
  value = {
    for key, fn in aws_lambda_function.fn : key => fn.function_name
  }
}

output "lambda_function_arns" {
  description = "Map of function names to their ARNs"
  value = {
    for key, fn in aws_lambda_function.fn : key => fn.arn
  }
}

output "lambda_memory_size" {
  description = "Memory size configured for Lambda functions (MB)"
  value       = var.memory_size
}

output "api_gateway_id" {
  description = "API Gateway v2 API ID"
  value       = data.terraform_remote_state.ep.outputs.aws_apigatewayv2_api.id
}

output "api_gateway_name" {
  description = "API Gateway v2 API Name"
  value       = data.terraform_remote_state.ep.outputs.aws_apigatewayv2_api.name
}

output "api_gateway_endpoint" {
  description = "API Gateway endpoint URL"
  value       = data.terraform_remote_state.ep.outputs.AWS_LAMBDA_ENDPOINT
}
