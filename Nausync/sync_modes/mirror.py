"""
Mirror Mode -- source adalah master, destination dibuat identik.

    file baru di source     -> COPY ke destination
    file berubah di source  -> UPDATE destination
    file dihapus dari source -> DELETE di destination
    file baru di destination (tidak ada di source) -> dianggap tidak
        valid, DIHAPUS

Ini adalah perilaku ENGINE YANG SUDAH ADA sebelum refactor 3-mode ini.
`MirrorMode` murni WRAPPER tipis di atas `DeltaEngine.compare()` yang
sudah ada dan sudah diuji (lihat test_delta.py) -- logika COPY/UPDATE/
DELETE TIDAK diduplikasi atau diubah sama sekali di sini, supaya
perilaku Mirror Mode dijamin identik dengan sebelumnya.
"""

from __future__ import annotations

from action import Action
from delta import DeltaEngine
from models import FileRecord
from sync_modes.base import DeltaProgressCallback, SyncMode


class MirrorMode(SyncMode):
    """Strategi default -- perilaku engine sebelum ada mode lain."""

    name = "MIRROR"

    def __init__(self) -> None:
        self._engine = DeltaEngine()

    def generate_actions(
        self,
        source_manifest: dict[str, FileRecord],
        destination_manifest: dict[str, FileRecord],
        progress_callback: DeltaProgressCallback | None = None,
    ) -> list[Action]:
        return self._engine.compare(
            source_manifest, destination_manifest, progress_callback=progress_callback
        )
