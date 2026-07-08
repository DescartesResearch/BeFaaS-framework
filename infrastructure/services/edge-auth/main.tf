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

provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
}

locals {
  project_name = var.project_name

  protected_paths = var.protected_paths

  forwarded_headers = ["Authorization", "Content-Type", "Accept", "Origin", "Referer", "X-Requested-With", "X-BeFaaS-Edge-Processed", "X-BeFaaS-Edge-Subject"]
}

resource "aws_iam_role" "edge_lambda" {
  provider = aws.us_east_1
  name     = "${local.project_name}-edge-auth-lambda"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Service = [
            "lambda.amazonaws.com",
            "edgelambda.amazonaws.com"
          ]
        }
        Action = "sts:AssumeRole"
      }
    ]
  })

  tags = {
    Project = local.project_name
  }
}

resource "aws_iam_role_policy_attachment" "edge_lambda_basic" {
  provider   = aws.us_east_1
  role       = aws_iam_role.edge_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_lambda_function" "edge_auth" {
  provider = aws.us_east_1

  function_name = "${local.project_name}-edge-auth"
  filename      = var.edge_lambda_zip_path
  handler       = "index.handler"
  runtime       = "nodejs20.x"
  role          = aws_iam_role.edge_lambda.arn
  timeout       = 5 # Lambda@Edge max for viewer-request
  memory_size   = 128
  publish       = true

  source_code_hash = filebase64sha256(var.edge_lambda_zip_path)

  tags = {
    Project = local.project_name
  }
}

resource "aws_cloudfront_distribution" "api" {
  enabled             = true
  is_ipv6_enabled     = true
  wait_for_deployment = false
  comment             = "${local.project_name} Edge Auth Distribution${var.selective_edge_routing ? " (selective)" : ""}"
  price_class         = "PriceClass_100"

  # Origin configuration (API Gateway or ALB)
  origin {
    domain_name = var.origin_domain
    origin_id   = "origin"

    custom_origin_config {
      http_port              = var.origin_http_port
      https_port             = var.origin_https_port
      origin_protocol_policy = var.origin_protocol_policy
      origin_ssl_protocols   = ["TLSv1.2"]
    }

    custom_header {
      name  = "X-CloudFront-Secret"
      value = var.cloudfront_secret
    }
  }

  # Ordered cache behaviors for protected paths (selective mode only)
  # When selective_edge_routing is true, only these paths invoke Lambda@Edge.
  # CloudFront evaluates ordered_cache_behavior in order before default_cache_behavior.
  dynamic "ordered_cache_behavior" {
    for_each = var.selective_edge_routing ? local.protected_paths : []

    content {
      path_pattern     = "${ordered_cache_behavior.value}*"
      allowed_methods  = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
      cached_methods   = ["GET", "HEAD", "OPTIONS"]
      target_origin_id = "origin"

      forwarded_values {
        query_string = true
        headers      = local.forwarded_headers

        cookies {
          forward = "all"
        }
      }

      viewer_protocol_policy = "https-only"
      min_ttl                = 0
      default_ttl            = 0
      max_ttl                = 0
      compress               = true

      lambda_function_association {
        event_type   = "viewer-request"
        lambda_arn   = aws_lambda_function.edge_auth.qualified_arn
        include_body = true
      }
    }
  }

  # Default cache behavior
  # In selective mode: NO Lambda@Edge (public paths pass through directly)
  # In standard mode: ALL requests go through Lambda@Edge
  default_cache_behavior {
    allowed_methods  = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods   = ["GET", "HEAD", "OPTIONS"]
    target_origin_id = "origin"

    forwarded_values {
      query_string = true
      headers      = local.forwarded_headers

      cookies {
        forward = "all"
      }
    }

    viewer_protocol_policy = "https-only"
    min_ttl                = 0
    default_ttl            = 0
    max_ttl                = 0
    compress               = true

    dynamic "lambda_function_association" {
      for_each = var.selective_edge_routing ? [] : [1]

      content {
        event_type   = "viewer-request"
        lambda_arn   = aws_lambda_function.edge_auth.qualified_arn
        include_body = true
      }
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  tags = {
    Project = local.project_name
  }

  depends_on = [aws_lambda_function.edge_auth]
}

resource "aws_ssm_parameter" "edge_public_key" {
  name  = "/${local.project_name}/edge-auth/public-key"
  type  = "String"
  value = var.ed25519_public_key

  tags = {
    Project = local.project_name
  }
}

resource "aws_ssm_parameter" "edge_private_key" {
  provider = aws.us_east_1
  name     = "/${local.project_name}/edge-auth/private-key"
  type     = "SecureString"
  value    = var.ed25519_private_key

  tags = {
    Project = local.project_name
  }
}