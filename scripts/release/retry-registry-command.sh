#!/usr/bin/env bash

set -euo pipefail

attempts="${BRAID_REGISTRY_ATTEMPTS:-30}"
delay_seconds="${BRAID_REGISTRY_DELAY_SECONDS:-5}"

if [[ ! "$attempts" =~ ^[1-9][0-9]*$ ]]; then
  echo 'BRAID_REGISTRY_ATTEMPTS must be a positive integer' >&2
  exit 64
fi
if [[ ! "$delay_seconds" =~ ^[0-9]+$ ]]; then
  echo 'BRAID_REGISTRY_DELAY_SECONDS must be a non-negative integer' >&2
  exit 64
fi
if (( $# == 0 )); then
  echo 'A registry command is required' >&2
  exit 64
fi

attempt=1
while (( attempt <= attempts )); do
  if "$@"; then
    exit 0
  fi
  if (( attempt == attempts )); then
    echo "Registry command failed after $attempts attempts" >&2
    exit 1
  fi
  echo "Waiting for registry propagation ($attempt/$attempts)" >&2
  sleep "$delay_seconds"
  ((attempt += 1))
done
