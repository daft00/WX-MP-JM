#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
base=/opt/growth-diary
config=/etc/growth-diary
service=growth-diary.service

die() { echo "$*" >&2; exit 1; }
release_path() {
  [[ ${1:-} =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$ && $1 != *..* ]] || die 'Invalid release ID.'
  local directory="$base/releases/$1"
  [[ -d $directory && ! -L $directory && $(realpath -- "$directory") == "$directory" ]] || die 'Release not found or unsafe path.'
  [[ -f $directory/dist/main.js && -f $directory/IMPORTED ]] || die 'Incomplete release.'
  printf '%s\n' "$directory"
}
link_to() {
  local target=$1 name=$2
  [[ ! -e $base/$name || -L $base/$name ]] || die "Refusing to replace a non-symlink: $name"
  ln -s -- "$target" "$base/.$name.$$"
  mv -Tf -- "$base/.$name.$$" "$base/$name"
}
healthy() {
  local attempt
  for attempt in {1..20}; do
    if systemctl is-active --quiet "$service" &&
      curl --fail --silent --max-time 4 http://127.0.0.1:3000/api/v1/health/live >/dev/null &&
      curl --fail --silent --max-time 4 http://127.0.0.1:3000/api/v1/health/ready >/dev/null; then return 0; fi
    sleep 2
  done
  return 1
}
check_release() { /usr/bin/node "$script_dir/deploy/release-tools.cjs" "$1" "$2" "$config/app.env"; }
backup() {
  local destination temporary
  install -d -m 0700 "$base/backups"
  destination="$base/backups/growth_diary-$(date -u +%Y%m%dT%H%M%SZ)-$$.sql.gz"
  temporary="$destination.partial"
  if mysqldump --protocol=SOCKET --user=root --single-transaction --quick --no-tablespaces --set-gtid-purged=OFF --databases growth_diary | gzip > "$temporary"; then
    gzip -t "$temporary"
    mv -- "$temporary" "$destination"
    echo "Backup: $destination (copy off-server and verify restore separately)"
  else
    rm -f -- "$temporary"
    die 'Backup failed. No migration performed.'
  fi
}
activate() {
  local target=$1 old
  check_release schema "$target"
  old=$(readlink -f "$base/current" || true)
  if [[ -n $old && $old != "$base/current" ]]; then
    [[ $old == "$base/releases/"* && -f $old/BUILD_INFO ]] || die 'Unexpected current release.'
  else old=; fi
  systemctl stop "$service"
  link_to "$target" current
  if systemctl restart "$service" && healthy; then
    [[ -z $old || $old == "$target" ]] || link_to "$old" previous
    systemctl enable "$service"
    echo "Active release: $target"
    return
  fi
  systemctl stop "$service" || true
  if [[ -n $old ]]; then
    link_to "$old" current
    if check_release schema "$old" && systemctl restart "$service" && healthy; then
      echo 'Activation failed; previous code restored. Database/config were not reverted.' >&2
    else
      systemctl disable --now "$service" || true
      echo 'Activation failed; previous code cannot be verified. Service remains stopped.' >&2
    fi
  else
    systemctl disable "$service" || true
    echo 'First activation failed; service remains stopped.' >&2
  fi
  return 1
}

