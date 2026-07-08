resource "aws_security_group" "alb" {
  name        = "${local.project_name}-microservices-alb"
  description = "Security group for Application Load Balancer"
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
    Name    = "${local.project_name}-microservices-alb"
    Project = local.project_name
  }
}

resource "aws_lb" "microservices" {
  name               = "${local.project_name}-ms"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = local.subnet_ids

  enable_deletion_protection = false

  tags = {
    Project      = local.project_name
    Architecture = "microservices"
  }
}

resource "aws_lb_target_group" "frontend" {
  name        = "${local.project_name}-ms"
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
    Service = "frontend-service"
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.microservices.arn
  port              = "80"
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.frontend.arn
  }

  tags = {
    Project = local.project_name
  }
}