"""
Queue Engine.

Menerima `Action` dari Delta Engine, menyimpannya sebagai `QueueItem`,
dan menyediakan API untuk Executor Engine mengambil serta melaporkan
hasil eksekusinya. Sama seperti Delta Engine, Queue Engine murni
mengelola data -- ia TIDAK menyalin file, TIDAK menghitung hash, dan
TIDAK tahu apa pun soal filesystem.

Business logic (method publik di bawah) dipisah dari SQL mentah
(`queue_db.py`), mengikuti pola yang sama dengan pemisahan
scanner.py / database.py.

Catatan penamaan: modul ini bernama `queue.py` sesuai daftar modul di
AI_CONTEXT.md, meski ini menaungi (shadow) modul stdlib `queue`. Tidak
ada modul lain di proyek ini yang mengimpor `queue` bawaan Python,
jadi shadowing ini aman untuk saat ini -- tapi perlu diingat jika
suatu saat butuh `queue.Queue` dari stdlib di dalam proyek ini.
"""

from __future__ import annotations

from pathlib import Path
from types import TracebackType

from action import Action, ActionType
from config import QUEUE_DATABASE_PATH
from queue_db import QueueDatabase
from queue_models import QueueItem, QueuePriority, QueueStatus
from utils import current_timestamp


class QueueEngine:
    """API publik Queue Engine, dipakai oleh Sync Engine dan Executor Engine."""

    def __init__(self, db_path: Path = QUEUE_DATABASE_PATH) -> None:
        self._db = QueueDatabase(db_path=db_path)

    def __enter__(self) -> "QueueEngine":
        self._db.connect()
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None:
        self._db.close()

    # ------------------------------------------------------------------
    # enqueue
    # ------------------------------------------------------------------

    def enqueue(self, action: Action, priority: QueuePriority = QueuePriority.NORMAL) -> int:
        """Menambahkan satu Action ke queue sebagai QueueItem PENDING.

        Args:
            action: Action hasil sebuah SyncMode (COPY/UPDATE/DELETE).
                `direction`-nya (source->destination atau sebaliknya,
                lihat action.py) ikut tersimpan supaya Executor tahu
                root mana yang dibaca/ditulis.
            priority: Prioritas eksekusi, default NORMAL.

        Returns:
            queue_id item yang baru dibuat.

        Raises:
            ValueError: jika `action.action` adalah CONFLICT -- Action
                jenis ini murni untuk pelaporan (lihat sync_modes/twoway.py)
                dan TIDAK PERNAH dieksekusi, jadi tidak boleh masuk queue
                sama sekali. Dalam alur normal, SyncEngine sudah
                memfilternya sebelum memanggil enqueue(); error ini
                adalah pengaman lapis kedua untuk pemanggilan manual.
            ValueError: jika `action.size` atau `action.modified_time`
                None -- QueueItem mewajibkan keduanya terisi. Dalam
                penggunaan normal (Action datang dari DeltaEngine),
                keduanya selalu terisi sesuai kontrak di action.py;
                error ini hanya muncul jika Action dibuat manual secara
                tidak lengkap.
        """
        if action.action is ActionType.CONFLICT:
            raise ValueError(
                f"Action for {action.path!r} is CONFLICT; conflicts are report-only "
                "and must never be enqueued for execution."
            )

        if action.size is None or action.modified_time is None:
            raise ValueError(
                f"Action for {action.path!r} is missing size/modified_time; "
                "cannot enqueue an incomplete Action."
            )

        item = QueueItem(
            queue_id=None,
            action=action.action.value,
            path=action.path,
            source_hash=action.source_hash,
            destination_hash=action.destination_hash,
            size=action.size,
            modified_time=action.modified_time,
            status=QueueStatus.PENDING,
            priority=priority,
            direction=action.direction,
        )
        return self._db.insert(item)

    def enqueue_many(
        self, actions: list[Action], priority: QueuePriority = QueuePriority.NORMAL
    ) -> list[int]:
        """Menambahkan banyak Action sekaligus, mempertahankan urutan input."""
        return [self.enqueue(action, priority=priority) for action in actions]

    # ------------------------------------------------------------------
    # dequeue / status transitions (dipakai oleh Executor Engine)
    # ------------------------------------------------------------------

    def dequeue(self) -> QueueItem | None:
        """Mengambil satu QueueItem PENDING berikutnya, atau None jika kosong.

        Tidak mengubah status item -- pemanggil (Executor) yang
        bertanggung jawab memanggil `mark_running` sebelum eksekusi.
        """
        return self._db.get_next_pending()

    def mark_running(self, queue_id: int) -> None:
        self._db.set_status(
            queue_id, QueueStatus.RUNNING, started_at=current_timestamp()
        )

    def mark_success(self, queue_id: int) -> None:
        self._db.set_status(
            queue_id, QueueStatus.SUCCESS, finished_at=current_timestamp()
        )

    def mark_failed(self, queue_id: int, error: str) -> None:
        self._db.set_status(
            queue_id,
            QueueStatus.FAILED,
            last_error=error,
            finished_at=current_timestamp(),
        )

    def retry(self, queue_id: int) -> None:
        """Menaikkan retry_count dan mengembalikan item ke status PENDING."""
        self._db.increment_retry(queue_id)

    # ------------------------------------------------------------------
    # housekeeping / progress
    # ------------------------------------------------------------------

    def clear(self) -> None:
        """Mengosongkan seluruh queue."""
        self._db.clear()

    def progress(self) -> dict[str, int]:
        """Mengembalikan jumlah item per status, untuk progress tracking.

        Contoh hasil: {"PENDING": 3, "RUNNING": 1, "SUCCESS": 10}.
        Status yang tidak punya item sama sekali tidak muncul sebagai key.
        """
        return self._db.count_by_status()

    def get(self, queue_id: int) -> QueueItem | None:
        """Mengambil satu item berdasarkan ID, untuk inspeksi/debugging."""
        return self._db.get_by_id(queue_id)
