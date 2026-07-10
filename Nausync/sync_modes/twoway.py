"""
Two-Way Sync Mode -- perubahan mengalir dua arah antara source dan
destination.

    file baru di source                  -> COPY ke destination
    file baru di destination             -> COPY ke source
    file berubah di salah satu sisi saja -> disalin ke sisi lain
    file berubah di KEDUA sisi           -> CONFLICT (tidak dieksekusi)

Resolver CONFLICT SENGAJA belum diimplementasikan (sesuai spesifikasi
tahap ini) -- Action ber-tipe `ActionType.CONFLICT` hanya dikumpulkan
untuk dilaporkan; SyncEngine memfilternya keluar dari antrian eksekusi
secara otomatis (lihat sync.py).

Bagaimana "berubah" dideteksi:
    `FileRecord.status` (NEW/MODIFIED/UNCHANGED/DELETED) sudah dihitung
    oleh Scanner SAAT scan masing-masing sisi (relatif terhadap riwayat
    manifest sisi itu sendiri) -- lihat scanner.py. Two-Way Mode
    memakai status ini langsung, TANPA menghitung ulang apa pun:
        - source.status NEW/MODIFIED    -> "source berubah sejak
          terakhir kali sisi ini di-scan"
        - destination.status NEW/MODIFIED -> sama, untuk destination
    Kalau status di kedua sisi menunjukkan perubahan -> CONFLICT.
    Kalau hanya satu sisi -> sisi yang berubah "menang", disalin ke
    sisi lain. Kalau tidak ada status yang menunjukkan perubahan tapi
    hash tetap berbeda (mis. sinkronisasi pertama kali dengan file yang
    sudah lebih dulu berbeda di kedua sisi sebelum NauSync pernah
    melihatnya) -> juga CONFLICT, karena Engine tidak punya cara aman
    untuk menentukan siapa yang benar.

Kasus dihapus di satu sisi, masih ada di sisi lain:
    Spesifikasi tahap ini TIDAK mendefinisikan propagasi delete untuk
    Two-Way Sync (beda dengan Mirror/Backup yang eksplisit soal ini).
    Menebak ("anggap saja file baru" atau "hapus otomatis di sisi lain")
    berisiko kehilangan data secara diam-diam. Karena itu kasus ini
    SENGAJA ditandai CONFLICT juga -- aman secara default, dan sudah
    ada infrastrukturnya (kolom status DELETED) begitu resolver
    dikembangkan nanti.
"""

from __future__ import annotations

from action import Action, ActionDirection, ActionType
from delta import DeltaProgressCallback, is_same
from models import FileRecord, FileStatus
from progress import DeltaProgress, ProgressThrottler
from sync_modes.base import SyncMode

_CHANGED_STATUSES = (FileStatus.NEW, FileStatus.MODIFIED)


