import contextlib
import datetime as dt
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import backup
import monitor


def name(day, suffix="a"):
    return "growth_diary-" + day.strftime("%Y%m%dT%H%M%SZ") + "-" + suffix * 32 + ".sql.gz.gpg"


class OperationsTests(unittest.TestCase):
    def test_notifications_change_recovery_and_hourly_repeat(self):
        now = dt.datetime(2026, 10, 26, tzinfo=dt.timezone.utc)
        report = {"issues": ["disk"], "status": "failed"}
        with tempfile.TemporaryDirectory() as folder:
            command = Path(folder) / "notify"
            command.touch(mode=0o700)
            with patch.object(monitor.os, "geteuid", return_value=0, create=True), \
                 patch.object(Path, "lstat", return_value=SimpleNamespace(st_mode=0o100700, st_uid=0)), patch.object(monitor, "run") as run:
                monitor.notify(report, {}, str(command), now)
                run.assert_called_once()
                previous = report.copy()
                run.reset_mock()
                monitor.notify(report, previous, str(command), now + dt.timedelta(minutes=5))
                run.assert_not_called()
                monitor.notify(report, previous, str(command), now + dt.timedelta(hours=1))
                run.assert_called_once()
                run.reset_mock()
                recovered = {"issues": [], "status": "ok"}
                monitor.notify(recovered, previous, str(command), now)
                run.assert_called_once()
                run.side_effect = RuntimeError("sensitive delivery error")
                failure = {"issues": [], "status": "ok"}
                monitor.notify(failure, {}, str(command), now)
                self.assertIn("alert_delivery_failed", failure["issues"])
        missing = {"issues": [], "status": "ok"}
        monitor.notify(missing, {}, "", now)
        self.assertIn("alert_delivery_unconfigured", missing["issues"])

    def test_retention_daily_weekly_and_unrelated_files(self):
        start = dt.datetime(2026, 10, 26)
        names = [name(start - dt.timedelta(days=index)) for index in range(60)]
        keep = backup.retention(names + ["do-not-touch.sql.gz", "last-success.json"])
        self.assertTrue(set(names[:7]).issubset(keep))
        weeks = {dt.datetime.strptime(backup.NAME.fullmatch(item)[1], "%Y%m%dT%H%M%SZ").isocalendar()[:2] for item in keep}
        self.assertEqual(len(weeks), 4)
        self.assertLessEqual(len(keep), 11)
        self.assertNotIn(names[-1], keep)

    def test_receive_rejects_corruption_before_pruning(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            existing = root / name(dt.datetime(2020, 1, 1))
            existing.write_bytes(b"old")
            current = name(dt.datetime(2026, 10, 26))
            with patch.object(backup, "directory", return_value=root), patch.object(backup, "lock", return_value=contextlib.nullcontext()):
                with self.assertRaisesRegex(ValueError, "checksum"):
                    backup.receive(root, current, "0" * 64, io.BytesIO(b"corrupt"))
                self.assertTrue(existing.exists())
                self.assertFalse((root / current).exists())
                self.assertFalse(list(root.glob("*.partial")))
                expected = hashlib.sha256(b"encrypted").hexdigest()
                result = backup.receive(root, current, expected, io.BytesIO(b"encrypted"))
                self.assertEqual(result["sha256"], expected)
                self.assertEqual((root / current).read_bytes(), b"encrypted")
                with self.assertRaises(ValueError):
                    backup.receive(root, "../escape", expected, io.BytesIO(b"encrypted"))

    def test_failed_pipeline_checks_upstream_and_downstream(self):
        with open(os.devnull, "wb") as sink:
            for first, second in ((1, 0), (0, 1)):
                with self.assertRaises(RuntimeError):
                    backup.pipeline([[sys.executable, "-c", f"import sys; sys.exit({first})"],
                                     [sys.executable, "-c", f"import sys; sys.stdin.buffer.read(); sys.exit({second})"]], destination=sink)

    def test_restore_rejects_production_and_broad_grants(self):
        target = "growth_diary_restore_20261026_aabbccdd"
        valid = "GRANT USAGE ON *.* TO `restore`@`localhost`\nGRANT ALL PRIVILEGES ON `" + target + "`.* TO `restore`@`localhost`"
        self.assertTrue(backup.restore_grants(valid, target))
        for invalid in ("GRANT ALL PRIVILEGES ON *.* TO `root`@`localhost`", valid + "\nGRANT `admin_role`@`%` TO `restore`@`localhost`", valid.replace(target, "growth_diary")):
            self.assertFalse(backup.restore_grants(invalid, target))
        with patch.object(backup, "pipeline") as pipeline:
            with self.assertRaises(ValueError):
                backup.restore("unused", "unused", "unused", "growth_diary")
            with patch.object(backup, "private_file", return_value="private.cnf"), patch.object(backup, "mysql", side_effect=[valid, "1"]):
                with self.assertRaisesRegex(ValueError, "empty"):
                    backup.restore("unused", "private.cnf", "unused", target)
            pipeline.assert_not_called()

    def test_backup_age_and_missing_file(self):
        now = dt.datetime(2026, 10, 26, tzinfo=dt.timezone.utc)
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            archive = root / "archive.gpg"
            archive.touch()
            receipt = {"name": archive.name, "completed_at": now.isoformat()}
            (root / "last-success.json").write_text(json.dumps(receipt))
            monitor.check_backup(root, now)
            with self.assertRaises(ValueError):
                monitor.check_backup(root, now + dt.timedelta(hours=25))
            with self.assertRaises(ValueError):
                monitor.check_backup(root, now - dt.timedelta(hours=1))
            archive.unlink()
            with self.assertRaises(ValueError):
                monitor.check_backup(root, now)

    def test_5xx_window_and_invalid_log(self):
        with tempfile.TemporaryDirectory() as folder:
            log = Path(folder) / "access.log"
            log.write_text("100 500 0.1\n900 503 0.1\n950 200 0.1\n")
            monitor.nginx_errors(log, 1000, 2)
            with self.assertRaises(ValueError):
                monitor.nginx_errors(log, 1000, 1)
            rotated = Path(str(log) + ".1")
            rotated.write_text("850 500 0.1\n")
            with self.assertRaises(ValueError):
                monitor.nginx_errors(log, 1000, 2)
            rotated.unlink()
            log.write_text("GET /secret HTTP/1.1")
            with self.assertRaises(ValueError):
                monitor.nginx_errors(log, 1000, 1)

    def test_failed_backup_delivery_preserves_history_and_receipt(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            receipt = root / "last-success.json"
            receipt.write_text('{"old":true}')
            config = {"backup_dir": folder, "mysql_defaults": "unused", "recipient": "A" * 40,
                      "ssh_alias": "backup-host", "gpg_home": folder, "remote_script": "/ops/backup.py", "remote_dir": "/backup"}

            def encrypted(*args, **kwargs):
                kwargs["destination"].write(b"encrypted")

            with patch.object(backup, "directory", return_value=root), patch.object(backup, "private_file", return_value="unused"), \
                 patch.object(backup, "lock", side_effect=lambda _: contextlib.nullcontext()), patch.object(backup, "mysql", return_value="0"), \
                 patch.object(backup, "pipeline", side_effect=encrypted), patch.object(backup, "run", side_effect=RuntimeError("offline")), \
                 patch.object(backup, "prune") as prune:
                with self.assertRaises(RuntimeError):
                    backup.backup(config)
                prune.assert_not_called()
                self.assertEqual(receipt.read_text(), '{"old":true}')
                self.assertEqual(len(list(root.glob("*.gpg"))), 1)


if __name__ == "__main__":
    unittest.main()
