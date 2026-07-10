"""
Lapisan akses database untuk Queue Engine.

Mengikuti pola yang sama dengan `database.py`: satu-satunya modul yang
boleh menjalankan SQL untuk data queue. `queue.py` (business logic --
enqueue/dequeue/retry/dsb.) berinteraksi dengan storage hanya lewat
method publik `QueueDatabase`, sama seperti `scanner.py` berinteraksi
dengan `database.py`.

Dipisah dari manifest.db (lihat config.QUEUE_DATABASE_PATH) karena
siklus hidup datanya berbeda: queue.db berisi job yang sedang berjalan
untuk satu sync run dan boleh di-clear, sedangkan manifest.db adalah
riwayat state file yang harus tetap ada antar run.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from types import TracebackType

from config import DATA_DIR, QUEUE_DATABASE_PATH, QUEUE_TABLE
from action import ActionDirection
from queue_models import QueueItem, QueuePriority, QueueStatus
from utils import current_timestamp


class QueueDatabase:
    """Mengelola koneksi dan operasi terhadap queue.db.

    Context manager seperti `Database`, agar koneksi selalu ditutup
    dengan benar termasuk saat terjadi error.
    """

    def __init__(self, db_path: Path = QUEUE_DATABASE_PATH) -> None:
        self.db_path = db_path
        self._conn: sqlite3.Connection | None = None

    def __enter__(self) -> "QueueDatabase":
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
            raise RuntimeError("QueueDatabase belum terkoneksi. Panggil connect() dulu.")
        return self._conn

    def _create_schema(self) -> None:
        """Membuat tabel queue jika belum ada, plus migrasi ringan untuk
        queue.db lama yang dibuat sebelum kolom `direction` ada.
        """
        self.connection.execute(
            f"""
            CREATE TABLE IF NOT EXISTS {QUEUE_TABLE} (
                queue_id          INTEGER PRIMARY KEY AUTOINCREMENT,
                action            TEXT NOT NULL,
                path              TEXT NOT NULL,
                source_hash       TEXT,
                destination_hash  TEXT,
                size              INTEGER NOT NULL,
                modified_time     REAL NOT NULL,
                status            TEXT NOT NULL,
                priority          INTEGER NOT NULL,
                retry_count       INTEGER NOT NULL DEFAULT 0,
                last_error        TEXT,
                created_at        TEXT,
                started_at        TEXT,
                finished_at       TEXT,
                direction         TEXT NOT NULL DEFAULT 'TO_DESTINATION'
            )
            """
        )
        self._migrate_add_direction_column()
        self.connection.commit()

    def _migrate_add_direction_column(self) -> None:
        """Menambahkan kolom `direction` jika belum ada.

        `CREATE TABLE IF NOT EXISTS` tidak menyentuh tabel yang sudah
        ada, jadi queue.db lama (dibuat sebelum Two-Way Sync ditambahkan)
        bisa jadi belum punya kolom ini. Karena queue.db bersifat
        ephemeral (selalu di-clear() sebelum sync run baru -- lihat
        docstring modul), migrasi ini murni jaga-jaga: aman dijalankan
        berkali-kali, dan tidak menyentuh data historis penting apa pun.
        """
        columns = {row["name"] for row in self.connection.execute(f"PRAGMA table_info({QUEUE_TABLE})")}
        if "direction" not in columns:
            self.connection.execute(
                f"ALTER TABLE {QUEUE_TABLE} ADD COLUMN direction TEXT NOT NULL DEFAULT 'TO_DESTINATION'"
            )

    # ------------------------------------------------------------------
    # write
    # ------------------------------------------------------------------

    def insert(self, item: QueueItem) -> int:
        """Menyisipkan satu QueueItem baru, selalu berstatus PENDING.

        `item.queue_id` diabaikan (AUTOINCREMENT menentukan ID final).

        Returns:
            queue_id yang baru dibuat.
        """
        cursor = self.connection.execute(
            f"""
            INSERT INTO {QUEUE_TABLE}
                (action, path, source_hash, destination_hash, size,
                 modified_time, status, priority, retry_count, last_error,
                 created_at, started_at, finished_at, direction)
            VALUES
                (:action, :path, :source_hash, :destination_hash, :size,
                 :modified_time, :status, :priority, 0, NULL,
                 :created_at, NULL, NULL, :direction)
            """,
            {
                "action": item.action,
                "path": item.path,
                "source_hash": item.source_hash,
                "destination_hash": item.destination_hash,
                "size": item.size,
                "modified_time": item.modified_time,
                "status": QueueStatus.PENDING.value,
                "priority": item.priority.value,
                "created_at": current_timestamp(),
                "direction": item.direction.value,
            },
        )
        self.connection.commit()
        assert cursor.lastrowid is not None
        return cursor.lastrowid

    def set_status(
        self,
        queue_id: int,
        status: QueueStatus,
        *,
        last_error: str | None = None,
        started_at: str | None = None,
        finished_at: str | None = None,
    ) -> None:
        """Memperbarui status sebuah item, plus timestamp/error terkait.

        Field opsional (`last_error`, `started_at`, `finished_at`) hanya
        ditulis jika diberikan; jika None, kolom yang bersangkutan
        TIDAK ditimpa (dipertahankan seperti nilai lama). Ini supaya
        satu method bisa dipakai untuk semua transisi status tanpa
        setiap pemanggil harus tahu kolom mana yang relevan.
        """
        fields: list[str] = ["status = :status"]
        params: dict[str, object] = {"queue_id": queue_id, "status": status.value}

        if last_error is not None:
            fields.append("last_error = :last_error")
            params["last_error"] = last_error
        if started_at is not None:
            fields.append("started_at = :started_at")
            params["started_at"] = started_at
        if finished_at is not None:
            fields.append("finished_at = :finished_at")
            params["finished_at"] = finished_at

        self.connection.execute(
            f"UPDATE {QUEUE_TABLE} SET {', '.join(fields)} WHERE queue_id = :queue_id",
            params,
        )
        self.connection.commit()

    def increment_retry(self, queue_id: int) -> None:
        """Menaikkan retry_count dan mengembalikan item ke status PENDING.

        `last_error` sengaja dipertahankan (bukan dihapus) agar riwayat
        error terakhir masih bisa dilihat sebelum item dicoba ulang.
        """
        self.connection.execute(
            f"""
            UPDATE {QUEUE_TABLE}
            SET retry_count = retry_count + 1,
                status = :status,
                started_at = NULL,
                finished_at = NULL
            WHERE queue_id = :queue_id
            """,
            {"queue_id": queue_id, "status": QueueStatus.PENDING.value},
        )
        self.connection.commit()

    def clear(self) -> None:
        """Menghapus seluruh item di queue."""
        self.connection.execute(f"DELETE FROM {QUEUE_TABLE}")
        self.connection.commit()

    # ------------------------------------------------------------------
    # read
    # ------------------------------------------------------------------

    def get_next_pending(self) -> QueueItem | None:
        """Mengambil satu item PENDING berikutnya (prioritas tinggi dulu,
        lalu yang paling lama menunggu -- FIFO dalam prioritas yang sama).
        """
        cursor = self.connection.execute(
            f"""
            SELECT * FROM {QUEUE_TABLE}
            WHERE status = :status
            ORDER BY priority DESC, created_at ASC, queue_id ASC
            LIMIT 1
            """,
            {"status": QueueStatus.PENDING.value},
        )
        row = cursor.fetchone()
        return self._row_to_item(row) if row is not None else None

    def get_by_id(self, queue_id: int) -> QueueItem | None:
        """Mengambil satu item berdasarkan queue_id, atau None jika tidak ada."""
        cursor = self.connection.execute(
            f"SELECT * FROM {QUEUE_TABLE} WHERE queue_id = :queue_id",
            {"queue_id": queue_id},
        )
        row = cursor.fetchone()
        return self._row_to_item(row) if row is not None else None

    def count_by_status(self) -> dict[str, int]:
        """Menghitung jumlah item per status, untuk progress tracking."""
        cursor = self.connection.execute(
            f"SELECT status, COUNT(*) AS total FROM {QUEUE_TABLE} GROUP BY status"
        )
        return {row["status"]: row["total"] for row in cursor.fetchall()}

    @staticmethod
    def _row_to_item(row: sqlite3.Row) -> QueueItem:
        row_keys = row.keys()
        direction_value = row["direction"] if "direction" in row_keys else ActionDirection.TO_DESTINATION.value
        return QueueItem(
            queue_id=row["queue_id"],
            action=row["action"],
            path=row["path"],
            source_hash=row["source_hash"],
            destination_hash=row["destination_hash"],
            size=row["size"],
            modified_time=row["modified_time"],
            status=QueueStatus(row["status"]),
            priority=QueuePriority(row["priority"]),
            retry_count=row["retry_count"],
            last_error=row["last_error"],
            created_at=row["created_at"],
            started_at=row["started_at"],
            finished_at=row["finished_at"],
            direction=ActionDirection(direction_value),
        )