class TwoWayMode(SyncMode):
    """Sinkronisasi dua arah dengan deteksi konflik (tanpa resolver)."""

    name = "TWOWAY"

    def is_bidirectional(self) -> bool:
        return True

    def generate_actions(
        self,
        source_manifest: dict[str, FileRecord],
        destination_manifest: dict[str, FileRecord],
        progress_callback: DeltaProgressCallback | None = None,
    ) -> list[Action]:
        all_paths = sorted(set(source_manifest) | set(destination_manifest))

        to_destination: list[Action] = []
        to_source: list[Action] = []
        conflicts: list[Action] = []

        total = len(all_paths)
        processed = 0
        throttle = ProgressThrottler()

        def _report(force: bool = False) -> None:
            if progress_callback is not None and (force or throttle.should_emit()):
                progress_callback(
                    DeltaProgress(
                        compared=processed,
                        total=total,
                        copy_count=len(to_destination) + len(to_source),
                        update_count=0,
                        delete_count=0,
                        conflict_count=len(conflicts),
                    )
                )

        for path in all_paths:
            source_record = source_manifest.get(path)
            destination_record = destination_manifest.get(path)
            source_alive = source_record is not None and source_record.status is not FileStatus.DELETED
            destination_alive = (
                destination_record is not None and destination_record.status is not FileStatus.DELETED
            )

            if source_alive and destination_alive:
                self._handle_both_present(
                    path, source_record, destination_record, to_destination, to_source, conflicts
                )
            elif source_alive and not destination_alive:
                self._handle_one_sided(
                    path,
                    present_record=source_record,
                    present_is_source=True,
                    ever_existed_other_side=destination_record is not None,
                    to_destination=to_destination,
                    to_source=to_source,
                    conflicts=conflicts,
                )
            elif destination_alive and not source_alive:
                self._handle_one_sided(
                    path,
                    present_record=destination_record,
                    present_is_source=False,
                    ever_existed_other_side=source_record is not None,
                    to_destination=to_destination,
                    to_source=to_source,
                    conflicts=conflicts,
                )
            # else: mati di kedua sisi (dihapus di keduanya, atau tidak
            # pernah ada) -> tidak ada Action.

            processed += 1
            _report()

        _report(force=True)
        return to_destination + to_source + conflicts

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    @staticmethod
    def _handle_both_present(
        path: str,
        source_record: FileRecord,
        destination_record: FileRecord,
        to_destination: list[Action],
        to_source: list[Action],
        conflicts: list[Action],
    ) -> None:
        """File hidup di kedua sisi -- identik, satu sisi berubah, atau
        kedua sisi berubah (CONFLICT)."""
        if is_same(source_record, destination_record):
            return

        source_changed = source_record.status in _CHANGED_STATUSES
        destination_changed = destination_record.status in _CHANGED_STATUSES

        if source_changed and destination_changed:
            conflicts.append(
                Action(
                    action=ActionType.CONFLICT,
                    path=path,
                    source_hash=source_record.hash,
                    destination_hash=destination_record.hash,
                    size=source_record.size,
                    modified_time=source_record.modified_time,
                )
            )
        elif source_changed:
            to_destination.append(
                Action(
                    action=ActionType.UPDATE,
                    path=path,
                    source_hash=source_record.hash,
                    destination_hash=destination_record.hash,
                    size=source_record.size,
                    modified_time=source_record.modified_time,
                    direction=ActionDirection.TO_DESTINATION,
                )
            )
        elif destination_changed:
            to_source.append(
                Action(
                    action=ActionType.UPDATE,
                    path=path,
                    source_hash=source_record.hash,
                    destination_hash=destination_record.hash,
                    size=destination_record.size,
                    modified_time=destination_record.modified_time,
                    direction=ActionDirection.TO_SOURCE,
                )
            )
        else:
            # Hash berbeda tapi tidak ada sisi yang tercatat "berubah" --
            # kemungkinan besar sinkronisasi pertama kali dengan file
            # yang sudah lebih dulu divergen. Tidak aman ditebak.
            conflicts.append(
                Action(
                    action=ActionType.CONFLICT,
                    path=path,
                    source_hash=source_record.hash,
                    destination_hash=destination_record.hash,
                    size=source_record.size,
                    modified_time=source_record.modified_time,
                )
            )

    @staticmethod
    def _handle_one_sided(
        path: str,
        present_record: FileRecord,
        present_is_source: bool,
        ever_existed_other_side: bool,
        to_destination: list[Action],
        to_source: list[Action],
        conflicts: list[Action],
    ) -> None:
        """File hidup di satu sisi saja.

        Jika sisi lain memang TIDAK PERNAH punya file ini -> file baru,
        aman untuk disalin. Jika sisi lain PERNAH punya file ini (statusnya
        DELETED di sana) -> ambigu (file baru vs dihapus di sisi lain?)
        -> CONFLICT, lihat catatan modul di atas.
        """
        if ever_existed_other_side:
            conflicts.append(
                Action(
                    action=ActionType.CONFLICT,
                    path=path,
                    source_hash=present_record.hash if present_is_source else None,
                    destination_hash=None if present_is_source else present_record.hash,
                    size=present_record.size,
                    modified_time=present_record.modified_time,
                )
            )
            return

        if present_is_source:
            to_destination.append(
                Action(
                    action=ActionType.COPY,
                    path=path,
                    source_hash=present_record.hash,
                    destination_hash=None,
                    size=present_record.size,
                    modified_time=present_record.modified_time,
                    direction=ActionDirection.TO_DESTINATION,
                )
            )
        else:
            to_source.append(
                Action(
                    action=ActionType.COPY,
                    path=path,
                    source_hash=None,
                    destination_hash=present_record.hash,
                    size=present_record.size,
                    modified_time=present_record.modified_time,
                    direction=ActionDirection.TO_SOURCE,
                )
            )
