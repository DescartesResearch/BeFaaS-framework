output "cloudfront_domain" {
  description = "CloudFront distribution domain name"
  value       = aws_cloudfront_distribution.api.domain_name
}

output "cloudfront_distribution_id" {
  description = "CloudFront distribution ID"
  value       = aws_cloudfront_distribution.api.id
}

output "cloudfront_url" {
  description = "Full CloudFront URL (HTTPS)"
  value       = "https://${aws_cloudfront_distribution.api.domain_name}"
}

output "edge_lambda_arn" {
  description = "Lambda@Edge function ARN (qualified)"
  value       = aws_lambda_function.edge_auth.qualified_arn
}

output "edge_lambda_version" {
  description = "Lambda@Edge function version"
  value       = aws_lambda_function.edge_auth.version
}

output "EDGE_PUBLIC_KEY" {
  description = "Ed25519 public key for internal token verification"
  value       = var.ed25519_public_key
}

output "ssm_public_key_name" {
  description = "SSM parameter name for the public key"
  value       = aws_ssm_parameter.edge_public_key.name
}

output "project_name" {
  description = "Project name used for resource naming (needed for edge-auth reuse)"
  value       = var.project_name
}

output "selective_edge_routing" {
  description = "Whether selective edge routing is enabled (only protected paths use Lambda@Edge)"
  value       = var.selective_edge_routing
}