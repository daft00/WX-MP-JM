#!/usr/bin/env python3
"""Read-only checks; JSON issues go to journald and a private status file."""
import argparse
import datetime as dt
import json
import os
from pathlib import Path
import shutil
import socket
import ssl
import stat
import sys
import time
import urllib.request

from backup import atomic_json, directory, mysql, private_file, run


def age_seconds(value, now):
    age = (now - dt.datetime.fromisoformat(value)).total_seconds()
    if age < -300:
        raise ValueError("Future timestamp")
    return age


def check_backup(root, now):
    receipt = json.loads((Path(root) / "last-success.json").read_text(encoding="utf-8"))
    if age_seconds(receipt["completed_at"], now) > 24 * 3600:
        raise ValueError("Off-server backup older than 24 hours")
    # A success file is written only after the receiver verifies the ciphertext.
    if not (Path(root) / receipt["name"]).is_file():
        raise ValueError("Last successful local archive is missing")


def log_window(path, now):
    with open(path, "rb") as handle:
        handle.seek(0, 2)
        size = handle.tell()
        handle.seek(max(0, size - 1024 * 1024))
        if size > 1024 * 1024:
            handle.readline()
        lines = handle.read().decode("ascii").splitlines()
    recent = []
    for line in lines:
        stamp, status, latency = line.split()
        stamp = float(stamp)
        if stamp > now + 300:
            raise ValueError("Future log timestamp")
        if stamp >= now - 300:
            recent.append((int(status), float(latency)))
    if size > 1024 * 1024 and lines and float(lines[0].split()[0]) >= now - 300:
        raise ValueError("Log sample truncated inside monitoring window")
    return recent


def nginx_errors(path, now, threshold):
    recent = log_window(path, now)
    rotated = Path(str(path) + ".1")
    if rotated.is_file():
        recent += log_window(rotated, now)
    if sum(status >= 500 for status, _ in recent) >= threshold:
        raise ValueError("HTTP 5xx threshold exceeded")


def certificate(host):
    # Correct SNI and trust validation; works while nginx only listens on loopback.
    with socket.create_connection(("127.0.0.1", 443), timeout=8) as raw:
        with ssl.create_default_context().wrap_socket(raw, server_hostname=host) as connection:
            expires = ssl.cert_time_to_seconds(connection.getpeercert()["notAfter"])
            if expires - time.time() < 30 * 86400:
                raise ValueError("Certificate expires within 30 days")


def service(name):
    if run(["systemctl", "is-active", name]).strip() != b"active":
        raise ValueError("Inactive service")


def worker(name, max_age):
    service(name + ".timer")
    result = run(["systemctl", "show", name + ".service", "--property=Result", "--value"]).strip()
    if result != b"success":
        raise ValueError("Worker failed")
    trigger = int(run(["systemctl", "show", name + ".timer", "--property=LastTriggerUSecMonotonic", "--value"]))
    if not trigger or time.monotonic() - trigger / 1_000_000 > max_age:
        raise ValueError("Worker timer stale")
    journal = run(["journalctl", "--unit=" + name + ".service", "--since=-6min", "--no-pager", "--quiet", "--output=cat", "--lines=1000"])
    if b"worker failed" in journal.lower() or b"failed with result" in journal.lower():
        raise ValueError("Worker failed recently, even if a later retry succeeded")


def health():
    # Do not use proxy environment variables for the loopback health endpoint.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for endpoint in ("live", "ready"):
        with opener.open("http://127.0.0.1:3000/api/v1/health/" + endpoint, timeout=8) as response:
            body = json.loads(response.read(4096))
            if response.status != 200 or body.get("status") != "ok" or (endpoint == "ready" and body.get("database") != "up"):
                raise ValueError("Unhealthy API")


def database(cnf, percent):
    rows = dict(line.split("\t") for line in mysql(cnf, "growth_diary", "SHOW GLOBAL STATUS LIKE 'Threads_connected'; SELECT 'max', @@max_connections").splitlines())
    if int(rows["Threads_connected"]) * 100 >= int(rows["max"]) * percent:
        raise ValueError("Database connection threshold exceeded")


