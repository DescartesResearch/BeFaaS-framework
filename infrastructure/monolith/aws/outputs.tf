output "cluster_id" {
  description = "ECS Cluster ID"
  value       = aws_ecs_cluster.monolith.id
}

output "cluster_name" {
  description = "ECS Cluster name"
  value       = aws_ecs_cluster.monolith.name
}

output "cluster_arn" {
  description = "ECS Cluster ARN"
  value       = aws_ecs_cluster.monolith.arn
}

output "alb_dns_name" {
  description = "DNS name of the Application Load Balancer"
  value       = aws_lb.monolith.dns_name
}

output "alb_url" {
  description = "URL to access the monolith service"
  value       = "http://${aws_lb.monolith.dns_name}"
}

output "health_url" {
  description = "Health check endpoint URL"
  value       = "http://${aws_lb.monolith.dns_name}/health"
}

output "ecr_repository_url" {
  description = "ECR repository URL for the monolith image"
  value       = aws_ecr_repository.monolith.repository_url
}

output "service_arn" {
  description = "ARN of the ECS service"
  value       = aws_ecs_service.monolith.id
}

output "task_definition_arn" {
  description = "ARN of the task definition"
  value       = aws_ecs_task_definition.monolith.arn
}

output "log_group_name" {
  description = "CloudWatch log group name"
  value       = aws_cloudwatch_log_group.monolith.name
}

output "cognito_user_pool_id" {
  description = "Cognito User Pool ID (from persistent pool)"
  value       = local.cognito_user_pool_id
}

output "cognito_client_id" {
  description = "Cognito Client ID (from persistent pool)"
  value       = local.cognito_client_id
}

output "alb_arn" {
  description = "ARN of the Application Load Balancer"
  value       = aws_lb.monolith.arn
}

output "alb_arn_suffix" {
  description = "ARN suffix of the Application Load Balancer (for CloudWatch metrics)"
  value       = aws_lb.monolith.arn_suffix
}

output "target_group_arn_suffix" {
  description = "ARN suffix of the Target Group (for CloudWatch metrics)"
  value       = aws_lb_target_group.monolith.arn_suffix
}

output "service_name" {
  description = "Name of the ECS service"
  value       = aws_ecs_service.monolith.name
}

output "scaling_config" {
  description = "Per-service scaling configuration for database import"
  value = {
    monolith = {
      cpu_units    = var.cpu
      memory_mb    = var.memory
      min_capacity = var.min_capacity
      max_capacity = var.max_capacity
      scaling_rules = (
        var.scaling_mode == "request_count" ? {
          request_count = {
            target_value           = var.target_request_count
            scale_in_cooldown_sec  = var.scale_in_cooldown
            scale_out_cooldown_sec = var.scale_out_cooldown
          }
        } : var.scaling_mode == "latency" ? {
          latency = {
            target_value           = var.target_response_time
            scale_in_cooldown_sec  = var.scale_in_cooldown
            scale_out_cooldown_sec = var.scale_out_cooldown
          }
        } : {}
      )
    }
  }
}