main() {
  [[ $EUID -eq 0 ]] || die 'Run this deployment script with sudo.'
  [[ -d /run/systemd/system ]] || die 'Ubuntu with running systemd is required.'
  [[ -x /usr/bin/node && $(/usr/bin/node -p 'process.versions.node.split(".")[0]') == 22 ]] || die '/usr/bin/node must be Node.js 22.'
  for program in flock curl mysql mysqldump gzip runuser systemd-run; do command -v "$program" >/dev/null || die "Missing command: $program"; done
  exec 9>/run/lock/growth-diary-deploy.lock
  flock -n 9 || die 'Another deployment is running.'
  case ${1:-} in
    import|migrate|activate|rollback|verify)
      for file in app.env migration.env; do
        [[ -f $config/$file && ! -L $config/$file && $(stat -c '%u:%a' "$config/$file") == 0:600 ]] || die 'Run init first; environment files must remain root-owned mode 600.'
      done ;;
  esac
  case ${1:-} in
    init)
      [[ $# -eq 1 ]] || die 'Usage: init'
      [[ -f $config/database.env && $(stat -c '%u:%a' "$config/database.env") == 0:600 ]] || die 'Expected existing root-owned database.env mode 600.'
      for account in growth-api growth-migrate; do
        if ! id "$account" >/dev/null 2>&1; then useradd --system --user-group --no-create-home --shell /usr/sbin/nologin "$account"; fi
        [[ $(id -u "$account") != 0 && $(getent passwd "$account" | cut -d: -f7) == /usr/sbin/nologin ]] || die 'Unexpected existing service account; review manually.'
      done
      install -d -m 0755 "$base" "$base/releases"
      /usr/bin/node "$script_dir/deploy/release-tools.cjs" init "$config"
      for file in app.env migration.env; do
        [[ $(stat -c '%u:%a' "$config/$file") == 0:600 && ! -L $config/$file ]] || die 'Private environment files must be root-owned mode 600, not symlinks.'
      done
      if [[ -e /etc/systemd/system/$service ]]; then
        cmp -s "$script_dir/deploy/$service" "/etc/systemd/system/$service" || die 'Existing unit differs; review it manually. Not overwritten.'
      else install -m 0644 "$script_dir/deploy/$service" "/etc/systemd/system/$service"; fi
      systemctl daemon-reload
      echo 'Initialized. Edit /etc/growth-diary/app.env with sudoedit; existing configs were preserved.'
      ;;
    import)
      [[ $# -eq 3 ]] || die 'Usage: import RELEASE_ID /absolute/built-release-directory'
      local id=$2 source target
      [[ $id =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$ && $id != *..* ]] || die 'Invalid release ID.'
      source=$(realpath -- "$3")
      target="$base/releases/$id"
      [[ -d $base/releases && ! -e $target && ! -L $target ]] || die 'Run init first; release ID must be new.'
      for item in dist/main.js dist/database/migrate.js node_modules package.json package-lock.json BUILD_INFO; do [[ -e $source/$item ]] || die "Missing build item: $item"; done
      install -d -m 0755 "$target"
      # Only artifacts from a trusted local build; never import .env or migration credentials.
      for item in dist node_modules package.json package-lock.json BUILD_INFO; do cp -a -- "$source/$item" "$target/"; done
      local link resolved
      while IFS= read -r -d '' link; do
        resolved=$(realpath -- "$link")
        [[ $resolved == "$target/"* ]] || die 'Build contains a symlink outside the release; import refused.'
      done < <(find "$target" -type l -print0)
      chown -hR root:root "$target"
      chmod -R go-w "$target"
      find "$target" -type d -exec chmod a+rx {} +
      find "$target" -type f -exec chmod a+r {} +
      check_release config "$target"
      touch "$target/IMPORTED"
      echo "Imported: $target. Not migrated or activated."
      ;;
    backup) [[ $# -eq 1 ]] || die 'Usage: backup'; backup ;;
    migrate)
      [[ $# -eq 2 ]] || die 'Usage: migrate RELEASE_ID'
      local target
      target=$(release_path "$2")
      check_release config "$target"
      systemctl disable --now "$service"
      backup
      # systemd reads root-only credentials, then runs migration under a separate Unix identity.
      systemd-run --unit=growth-diary-migration --wait --pipe --collect \
        --property=User=growth-migrate --property=Group=growth-migrate \
        --property="WorkingDirectory=$target" --property="EnvironmentFile=$config/migration.env" \
        --property=NoNewPrivileges=yes --property=ProtectSystem=strict --property=ProtectHome=yes \
        /usr/bin/node dist/database/migrate.js run
      check_release schema "$target"
      echo 'Migration verified. Service is stopped; activate the release explicitly.'
      ;;
    activate|rollback)
      [[ $# -eq 2 ]] || die 'Usage: activate|rollback RELEASE_ID'
      activate "$(release_path "$2")"
      ;;
    verify)
      [[ $# -eq 1 ]] || die 'Usage: verify'
      check_release schema "$(readlink -f "$base/current")"
      healthy || die 'Service health checks failed.'
      echo 'PASS: systemd, live/ready, runtime DB access, tables and migration history. Business/WeChat tests are separate.'
      ;;
    *) die 'Commands: init | import ID DIR | backup | migrate ID | activate ID | rollback ID | verify' ;;
  esac
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then main "$@"; fi
