"""
Model data untuk NauSync.

Modul ini hanya berisi struktur data (Enum & dataclass), tanpa logic
bisnis. Tujuannya agar modul lain (scanner, database, main) punya
"bahasa" yang sama saat bertukar data.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class FileStatus(str, Enum):
    """Status perbandingan sebuah file terhadap database manifest.

    Mewarisi `str` agar nilainya bisa langsung disimpan/dibaca sebagai
    teks di SQLite tanpa konversi manual, sekaligus tetap type-safe
    saat dipakai di kode Python (mencegah typo seperti "Modifed").
    """

    NEW = "NEW"
    MODIFIED = "MODIFIED"
    DELETED = "DELETED"
    UNCHANGED = "UNCHANGED"


class FolderStatus(str, Enum):
    """Status perbandingan sebuah folder terhadap database manifest.

    Sengaja dipisah dari `FileStatus` (bukan reuse) karena folder tidak
    punya konsep MODIFIED (folder tidak punya size/hash yang bisa
    berubah) — memisahkan enum mencegah kode secara tidak sengaja
    menyimpan status yang tidak valid untuk sebuah folder.
    """

    NEW = "NEW"
    DELETED = "DELETED"
    UNCHANGED = "UNCHANGED"


@dataclass(slots=True)
class FileRecord:
    """Representasi satu baris data file, baik dari disk maupun database.

    Field `hash` opsional karena tidak semua file perlu di-hash pada
    setiap scan (lihat aturan hashing kondisional di scanner.py).
    """

    path: str  # relative path terhadap folder yang di-scan
    size: int
    modified_time: float
    hash: str | None = None
    status: FileStatus = FileStatus.UNCHANGED
    last_scan: str | None = None


@dataclass(slots=True)
class FolderRecord:
    """Representasi satu baris data folder, baik dari disk maupun database.

    Ditambahkan agar folder kosong ikut tercatat di manifest (tidak
    hilang jejaknya saat restore/sync), sesuai poin 2 dari review
    arsitektur.
    """

    path: str  # relative path terhadap folder yang di-scan
    status: FolderStatus = FolderStatus.UNCHANGED
    created_at: str | None = None
    last_scan: str | None = None


@dataclass(slots=True)
class ManifestInfo:
    """Info tingkat-manifest (bukan per-file), disimpan sebagai single row.

    Menyediakan cara murah untuk menjawab "manifest apa ini, dari root
    mana, kapan terakhir di-scan" tanpa perlu full scan/COUNT(*) pada
    tabel `files` — prasyarat untuk validasi kompatibilitas antar
    manifest saat fitur sinkronisasi dibangun (poin 1 dari review).

    `total_files`/`total_size` sengaja didenormalisasi (bisa dihitung
    ulang dari `files`, tapi disimpan terpisah demi kecepatan baca).
    Kedua field ini WAJIB di-update dalam transaction yang sama dengan
    `save_records`, supaya tidak melenceng dari kenyataan.
    """

    manifest_version: str
    application_version: str
    root_folder: str
    created_at: str
    last_scan: str | None = None
    total_files: int = 0
    total_size: int = 0


@dataclass(slots=True)
class ScanSummary:
    """Ringkasan hasil satu kali proses scan, untuk ditampilkan di CLI.

    `ignored_files`/`ignored_folders` dihitung dari entry yang cocok
    aturan `.nausyncignore` (lihat ignore_parser.py) -- entry tersebut
    TIDAK ikut menambah `total`/`new`/`modified`/dst. karena memang
    dilewati sejak proses walk filesystem, bukan sekadar disaring
    setelahnya (lihat scanner.py). Default 0, backward-compatible
    dengan kode lama yang membuat ScanSummary tanpa dua field ini.
    """

    folder: str
    total: int = 0
    new: int = 0
    modified: int = 0
    deleted: int = 0
    unchanged: int = 0
    folders_new: int = 0
    folders_deleted: int = 0
    folders_unchanged: int = 0
    ignored_files: int = 0
    ignored_folders: int = 0

    def add(self, status: FileStatus) -> None:
        """Menambah hitungan file sesuai status, sekaligus menaikkan total."""
        self.total += 1
        if status is FileStatus.NEW:
            self.new += 1
        elif status is FileStatus.MODIFIED:
            self.modified += 1
        elif status is FileStatus.DELETED:
            self.deleted += 1
        elif status is FileStatus.UNCHANGED:
            self.unchanged += 1

    def add_folder(self, status: FolderStatus) -> None:
        """Menambah hitungan folder sesuai status."""
        if status is FolderStatus.NEW:
            self.folders_new += 1
        elif status is FolderStatus.DELETED:
            self.folders_deleted += 1
        elif status is FolderStatus.UNCHANGED:
            self.folders_unchanged += 1
