terraform {
  required_version = ">= 1.0"

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

data "terraform_remote_state" "exp" {
  backend = "local"

  config = {
    path = "${path.module}/../../experiment/terraform.tfstate"
  }
}

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

data "terraform_remote_state" "redis" {
  backend = "local"

  config = {
    path = "${path.module}/../../services/redisAws/terraform.tfstate"
  }
}

data "terraform_remote_state" "cognito" {
  backend = "local"

  config = {
    path = "${path.module}/../../services/cognito/terraform.tfstate"
  }
}

locals {
  project_name = data.terraform_remote_state.exp.outputs.project_name
  subnet_ids   = data.aws_subnets.default.ids
  redis_url    = data.terraform_remote_state.redis.outputs.REDIS_ENDPOINT

  # Always use persistent Cognito pool
  cognito_user_pool_id  = data.terraform_remote_state.cognito.outputs.cognito_user_pool_id
  cognito_client_id     = data.terraform_remote_state.cognito.outputs.cognito_client_id
  cognito_user_pool_arn = data.terraform_remote_state.cognito.outputs.cognito_user_pool_arn
}

locals {
  vpc_id = data.aws_vpc.default.id

  services = {
    "frontend-service" = {
      port           = 3000
      container_port = 3000
      cpu            = var.cpu
      memory         = var.memory
      desired_count  = var.desired_count
    }
    "product-service" = {
      port           = 3001
      container_port = 3001
      cpu            = var.cpu
      memory         = var.memory
      desired_count  = var.desired_count
    }
    "cart-service" = {
      port           = 3002
      container_port = 3002
      cpu            = var.cpu
      memory         = var.memory
      desired_count  = var.desired_count
    }
    "order-service" = {
      port           = 3003
      container_port = 3003
      cpu            = var.cpu
      memory         = var.memory
      desired_count  = var.desired_count
    }
    "content-service" = {
      port           = 3004
      container_port = 3004
      cpu            = var.cpu
      memory         = var.memory
      desired_count  = var.desired_count
    }
  }
}

resource "aws_ecs_cluster" "microservices" {
  name = "${local.project_name}-microservices"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = {
    Project      = local.project_name
    Architecture = "microservices"
  }
}

resource "aws_iam_role" "ecs_task_execution" {
  name = "${local.project_name}-microservices-task-execution"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Service = "ecs-tasks.amazonaws.com"
        }
        Action = "sts:AssumeRole"
      }
    ]
  })

  tags = {
    Project = local.project_name
  }
}

resource "aws_iam_role_policy_attachment" "ecs_task_execution_policy" {
  role       = aws_iam_role.ecs_task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role" "ecs_task" {
  name = "${local.project_name}-microservices-task"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Service = "ecs-tasks.amazonaws.com"
        }
        Action = "sts:AssumeRole"
      }
    ]
  })

  tags = {
    Project = local.project_name
  }
}

resource "aws_iam_role_policy" "ecs_task_cloudmap" {
  name = "cloudmap-access"
  role = aws_iam_role.ecs_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "servicediscovery:RegisterInstance",
          "servicediscovery:DeregisterInstance",
          "servicediscovery:DiscoverInstances",
          "servicediscovery:Get*",
          "servicediscovery:List*"
        ]
        Resource = "*"
      }
    ]
  })
}

resource "aws_iam_role_policy" "ecs_task_cognito" {
  name = "cognito-access"
  role = aws_iam_role.ecs_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "cognito-idp:AdminConfirmSignUp",
          "cognito-idp:AdminGetUser",
          "cognito-idp:AdminCreateUser",
          "cognito-idp:AdminSetUserPassword"
        ]
        Resource = local.cognito_user_pool_arn
      }
    ]
  })
}

resource "aws_security_group" "ecs_tasks" {
  name        = "${local.project_name}-microservices-ecs"
  description = "Security group for microservices ECS tasks"
  vpc_id      = local.vpc_id

  # Allow all internal traffic within the security group
  ingress {
    from_port = 0
    to_port   = 65535
    protocol  = "tcp"
    self      = true
  }

  # Allow traffic from ALB
  ingress {
    from_port       = 0
    to_port         = 65535
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name    = "${local.project_name}-microservices-ecs"
    Project = local.project_name
  }
}

resource "aws_cloudwatch_log_group" "microservices" {
  for_each = local.services

  name              = "/aws/ecs/${local.project_name}/${each.key}"
  retention_in_days = 7

  tags = {
    Project = local.project_name
    Service = each.key
  }
}

