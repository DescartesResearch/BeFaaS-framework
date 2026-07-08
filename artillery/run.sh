#!/bin/sh

set -xeuo pipefail

# Pre-register users in Redis (if REDIS_ENDPOINT is set and auth mode requires Redis user storage)
# - 'none': users stored in Redis with plain passwords
# - 'service-integrated-manual': users stored in Redis with bcrypt hashed passwords
# - 'service-integrated': uses Cognito, NO Redis preregistration needed
if [ -n "${REDIS_ENDPOINT:-}" ] && { [ "${AUTH_MODE:-}" = "service-integrated-manual" ] || [ "${AUTH_MODE:-}" = "none" ]; }; then
  echo "Running Redis user preregistration (auth mode: ${AUTH_MODE})..."
  node /workload/preregister-redis.js
else
  echo "Skipping Redis preregistration (auth mode: ${AUTH_MODE:-not set})"
fi

artillery run -v "$(cat ./variables.json || echo -n "{}")" ./workload.yml
