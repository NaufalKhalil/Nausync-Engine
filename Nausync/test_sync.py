"""
Unit test untuk SyncEngine (sync.py).

Setiap test memakai folder temporary sendiri (source, destination) dan
manifest_dir/queue_db_path temporary sendiri, supaya test-test ini
terisolasi satu sama lain dan tidak menyentuh data/manifest.db /
data/queue.db yang sesungguhnya dipakai aplikasi.
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from sync import SyncEngine


class SyncEngineTestCase(unittest.TestCase):
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

    def _make_engine(self) -> SyncEngine:
        return SyncEngine(
            manifest_dir=self.manifest_dir,
            queue_db_path=self.queue_db_path,
        )

    def _write(self, root: Path, relative_path: str, content: str) -> None:
        path = root / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)

    # ------------------------------------------------------------------

    def test_source_kosong_destination_kosong(self) -> None:
        engine = self._make_engine()
        summary = engine.sync(self.source, self.destination)

        self.assertEqual(summary.scanned_files, 0)
        self.assertEqual(summary.copied_files, 0)
        self.assertEqual(summary.updated_files, 0)
        self.assertEqual(summary.deleted_files, 0)
        self.assertEqual(summary.failed_files, 0)

    def test_destination_kosong_menghasilkan_copy(self) -> None:
        self._write(self.source, "a.txt", "hello")
        self._write(self.source, "sub/b.txt", "world")

        engine = self._make_engine()
        summary = engine.sync(self.source, self.destination)

        self.assertEqual(summary.copied_files, 2)
        self.assertEqual(summary.updated_files, 0)
        self.assertEqual(summary.deleted_files, 0)
        self.assertEqual((self.destination / "a.txt").read_text(), "hello")
        self.assertEqual((self.destination / "sub" / "b.txt").read_text(), "world")

    def test_tidak_ada_perubahan_setelah_sync_kedua(self) -> None:
        self._write(self.source, "a.txt", "hello")
        engine = self._make_engine()
        engine.sync(self.source, self.destination)

        # Sync ulang tanpa perubahan apa pun.
        summary = engine.sync_once()

        self.assertEqual(summary.copied_files, 0)
        self.assertEqual(summary.updated_files, 0)
        self.assertEqual(summary.deleted_files, 0)
        self.assertEqual(summary.skipped_files, 1)

    def test_hanya_copy(self) -> None:
        self._write(self.source, "existing.txt", "same")
        self._write(self.destination, "existing.txt", "same")
        engine = self._make_engine()
        # sinkronkan hash "same" dulu ke database via satu sync supaya
        # baseline manifest konsisten (hash source & destination sama).
        engine.sync(self.source, self.destination)

        self._write(self.source, "new_file.txt", "brand new")
        summary = engine.sync_once()

        self.assertEqual(summary.copied_files, 1)
        self.assertEqual(summary.updated_files, 0)
        self.assertEqual(summary.deleted_files, 0)
        self.assertEqual((self.destination / "new_file.txt").read_text(), "brand new")

    def test_hanya_update(self) -> None:
        self._write(self.source, "a.txt", "version 1")
        engine = self._make_engine()
        engine.sync(self.source, self.destination)

        self._write(self.source, "a.txt", "version 2")
        summary = engine.sync_once()

        self.assertEqual(summary.copied_files, 0)
        self.assertEqual(summary.updated_files, 1)
        self.assertEqual(summary.deleted_files, 0)
        self.assertEqual((self.destination / "a.txt").read_text(), "version 2")

    def test_hanya_delete(self) -> None:
        self._write(self.source, "a.txt", "keep me")
        self._write(self.source, "b.txt", "remove me")
        engine = self._make_engine()
        engine.sync(self.source, self.destination)

        (self.source / "b.txt").unlink()
        summary = engine.sync_once()

        self.assertEqual(summary.copied_files, 0)
        self.assertEqual(summary.updated_files, 0)
        self.assertEqual(summary.deleted_files, 1)
        self.assertTrue((self.destination / "a.txt").exists())
        self.assertFalse((self.destination / "b.txt").exists())

    def test_kombinasi_copy_update_delete(self) -> None:
        self._write(self.source, "unchanged.txt", "stays the same")
        self._write(self.source, "to_update.txt", "old version")
        self._write(self.source, "to_delete.txt", "will be removed")
        engine = self._make_engine()
        engine.sync(self.source, self.destination)

        self._write(self.source, "to_update.txt", "new version")
        (self.source / "to_delete.txt").unlink()
        self._write(self.source, "to_add.txt", "freshly added")

        summary = engine.sync_once()

        self.assertEqual(summary.copied_files, 1)
        self.assertEqual(summary.updated_files, 1)
        self.assertEqual(summary.deleted_files, 1)
        self.assertEqual(summary.failed_files, 0)

        self.assertEqual((self.destination / "unchanged.txt").read_text(), "stays the same")
        self.assertEqual((self.destination / "to_update.txt").read_text(), "new version")
        self.assertFalse((self.destination / "to_delete.txt").exists())
        self.assertEqual((self.destination / "to_add.txt").read_text(), "freshly added")

    def test_summary_sebelum_sync_raises(self) -> None:
        engine = self._make_engine()
        with self.assertRaises(RuntimeError):
            engine.summary()


if __name__ == "__main__":
    unittest.main()
