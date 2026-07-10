"""
Executor Engine untuk NauSync.

Bertanggung jawab HANYA untuk mengeksekusi QueueItem yang statusnya
PENDING: melakukan operasi filesystem (COPY/UPDATE/DELETE), memverifikasi
hasilnya, lalu memperbarui status item tersebut lewat Queue Engine.

Executor TIDAK melakukan:
    - Scan folder (itu tugas scanner.py)
    - Generate manifest (itu tugas database.py)
    - Hitung delta / memilih strategi mode (itu tugas delta.py & sync_modes/)
    - Membuat queue item (itu tugas queue.py)
    - Networking / storage provider apa pun selain local filesystem
    - GUI

Executor MENDUKUNG eksekusi dua arah (source->destination maupun
destination->source, lihat `QueueItem.direction` / `action.py`) supaya
bisa dipakai oleh mode manapun (Mirror, Backup, Two-Way) tanpa
percabangan logic di sini -- root mana yang dibaca/ditulis ditentukan
generik lewat `_roots_for()`. Untuk item lama/default (`TO_DESTINATION`),
perilakunya identik persis dengan sebelum `direction` ditambahkan.

Executor sengaja tidak bergantung langsung pada implementasi konkret
Queue Engine (queue.py / queue_db.py belum tersedia saat modul ini
ditulis). Sebagai gantinya, ia bergantung pada `QueueRepository`,
sebuah Protocol yang meniru method yang sudah didefinisikan di
AI_CONTEXT.md (dequeue, mark_running, mark_success, mark_failed,
retry). Begitu queue.py tersedia, cukup pastikan class Queue Engine
yang sebenarnya punya method-method ini dengan signature yang sama
(atau buat adapter tipis) -- Executor tidak perlu berubah.
"""

from __future__ import annotations

import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Protocol

from action import ActionDirection
from hasher import compute_hash
from queue_models import QueueItem


# ---------------------------------------------------------------------------
# Kontrak terhadap Queue Engine
# ---------------------------------------------------------------------------


class QueueRepository(Protocol):
    """Kontrak minimal yang dibutuhkan Executor dari Queue Engine.

    Ini BUKAN implementasi -- hanya definisi method yang harus dipenuhi
    oleh queue.py yang sebenarnya. Nama method mengikuti daftar di
    AI_CONTEXT.md ("Supports: enqueue, dequeue, retry, mark_running,
    mark_success, mark_failed, clear, progress tracking") agar konsisten
    dengan API yang sudah direncanakan, bukan API baru buatan Executor.
    """

    def dequeue(self) -> QueueItem | None:
        """Mengambil satu QueueItem berikutnya yang berstatus PENDING.

        Mengembalikan None jika tidak ada item PENDING tersisa.
        """
        ...

    def mark_running(self, queue_id: int) -> None:
        """Menandai item sebagai RUNNING sebelum dieksekusi."""
        ...

    def mark_success(self, queue_id: int) -> None:
        """Menandai item sebagai SUCCESS setelah eksekusi & verifikasi lolos."""
        ...

    def mark_failed(self, queue_id: int, error: str) -> None:
        """Menandai item sebagai FAILED beserta pesan error-nya."""
        ...

    def retry(self, queue_id: int) -> None:
        """Menaikkan retry_count dan mengembalikan item ke status PENDING."""
        ...


# ---------------------------------------------------------------------------
# Konfigurasi & hasil eksekusi
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class ExecutorConfig:
    """Konfigurasi yang dibutuhkan Executor untuk menyusun path absolut.

    QueueItem.path bersifat relatif (relatif terhadap root folder yang
    di-scan) -- konsisten dengan FileRecord.path di models.py.
    """

    source_root: Path
    destination_root: Path
    verify_after_write: bool = True
    max_retries: int = 3


@dataclass(slots=True)
class ExecutionSummary:
    """Ringkasan satu kali run Executor, untuk ditampilkan di CLI.

    Mengikuti pola ScanSummary di models.py.
    """

    total: int = 0
    success: int = 0
    failed: int = 0
    requeued: int = 0

    def add_success(self) -> None:
        self.total += 1
        self.success += 1

    def add_failed(self, requeued: bool) -> None:
        self.total += 1
        self.failed += 1
        if requeued:
            self.requeued += 1


class ExecutionError(Exception):
    """Dilempar saat sebuah operasi filesystem atau verifikasi gagal."""


# ---------------------------------------------------------------------------
# Executor
# ---------------------------------------------------------------------------


