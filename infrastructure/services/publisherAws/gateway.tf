resource "aws_apigatewayv2_integration" "publisher" {
  api_id           = data.terraform_remote_state.endpoint.outputs.aws_apigatewayv2_api.id
  integration_type = "AWS_PROXY"

  integration_uri        = aws_lambda_function.publisherAWS.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "publisher_root" {
  api_id    = data.terraform_remote_state.endpoint.outputs.aws_apigatewayv2_api.id
  route_key = "ANY /publisher"
  target    = "integrations/${aws_apigatewayv2_integration.publisher.id}"
}

resource "aws_apigatewayv2_route" "publisher_proxy" {
  api_id    = data.terraform_remote_state.endpoint.outputs.aws_apigatewayv2_api.id
  route_key = "ANY /publisher/{proxy+}"
  target    = "integrations/${aws_apigatewayv2_integration.publisher.id}"
}
