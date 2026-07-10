"""
Modul penghitung hash file.

Sengaja dipisah dari scanner.py agar:
1. Bisa dites secara independen (unit test tidak perlu filesystem scan).
2. Saat tahap berikutnya menambahkan blake3, cukup ubah modul ini saja.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

from config import HASH_ALGORITHM, HASH_CHUNK_SIZE


def compute_hash(file_path: Path) -> str:
    """Menghitung hash sebuah file secara chunked (hemat memori).

    Args:
        file_path: Path absolut menuju file yang akan di-hash.

    Returns:
        Hex digest hash file sebagai string.

    Raises:
        OSError: jika file tidak bisa dibaca (terhapus/terkunci saat scan).
    """
    hasher = hashlib.new(HASH_ALGORITHM)

    with file_path.open("rb") as f:
        while chunk := f.read(HASH_CHUNK_SIZE):
            hasher.update(chunk)

    return hasher.hexdigest()
