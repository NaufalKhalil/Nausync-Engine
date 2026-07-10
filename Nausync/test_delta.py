"""
Unit test untuk Delta Engine.

Menguji empat skenario inti sesuai spesifikasi:
    1. COPY      -> file ada di source, tidak ada di destination.
    2. UPDATE    -> file ada di keduanya, tapi hash berbeda.
    3. DELETE    -> file ada di destination, tidak ada di source.
    4. UNCHANGED -> file identik -> tidak menghasilkan Action apa pun.

Menggunakan `unittest` dari standard library, tanpa dependency
tambahan, dan tidak menyentuh filesystem/database sungguhan --
manifest dibuat sebagai dict[str, FileRecord] secara langsung, sesuai
prinsip Delta Engine yang hanya membaca dua manifest in-memory.
"""

from __future__ import annotations

import unittest

from action import ActionType
from delta import DeltaEngine
from models import FileRecord, FileStatus


class TestDeltaEngine(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = DeltaEngine()

    def test_copy_when_file_only_in_source(self) -> None:
        """File ada di source tapi tidak ada di destination -> COPY."""
        source = {
            "music.mp3": FileRecord(
                path="music.mp3",
                size=1000,
                modified_time=111.0,
                hash="hash-music",
                status=FileStatus.UNCHANGED,
            ),
        }
        destination: dict[str, FileRecord] = {}

        actions = self.engine.compare(source, destination)

        self.assertEqual(len(actions), 1)
        action = actions[0]
        self.assertEqual(action.action, ActionType.COPY)
        self.assertEqual(action.path, "music.mp3")
        self.assertEqual(action.source_hash, "hash-music")
        self.assertIsNone(action.destination_hash)
        self.assertEqual(action.size, 1000)

    def test_update_when_hash_differs(self) -> None:
        """File ada di keduanya tapi hash berbeda -> UPDATE."""
        source = {
            "README.md": FileRecord(
                path="README.md",
                size=200,
                modified_time=222.0,
                hash="hash-new",
                status=FileStatus.UNCHANGED,
            ),
        }
        destination = {
            "README.md": FileRecord(
                path="README.md",
                size=150,
                modified_time=111.0,
                hash="hash-old",
                status=FileStatus.UNCHANGED,
            ),
        }

        actions = self.engine.compare(source, destination)

        self.assertEqual(len(actions), 1)
        action = actions[0]
        self.assertEqual(action.action, ActionType.UPDATE)
        self.assertEqual(action.path, "README.md")
        self.assertEqual(action.source_hash, "hash-new")
        self.assertEqual(action.destination_hash, "hash-old")

    def test_delete_when_file_only_in_destination(self) -> None:
        """File ada di destination tapi tidak ada di source -> DELETE."""
        source: dict[str, FileRecord] = {}
        destination = {
            "video.mp4": FileRecord(
                path="video.mp4",
                size=5000,
                modified_time=333.0,
                hash="hash-video",
                status=FileStatus.UNCHANGED,
            ),
        }

        actions = self.engine.compare(source, destination)

        self.assertEqual(len(actions), 1)
        action = actions[0]
        self.assertEqual(action.action, ActionType.DELETE)
        self.assertEqual(action.path, "video.mp4")
        self.assertIsNone(action.source_hash)
        self.assertEqual(action.destination_hash, "hash-video")

    def test_no_action_when_file_identical(self) -> None:
        """File identik (hash sama) di kedua manifest -> tidak ada Action."""
        source = {
            "logo.png": FileRecord(
                path="logo.png",
                size=300,
                modified_time=444.0,
                hash="hash-logo",
                status=FileStatus.UNCHANGED,
            ),
        }
        destination = {
            "logo.png": FileRecord(
                path="logo.png",
                size=300,
                modified_time=444.0,
                hash="hash-logo",
                status=FileStatus.UNCHANGED,
            ),
        }

        actions = self.engine.compare(source, destination)

        self.assertEqual(actions, [])

    def test_combined_scenario_matches_specification_example(self) -> None:
        """Skenario gabungan sesuai contoh pada spesifikasi:

        Manifest A: README.md (beda hash), logo.png (sama), music.mp3 (baru)
        Manifest B: README.md, logo.png, video.mp4 (harus dihapus)
        Hasil    : UPDATE README.md, COPY music.mp3, DELETE video.mp4
        """
        source = {
            "README.md": FileRecord(
                path="README.md", size=10, modified_time=1.0, hash="a1"
            ),
            "logo.png": FileRecord(
                path="logo.png", size=20, modified_time=2.0, hash="b1"
            ),
            "music.mp3": FileRecord(
                path="music.mp3", size=30, modified_time=3.0, hash="c1"
            ),
        }
        destination = {
            "README.md": FileRecord(
                path="README.md", size=10, modified_time=1.0, hash="a0"
            ),
            "logo.png": FileRecord(
                path="logo.png", size=20, modified_time=2.0, hash="b1"
            ),
            "video.mp4": FileRecord(
                path="video.mp4", size=40, modified_time=4.0, hash="d1"
            ),
        }

        actions = self.engine.compare(source, destination)
        result = {(a.action, a.path) for a in actions}

        self.assertEqual(
            result,
            {
                (ActionType.UPDATE, "README.md"),
                (ActionType.COPY, "music.mp3"),
                (ActionType.DELETE, "video.mp4"),
            },
        )

    def test_deleted_status_records_are_ignored(self) -> None:
        """Record berstatus DELETED (riwayat lama di DB) tidak boleh
        memicu aksi apa pun -- baik di source maupun destination."""
        source = {
            "old.txt": FileRecord(
                path="old.txt",
                size=10,
                modified_time=1.0,
                hash="h1",
                status=FileStatus.DELETED,
            ),
        }
        destination = {
            "old.txt": FileRecord(
                path="old.txt",
                size=10,
                modified_time=1.0,
                hash="h1",
                status=FileStatus.DELETED,
            ),
        }

        actions = self.engine.compare(source, destination)

        self.assertEqual(actions, [])


if __name__ == "__main__":
    unittest.main()