resource "aws_ecs_task_definition" "service" {
  for_each = local.services

  family                   = "${local.project_name}-${each.key}"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = each.value.cpu
  memory                   = each.value.memory
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([
    {
      name      = each.key
      image     = "${aws_ecr_repository.service[each.key].repository_url}:${var.image_tag}"
      essential = true

      portMappings = [
        {
          containerPort = each.value.container_port
          protocol      = "tcp"
        }
      ]

      environment = concat([
        {
          name  = "SERVICE_NAME"
          value = each.key
        },
        {
          name  = "BEFAAS_FN_NAME"
          value = each.key
        },
        {
          name  = "PORT"
          value = tostring(each.value.container_port)
        },
        {
          name  = "NODE_ENV"
          value = "production"
        },
        {
          name  = "CLOUDMAP_NAMESPACE"
          value = aws_service_discovery_private_dns_namespace.microservices.name
        },
        {
          name  = "AWS_REGION"
          value = var.aws_region
        },
        {
          name  = "REDIS_URL"
          value = local.redis_url
        },
        {
          name  = "COGNITO_USER_POOL_ID"
          value = local.cognito_user_pool_id
        },
        {
          name  = "COGNITO_CLIENT_ID"
          value = local.cognito_client_id
        },
        {
          name  = "BEFAAS_AUTH_GRANULARITY"
          value = var.auth_granularity
        }
      ], var.edge_public_key != "" ? [
        {
          name  = "EDGE_PUBLIC_KEY"
          value = var.edge_public_key
        }
      ] : [],
      var.jwt_private_key != "" ? [
        {
          name  = "JWT_PRIVATE_KEY"
          value = var.jwt_private_key
        }
      ] : [],
      var.jwt_public_key != "" ? [
        {
          name  = "JWT_PUBLIC_KEY"
          value = var.jwt_public_key
        }
      ] : [])

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.microservices[each.key].name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "ecs"
        }
      }

      healthCheck = {
        command     = ["CMD-SHELL", "curl -f http://localhost:${each.value.container_port}/health || exit 1"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 60
      }
    }
  ])

  tags = {
    Project = local.project_name
    Service = each.key
  }
}

resource "aws_ecs_service" "service" {
  for_each = local.services

  name            = each.key
  cluster         = aws_ecs_cluster.microservices.id
  task_definition = aws_ecs_task_definition.service[each.key].arn
  desired_count   = each.value.desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = local.subnet_ids
    security_groups  = [aws_security_group.ecs_tasks.id]
    assign_public_ip = true
  }

  service_registries {
    registry_arn = aws_service_discovery_service.service[each.key].arn
  }

  dynamic "load_balancer" {
    for_each = each.key == "frontend-service" ? [1] : []
    content {
      target_group_arn = aws_lb_target_group.frontend.arn
      container_name   = each.key
      container_port   = each.value.container_port
    }
  }

  depends_on = [
    aws_lb_listener.http,
    aws_service_discovery_service.service
  ]

  tags = {
    Project = local.project_name
    Service = each.key
  }

  lifecycle {
    ignore_changes = [desired_count]
  }
}

resource "aws_appautoscaling_target" "service" {
  for_each = local.services

  max_capacity       = var.max_capacity
  min_capacity       = each.key == "frontend-service" ? var.min_capacity_frontend : var.min_capacity
  resource_id        = "service/${aws_ecs_cluster.microservices.name}/${aws_ecs_service.service[each.key].name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"

  depends_on = [aws_ecs_service.service]
}

resource "aws_appautoscaling_policy" "service_cpu" {
  for_each = var.scaling_mode == "request_count" ? local.services : {}

  name               = "${local.project_name}-${each.key}-cpu-scaling"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.service[each.key].resource_id
  scalable_dimension = aws_appautoscaling_target.service[each.key].scalable_dimension
  service_namespace  = aws_appautoscaling_target.service[each.key].service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }

    target_value = var.target_cpu_utilization

    scale_out_cooldown = var.scale_out_cooldown
    scale_in_cooldown  = var.scale_in_cooldown
  }
}

resource "aws_appautoscaling_policy" "frontend_requests" {
  count = var.scaling_mode == "request_count" ? 1 : 0

  name               = "${local.project_name}-frontend-service-request-scaling"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.service["frontend-service"].resource_id
  scalable_dimension = aws_appautoscaling_target.service["frontend-service"].scalable_dimension
  service_namespace  = aws_appautoscaling_target.service["frontend-service"].service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ALBRequestCountPerTarget"
      resource_label         = "${aws_lb.microservices.arn_suffix}/${aws_lb_target_group.frontend.arn_suffix}"
    }

    target_value = var.target_request_count

    scale_out_cooldown = var.scale_out_cooldown
    scale_in_cooldown  = var.scale_in_cooldown
  }
}

resource "aws_appautoscaling_policy" "frontend_latency" {
  count = var.scaling_mode == "latency" ? 1 : 0

  name               = "${local.project_name}-frontend-service-latency-scaling"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.service["frontend-service"].resource_id
  scalable_dimension = aws_appautoscaling_target.service["frontend-service"].scalable_dimension
  service_namespace  = aws_appautoscaling_target.service["frontend-service"].service_namespace

  target_tracking_scaling_policy_configuration {
    customized_metric_specification {
      metric_name = "TargetResponseTime"
      namespace   = "AWS/ApplicationELB"
      statistic   = "Average"

      dimensions {
        name  = "LoadBalancer"
        value = aws_lb.microservices.arn_suffix
      }
    }

    target_value = var.target_response_time

    scale_out_cooldown = var.scale_out_cooldown
    scale_in_cooldown  = var.scale_in_cooldown
  }
}