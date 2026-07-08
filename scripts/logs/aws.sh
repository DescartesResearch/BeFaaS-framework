#!/bin/bash

set -euo pipefail

export AWS_DEFAULT_REGION=${AWS_REGION:-us-east-1}
echo "Getting AWS logs for deployment: ${BEFAAS_DEPLOYMENT_ID}" | chalk magenta
echo "Using AWS region: ${AWS_DEFAULT_REGION}" | chalk blue

# Get run_id for log group lookup
# Log groups are named: /aws/lambda/{run_id}/{function_name}
run_id="${BEFAAS_RUN_ID:-}"
if [ -z "$run_id" ]; then
    echo "BEFAAS_RUN_ID not set, trying to get from terraform output" | chalk yellow
    cd infrastructure/experiment 2>/dev/null && run_id=$(terraform output -json 2>/dev/null | jq -r '.run_id.value // empty') && cd - > /dev/null || true
fi

if [ -z "$run_id" ]; then
    echo "Warning: Could not determine run_id for log group lookup" | chalk yellow
    echo "Trying legacy prefix /aws/${BEFAAS_DEPLOYMENT_ID}" | chalk yellow
    log_prefix="/aws/${BEFAAS_DEPLOYMENT_ID}"
else
    log_prefix="/aws/lambda/${run_id}"
    echo "Using log prefix: ${log_prefix}" | chalk blue
fi

# Check if log groups exist
log_groups=$(aws logs describe-log-groups --log-group-name-prefix "${log_prefix}" | jq -r '.logGroups[].logGroupName')
if [ -z "$log_groups" ]; then
    echo "Warning: No CloudWatch log groups found with prefix ${log_prefix}" | chalk yellow
    echo "Available log groups:" | chalk yellow
    aws logs describe-log-groups --limit 10 | jq -r '.logGroups[].logGroupName' | head -5 || true
    exit 0
fi

log_group_count=$(echo $log_groups | wc -w | tr -d ' ')
echo "Found log groups: $log_group_count" | chalk green

# Setup timestamp filtering if available (must be defined before use)
timestamp_params=""
if [ ! -z "${EXPERIMENT_START_TIME:-}" ]; then
  start_time_ms="${EXPERIMENT_START_TIME}"
  end_time_ms="${EXPERIMENT_END_TIME:-$(date +%s)000}"  # Default to now if end time not set

  # Validate timestamp format (should be numeric)
  if [[ "$start_time_ms" =~ ^[0-9]+$ ]] && [[ "$end_time_ms" =~ ^[0-9]+$ ]]; then
    timestamp_params="--start-time $start_time_ms --end-time $end_time_ms"

    # Try to format timestamps for display (fallback to raw values if date command fails)
    start_display=$(date -d "@$((start_time_ms/1000))" -Iseconds 2>/dev/null || echo "$start_time_ms")
    end_display=$(date -d "@$((end_time_ms/1000))" -Iseconds 2>/dev/null || echo "$end_time_ms")
    echo "Using timestamp filtering: $start_display to $end_display" | chalk blue

    # Validate time range makes sense
    if [ "$start_time_ms" -gt "$end_time_ms" ]; then
      echo "Warning: Start time is after end time, this may produce no results" | chalk yellow
    fi
  else
    echo "Warning: Invalid timestamp format, collecting ALL logs (this may be expensive)" | chalk yellow
    echo "  EXPERIMENT_START_TIME: $start_time_ms" | chalk yellow
    echo "  EXPERIMENT_END_TIME: $end_time_ms" | chalk yellow
  fi
else
  echo "Warning: No EXPERIMENT_START_TIME set, collecting ALL logs (this may be expensive)" | chalk yellow
fi

# Fetch logs from all found log groups with pagination support
for lg in $log_groups; do
  echo "Getting logs for log group $lg" | chalk magenta

  # Filter log streams by time range if timestamps are available
  if [ ! -z "${EXPERIMENT_START_TIME:-}" ] && [ ! -z "${EXPERIMENT_END_TIME:-}" ]; then
    # Only get streams that have events within our time range
    # A stream is relevant if: lastEventTimestamp >= start_time AND firstEventTimestamp <= end_time
    streams=$(aws logs describe-log-streams --log-group-name $lg --order-by LastEventTime --descending | \
      jq -r --arg start "$EXPERIMENT_START_TIME" --arg end "$EXPERIMENT_END_TIME" \
      '.logStreams[] | select((.lastEventTimestamp // 0) >= ($start | tonumber) and (.firstEventTimestamp // 0) <= ($end | tonumber)) | .logStreamName')
  else
    streams=$(aws logs describe-log-streams --log-group-name $lg | jq -r '.logStreams[].logStreamName')
  fi

  stream_count=$(echo "$streams" | grep -c . || echo "0")
  echo "Found $stream_count relevant log streams" | chalk blue

  for ls in $streams; do
      echo "|--> Get Logs for log stream $ls" | chalk magenta
      newtoken="null"
      end=0
      while [ $end -eq 0 ]
      do
        if [ $newtoken == "null" ]; then
          echo "no token found, start new chain" | chalk green
          if ! aws logs get-log-events --log-group-name $lg --log-stream-name $ls --start-from-head $timestamp_params --limit 10000 | tee >(jq -c '.events[]' >> $logdir/aws.log) >(jq -c '.nextForwardToken' >> $logdir/token.txt) 1>/dev/null; then
            echo "Error: Failed to fetch logs from $lg/$ls, skipping..." | chalk red
            break
          fi
          #Parse next token
          newtoken=$(tail -n 1 $logdir/token.txt | cut -d "\"" -f 2 2>/dev/null || echo "null")
        else
          echo "token already exists, using $newtoken" | chalk red
          token=$newtoken
          if ! aws logs get-log-events --log-group-name $lg --log-stream-name $ls --start-from-head --next-token $token $timestamp_params --limit 10000 | tee >(jq -c '.events[]' >> $logdir/aws.log) >(jq -c '.nextForwardToken' >> $logdir/token.txt) 1>/dev/null; then
            echo "Error: Failed to fetch logs from $lg/$ls with token, skipping..." | chalk red
            break
          fi
          #Parse next token
          newtoken=$(tail -n 1 $logdir/token.txt | cut -d "\"" -f 2 2>/dev/null || echo "$token")
          # if (newtoken == token) => no new next token => end
          if [ $newtoken == $token ]; then
            end=1
            echo "no token update, end chain here." | chalk red
          fi
        fi
      done

      echo "GetLogs complete for log stream $ls" | chalk magenta
      #clear token.txt for next stream
      rm -f $logdir/token.txt
  done
  echo "GetLogs complete for group $lg" | chalk magenta
done