data "terraform_remote_state" "ep" {
  backend = "local"

  config = {
    path = "${path.module}/endpoint/terraform.tfstate"
  }
}

resource "aws_apigatewayv2_integration" "lambda" {
  for_each         = local.fns
  api_id           = data.terraform_remote_state.ep.outputs.aws_apigatewayv2_api.id
  integration_type = "AWS_PROXY"

  integration_uri        = aws_lambda_function.fn[each.key].invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "root" {
  for_each  = local.fns
  api_id    = data.terraform_remote_state.ep.outputs.aws_apigatewayv2_api.id
  route_key = "ANY /${each.key}"
  target    = "integrations/${aws_apigatewayv2_integration.lambda[each.key].id}"
}

resource "aws_apigatewayv2_route" "proxy" {
  for_each  = local.fns
  api_id    = data.terraform_remote_state.ep.outputs.aws_apigatewayv2_api.id
  route_key = "ANY /${each.key}/{proxy+}"
  target    = "integrations/${aws_apigatewayv2_integration.lambda[each.key].id}"
}
