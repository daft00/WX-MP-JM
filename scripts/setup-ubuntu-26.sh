#!/usr/bin/env bash
set -Eeuo pipefail

# Install a small single-server development stack on Ubuntu Server 26.04 LTS.
# Run as: sudo bash setup-ubuntu-26.sh

if [[ ${EUID} -ne 0 ]]; then
  echo "Run this script with sudo: sudo bash setup-ubuntu-26.sh" >&2
  exit 1
fi

if [[ ! -r /etc/os-release ]]; then
  echo "Cannot determine the operating system." >&2
  exit 1
fi

# shellcheck disable=SC1091
source /etc/os-release
if [[ ${ID:-} != ubuntu || ${VERSION_ID:-} != 26.04 ]]; then
  echo "This script is intended for Ubuntu 26.04 LTS; found ${PRETTY_NAME:-unknown}." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates nodejs npm mysql-server

# Keep MySQL local to this host. The config file is created only once so a
# later run of this script will not overwrite the operator's changes.
mysql_config=/etc/mysql/mysql.conf.d/99-growth-diary-local.cnf
if [[ ! -e "$mysql_config" ]]; then
  cat > "$mysql_config" <<'MYSQL_CONFIG'
[mysqld]
bind-address = 127.0.0.1
innodb_buffer_pool_size = 256M
max_connections = 30
MYSQL_CONFIG
  chmod 0644 "$mysql_config"
fi

systemctl enable mysql
systemctl restart mysql

echo "Node.js: $(node --version)"
echo "npm: $(npm --version)"
echo "MySQL: $(mysql --version)"
echo "MySQL bind address: $(mysql -N -B -e 'SELECT @@bind_address')"
echo "MySQL service: $(systemctl is-active mysql)"
echo
echo "Installation complete. No application database or password was created."
echo "Before deploying the API, create a least-privilege MySQL user and arrange off-server backups."
