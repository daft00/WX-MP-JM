#!/usr/bin/env python3
"""Encrypted MySQL backup and isolated restore; Linux, Python standard library only."""
import argparse
import contextlib
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
import uuid

NAME = re.compile(r"growth_diary-(\d{8}T\d{6}Z)-[a-f0-9]{32}\.sql\.gz\.gpg\Z")


def private_file(value):
    path = Path(value)
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise ValueError("Private file must be owned by this user, mode 600, and not a symlink")
    return path


def directory(value):
    path = Path(value)
    if not path.is_absolute() or path.resolve() != path:
        raise ValueError("An absolute directory without symlinks is required")
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.stat()
    if info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise ValueError("Directory must be owned by this user and mode 700")
    return path


@contextlib.contextmanager
def lock(path):
    import fcntl
    with open(path, "a") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


def run(args, **kwargs):
    # Command output can contain credentials or SQL; only expose the operation name.
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            timeout=kwargs.pop("timeout", 60), **kwargs)
    if result.returncode:
        raise RuntimeError("Command failed: " + Path(args[0]).name)
    return result.stdout


def pipeline(commands, source=None, destination=None):
    processes = []
    previous = source
    try:
        for index, command in enumerate(commands):
            output = destination if index == len(commands) - 1 else subprocess.PIPE
            process = subprocess.Popen(command, stdin=previous, stdout=output, stderr=subprocess.DEVNULL)
            if previous is not None and previous is not source:
                previous.close()
            processes.append(process)
            previous = process.stdout
        results = [process.wait(timeout=3600) for process in reversed(processes)]
        if any(results):
            raise RuntimeError("Backup/restore pipeline failed; inspect tool configuration")
    finally:
        for process in processes:
            if process.poll() is None:
                process.kill()
            process.wait()


def digest(path):
    checksum = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            checksum.update(block)
    return checksum.hexdigest()


def retention(names):
    """Keep the latest backup on 7 distinct days and in 4 distinct ISO weeks."""
    days, weeks, keep = set(), set(), set()
    for name in sorted(names, reverse=True):
        match = NAME.fullmatch(name)
        if not match:
            continue
        stamp = dt.datetime.strptime(match[1], "%Y%m%dT%H%M%SZ")
        day, week = stamp.date(), stamp.isocalendar()[:2]
        daily = day not in days and len(days) < 7
        weekly = week not in weeks and len(weeks) < 4
        if daily or weekly:
            keep.add(name)
        days.add(day)
        weeks.add(week)
    return keep


def prune(root, preserve=None):
    files = [p for p in root.iterdir() if NAME.fullmatch(p.name) and p.is_file() and not p.is_symlink()]
    keep = retention([p.name for p in files])
    if preserve:
        keep.add(preserve)
    for path in files:
        if path.name not in keep:
            path.unlink()


def atomic_json(path, value):
    temporary = path.with_suffix(".partial")
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(value, handle)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def receive(root, name, expected, source):
    if not NAME.fullmatch(name) or not re.fullmatch(r"[a-f0-9]{64}", expected):
        raise ValueError("Invalid archive name/checksum")
    dt.datetime.strptime(NAME.fullmatch(name)[1], "%Y%m%dT%H%M%SZ")
    root = directory(root)
    with lock(root / ".receive.lock"):
        target = root / name
        if target.exists() or target.is_symlink():
            raise ValueError("Archive already exists")
        with tempfile.NamedTemporaryFile(dir=root, suffix=".partial", delete=False) as handle:
            temporary = Path(handle.name)
            try:
                shutil.copyfileobj(source, handle, 1024 * 1024)
                handle.flush()
                os.fsync(handle.fileno())
            except BaseException:
                temporary.unlink(missing_ok=True)
                raise
        try:
            if digest(temporary) != expected or temporary.stat().st_size == 0:
                raise ValueError("Remote checksum mismatch")
            os.replace(temporary, target)
            prune(root, name)
        finally:
            temporary.unlink(missing_ok=True)
    return {"name": name, "sha256": expected}


