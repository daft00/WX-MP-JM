#!/usr/bin/env bash
set -Eeuo pipefail
# Use only a trusted HTTPS receiver accepting the monitor JSON schema.
# Configure its URL/auth in this root-owned mode-600 curl config, never in Git.
config=/etc/growth-diary/alert-curl.conf
[[ -f $config && ! -L $config && $(stat -c '%u:%a' "$config") == 0:600 ]]
exec curl --config "$config" --proto '=https' --connect-timeout 5 --max-time 15 \
  --fail --silent --output /dev/null --header 'Content-Type: application/json' --data-binary @-
