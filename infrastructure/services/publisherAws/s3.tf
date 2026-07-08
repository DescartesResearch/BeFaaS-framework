resource "aws_s3_bucket" "pub_bucket" {
  bucket        = "${local.project_name}-publisher"
  force_destroy = true
}

resource "aws_s3_bucket_acl" "pub_bucket_acl" {
  bucket = aws_s3_bucket.pub_bucket.id
  acl    = "private"
}

resource "aws_s3_object" "lambda_publisher" {
  bucket = aws_s3_bucket.pub_bucket.id
  key    = "${local.build_id}/publisherAws.zip"
  source = "${path.module}/publisher/_build/publisherAws.zip"
}