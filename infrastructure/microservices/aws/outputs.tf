output "cluster_id" {
  description = "ECS Cluster ID"
  value       = aws_ecs_cluster.microservices.id
}

output "cluster_name" {
  description = "ECS Cluster name"
  value       = aws_ecs_cluster.microservices.name
}

output "cluster_arn" {
  description = "ECS Cluster ARN"
  value       = aws_ecs_cluster.microservices.arn
}

output "cloudmap_namespace_id" {
  description = "Cloud Map namespace ID"
  value       = aws_service_discovery_private_dns_namespace.microservices.id
}

output "cloudmap_namespace_name" {
  description = "Cloud Map namespace name"
  value       = aws_service_discovery_private_dns_namespace.microservices.name
}

output "alb_dns_name" {
  description = "DNS name of the Application Load Balancer"
  value       = aws_lb.microservices.dns_name
}

output "alb_url" {
  description = "URL to access the frontend service"
  value       = "http://${aws_lb.microservices.dns_name}"
}

output "health_url" {
  description = "Health check URL for the frontend service"
  value       = "http://${aws_lb.microservices.dns_name}/health"
}

output "ecr_repositories" {
  description = "ECR repository URLs for each service"
  value = {
    for service_name, repo in aws_ecr_repository.service : service_name => repo.repository_url
  }
}

output "service_arns" {
  description = "ARNs of all ECS services"
  value = {
    for service_name, service in aws_ecs_service.service : service_name => service.id
  }
}

output "cloudmap_service_arns" {
  description = "ARNs of all Cloud Map services"
  value = {
    for service_name, service in aws_service_discovery_service.service : service_name => service.arn
  }
}

output "cognito_user_pool_id" {
  description = "Cognito User Pool ID"
  value       = local.cognito_user_pool_id
}

output "cognito_client_id" {
  description = "Cognito User Pool Client ID"
  value       = local.cognito_client_id
}

output "alb_arn" {
  description = "ARN of the Application Load Balancer"
  value       = aws_lb.microservices.arn
}

output "alb_arn_suffix" {
  description = "ARN suffix of the Application Load Balancer (for CloudWatch metrics)"
  value       = aws_lb.microservices.arn_suffix
}

output "target_group_arn_suffix" {
  description = "ARN suffix of the Target Group (for CloudWatch metrics)"
  value       = aws_lb_target_group.frontend.arn_suffix
}

output "service_names" {
  description = "Names of all ECS services"
  value = {
    for service_name, service in aws_ecs_service.service : service_name => service.name
  }
}

output "scaling_config" {
  description = "Per-service scaling configuration for database import"
  value = {
    for service_name, service in local.services : service_name => {
      cpu_units    = service.cpu
      memory_mb    = service.memory
      min_capacity = service_name == "frontend-service" ? var.min_capacity_frontend : var.min_capacity
      max_capacity = var.max_capacity
      scaling_rules = (
        var.scaling_mode == "request_count" ? merge(
          {
            cpu = {
              target_value           = var.target_cpu_utilization
              scale_in_cooldown_sec  = var.scale_in_cooldown
              scale_out_cooldown_sec = var.scale_out_cooldown
            }
          },
          service_name == "frontend-service" ? {
            request_count = {
              target_value           = var.target_request_count
              scale_in_cooldown_sec  = var.scale_in_cooldown
              scale_out_cooldown_sec = var.scale_out_cooldown
            }
          } : {}
        ) : var.scaling_mode == "latency" ? (
          service_name == "frontend-service" ? {
            latency = {
              target_value           = var.target_response_time
              scale_in_cooldown_sec  = var.scale_in_cooldown
              scale_out_cooldown_sec = var.scale_out_cooldown
            }
          } : {}
        ) : {}
      )
    }
  }
}