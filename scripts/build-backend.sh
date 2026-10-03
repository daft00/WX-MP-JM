#!/usr/bin/env bash
set -Eeuo pipefail

# Build in a NEW directory as the login user, never with sudo.
[[ $EUID -ne 0 ]] || { echo 'Run as the login user, without sudo.' >&2; exit 1; }
[[ $# -eq 1 ]] || { echo 'Usage: bash scripts/build-backend.sh /absolute/new-release-directory' >&2; exit 1; }
[[ $(uname -s) == Linux ]] || { echo 'Build on Linux; do not copy Windows node_modules to Ubuntu.' >&2; exit 1; }
[[ $(node -p 'process.versions.node.split(".")[0]') == 22 ]] || { echo 'Node.js 22 is required.' >&2; exit 1; }
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../backend" && pwd)
output=$1
[[ $output == /* && ! -e $output && ! -L $output ]] || { echo 'Output must be an absolute, nonexistent directory.' >&2; exit 1; }
mkdir -m 0755 -- "$output"
output=$(realpath -- "$output")
for item in package.json package-lock.json nest-cli.json tsconfig.json tsconfig.test.json src test; do
  cp -a -- "$source_dir/$item" "$output/"
done
cd -- "$output"
# npm and tests receive no production credentials. The repo's .env files are not copied.
unset NODE_ENV MYSQL_URL MIGRATION_DATABASE_URL TEST_MYSQL_URL TEST_MIGRATION_DATABASE_URL
export NODE_OPTIONS=--max-old-space-size=768
npm ci --include=dev --no-audit --no-fund
npm run check
npm prune --omit=dev --no-audit --no-fund
printf 'Built on Linux with Node %s at %s\n' "$(node --version)" "$(date -u +%FT%TZ)" > BUILD_INFO
echo "Build ready: $output"
