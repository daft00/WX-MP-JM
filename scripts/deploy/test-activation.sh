#!/usr/bin/env bash
set -Eeuo pipefail
# No system calls: mock service, schema and symlink operations, exercise failure recovery.
source "$(dirname -- "${BASH_SOURCE[0]}")/../deploy-backend.sh"
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
base=$(cd "$work" && pwd)
mkdir -p "$base/releases/old" "$base/releases/new"
touch "$base/releases/old/BUILD_INFO" "$base/releases/new/BUILD_INFO"
current_target="$base/releases/old"
previous_target=
failed_health=false
incompatible_old=false
stopped=false
readlink() { printf '%s\n' "$current_target"; }
link_to() { if [[ $2 == current ]]; then current_target=$1; else previous_target=$1; fi; }
systemctl() { if [[ $1 == stop || $1 == disable ]]; then stopped=true; elif [[ $1 == restart ]]; then stopped=false; fi; }
check_release() { [[ $incompatible_old == false || $2 != "$base/releases/old" ]]; }
healthy() { [[ $failed_health == false || $current_target == "$base/releases/old" ]]; }

activate "$base/releases/new"
[[ $current_target == "$base/releases/new" && $previous_target == "$base/releases/old" && $stopped == false ]]

current_target="$base/releases/old"
failed_health=true
if activate "$base/releases/new"; then echo 'Expected failed activation' >&2; exit 1; fi
[[ $current_target == "$base/releases/old" && $stopped == false ]]

incompatible_old=true
if activate "$base/releases/new"; then echo 'Expected failed rollback' >&2; exit 1; fi
[[ $stopped == true ]]

current_target=
if activate "$base/releases/new"; then echo 'Expected first activation failure' >&2; exit 1; fi
[[ $stopped == true ]]
echo 'PASS: activate, recover previous, incompatible rollback and first-start failure.'
