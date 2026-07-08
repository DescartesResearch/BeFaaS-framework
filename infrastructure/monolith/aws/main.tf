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
  project_name         = data.terraform_remote_state.exp.outputs.project_name
  subnet_ids           = data.aws_subnets.default.ids
  vpc_id               = data.aws_vpc.default.id
  redis_url            = data.terraform_remote_state.redis.outputs.REDIS_ENDPOINT
  cognito_user_pool_id = data.terraform_remote_state.cognito.outputs.cognito_user_pool_id
  cognito_client_id    = data.terraform_remote_state.cognito.outputs.cognito_client_id
  cognito_pool_arn     = data.terraform_remote_state.cognito.outputs.cognito_user_pool_arn
}


resource "aws_ecr_repository" "monolith" {
  name                 = "${local.project_name}-monolith"
  image_tag_mutability = "MUTABLE"
  force_delete         = true

  image_scanning_configuration {
    scan_on_push = false
  }

  tags = {
    Project      = local.project_name
    Architecture = "monolith"
  }
}

resource "aws_ecr_lifecycle_policy" "monolith" {
  repository = aws_ecr_repository.monolith.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Keep last 5 images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 5
        }
        action = {
          type = "expire"
        }
      }
    ]
  })
}

resource "aws_ecs_cluster" "monolith" {
  name = "${local.project_name}-monolith"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = {
    Project      = local.project_name
    Architecture = "monolith"
  }
}

resource "aws_iam_role" "ecs_task_execution" {
  name = "${local.project_name}-monolith-task-execution"

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
  name = "${local.project_name}-monolith-task"

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
        Resource = local.cognito_pool_arn
      }
    ]
  })
}

resource "aws_security_group" "alb" {
  name        = "${local.project_name}-monolith-alb"
  description = "Security group for Monolith ALB"
  vpc_id      = local.vpc_id

  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name    = "${local.project_name}-monolith-alb"
    Project = local.project_name
  }
}

resource "aws_security_group" "ecs_tasks" {
  name        = "${local.project_name}-monolith-ecs"
  description = "Security group for monolith ECS tasks"
  vpc_id      = local.vpc_id

  # Allow traffic from ALB
  ingress {
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  # Allow all outbound traffic
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name    = "${local.project_name}-monolith-ecs"
    Project = local.project_name
  }
}

resource "aws_lb" "monolith" {
  name               = "${local.project_name}-monolith"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = local.subnet_ids

  enable_deletion_protection = false

  tags = {
    Project      = local.project_name
    Architecture = "monolith"
  }
}

resource "aws_lb_target_group" "monolith" {
  name        = "${local.project_name}-monolith"
  port        = 3000
  protocol    = "HTTP"
  vpc_id      = local.vpc_id
  target_type = "ip"

  health_check {
    enabled             = true
    healthy_threshold   = 2
    unhealthy_threshold = 3
    timeout             = 5
    interval            = 30
    path                = "/health"
    protocol            = "HTTP"
    matcher             = "200"
  }

  deregistration_delay = 5

  tags = {
    Project = local.project_name
    Service = "monolith"
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.monolith.arn
  port              = "80"
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.monolith.arn
  }

  tags = {
    Project = local.project_name
  }
}

resource "aws_cloudwatch_log_group" "monolith" {
  name              = "/aws/ecs/${local.project_name}/monolith"
  retention_in_days = 7

  tags = {
    Project = local.project_name
    Service = "monolith"
  }
}

resource "aws_ecs_task_definition" "monolith" {
  family                   = "${local.project_name}-monolith"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.cpu
  memory                   = var.memory
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([
    {
      name      = "monolith"
      image     = "${aws_ecr_repository.monolith.repository_url}:${var.image_tag}"
      essential = true

      portMappings = [
        {
          containerPort = 3000
          protocol      = "tcp"
        }
      ]

      environment = concat([
        {
          name  = "PORT"
          value = "3000"
        },
        {
          name  = "BEFAAS_FN_NAME"
          value = "monolith"
        },
        {
          name  = "NODE_ENV"
          value = "production"
        },
        {
          name  = "REDIS_ENDPOINT"
          value = local.redis_url
        },
        {
          name  = "AWS_REGION"
          value = var.aws_region
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
          "awslogs-group"         = aws_cloudwatch_log_group.monolith.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "ecs"
        }
      }

      healthCheck = {
        command     = ["CMD-SHELL", "node -e \"require('http').get('http://localhost:3000/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})\""]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 60
      }
    }
  ])

  tags = {
    Project = local.project_name
    Service = "monolith"
  }
}

resource "aws_ecs_service" "monolith" {
  name            = "monolith"
  cluster         = aws_ecs_cluster.monolith.id
  task_definition = aws_ecs_task_definition.monolith.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = local.subnet_ids
    security_groups  = [aws_security_group.ecs_tasks.id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.monolith.arn
    container_name   = "monolith"
    container_port   = 3000
  }

  depends_on = [
    aws_lb_listener.http
  ]

  tags = {
    Project = local.project_name
    Service = "monolith"
  }

  # Ignore changes to desired_count as it's managed by auto-scaling
  lifecycle {
    ignore_changes = [desired_count]
  }
}

resource "aws_appautoscaling_target" "monolith" {
  max_capacity       = var.max_capacity
  min_capacity       = var.min_capacity
  resource_id        = "service/${aws_ecs_cluster.monolith.name}/${aws_ecs_service.monolith.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"

  depends_on = [aws_ecs_service.monolith]
}

resource "aws_appautoscaling_policy" "monolith_cpu" {
  count = var.scaling_mode == "request_count" ? 1 : 0

  name               = "${local.project_name}-monolith-cpu-scaling"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.monolith.resource_id
  scalable_dimension = aws_appautoscaling_target.monolith.scalable_dimension
  service_namespace  = aws_appautoscaling_target.monolith.service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }

    target_value = var.target_cpu_utilization

    scale_out_cooldown = var.scale_out_cooldown
    scale_in_cooldown  = var.scale_in_cooldown
  }
}

resource "aws_appautoscaling_policy" "monolith_requests" {
  count = var.scaling_mode == "request_count" ? 1 : 0

  name               = "${local.project_name}-monolith-request-scaling"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.monolith.resource_id
  scalable_dimension = aws_appautoscaling_target.monolith.scalable_dimension
  service_namespace  = aws_appautoscaling_target.monolith.service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ALBRequestCountPerTarget"
      resource_label         = "${aws_lb.monolith.arn_suffix}/${aws_lb_target_group.monolith.arn_suffix}"
    }

    target_value = var.target_request_count

    scale_out_cooldown = var.scale_out_cooldown
    scale_in_cooldown  = var.scale_in_cooldown
  }
}

resource "aws_appautoscaling_policy" "monolith_latency" {
  count = var.scaling_mode == "latency" ? 1 : 0

  name               = "${local.project_name}-monolith-latency-scaling"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.monolith.resource_id
  scalable_dimension = aws_appautoscaling_target.monolith.scalable_dimension
  service_namespace  = aws_appautoscaling_target.monolith.service_namespace

  target_tracking_scaling_policy_configuration {
    customized_metric_specification {
      metric_name = "TargetResponseTime"
      namespace   = "AWS/ApplicationELB"
      statistic   = "Average"

      dimensions {
        name  = "LoadBalancer"
        value = aws_lb.monolith.arn_suffix
      }
    }

    target_value = var.target_response_time

    scale_out_cooldown = var.scale_out_cooldown
    scale_in_cooldown  = var.scale_in_cooldown
  }
}