def backup(config):
    root = directory(config["backup_dir"])
    cnf = private_file(config["mysql_defaults"])
    fingerprint = config["recipient"]
    if not re.fullmatch(r"[A-Fa-f0-9]{40,64}", fingerprint):
        raise ValueError("Use the full verified GPG fingerprint")
    alias = config["ssh_alias"]
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]*", alias):
        raise ValueError("Use a dedicated SSH config alias")
    # Shares the deployment lock: backup cannot overlap schema migrations.
    with lock("/run/lock/growth-diary-deploy.lock"), lock(root / ".backup.lock"):
        unsupported = mysql(cnf, "growth_diary", """SELECT
          (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=DATABASE() AND (engine<>'InnoDB' OR table_type<>'BASE TABLE')) +
          (SELECT COUNT(*) FROM information_schema.triggers WHERE trigger_schema=DATABASE()) +
          (SELECT COUNT(*) FROM information_schema.routines WHERE routine_schema=DATABASE()) +
          (SELECT COUNT(*) FROM information_schema.events WHERE event_schema=DATABASE())""")
        if unsupported != "0":
            raise ValueError("This backup supports InnoDB base tables without stored programs only")
        name = "growth_diary-" + dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex + ".sql.gz.gpg"
        target = root / name
        temporary = root / (name + ".partial")
        try:
            with open(temporary, "xb") as handle:
                pipeline([
                    ["mysqldump", "--defaults-extra-file=" + str(cnf), "--single-transaction", "--quick",
                     "--no-tablespaces", "--set-gtid-purged=OFF", "--hex-blob", "--skip-add-drop-table",
                     "--skip-triggers", "--skip-add-locks", "growth_diary"],
                    ["gzip", "-c"],
                    ["gpg", "--homedir", str(directory(config["gpg_home"])), "--batch", "--trust-model", "always",
                     "--encrypt", "--cipher-algo", "AES256", "--recipient", fingerprint, "--output", "-"],
                ], destination=handle)
                handle.flush()
                os.fsync(handle.fileno())
            if temporary.stat().st_size == 0:
                raise ValueError("Empty archive")
            os.replace(temporary, target)
            checksum = digest(target)
            command = shlex.join(["python3", config["remote_script"], "receive", "--directory",
                                  config["remote_dir"], "--name", name, "--sha256", checksum])
            with open(target, "rb") as handle:
                receipt = json.loads(run(["ssh", "-oBatchMode=yes", "-oStrictHostKeyChecking=yes",
                                          "-oConnectTimeout=15", alias, command], stdin=handle, timeout=3600))
            if receipt != {"name": name, "sha256": checksum}:
                raise ValueError("Remote receipt mismatch")
            atomic_json(root / "last-success.json", {**receipt, "completed_at": dt.datetime.now(dt.timezone.utc).isoformat()})
            prune(root, name)
            return {"status": "ok", **receipt}
        finally:
            temporary.unlink(missing_ok=True)


def mysql(cnf, database, sql):
    return run(["mysql", "--defaults-extra-file=" + str(cnf), "--batch", "--skip-column-names",
                database, "--execute", sql]).decode("utf-8").strip()


def restore_grants(grants, database):
    """Reject global, role and other-schema grants, even for a correctly named target."""
    grants = [line.strip() for line in grants.splitlines() if line.strip()]
    return bool(grants) and all(
        re.fullmatch(r"GRANT USAGE ON \*\.\* TO .+", line)
        or (re.fullmatch(r"GRANT [A-Z_, ]+ ON `" + re.escape(database) + r"`\.\* TO .+", line)
            and "WITH GRANT OPTION" not in line)
        for line in grants)


