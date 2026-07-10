"""
Delta Engine -- modul perbandingan dua manifest.

Delta Engine TIDAK melakukan sinkronisasi, TIDAK menyalin file, TIDAK
melakukan networking, dan TIDAK mengakses filesystem maupun database
secara langsung. Ia murni membandingkan dua struktur data
(`dict[str, FileRecord]`) dan menghasilkan daftar `Action` yang
menjelaskan apa yang harus dilakukan agar destination manifest menjadi
sama dengan source manifest.

Kenapa dipisah dari Scanner/Database:
    - Scanner mendeteksi status SATU manifest terhadap kondisi disk
      saat ini (NEW/MODIFIED/DELETED/UNCHANGED terhadap folder yang
      sama).
    - Delta Engine membandingkan DUA manifest yang berbeda (mis. hasil
      scan lokal vs hasil scan remote) dan sama sekali tidak tahu-menahu
      soal disk maupun database.
    - Pemisahan ini membuat Delta Engine dapat dipakai ulang oleh Queue
      Engine pada tahap berikutnya tanpa membawa dependency ke
      Scanner/Database, dan mudah diuji dengan data dummy (in-memory).
"""

from __future__ import annotations

from typing import Callable

from action import Action, ActionType
from models import FileRecord, FileStatus
from progress import DeltaProgress, ProgressThrottler

DeltaProgressCallback = Callable[[DeltaProgress], None]


def is_present(record: FileRecord) -> bool:
    """Menentukan apakah sebuah FileRecord dianggap "ada" pada manifest.

    Manifest yang berasal dari `Database.get_all_files()` bisa berisi
    record berstatus DELETED yang sengaja tetap disimpan untuk riwayat
    (lihat database.py). Bagi Delta Engine, file berstatus DELETED
    harus diperlakukan seolah tidak ada di manifest tersebut --
    kalau tidak, file yang sudah lama dihapus bisa muncul lagi sebagai
    aksi COPY/DELETE yang keliru.

    PUBLIC (dipakai ulang oleh sync_modes/backup.py) -- Mirror dan
    Backup Mode sama-sama butuh definisi "ada" yang identik. Two-Way
    Mode (sync_modes/twoway.py) SENGAJA tidak memakai fungsi ini --
    status DELETED justru relevan di sana untuk mendeteksi kasus
    ambigu (dihapus di satu sisi, masih ada di sisi lain).
    """
    return record.status is not FileStatus.DELETED


def is_same(source: FileRecord, destination: FileRecord) -> bool:
    """Menentukan apakah dua FileRecord dianggap identik (tidak perlu aksi).

    Prioritas utama adalah `hash`, karena paling akurat untuk mendeteksi
    perubahan isi file. Jika salah satu hash tidak tersedia (None),
    Delta Engine jatuh ke perbandingan `size` + `modified_time` sebagai
    fallback, supaya tetap bisa bekerja pada manifest yang belum
    memiliki hash lengkap.

    PUBLIC -- dipakai ulang oleh seluruh sync_modes/ (Mirror, Backup,
    Two-Way) agar definisi "identik" konsisten di semua mode.
    """
    if source.hash is not None and destination.hash is not None:
        return source.hash == destination.hash
    return (
        source.size == destination.size
        and source.modified_time == destination.modified_time
    )


class DeltaEngine:
    """Membandingkan dua manifest dan menghasilkan daftar Action.

    Manifest yang diterima berbentuk `dict[str, FileRecord]` -- format
    yang sama dengan output `Database.get_all_files()` -- sehingga
    Delta Engine dapat langsung dipakai tanpa transformasi tambahan,
    baik untuk perbandingan dua manifest dari database yang berbeda
    maupun data buatan (mis. pada unit test).
    """

    def compare(
        self,
        source_manifest: dict[str, FileRecord],
        destination_manifest: dict[str, FileRecord],
        progress_callback: DeltaProgressCallback | None = None,
    ) -> list[Action]:
        """Membandingkan source_manifest terhadap destination_manifest.

        Args:
            source_manifest: Manifest acuan/tujuan (mis. Manifest A) --
                kondisi akhir yang diinginkan.
            destination_manifest: Manifest yang akan disesuaikan (mis.
                Manifest B) agar sama dengan source_manifest.
            progress_callback: opsional, dipanggil (throttled) selama
                perbandingan berjalan -- murni pelaporan progres
                (GENERATING_DELTA), tidak mempengaruhi hasil.

        Returns:
            Daftar `Action` (COPY/UPDATE/DELETE) yang jika dijalankan
            akan membuat destination sama dengan source. Hasil
            dikelompokkan per jenis aksi (COPY, lalu UPDATE, lalu
            DELETE) dan diurutkan berdasarkan path pada masing-masing
            kelompok, agar output deterministic dan mudah diuji.
        """
        source_files = {
            path: record
            for path, record in source_manifest.items()
            if is_present(record)
        }
        destination_files = {
            path: record
            for path, record in destination_manifest.items()
            if is_present(record)
        }

        copy_actions: list[Action] = []
        update_actions: list[Action] = []
        delete_actions: list[Action] = []

        total = len(source_files) + len(destination_files)
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
                        delete_count=len(delete_actions),
                    )
                )

        # 1. File yang ada di source -> COPY (belum ada di destination)
        #    atau UPDATE (ada, tapi berbeda). Jika sama, tidak ada aksi.
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
            # else: identik -> tidak menghasilkan Action.
            processed += 1
            _report()

        # 2. File yang ada di destination tapi tidak ada di source -> DELETE.
        for path in sorted(destination_files):
            if path in source_files:
                processed += 1
                _report()
                continue
            destination_record = destination_files[path]
            delete_actions.append(
                Action(
                    action=ActionType.DELETE,
                    path=path,
                    source_hash=None,
                    destination_hash=destination_record.hash,
                    size=destination_record.size,
                    modified_time=destination_record.modified_time,
                )
            )
            processed += 1
            _report()

        _report(force=True)
        return copy_actions + update_actions + delete_actions
