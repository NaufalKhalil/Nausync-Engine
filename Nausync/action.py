"""
Model data untuk hasil perbandingan dua manifest (Delta Engine) dan
strategi sinkronisasi (Sync Mode).

Dipisah dari delta.py agar `Action`/`ActionType`/`ActionDirection` bisa
dipakai ulang oleh modul lain (Queue Engine, Executor, sync_modes/)
tanpa perlu ikut mengimpor logic perbandingan manifest itu sendiri.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class ActionType(str, Enum):
    """Jenis aksi yang harus dilakukan agar kedua manifest sinkron
    sesuai mode yang dipakai (lihat sync_modes/).

    Mewarisi `str` mengikuti pola `FileStatus`/`FolderStatus` di
    models.py -- bisa dibandingkan langsung dengan string literal
    ("COPY", dst.) tanpa kehilangan type-safety di kode Python.
    """

    COPY = "COPY"
    UPDATE = "UPDATE"
    DELETE = "DELETE"
    CONFLICT = "CONFLICT"
    # RENAME akan ditambahkan pada versi berikutnya.
    #
    # CONFLICT ditambahkan untuk Two-Way Sync: dipakai saat kedua sisi
    # berubah bersamaan (atau kasus ambigu lain, mis. salah satu sisi
    # menghapus file yang masih ada di sisi lain) dan Engine SENGAJA
    # tidak menebak siapa yang benar. Action ber-tipe CONFLICT TIDAK
    # pernah dieksekusi oleh Executor -- SyncEngine memisahkannya dari
    # antrian eksekusi dan hanya melaporkannya (lihat sync.py). Resolver
    # (mis. "ambil yang terbaru", "tanya user") belum diimplementasikan
    # dengan sengaja, sesuai spesifikasi tahap ini.


class ActionDirection(str, Enum):
    """Arah eksekusi sebuah Action: dari mana dibaca, ke mana ditulis.

    Ditambahkan untuk mendukung Two-Way Sync, di mana file bisa mengalir
    dari destination KE source (bukan cuma source -> destination seperti
    Mirror/Backup). Default `TO_DESTINATION` menjaga PERILAKU LAMA persis
    sama -- Mirror/Backup tidak pernah men-set field ini secara eksplisit,
    jadi selalu jatuh ke default ini, identik dengan sebelum field ini ada.
    """

    TO_DESTINATION = "TO_DESTINATION"  # source -> destination (perilaku lama)
    TO_SOURCE = "TO_SOURCE"  # destination -> source (khusus Two-Way Sync)


@dataclass(slots=True)
class Action:
    """Satu aksi tunggal hasil perbandingan dua manifest.

    Field hash/size/modified_time bersifat opsional karena relevansinya
    berbeda tergantung jenis aksi:
        - COPY     : hash dari sisi yang PUNYA filenya terisi, sisi yang
                     belum punya None. size/modified_time mengikuti versi
                     yang akan disalin.
        - UPDATE   : source_hash & destination_hash sama-sama terisi
                     (hash lama tiap sisi, untuk verifikasi/referensi).
                     size/modified_time mengikuti versi yang MENANG
                     (yang akan menggantikan versi di sisi lain).
        - DELETE   : hash dari sisi yang akan dihapus terisi, size/
                     modified_time juga mengikuti sisi tersebut.
        - CONFLICT : source_hash & destination_hash diisi hash/None
                     apa adanya dari masing-masing sisi, murni untuk
                     pelaporan -- tidak dieksekusi.

    `direction` menentukan root mana yang dibaca dan mana yang ditulis
    saat Executor menjalankan Action ini (lihat executor.py). Default
    `TO_DESTINATION` = source -> destination, sama seperti sebelum field
    ini ditambahkan.
    """

    action: ActionType
    path: str
    source_hash: str | None = None
    destination_hash: str | None = None
    size: int | None = None
    modified_time: float | None = None
    direction: ActionDirection = ActionDirection.TO_DESTINATION