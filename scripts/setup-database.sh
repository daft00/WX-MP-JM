#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Ubuntu/MySQL local development database. Run with sudo.
[[ $EUID -eq 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
command -v mysql >/dev/null
command -v node >/dev/null
mysql --protocol=SOCKET -e 'SELECT 1' >/dev/null

config_dir=/etc/growth-diary
env_file=$config_dir/database.env
if [[ ! -f "$env_file" ]]; then
  existing=$(mysql --protocol=SOCKET -N -B -e "SELECT (SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='growth_diary') + (SELECT COUNT(*) FROM mysql.user WHERE User IN ('growth_app','growth_migrator'));")
  [[ "$existing" == 0 ]] || { echo 'Existing database/users found without managed credentials; stopping without changing them.' >&2; exit 1; }
  install -d -m 0700 "$config_dir"
  app_password=$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")
  migration_password=$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")
  # Persist first: a failed SQL step can be retried with the same credentials.
  temporary_env=$(mktemp "$config_dir/.database.env.XXXXXX")
  printf 'APP_DB_PASSWORD=%s\nMIGRATION_DB_PASSWORD=%s\nMYSQL_URL=mysql://growth_app:%s@127.0.0.1:3306/growth_diary\nMIGRATION_DATABASE_URL=mysql://growth_migrator:%s@127.0.0.1:3306/growth_diary\n' \
    "$app_password" "$migration_password" "$app_password" "$migration_password" > "$temporary_env"
  mv "$temporary_env" "$env_file"
fi

[[ $(stat -c '%u:%a' "$env_file") == '0:600' ]] || { echo 'Expected root-owned credentials with mode 600.' >&2; exit 1; }
# shellcheck disable=SC1090
source "$env_file"
[[ $APP_DB_PASSWORD =~ ^[a-f0-9]{64}$ && $MIGRATION_DB_PASSWORD =~ ^[a-f0-9]{64}$ ]] || { echo 'Unexpected credential format.' >&2; exit 1; }

mysql --protocol=SOCKET <<SQL
CREATE DATABASE IF NOT EXISTS growth_diary CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER IF NOT EXISTS 'growth_app'@'localhost' IDENTIFIED BY '$APP_DB_PASSWORD';
CREATE USER IF NOT EXISTS 'growth_migrator'@'localhost' IDENTIFIED BY '$MIGRATION_DB_PASSWORD';
GRANT SELECT, INSERT, UPDATE, DELETE ON growth_diary.* TO 'growth_app'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, INDEX, REFERENCES ON growth_diary.* TO 'growth_migrator'@'localhost';
SQL

for account in app migration; do
  if [[ $account == app ]]; then
    db_user=growth_app
    db_password=$APP_DB_PASSWORD
  else
    db_user=growth_migrator
    db_password=$MIGRATION_DB_PASSWORD
  fi
  printf '[client]\nuser=%s\npassword=%s\nhost=127.0.0.1\nport=3306\nprotocol=TCP\ndatabase=growth_diary\n' \
    "$db_user" "$db_password" > "$config_dir/$account.cnf"
  mysql --defaults-extra-file="$config_dir/$account.cnf" -N -B -e 'SELECT CURRENT_USER(), DATABASE();'
done
echo 'Database setup complete. Credentials stay in /etc/growth-diary/database.env (root-only).'
echo 'Runtime account: growth_app; schema migration account: growth_migrator.'
echo 'No business tables have been created.'
