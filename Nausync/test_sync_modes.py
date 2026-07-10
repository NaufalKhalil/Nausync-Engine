"""
Unit test untuk sync_modes/ (Strategy Pattern -- Mirror/Backup/Two-Way).

MirrorMode sendiri sudah diuji lewat test_delta.py (MirrorMode murni
wrapper tipis di atas DeltaEngine.compare()) -- file ini fokus ke
BackupMode dan TwoWayMode, plus beberapa test end-to-end SyncEngine
per mode untuk memastikan pipeline (scan -> mode -> queue -> executor)
nyambung dengan benar untuk ketiga mode.
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from action import ActionDirection, ActionType
from models import FileRecord, FileStatus
from sync import SyncEngine
from sync_modes import BackupMode, MirrorMode, TwoWayMode, get_mode


def _record(path: str, size: int, mtime: float, hash_: str, status: FileStatus = FileStatus.UNCHANGED) -> FileRecord:
    return FileRecord(path=path, size=size, modified_time=mtime, hash=hash_, status=status)


class TestBackupMode(unittest.TestCase):
    def setUp(self) -> None:
        self.mode = BackupMode()

    def test_copy_new_source_file(self) -> None:
        source = {"a.txt": _record("a.txt", 10, 1.0, "h1")}
        destination: dict[str, FileRecord] = {}

        actions = self.mode.generate_actions(source, destination)

        self.assertEqual(len(actions), 1)
        self.assertEqual(actions[0].action, ActionType.COPY)
        self.assertEqual(actions[0].path, "a.txt")

    def test_update_when_source_changed(self) -> None:
        source = {"a.txt": _record("a.txt", 10, 1.0, "h-new")}
        destination = {"a.txt": _record("a.txt", 9, 0.5, "h-old")}

        actions = self.mode.generate_actions(source, destination)

        self.assertEqual(len(actions), 1)
        self.assertEqual(actions[0].action, ActionType.UPDATE)

    def test_no_delete_when_file_removed_from_source(self) -> None:
        """Inti Backup Mode: file hilang dari source TIDAK menghasilkan
        DELETE -- destination adalah arsip."""
        source: dict[str, FileRecord] = {}
        destination = {"old.txt": _record("old.txt", 10, 1.0, "h1")}

        actions = self.mode.generate_actions(source, destination)

        self.assertEqual(actions, [])

    def test_destination_only_file_is_left_alone(self) -> None:
        """File ekstra di destination (tidak pernah ada di source) juga
        tidak menghasilkan aksi apa pun."""
        source = {"a.txt": _record("a.txt", 10, 1.0, "h1")}
        destination = {
            "a.txt": _record("a.txt", 10, 1.0, "h1"),
            "extra.txt": _record("extra.txt", 5, 1.0, "h2"),
        }

        actions = self.mode.generate_actions(source, destination)

        self.assertEqual(actions, [])


class TestTwoWayMode(unittest.TestCase):
    def setUp(self) -> None:
        self.mode = TwoWayMode()

    def test_new_source_file_copies_to_destination(self) -> None:
        source = {"a.txt": _record("a.txt", 10, 1.0, "h1", status=FileStatus.NEW)}
        destination: dict[str, FileRecord] = {}

        actions = self.mode.generate_actions(source, destination)

        self.assertEqual(len(actions), 1)
        self.assertEqual(actions[0].action, ActionType.COPY)
        self.assertEqual(actions[0].direction, ActionDirection.TO_DESTINATION)

    def test_new_destination_file_copies_to_source(self) -> None:
        source: dict[str, FileRecord] = {}
        destination = {"b.txt": _record("b.txt", 10, 1.0, "h1", status=FileStatus.NEW)}

        actions = self.mode.generate_actions(source, destination)

        self.assertEqual(len(actions), 1)
        self.assertEqual(actions[0].action, ActionType.COPY)
        self.assertEqual(actions[0].direction, ActionDirection.TO_SOURCE)

    def test_identical_file_produces_no_action(self) -> None:
        source = {"a.txt": _record("a.txt", 10, 1.0, "same-hash")}
        destination = {"a.txt": _record("a.txt", 10, 1.0, "same-hash")}

        actions = self.mode.generate_actions(source, destination)

        self.assertEqual(actions, [])

    def test_source_only_changed_updates_destination(self) -> None:
        source = {"a.txt": _record("a.txt", 20, 2.0, "h-new", status=FileStatus.MODIFIED)}
        destination = {"a.txt": _record("a.txt", 10, 1.0, "h-old", status=FileStatus.UNCHANGED)}

        actions = self.mode.generate_actions(source, destination)

        self.assertEqual(len(actions), 1)
        self.assertEqual(actions[0].action, ActionType.UPDATE)
        self.assertEqual(actions[0].direction, ActionDirection.TO_DESTINATION)

    def test_destination_only_changed_updates_source(self) -> None:
        source = {"a.txt": _record("a.txt", 10, 1.0, "h-old", status=FileStatus.UNCHANGED)}
        destination = {"a.txt": _record("a.txt", 20, 2.0, "h-new", status=FileStatus.MODIFIED)}

        actions = self.mode.generate_actions(source, destination)

        self.assertEqual(len(actions), 1)
        self.assertEqual(actions[0].action, ActionType.UPDATE)
        self.assertEqual(actions[0].direction, ActionDirection.TO_SOURCE)

    def test_both_sides_changed_is_conflict(self) -> None:
        source = {"a.txt": _record("a.txt", 20, 2.0, "h-source", status=FileStatus.MODIFIED)}
        destination = {"a.txt": _record("a.txt", 30, 3.0, "h-dest", status=FileStatus.MODIFIED)}

        actions = self.mode.generate_actions(source, destination)

        self.assertEqual(len(actions), 1)
        self.assertEqual(actions[0].action, ActionType.CONFLICT)

    def test_deleted_on_one_side_but_alive_on_other_is_conflict(self) -> None:
        """Kasus ambigu: source menghapus file, destination masih punya --
        SENGAJA tidak ditebak, ditandai CONFLICT (lihat docstring modul)."""
        source = {"a.txt": _record("a.txt", 10, 1.0, "h1", status=FileStatus.DELETED)}
        destination = {"a.txt": _record("a.txt", 10, 1.0, "h1", status=FileStatus.UNCHANGED)}

        actions = self.mode.generate_actions(source, destination)

        self.assertEqual(len(actions), 1)
        self.assertEqual(actions[0].action, ActionType.CONFLICT)

    def test_deleted_on_both_sides_produces_no_action(self) -> None:
        source = {"a.txt": _record("a.txt", 10, 1.0, "h1", status=FileStatus.DELETED)}
        destination = {"a.txt": _record("a.txt", 10, 1.0, "h1", status=FileStatus.DELETED)}

        actions = self.mode.generate_actions(source, destination)

        self.assertEqual(actions, [])


class TestGetMode(unittest.TestCase):
    def test_known_names_return_correct_types(self) -> None:
        self.assertIsInstance(get_mode("mirror"), MirrorMode)
        self.assertIsInstance(get_mode("BACKUP"), BackupMode)
        self.assertIsInstance(get_mode(" twoway "), TwoWayMode)

    def test_unknown_name_raises(self) -> None:
        with self.assertRaises(ValueError):
            get_mode("does-not-exist")


class SyncEngineModeTestCase(unittest.TestCase):
    """Test end-to-end (scan -> mode -> queue -> executor) per mode,
    memakai folder temporary sungguhan seperti test_sync.py."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        base = Path(self._tmp.name)

        self.source = base / "source"
        self.destination = base / "destination"
        self.source.mkdir()
        self.destination.mkdir()

        self.manifest_dir = base / "manifest_db"
        self.queue_db_path = base / "queue_db" / "queue.db"
        self.manifest_dir.mkdir()
        self.queue_db_path.parent.mkdir()

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _make_engine(self, mode) -> SyncEngine:
        return SyncEngine(
            manifest_dir=self.manifest_dir,
            queue_db_path=self.queue_db_path,
            mode=mode,
        )

    def _write(self, root: Path, relative_path: str, content: str) -> None:
        path = root / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)

    # -- Backup Mode ------------------------------------------------

    def test_backup_mode_never_deletes_destination(self) -> None:
        self._write(self.source, "keep.txt", "v1")
        self._write(self.source, "gone.txt", "v1")
        engine = self._make_engine(BackupMode())
        engine.sync(self.source, self.destination)

        (self.source / "gone.txt").unlink()
        summary = engine.sync_once()

        self.assertEqual(summary.deleted_files, 0)
        self.assertTrue((self.destination / "gone.txt").exists())
        self.assertTrue((self.destination / "keep.txt").exists())

    def test_backup_mode_ignores_destination_only_file(self) -> None:
        self._write(self.source, "a.txt", "v1")
        self._write(self.destination, "archive_only.txt", "manually placed")
        engine = self._make_engine(BackupMode())
        summary = engine.sync(self.source, self.destination)

        self.assertEqual(summary.deleted_files, 0)
        self.assertTrue((self.destination / "archive_only.txt").exists())

    # -- Two-Way Mode -------------------------------------------------

    def test_twoway_mode_copies_both_directions(self) -> None:
        self._write(self.source, "from_source.txt", "hello")
        self._write(self.destination, "from_dest.txt", "world")

        engine = self._make_engine(TwoWayMode())
        summary = engine.sync(self.source, self.destination)

        self.assertEqual(summary.copied_files, 2)
        self.assertEqual(summary.conflicts, 0)
        self.assertEqual((self.destination / "from_source.txt").read_text(), "hello")
        self.assertEqual((self.source / "from_dest.txt").read_text(), "world")

    def test_twoway_mode_reports_conflict_without_executing(self) -> None:
        self._write(self.source, "a.txt", "same")
        self._write(self.destination, "a.txt", "same")
        engine = self._make_engine(TwoWayMode())
        engine.sync(self.source, self.destination)

        # Kedua sisi mengubah file yang sama di antara dua sync run.
        self._write(self.source, "a.txt", "source version")
        self._write(self.destination, "a.txt", "destination version")
        summary = engine.sync_once()

        self.assertEqual(summary.conflicts, 1)
        self.assertEqual(summary.copied_files, 0)
        self.assertEqual(summary.updated_files, 0)
        self.assertEqual(len(engine.conflicts), 1)
        self.assertEqual(engine.conflicts[0].action, ActionType.CONFLICT)
        # File TIDAK disentuh sama sekali -- masing-masing versi tetap.
        self.assertEqual((self.source / "a.txt").read_text(), "source version")
        self.assertEqual((self.destination / "a.txt").read_text(), "destination version")


if __name__ == "__main__":
    unittest.main()
