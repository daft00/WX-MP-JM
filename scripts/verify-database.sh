#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
[[ $EUID -eq 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
app_client=/etc/growth-diary/app.cnf
migration_client=/etc/growth-diary/migration.cnf
probe="_setup_probe_$(node -e "process.stdout.write(require('node:crypto').randomBytes(8).toString('hex'))")"
work_dir=$(mktemp -d /tmp/growth-diary-check.XXXXXX)
cleanup() {
  mysql --defaults-extra-file="$migration_client" -e "DROP TABLE IF EXISTS $probe;" >/dev/null
  rm -f -- "$work_dir/error"
  rmdir -- "$work_dir"
}
trap cleanup EXIT
mysql --defaults-extra-file="$migration_client" -e "CREATE TABLE $probe (id INT PRIMARY KEY, value VARCHAR(32));"
mysql --defaults-extra-file="$app_client" -e "INSERT INTO $probe VALUES (1,'before'); UPDATE $probe SET value='after' WHERE id=1;"
result=$(mysql --defaults-extra-file="$app_client" -N -B -e "SELECT value FROM $probe WHERE id=1;")
[[ $result == after ]] || { echo 'CRUD verification failed.' >&2; exit 1; }
mysql --defaults-extra-file="$app_client" -e "DELETE FROM $probe WHERE id=1;"
if mysql --defaults-extra-file="$app_client" -e "DROP TABLE $probe;" 2>"$work_dir/error"; then
  echo 'Unexpected runtime DROP permission.' >&2
  exit 1
fi
grep -q 'ERROR 1142' "$work_dir/error" || { echo 'DROP test failed for an unexpected reason.' >&2; exit 1; }
if mysql --defaults-extra-file="$app_client" -e 'SELECT User FROM mysql.user;' 2>"$work_dir/error"; then
  echo 'Unexpected access to system user table.' >&2
  exit 1
fi
grep -q 'ERROR 1142' "$work_dir/error" || { echo 'Isolation test failed for an unexpected reason.' >&2; exit 1; }
echo 'PASS: application CRUD, migration DDL, runtime DROP denied, system-table read denied.'