VERIFY_SQL = """
SELECT 'families', COUNT(*) FROM families;
SELECT 'children', COUNT(*) FROM children;
SELECT 'entries', COUNT(*) FROM entries;
SELECT 'assets', COUNT(*) FROM assets;
SELECT 'entry_assets', COUNT(*) FROM entry_assets;
SELECT 'schema_migrations', COUNT(*) FROM schema_migrations;
SELECT 'orphans', (
 (SELECT COUNT(*) FROM families f LEFT JOIN users u ON u.id=f.owner_id WHERE u.id IS NULL) +
 (SELECT COUNT(*) FROM children c LEFT JOIN families f ON f.id=c.family_id WHERE f.id IS NULL) +
 (SELECT COUNT(*) FROM entries e LEFT JOIN children c ON c.id=e.child_id AND c.family_id=e.family_id WHERE c.id IS NULL) +
 (SELECT COUNT(*) FROM assets a LEFT JOIN children c ON c.id=a.child_id AND c.family_id=a.family_id WHERE c.id IS NULL) +
 (SELECT COUNT(*) FROM entry_assets ea LEFT JOIN entries e ON e.id=ea.entry_id AND e.family_id=ea.family_id AND e.child_id=ea.child_id
 LEFT JOIN assets a ON a.id=ea.asset_id AND a.family_id=ea.family_id AND a.child_id=ea.child_id WHERE e.id IS NULL OR a.id IS NULL));
SELECT 'invalid_media_keys', COUNT(*) FROM assets WHERE status='READY' AND (object_key='' OR object_key LIKE 'http%');
"""


def restore(archive, cnf, gpg_home, database):
    if not re.fullmatch(r"growth_diary_restore_\d{8}_[a-f0-9]{8}", database):
        raise ValueError("Only growth_diary_restore_YYYYMMDD_8hex targets are allowed")
    cnf = private_file(cnf)
    if not restore_grants(mysql(cnf, database, "SHOW GRANTS FOR CURRENT_USER"), database):
        raise ValueError("Restore user must have privileges ONLY on the exact isolated target, no roles/global grants")
    if mysql(cnf, database, "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=DATABASE()") != "0":
        raise ValueError("Restore target must be empty; it will never be cleared automatically")
    started = dt.datetime.now(dt.timezone.utc)
    with open(archive, "rb") as source, open(os.devnull, "wb") as sink:
        pipeline([
            ["gpg", "--homedir", str(directory(gpg_home)), "--batch", "--decrypt"],
            ["gzip", "-dc"],
            ["mysql", "--defaults-extra-file=" + str(cnf), "--binary-mode", database],
        ], source, sink)
    counts = dict(line.split("\t") for line in mysql(cnf, database, VERIFY_SQL).splitlines())
    if counts.get("orphans") != "0" or counts.get("invalid_media_keys") != "0":
        raise ValueError("Restored relational/media reference checks failed")
    return {"status": "ok", "database": database, "counts": counts,
            "elapsed_seconds": (dt.datetime.now(dt.timezone.utc) - started).total_seconds(),
            "scope": "database only; compare counts to expected data and verify COS objects separately"}


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    backup_parser = commands.add_parser("backup")
    backup_parser.add_argument("--config", required=True)
    receiver = commands.add_parser("receive")
    for key in ("directory", "name", "sha256"):
        receiver.add_argument("--" + key, required=True)
    restorer = commands.add_parser("restore")
    for key in ("archive", "mysql-defaults", "gpg-home", "database"):
        restorer.add_argument("--" + key, required=True)
    args = parser.parse_args()
    try:
        if args.command == "backup":
            config = json.loads(private_file(args.config).read_text(encoding="utf-8"))
            result = backup(config)
        elif args.command == "receive":
            result = receive(args.directory, args.name, args.sha256, sys.stdin.buffer)
        else:
            result = restore(args.archive, args.mysql_defaults, args.gpg_home, args.database)
        print(json.dumps(result))
    except Exception:
        # Do not include original exceptions: subprocesses/configuration may carry secrets.
        print("Operation failed; verify config, tools, permissions, free space and connectivity. Restore may be partial; never retry into a nonempty target.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
