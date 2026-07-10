"""
Fungsi-fungsi bantu (helper) yang dipakai lintas modul.

Diletakkan terpisah agar scanner.py dan main.py tidak perlu duplikasi
logic kecil seperti format waktu atau konversi path.
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path

from config import TIMESTAMP_FORMAT


def current_timestamp() -> str:
    """Mengembalikan timestamp saat ini dalam format standar proyek."""
    return datetime.now().strftime(TIMESTAMP_FORMAT)


def to_relative_posix(path: Path, root: Path) -> str:
    """Mengubah path absolut menjadi relative path (format posix) terhadap root.

    Menggunakan format posix ("/") agar path yang disimpan di database
    konsisten lintas OS (Windows/Linux/Mac), sehingga manifest.db bisa
    dipindah antar perangkat di tahap sinkronisasi nanti.
    """
    return path.relative_to(root).as_posix()


def format_count(n: int) -> str:
    """Memformat angka dengan pemisah ribuan, contoh: 12543 -> '12,543'."""
    return f"{n:,}"
