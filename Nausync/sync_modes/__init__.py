"""
Sync Modes -- strategi sinkronisasi (Strategy Pattern).

Satu titik import untuk seluruh mode:

    from sync_modes import MirrorMode, BackupMode, TwoWayMode, get_mode

`get_mode()` opsional, memudahkan pemilihan mode dari string (mis. dari
argumen CLI atau file konfigurasi) tanpa if/elif di pemanggil.

Menambah mode baru:
    1. Buat file baru di folder ini, mis. `sync_modes/archive.py`,
       berisi kelas yang mewarisi `SyncMode` (lihat base.py).
    2. Tambahkan importnya + entri di `_REGISTRY` di bawah.
    Tidak ada file lain (sync.py, delta.py, dst.) yang perlu diubah.
"""

from __future__ import annotations

from sync_modes.backup import BackupMode
from sync_modes.base import SyncMode
from sync_modes.mirror import MirrorMode
from sync_modes.twoway import TwoWayMode

_REGISTRY: dict[str, type[SyncMode]] = {
    "mirror": MirrorMode,
    "backup": BackupMode,
    "twoway": TwoWayMode,
}


def get_mode(name: str) -> SyncMode:
    """Membuat instance SyncMode dari nama (case-insensitive).

    Raises:
        ValueError: jika nama tidak dikenal, dengan pesan berisi daftar
            nama yang valid supaya mudah di-debug dari CLI.
    """
    key = name.strip().lower()
    try:
        mode_cls = _REGISTRY[key]
    except KeyError as exc:
        valid = ", ".join(sorted(_REGISTRY))
        raise ValueError(f"Mode sinkronisasi tidak dikenal: {name!r}. Pilihan: {valid}") from exc
    return mode_cls()


__all__ = ["SyncMode", "MirrorMode", "BackupMode", "TwoWayMode", "get_mode"]
