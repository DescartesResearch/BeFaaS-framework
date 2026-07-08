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

locals {
  project_name = var.project_name

  forwarded_headers = ["Authorization", "Content-Type", "Accept", "Origin", "Referer", "X-Requested-With"]
}

resource "aws_cloudfront_distribution" "proxy" {
  enabled             = true
  is_ipv6_enabled     = true
  wait_for_deployment = false
  comment             = "${local.project_name} CloudFront Proxy (passthrough)"
  price_class         = "PriceClass_100"

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
}
