resource "aws_ecr_repository" "service" {
  for_each = local.services

  name                 = "${local.project_name}-${each.key}"
  image_tag_mutability = "MUTABLE"
  force_delete         = true

  image_scanning_configuration {
    scan_on_push = false
  }

  tags = {
    Project = local.project_name
    Service = each.key
  }
}

resource "aws_ecr_lifecycle_policy" "service" {
  for_each   = local.services
  repository = aws_ecr_repository.service[each.key].name

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