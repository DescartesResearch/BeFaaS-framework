#!/bin/bash

set -euo pipefail

if [ ! -z ${BASH_SOURCE} ]; then
  SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
else
  SCRIPT_DIR=$(dirname "$(readlink -f "$0")")
fi

if [ -z "${1:-}" ]; then
    chalk -t "{yellow Usage: $0 }{yellow.bold <experiment name>}"
    echo "Choose one of:" | chalk yellow
    chalk -t "{yellow >} {yellow.bold $(ls experiments/ | tr '\n' ' ')}"
    echo ""
    exit 1
fi

if [[ -z "${2:-}" ]]; then
	exp_json="experiment.json"
else
	exp_json="$2"
fi

exp_dir="experiments/$1/functions"
artillery_dir="artillery"

if [[ ! -d $exp_dir ]]; then
    echo -e "Invalid experiment name\n" | chalk red
    exit 1
fi

cd infrastructure/experiment
terraform_output=$(terraform output -json)
export BEFAAS_PROJECT_NAME=$(echo "$terraform_output" | jq -r '.project_name.value')
export project_name=$BEFAAS_PROJECT_NAME
export BEFAAS_DEPLOYMENT_ID=$(echo "$terraform_output" | jq -r '.deployment_id.value')
export BEFAAS_RUN_ID=$(echo "$terraform_output" | jq -r '.run_id.value // empty')
cd -

export logdir=logs/$1/$(date +%Y-%m-%d_%H-%M-%S)
mkdir -p $logdir

echo "Project Name: $BEFAAS_PROJECT_NAME" | chalk blue
echo "Deployment ID: $BEFAAS_DEPLOYMENT_ID" | chalk blue
echo "Run ID: ${BEFAAS_RUN_ID:-not set}" | chalk blue
echo "Log directory: $logdir" | chalk blue
echo "AWS_REGION: ${AWS_REGION:-not set}" | chalk blue

providers=$(jq -r '[.program.functions[].provider] | unique | .[]' "experiments/${1}/$exp_json")
echo "Found providers: $providers" | chalk blue

for provider in $providers; do
    echo "Collecting logs for provider: $provider" | chalk cyan
    if [ -f "${SCRIPT_DIR}/logs/${provider}.sh" ]; then
        ${SCRIPT_DIR}/logs/${provider}.sh "experiments/${1}/$exp_json" || echo "Warning: ${provider}.sh failed" | chalk yellow
    else
        echo "Warning: ${SCRIPT_DIR}/logs/${provider}.sh not found" | chalk yellow
    fi
done

# obtain artillery logs
artillery_logs="$artillery_dir/workload-deploy.log"
if [ -f "$artillery_logs" ]; then
	echo "Getting artillery logs from $artillery_logs" | chalk magenta
	cp "$artillery_logs" "$logdir/artillery.log"
fi

# copy deployment id into a separate file
cd infrastructure/experiment
deploy_id=$(terraform output -json | jq -r '.deployment_id.value')
cd - > /dev/null
echo $deploy_id > "$logdir/deployment_id.txt"