def jobs(cnf):
    sql = """SELECT
      (SELECT COUNT(*) FROM export_tasks WHERE status='FAILED' AND updated_at > UTC_TIMESTAMP() - INTERVAL 1 DAY) +
      (SELECT COUNT(*) FROM assets WHERE status='FAILED' AND updated_at > UTC_TIMESTAMP() - INTERVAL 1 DAY) +
      (SELECT COUNT(*) FROM assets WHERE status='DELETING' AND updated_at < UTC_TIMESTAMP() - INTERVAL 1 DAY) +
      (SELECT COUNT(*) FROM data_requests WHERE status='PROCESSING' AND
        (started_at < UTC_TIMESTAMP() - INTERVAL 1 DAY OR last_error IN ('CLEANUP_RETRY','STORAGE_UNAVAILABLE','LEGACY_MEDIA_REQUIRES_REVIEW','MEDIA_LEDGER_REQUIRES_REVIEW')))"""
    if int(mysql(cnf, "growth_diary", sql)):
        raise ValueError("Failed or stalled jobs need review")


def checks(config, now):
    issues = []

    def check(name, action):
        try:
            action()
        except Exception:
            # Only stable check IDs are logged; never SQL, user data or signed URLs.
            issues.append(name)

    def disk():
        usage = shutil.disk_usage(config["backup_dir"])
        if usage.used * 100 >= usage.total * config["disk_percent"] or usage.free < 2 * 1024 ** 3:
            raise ValueError("Low disk space")

    def billing():
        note = json.loads(private_file(config["billing_review_file"]).read_text(encoding="utf-8"))
        if note.get("budget_alerts_verified") is not True or age_seconds(note["checked_at"], now) > 7 * 86400:
            raise ValueError("Cloud billing alert verification overdue")

    check("disk", disk)
    check("offsite_backup", lambda: check_backup(config["backup_dir"], now))
    check("api_service", lambda: service("growth-diary.service"))
    check("nginx_service", lambda: service("nginx.service"))
    check("health", health)
    check("tls_certificate", lambda: certificate(config["tls_host"]))
    check("database_connections", lambda: database(private_file(config["mysql_defaults"]), config["connection_percent"]))
    check("media_worker", lambda: worker("growth-diary-media", 300))
    check("export_worker", lambda: worker("growth-diary-export", 2400))
    check("deletion_worker", lambda: worker("growth-diary-deletion", 1500))
    check("failed_jobs", lambda: jobs(private_file(config["mysql_defaults"])))
    check("http_5xx", lambda: nginx_errors(config["nginx_log"], now.timestamp(), config["http_5xx_count"]))
    check("cloud_billing_review", billing)
    return {"checked_at": now.isoformat(), "status": "failed" if issues else "ok", "issues": issues}


def notify(report, previous, command, now):
    """Notify on change/recovery; repeat unresolved failures hourly, retry delivery failures."""
    if not command:
        report["issues"].append("alert_delivery_unconfigured")
        report["status"] = "failed"
        return
    try:
        path = Path(command)
        info = path.lstat()
        if not path.is_absolute() or path.is_symlink() or not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022:
            raise ValueError("Notification executable must be owned by this user and not writable by others")
        changed = previous.get("issues") != report["issues"]
        expired = age_seconds(previous.get("notified_at", "1970-01-01T00:00:00+00:00"), now) >= 3600
        if changed or (report["issues"] and expired):
            run([str(path)], input=json.dumps(report).encode("utf-8"), timeout=20)
            report["notified_at"] = now.isoformat()
        elif "notified_at" in previous:
            report["notified_at"] = previous["notified_at"]
    except Exception:
        report["issues"].append("alert_delivery_failed")
        report["status"] = "failed"


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    try:
        config = json.loads(private_file(args.config).read_text(encoding="utf-8"))
        for name in ("disk_percent", "connection_percent"):
            if not 1 <= config[name] <= 100:
                raise ValueError("Invalid threshold")
        if not 1 <= config["http_5xx_count"] <= 10000:
            raise ValueError("Invalid threshold")
        now = dt.datetime.now(dt.timezone.utc)
        report = checks(config, now)
        status = directory(config["status_dir"]) / "monitor.json"
        try:
            previous = json.loads(status.read_text(encoding="utf-8"))
        except (FileNotFoundError, ValueError):
            previous = {}
        notify(report, previous, config.get("alert_command"), now)
        atomic_json(status, report)
        print(json.dumps(report), flush=True)
        return 1 if report["issues"] else 0
    except Exception:
        print('{"status":"failed","issues":["monitor_configuration"]}', flush=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
