"""
Lapisan akses database untuk NauSync.

Ini adalah satu-satunya modul yang boleh menjalankan SQL. Modul lain
(scanner, main) berinteraksi dengan database hanya lewat method-method
publik kelas `Database`, sehingga jika suatu saat backend berpindah
dari SQLite ke sistem lain, hanya file ini yang perlu diubah.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from types import TracebackType

from config import DATA_DIR, DATABASE_PATH, FILES_TABLE, FOLDERS_TABLE, MANIFEST_INFO_TABLE
from models import FileRecord, FileStatus, FolderRecord, FolderStatus, ManifestInfo


class Database:
    """Mengelola koneksi dan operasi terhadap manifest.db.

    Didesain sebagai context manager (`with Database() as db:`) supaya
    koneksi selalu ditutup dengan benar, termasuk saat terjadi error.
    """

    def __init__(self, db_path: Path = DATABASE_PATH) -> None:
        self.db_path = db_path
        self._conn: sqlite3.Connection | None = None

    def __enter__(self) -> "Database":
        self.connect()
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None:
        self.close()

    def connect(self) -> None:
        """Membuka koneksi ke database dan memastikan schema sudah ada."""
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(self.db_path)
        self._conn.row_factory = sqlite3.Row
        self._create_schema()

    def close(self) -> None:
        """Menutup koneksi jika masih terbuka."""
        if self._conn is not None:
            self._conn.close()
            self._conn = None

    @property
    def connection(self) -> sqlite3.Connection:
        """Mengembalikan koneksi aktif, atau error jika belum connect()."""
        if self._conn is None:
            raise RuntimeError("Database belum terkoneksi. Panggil connect() dulu.")
        return self._conn

    def _create_schema(self) -> None:
        """Membuat seluruh tabel jika belum ada (files, folders, manifest_info)."""
        self.connection.execute(
            f"""
            CREATE TABLE IF NOT EXISTS {FILES_TABLE} (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                path          TEXT NOT NULL UNIQUE,
                size          INTEGER NOT NULL,
                modified_time REAL NOT NULL,
                hash          TEXT,
                status        TEXT NOT NULL,
                last_scan     TEXT NOT NULL
            )
            """
        )
        self.connection.execute(
            f"""
            CREATE TABLE IF NOT EXISTS {FOLDERS_TABLE} (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                path       TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL,
                last_scan  TEXT NOT NULL,
                status     TEXT NOT NULL
            )
            """
        )
        self.connection.execute(
            f"""
            CREATE TABLE IF NOT EXISTS {MANIFEST_INFO_TABLE} (
                id                  INTEGER PRIMARY KEY CHECK (id = 1),
                manifest_version    TEXT NOT NULL,
                application_version TEXT NOT NULL,
                root_folder         TEXT NOT NULL,
                created_at          TEXT NOT NULL,
                last_scan           TEXT,
                total_files         INTEGER NOT NULL DEFAULT 0,
                total_size          INTEGER NOT NULL DEFAULT 0
            )
            """
        )
        self.connection.commit()

    # ------------------------------------------------------------------
    # files
    # ------------------------------------------------------------------

    def get_all_files(self) -> dict[str, FileRecord]:
        """Mengambil seluruh record file dari database, dikelompokkan by path.

        Returns:
            Dict dengan key = relative path, value = FileRecord.
            Memudahkan lookup O(1) saat scanner membandingkan hasil scan.
        """
        cursor = self.connection.execute(
            f"SELECT path, size, modified_time, hash, status, last_scan FROM {FILES_TABLE}"
        )
        result: dict[str, FileRecord] = {}
        for row in cursor.fetchall():
            result[row["path"]] = FileRecord(
                path=row["path"],
                size=row["size"],
                modified_time=row["modified_time"],
                hash=row["hash"],
                status=FileStatus(row["status"]),
                last_scan=row["last_scan"],
            )
        return result

    def save_records(self, records: list[FileRecord]) -> None:
        """Menyimpan (insert/update) banyak record sekaligus dalam satu transaction.

        Menggunakan `INSERT ... ON CONFLICT` (upsert) berdasarkan kolom
        `path` yang UNIQUE, dan prepared statement (`?` placeholder)
        untuk mencegah SQL injection sekaligus performa lebih baik pada
        eksekusi berulang (executemany).

        File berstatus DELETED tetap disimpan (bukan dihapus dari DB)
        agar riwayatnya terlacak, sesuai definisi status pada spesifikasi.
        """
        conn = self.connection
        try:
            conn.execute("BEGIN")
            conn.executemany(
                f"""
                INSERT INTO {FILES_TABLE} (path, size, modified_time, hash, status, last_scan)
                VALUES (:path, :size, :modified_time, :hash, :status, :last_scan)
                ON CONFLICT(path) DO UPDATE SET
                    size = excluded.size,
                    modified_time = excluded.modified_time,
                    hash = excluded.hash,
                    status = excluded.status,
                    last_scan = excluded.last_scan
                """,
                [
                    {
                        "path": r.path,
                        "size": r.size,
                        "modified_time": r.modified_time,
                        "hash": r.hash,
                        "status": r.status.value,
                        "last_scan": r.last_scan,
                    }
                    for r in records
                ],
            )
            conn.commit()
        except Exception:
            conn.rollback()
            raise

    # ------------------------------------------------------------------
    # folders
    # ------------------------------------------------------------------

    def get_all_folders(self) -> dict[str, FolderRecord]:
        """Mengambil seluruh record folder dari database, dikelompokkan by path.

        Sama pola dengan `get_all_files`, dipisah demi kejelasan tipe
        (folder dan file punya struktur & aturan status yang berbeda).
        """
        cursor = self.connection.execute(
            f"SELECT path, created_at, last_scan, status FROM {FOLDERS_TABLE}"
        )
        result: dict[str, FolderRecord] = {}
        for row in cursor.fetchall():
            result[row["path"]] = FolderRecord(
                path=row["path"],
                status=FolderStatus(row["status"]),
                created_at=row["created_at"],
                last_scan=row["last_scan"],
            )
        return result

    def save_folders(self, records: list[FolderRecord]) -> None:
        """Menyimpan (insert/update) banyak record folder dalam satu transaction.

        Sama pola upsert dengan `save_records`. Folder DELETED tetap
        disimpan (bukan dihapus) agar konsisten dengan aturan retensi
        riwayat pada file.
        """
        if not records:
            return

        conn = self.connection
        try:
            conn.execute("BEGIN")
            conn.executemany(
                f"""
                INSERT INTO {FOLDERS_TABLE} (path, created_at, last_scan, status)
                VALUES (:path, :created_at, :last_scan, :status)
                ON CONFLICT(path) DO UPDATE SET
                    last_scan = excluded.last_scan,
                    status = excluded.status
                """,
                [
                    {
                        "path": r.path,
                        "created_at": r.created_at,
                        "last_scan": r.last_scan,
                        "status": r.status.value,
                    }
                    for r in records
                ],
            )
            conn.commit()
        except Exception:
            conn.rollback()
            raise

    # ------------------------------------------------------------------
    # manifest_info
    # ------------------------------------------------------------------

    def get_manifest_info(self) -> ManifestInfo | None:
        """Mengambil baris tunggal manifest_info, atau None jika belum pernah scan."""
        cursor = self.connection.execute(
            f"""
            SELECT manifest_version, application_version, root_folder,
                   created_at, last_scan, total_files, total_size
            FROM {MANIFEST_INFO_TABLE}
            WHERE id = 1
            """
        )
        row = cursor.fetchone()
        if row is None:
            return None

        return ManifestInfo(
            manifest_version=row["manifest_version"],
            application_version=row["application_version"],
            root_folder=row["root_folder"],
            created_at=row["created_at"],
            last_scan=row["last_scan"],
            total_files=row["total_files"],
            total_size=row["total_size"],
        )

    def save_manifest_info(self, info: ManifestInfo) -> None:
        """Menyimpan (insert/update) baris tunggal manifest_info.

        `id = 1` selalu dipakai secara eksplisit (bukan AUTOINCREMENT)
        karena tabel ini didesain singleton — `CHECK (id = 1)` pada
        schema mencegah baris kedua masuk secara tidak sengaja.

        Dipanggil di transaction yang sama dengan `save_records` dari
        pemanggil (lihat main.py), supaya `total_files`/`total_size`
        yang didenormalisasi tidak pernah melenceng dari tabel `files`.
        """
        conn = self.connection
        try:
            conn.execute("BEGIN")
            conn.execute(
                f"""
                INSERT INTO {MANIFEST_INFO_TABLE}
                    (id, manifest_version, application_version, root_folder,
                     created_at, last_scan, total_files, total_size)
                VALUES (1, :manifest_version, :application_version, :root_folder,
                        :created_at, :last_scan, :total_files, :total_size)
                ON CONFLICT(id) DO UPDATE SET
                    manifest_version = excluded.manifest_version,
                    application_version = excluded.application_version,
                    last_scan = excluded.last_scan,
                    total_files = excluded.total_files,
                    total_size = excluded.total_size
                """,
                {
                    "manifest_version": info.manifest_version,
                    "application_version": info.application_version,
                    "root_folder": info.root_folder,
                    "created_at": info.created_at,
                    "last_scan": info.last_scan,
                    "total_files": info.total_files,
                    "total_size": info.total_size,
                },
            )
            conn.commit()
        except Exception:
            conn.rollback()
            raise
