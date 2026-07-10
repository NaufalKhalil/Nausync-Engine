"""
One-Way Backup Mode -- source disalin ke destination, tapi destination
tidak pernah dihapus atau ditimpa balik. Destination berfungsi sebagai
arsip.

    file baru di source     -> COPY
    file berubah di source  -> UPDATE
    file dihapus dari source -> JANGAN hapus destination (dibiarkan)
    file baru di destination (tidak ada di source) -> dibiarkan

Beda satu-satunya dengan Mirror Mode: TIDAK PERNAH menghasilkan Action
ber-tipe DELETE. Dipakai ulang `is_present`/`is_same` dari delta.py
supaya definisi "ada"/"identik" konsisten dengan Mirror Mode -- hanya
langkah 2 (DELETE untuk file yang cuma ada di destination) yang
sengaja dihilangkan di sini.
"""

from __future__ import annotations

from action import Action, ActionType
from delta import DeltaProgressCallback, is_present, is_same
from models import FileRecord
from progress import DeltaProgress, ProgressThrottler
from sync_modes.base import SyncMode


class BackupMode(SyncMode):
    """Arsip satu-arah -- destination tidak pernah kehilangan data."""

    name = "BACKUP"

    def generate_actions(
        self,
        source_manifest: dict[str, FileRecord],
        destination_manifest: dict[str, FileRecord],
        progress_callback: DeltaProgressCallback | None = None,
    ) -> list[Action]:
        source_files = {
            path: record for path, record in source_manifest.items() if is_present(record)
        }
        destination_files = {
            path: record for path, record in destination_manifest.items() if is_present(record)
        }

        copy_actions: list[Action] = []
        update_actions: list[Action] = []

        total = len(source_files)
        processed = 0
        throttle = ProgressThrottler()

        def _report(force: bool = False) -> None:
            if progress_callback is not None and (force or throttle.should_emit()):
                progress_callback(
                    DeltaProgress(
                        compared=processed,
                        total=total,
                        copy_count=len(copy_actions),
                        update_count=len(update_actions),
                        delete_count=0,
                    )
                )

        # Hanya satu langkah: telusuri file di source. Tidak ada langkah
        # "file di destination tapi tidak di source -> DELETE" seperti di
        # Mirror Mode -- itulah esensi Backup Mode.
        for path in sorted(source_files):
            source_record = source_files[path]
            destination_record = destination_files.get(path)

            if destination_record is None:
                copy_actions.append(
                    Action(
                        action=ActionType.COPY,
                        path=path,
                        source_hash=source_record.hash,
                        destination_hash=None,
                        size=source_record.size,
                        modified_time=source_record.modified_time,
                    )
                )
            elif not is_same(source_record, destination_record):
                update_actions.append(
                    Action(
                        action=ActionType.UPDATE,
                        path=path,
                        source_hash=source_record.hash,
                        destination_hash=destination_record.hash,
                        size=source_record.size,
                        modified_time=source_record.modified_time,
                    )
                )
            # else: identik -> tidak ada Action.
            # File yang dihapus dari source, atau file ekstra yang cuma
            # ada di destination, keduanya SENGAJA tidak diproses sama
            # sekali -- destination adalah arsip, bukan cermin.

            processed += 1
            _report()

        _report(force=True)
        return copy_actions + update_actions
