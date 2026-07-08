#!/bin/bash

set -euo pipefail


export TF_VAR_fn_env='{}'
export TF_VAR_TINYFAAS_ADDRESS=${TINYFAAS_ADDRESS:-}
export TF_VAR_TINYFAAS_MPORT=${TINYFAAS_MPORT:-}
export TF_VAR_TINYFAAS_FPORT=${TINYFAAS_FPORT:-}
export TF_VAR_OPENFAAS_GATEWAY=${OPENFAAS_GATEWAY:-}
export TF_VAR_OPENFAAS_USER=admin
export TF_VAR_OPENFAAS_TOKEN=${OPENFAAS_TOKEN:-}
export TF_VAR_DOCKERHUB_USER=`docker info 2>/dev/null | sed '/Username:/!d;s/.* //'`
export TF_VAR_OPENWHISK_EXTERNAL=${OPENWHISK_EXTERNAL:-}

providers=`ls infrastructure/`
providers=( "${providers[@]/services}" )
providers=( "${providers[@]/experiment}" )

services=`ls infrastructure/services/`
services=( "${services[@]/vpc}" )
services=( "${services[@]/edge-auth}" )

for provider in $providers; do
  echo "Destroying $provider" | chalk green
  cd infrastructure/${provider}
  if test -f terraform.tfstate && [ "$(jq -r '.resources | length' terraform.tfstate)" != "0" ]; then
    terraform destroy -auto-approve
  fi
  cd -
done

for service in $services; do
  echo "Destroying service $service" | chalk green
  cd infrastructure/services/${service}
  if test -f terraform.tfstate && [ "$(jq -r '.resources | length' terraform.tfstate)" != "0" ]; then
    terraform destroy -auto-approve
  fi
  cd -
done

for provider in $providers; do
  echo "Destroying endpoints for $provider" | chalk green
  cd infrastructure/${provider}/endpoint
  if test -f terraform.tfstate && [ "$(jq -r '.resources | length' terraform.tfstate)" != "0" ]; then
    terraform destroy -auto-approve
  fi
  cd -
done

echo "Cleaning up orphaned ENIs in VPC before destroying" | chalk green
VPC_ID=$(cd infrastructure/services/vpc && jq -r '.resources[] | select(.type == "aws_vpc") | .instances[0].attributes.id // empty' terraform.tfstate 2>/dev/null || true)
if [ -n "$VPC_ID" ]; then
  ENI_IDS=$(aws ec2 describe-network-interfaces \
    --filters "Name=vpc-id,Values=$VPC_ID" \
    --query 'NetworkInterfaces[*].NetworkInterfaceId' \
    --output text)

  for eni_id in $ENI_IDS; do
    echo "Cleaning up ENI $eni_id" | chalk yellow

    ATTACHMENT_ID=$(aws ec2 describe-network-interfaces \
      --network-interface-ids "$eni_id" \
      --query 'NetworkInterfaces[0].Attachment.AttachmentId' \
      --output text 2>/dev/null || true)

    if [ -n "$ATTACHMENT_ID" ] && [ "$ATTACHMENT_ID" != "None" ]; then
      echo "  Detaching ENI $eni_id (attachment $ATTACHMENT_ID)" | chalk yellow
      aws ec2 detach-network-interface --attachment-id "$ATTACHMENT_ID" --force 2>/dev/null || true
      aws ec2 wait network-interface-available --network-interface-ids "$eni_id" 2>/dev/null || sleep 5
    fi

    echo "  Deleting ENI $eni_id" | chalk yellow
    aws ec2 delete-network-interface --network-interface-id "$eni_id" 2>/dev/null || true
  done
fi

echo "Destroying vpc" | chalk green
cd infrastructure/services/vpc
if test -f terraform.tfstate && [ "$(jq -r '.resources | length' terraform.tfstate)" != "0" ]; then
  terraform destroy -auto-approve
fi
cd -

echo "Destroying experiment" | chalk green
cd infrastructure/experiment
if test -f terraform.tfstate && [ "$(jq -r '.resources | length' terraform.tfstate)" != "0" ]; then
  terraform destroy -var "experiment=test" -auto-approve # just needs some experiment that exists
fi
cd -

echo "Destroying CloudFront/Lambda@Edge (edge-auth) - this may take 15-45 minutes" | chalk green
cd infrastructure/services/edge-auth
if test -f terraform.tfstate && [ "$(jq -r '.resources | length' terraform.tfstate)" != "0" ]; then
  terraform destroy -auto-approve
fi
cd -
