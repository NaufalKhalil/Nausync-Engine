"""
Base class untuk Sync Mode -- Strategy Pattern.

Setiap mode sinkronisasi (`MirrorMode`, `BackupMode`, `TwoWayMode`, dan
mode baru di masa depan) mengimplementasikan `SyncMode` ini dengan satu
method: `generate_actions()`. SyncEngine (sync.py) TIDAK PERNAH tahu
detail tiap mode -- ia hanya memanggil method ini dan mendapatkan
`list[Action]` yang siap dipisah (conflict vs actionable) lalu
di-enqueue, persis seperti hasil `DeltaEngine.compare()` sebelum
refactor ini.

Menambah mode baru = membuat kelas baru yang mewarisi `SyncMode` di
folder ini, TANPA menyentuh SyncEngine atau mode lain sama sekali
(Open/Closed Principle). Tidak ada if/elif mode di mana pun dalam
codebase -- SyncEngine cukup menerima instance `SyncMode` apa pun lewat
constructor (`SyncEngine(mode=BackupMode())`, dst.).
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Callable

from action import Action
from models import FileRecord
from progress import DeltaProgress

DeltaProgressCallback = Callable[[DeltaProgress], None]


class SyncMode(ABC):
    """Kontrak yang harus dipenuhi setiap strategi sinkronisasi."""

    #: Nama pendek mode, dipakai untuk logging/CLI (mis. "MIRROR").
    name: str = "BASE"

    @abstractmethod
    def generate_actions(
        self,
        source_manifest: dict[str, FileRecord],
        destination_manifest: dict[str, FileRecord],
        progress_callback: DeltaProgressCallback | None = None,
    ) -> list[Action]:
        """Membandingkan dua manifest dan menghasilkan daftar Action.

        Signature-nya SENGAJA identik dengan `DeltaEngine.compare()`
        (parameter, urutan, tipe balik) supaya SyncEngine bisa memakai
        SyncMode manapun secara seragam tanpa percabangan logic.

        Boleh menghasilkan `Action` ber-tipe `ActionType.CONFLICT` --
        SyncEngine akan memisahkannya dari antrian eksekusi secara
        otomatis (lihat sync.py), jadi setiap mode bebas menandai
        situasi ambigu sebagai CONFLICT tanpa perlu tahu bagaimana
        SyncEngine menanganinya lebih lanjut.

        Returns:
            Daftar `Action`, urutan bebas (SyncEngine tidak mengasumsikan
            urutan tertentu selain yang dijamin masing-masing mode untuk
            keperluan testing).
        """
        raise NotImplementedError

    def is_bidirectional(self) -> bool:
        """True jika mode ini bisa menghasilkan Action dengan
        `direction=ActionDirection.TO_SOURCE` (menulis balik ke source).

        Dipakai murni sebagai informasi/validasi (mis. peringatan di
        CLI bahwa source juga akan ditulis) -- Executor sendiri sudah
        menangani kedua arah secara generik lewat `Action.direction`,
        jadi flag ini TIDAK mempengaruhi eksekusi.
        """
        return False
