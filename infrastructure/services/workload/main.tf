variable "validation_mode" {
  description = "Enable validation mode to log HTTP response details"
  type        = string
  default     = "false"
}

variable "auth_mode" {
  description = "Authentication mode for user preregistration"
  type        = string
  default     = "none"
}

variable "architecture" {
  description = "Architecture type: faas, microservices, or monolith"
  type        = string
  default     = "faas"
}

variable "algorithm" {
  description = "Auth algorithm variant for service-integrated-manual (argon2id-eddsa or bcrypt-hs256)"
  type        = string
  default     = "argon2id-eddsa"
}

data "terraform_remote_state" "exp" {
  backend = "local"

  config = {
    path = "${path.module}/../../experiment/terraform.tfstate"
  }
}

data "terraform_remote_state" "vpc" {
  backend = "local"
  defaults = {
    default_subnet  = ""
    security_groups = []
    ssh_key_name    = ""
    ssh_private_key = ""
  }

  config = {
    path = "${path.module}/../vpc/terraform.tfstate"
  }
}

data "terraform_remote_state" "redis" {
  backend = "local"
  defaults = {
    REDIS_ENDPOINT = ""
  }

  config = {
    path = "${path.module}/../redisAws/terraform.tfstate"
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

locals {
  project_name  = data.terraform_remote_state.exp.outputs.project_name
  deployment_id = data.terraform_remote_state.exp.outputs.deployment_id

  use_default_vpc = var.architecture != "faas"

  redis_endpoint = try(data.terraform_remote_state.redis.outputs.REDIS_ENDPOINT, "")
}

resource "aws_security_group" "workload_default_vpc" {
  count       = local.use_default_vpc ? 1 : 0
  name        = "${local.project_name}-workload-sg"
  description = "Security group for workload EC2 in default VPC"
  vpc_id      = data.aws_vpc.default.id

  # Allow all outbound traffic (needed to reach ALB and internet)
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # Allow SSH inbound (for Terraform provisioner)
  ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${local.project_name}-workload-sg"
  }
}

# SSH key for default VPC workload (used for microservices/monolith)
resource "tls_private_key" "workload" {
  count     = local.use_default_vpc ? 1 : 0
  algorithm = "RSA"
  rsa_bits  = 4096
}

resource "aws_key_pair" "workload" {
  count      = local.use_default_vpc ? 1 : 0
  key_name   = "${local.project_name}-workload-key"
  public_key = tls_private_key.workload[0].public_key_openssh
}

data "aws_ami" "ubuntu_lts" {
  most_recent = true
  name_regex  = "^ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-\\d+$"
  owners      = ["099720109477"]
}

resource "aws_instance" "workload" {
  ami                                  = data.aws_ami.ubuntu_lts.id
  instance_type                        = "t3a.medium"
  associate_public_ip_address          = true
  instance_initiated_shutdown_behavior = "terminate"

  # For microservices/monolith: use default VPC (same VPC as the services)
  # For FaaS: use custom VPC from vpc terraform
  subnet_id              = local.use_default_vpc ? tolist(data.aws_subnets.default.ids)[0] : data.terraform_remote_state.vpc.outputs.default_subnet
  key_name               = local.use_default_vpc ? aws_key_pair.workload[0].key_name : data.terraform_remote_state.vpc.outputs.ssh_key_name
  vpc_security_group_ids = local.use_default_vpc ? [aws_security_group.workload_default_vpc[0].id] : data.terraform_remote_state.vpc.outputs.security_groups

  tags = {
    Name = "${local.project_name}-workload"
  }

  provisioner "file" {
    connection {
      type        = "ssh"
      user        = "ubuntu"
      host        = self.public_ip
      private_key = local.use_default_vpc ? tls_private_key.workload[0].private_key_pem : data.terraform_remote_state.vpc.outputs.ssh_private_key
      agent       = false
    }
    source      = "${path.module}/../../../artillery/image.tar.gz"
    destination = "/tmp/image.tar.gz"
  }

  provisioner "remote-exec" {
    connection {
      type        = "ssh"
      user        = "ubuntu"
      host        = self.public_ip
      private_key = local.use_default_vpc ? tls_private_key.workload[0].private_key_pem : data.terraform_remote_state.vpc.outputs.ssh_private_key
      agent       = false
    }

    inline = [
      "sudo apt-get update",
      "for i in 1 2 3 4 5; do sudo apt-get install -y docker.io && break || sleep 10; done",
      "sudo systemctl start docker",
      "sudo systemctl enable docker",
      "sudo docker load -i /tmp/image.tar.gz",
      "sudo docker run --rm -e BEFAAS_DEPLOYMENT_ID=${local.deployment_id} -e ARTILLERY_VALIDATION_MODE=${var.validation_mode} -e REDIS_ENDPOINT=${local.redis_endpoint} -e AUTH_MODE=${var.auth_mode} -e ALGORITHM=${var.algorithm} befaas/artillery"
    ]
  }
}