resource "aws_service_discovery_private_dns_namespace" "microservices" {
  name        = "${local.project_name}.local"
  description = "Private DNS namespace for microservices"
  vpc         = local.vpc_id

  tags = {
    Project      = local.project_name
    Architecture = "microservices"
  }
}

resource "aws_service_discovery_service" "service" {
  for_each = local.services

  name = each.key

  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.microservices.id

    dns_records {
      ttl  = 10
      type = "A"
    }

    routing_policy = "MULTIVALUE"
  }

  health_check_custom_config {
    failure_threshold = 1
  }

  force_destroy = true

  tags = {
    Project = local.project_name
    Service = each.key
  }
}