terraform {
  required_version = ">= 1.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

data "terraform_remote_state" "exp" {
  backend = "local"

  config = {
    path = "${path.module}/../experiment/terraform.tfstate"
  }
}

locals {
  project_name  = data.terraform_remote_state.exp.outputs.project_name
  build_id      = data.terraform_remote_state.exp.outputs.build_id
  deployment_id = data.terraform_remote_state.exp.outputs.deployment_id
  run_id        = data.terraform_remote_state.exp.outputs.run_id
  fns           = data.terraform_remote_state.exp.outputs.aws_fns
  fns_async     = data.terraform_remote_state.exp.outputs.aws_fns_async

  lambda_fn_env_vars = {
    for key, _ in data.terraform_remote_state.exp.outputs.aws_fns :
    "LAMBDA_FN_${upper(key)}" => "${local.project_name}-${key}"
  }
}

resource "aws_iam_role" "lambda_exec" {
  name = local.project_name

  assume_role_policy = <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Action": "sts:AssumeRole",
      "Principal": {
        "Service": "lambda.amazonaws.com"
      },
      "Effect": "Allow",
      "Sid": ""
    }
  ]
}
EOF
}

resource "aws_iam_policy" "policy" {
  name = local.project_name

  policy = <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Action": [
        "s3:List*"
      ],
      "Effect": "Allow",
      "Resource": "arn:aws:s3:::*"
    },
    {
      "Action": [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ],
      "Resource": "arn:aws:logs:*:*:*",
      "Effect": "Allow"
    },
    {
      "Action": [
        "cognito-idp:AdminInitiateAuth",
        "cognito-idp:AdminCreateUser",
        "cognito-idp:AdminSetUserPassword",
        "cognito-idp:AdminConfirmSignUp",
        "cognito-idp:SignUp",
        "cognito-idp:InitiateAuth"
      ],
      "Effect": "Allow",
      "Resource": "*"
    },
    {
      "Sid": "LambdaDirectInvoke",
      "Action": [
        "lambda:InvokeFunction"
      ],
      "Effect": "Allow",
      "Resource": "arn:aws:lambda:*:*:function:${local.project_name}-*"
    }
  ]
}
EOF
}

resource "aws_iam_role_policy_attachment" "lambda_exec" {
  role       = aws_iam_role.lambda_exec.name
  policy_arn = aws_iam_policy.policy.arn
}

resource "aws_cloudwatch_log_group" "lambda_logs" {
  for_each          = local.fns
  name              = "/aws/lambda/${local.run_id}/${each.key}"
  retention_in_days = 7
}

resource "aws_lambda_function" "fn" {
  for_each      = local.fns
  function_name = "${local.project_name}-${each.key}"

  s3_bucket        = aws_s3_object.source[each.key].bucket
  s3_key           = aws_s3_object.source[each.key].key
  source_code_hash = try(filebase64sha256(each.value), null)

  handler     = var.handler
  runtime     = "nodejs18.x"
  timeout     = var.timeout
  memory_size = var.memory_size

  role = aws_iam_role.lambda_exec.arn

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.lambda_logs[each.key].name
  }

  environment {
    variables = merge(
      {
        BEFAAS_DEPLOYMENT_ID     = local.deployment_id
        BEFAAS_FN_NAME           = each.key
        COGNITO_USER_POOL_ID     = local.cognito_user_pool_id
        COGNITO_CLIENT_ID        = local.cognito_client_id
        BEFAAS_AUTH_GRANULARITY  = var.auth_granularity
      },
      local.lambda_fn_env_vars,
      var.fn_env,
      var.edge_public_key != "" ? { EDGE_PUBLIC_KEY = var.edge_public_key } : {},
      var.jwt_private_key != "" ? { JWT_PRIVATE_KEY = var.jwt_private_key } : {},
      var.jwt_public_key != "" ? { JWT_PUBLIC_KEY = var.jwt_public_key } : {}
    )
  }

  depends_on = [aws_cloudwatch_log_group.lambda_logs]
}

resource "aws_lambda_permission" "apigw" {
  for_each      = local.fns
  statement_id  = "AllowExecutionFromAPIGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.fn[each.key].function_name
  principal     = "apigateway.amazonaws.com"

  source_arn = "${data.terraform_remote_state.ep.outputs.aws_apigatewayv2_api.execution_arn}/*/*"
}

resource "aws_sns_topic" "fn_topic" {
  for_each = toset(local.fns_async)
  name     = aws_lambda_function.fn[each.key].function_name
}

resource "aws_lambda_permission" "allow_fn_invocation" {
  for_each      = toset(local.fns_async)
  statement_id  = "AllowExecutionFromSNS"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.fn[each.key].function_name
  principal     = "sns.amazonaws.com"
  source_arn    = aws_sns_topic.fn_topic[each.key].arn

  depends_on = [aws_lambda_function.fn]
}

resource "aws_sns_topic_subscription" "function_subscr" {
  for_each  = toset(local.fns_async)
  topic_arn = aws_sns_topic.fn_topic[each.key].arn
  protocol  = "lambda"
  endpoint  = aws_lambda_function.fn[each.key].arn

  depends_on = [aws_lambda_function.fn]
}