class Executor:
    """Mengeksekusi QueueItem satu per satu sampai queue PENDING kosong."""

    def __init__(self, queue: QueueRepository, config: ExecutorConfig) -> None:
        self._queue = queue
        self._config = config

    # -- Public API ---------------------------------------------------

    def run(
        self,
        on_item: Callable[[QueueItem, bool, str | None], None] | None = None,
    ) -> ExecutionSummary:
        """Menjalankan seluruh item PENDING di queue sampai habis.

        Setiap item diproses satu per satu (bukan paralel) agar urutan
        operasi tetap deterministik dan mudah di-debug. Paralelisasi
        bisa ditambahkan nanti di layer di atas Executor jika diperlukan,
        tanpa mengubah logic eksekusi per-item di sini.

        Args:
            on_item: callback opsional dipanggil setelah SETIAP item
                selesai diproses (baik sukses maupun gagal), dengan
                argumen (item, success, error). Ditambahkan agar
                pemanggil (mis. Sync Engine) bisa melaporkan progress
                per-item tanpa perlu menduplikasi loop dequeue ini
                sendiri. Parameter opsional dengan default None --
                pemanggil lama yang tidak butuh progress tidak terdampak.
        """
        summary = ExecutionSummary()

        while (item := self._queue.dequeue()) is not None:
            self._run_single(item, summary, on_item)

        return summary

    def execute_item(self, item: QueueItem) -> None:
        """Mengeksekusi satu QueueItem tanpa mengubah status di queue.

        Dipisah dari `run()`/`_run_single()` supaya bisa dites secara
        independen (unit test tidak perlu QueueRepository palsu yang
        rumit -- cukup panggil langsung dengan sebuah QueueItem).

        Raises:
            ExecutionError: jika operasi filesystem atau verifikasi gagal.
        """
        match item.action:
            case "COPY" | "UPDATE":
                self._write(item)
            case "DELETE":
                self._delete(item)
            case _:
                raise ExecutionError(f"Unknown action type: {item.action!r}")

    # -- Internal: orkestrasi status ------------------------------------

    def _run_single(
        self,
        item: QueueItem,
        summary: ExecutionSummary,
        on_item: Callable[[QueueItem, bool, str | None], None] | None = None,
    ) -> None:
        if item.queue_id is None:
            raise ExecutionError("QueueItem.queue_id is None; cannot report status")

        self._queue.mark_running(item.queue_id)

        try:
            self.execute_item(item)
        except ExecutionError as exc:
            self._queue.mark_failed(item.queue_id, str(exc))
            requeue = item.retry_count < self._config.max_retries
            if requeue:
                self._queue.retry(item.queue_id)
            summary.add_failed(requeued=requeue)
            if on_item is not None:
                on_item(item, False, str(exc))
        else:
            self._queue.mark_success(item.queue_id)
            summary.add_success()
            if on_item is not None:
                on_item(item, True, None)

    # -- Internal: operasi filesystem -----------------------------------

    def _roots_for(self, item: QueueItem) -> tuple[Path, Path]:
        """Menentukan (read_root, write_root) berdasarkan `item.direction`.

        TO_DESTINATION (default -- perilaku lama, dipakai Mirror/Backup):
            baca dari source, tulis ke destination. Identik persis dengan
            sebelum `direction` ditambahkan.
        TO_SOURCE (khusus Two-Way Sync):
            kebalikannya -- baca dari destination, tulis ke source.
        """
        if item.direction is ActionDirection.TO_SOURCE:
            return self._config.destination_root, self._config.source_root
        return self._config.source_root, self._config.destination_root

    def _write(self, item: QueueItem) -> None:
        """Menjalankan COPY maupun UPDATE, ke arah manapun.

        Secara fisik selalu operasi yang sama: menyalin file dari
        read_root ke write_root. Bedanya hanya makna semantiknya (file
        baru vs file yang sudah ada, dan arahnya), yang sudah ditentukan
        oleh SyncMode sebelumnya -- Executor tidak perlu tahu bedanya.
        """
        read_root, write_root = self._roots_for(item)
        read_path = read_root / item.path
        write_path = write_root / item.path

        if not read_path.exists():
            raise ExecutionError(f"Source file not found: {read_path}")

        try:
            write_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(read_path, write_path)
        except OSError as exc:
            raise ExecutionError(f"Failed to write {item.path}: {exc}") from exc

        if self._config.verify_after_write:
            expected_hash = (
                item.destination_hash if item.direction is ActionDirection.TO_SOURCE else item.source_hash
            )
            self._verify_write(item, write_path, expected_hash)

    def _delete(self, item: QueueItem) -> None:
        _, write_root = self._roots_for(item)
        target_path = write_root / item.path

        if not target_path.exists():
            # Sudah tidak ada -- anggap sukses (idempotent), bukan error.
            return

        try:
            target_path.unlink()
        except OSError as exc:
            raise ExecutionError(f"Failed to delete {item.path}: {exc}") from exc

        if self._config.verify_after_write and target_path.exists():
            raise ExecutionError(f"Verification failed: {item.path} still exists after delete")

    # -- Internal: verifikasi ---------------------------------------

    def _verify_write(self, item: QueueItem, written_path: Path, expected_hash: str | None) -> None:
        if expected_hash is None:
            # Tidak ada hash untuk dibandingkan -- lewati verifikasi hash,
            # tapi keberadaan file sudah cukup membuktikan write berhasil.
            return

        try:
            actual_hash = compute_hash(written_path)
        except OSError as exc:
            raise ExecutionError(f"Failed to verify {item.path}: {exc}") from exc

        if actual_hash != expected_hash:
            raise ExecutionError(
                f"Hash mismatch after write for {item.path}: "
                f"expected {expected_hash}, got {actual_hash}"
            )
