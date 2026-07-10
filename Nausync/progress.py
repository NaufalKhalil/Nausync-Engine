"""
Progress reporting untuk NauSync.

Modul ini SENGAJA dipisah dari sync.py/scanner.py/delta.py/executor.py:
ia hanya berisi "bahasa" untuk melaporkan progres (stage + payload data)
dan cara menampilkannya di console. Modul ini TIDAK tahu-menahu soal
algoritma sinkronisasi, delta, hashing, atau eksekusi filesystem --
ia murni menerima angka/string dan menampilkannya.

Kenapa SyncStage diletakkan di sini (bukan di sync.py):
    ScanProgress/HashProgress dibutuhkan oleh scanner.py, DeltaProgress
    oleh delta.py, dan seluruh stage dibutuhkan oleh sync.py. Supaya
    tidak ada import melingkar (scanner.py <-> sync.py), definisi stage
    dan seluruh payload progress dipusatkan di modul netral ini, lalu
    di-reexport dari sync.py agar kode lama yang mengimpor
    `from sync import SyncStage` tetap berjalan.
"""

from __future__ import annotations

import sys
import time
from dataclasses import dataclass
from enum import Enum
from typing import TextIO


# ---------------------------------------------------------------------------
# Stages
# ---------------------------------------------------------------------------


class SyncStage(str, Enum):
    """Seluruh tahapan yang bisa dilaporkan selama satu kali sync run.

    BUILDING_*_MANIFEST dan SCANNING_* dilaporkan dalam SATU pemanggilan
    Scanner.compare() (scan lalu hash), bukan dua langkah terpisah --
    lihat catatan di scanner.py.

    VERIFYING sengaja tidak punya payload progress tersendiri: verifikasi
    hash tulis (write) terjadi INLINE per-file di dalam executor.py
    sebagai bagian dari EXECUTING (lihat ExecutorConfig.verify_after_write),
    dan executor.py tidak diubah untuk memisahkannya. Stage ini tetap
    dilaporkan sebagai penanda transisi singkat sebelum FINISHED, supaya
    timeline UX tetap sesuai spesifikasi tanpa menyentuh Executor.
    """

    INITIALIZING = "INITIALIZING"
    SCANNING_SOURCE = "SCANNING_SOURCE"
    BUILDING_SOURCE_MANIFEST = "BUILDING_SOURCE_MANIFEST"
    SCANNING_DESTINATION = "SCANNING_DESTINATION"
    BUILDING_DESTINATION_MANIFEST = "BUILDING_DESTINATION_MANIFEST"
    GENERATING_DELTA = "GENERATING_DELTA"
    BUILDING_QUEUE = "BUILDING_QUEUE"
    EXECUTING = "EXECUTING"
    VERIFYING = "VERIFYING"
    FINISHED = "FINISHED"


# ---------------------------------------------------------------------------
# Stage-specific payloads
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class ScanProgress:
    """Snapshot progres saat menjelajahi filesystem (SCANNING_SOURCE/DESTINATION).

    `ignored_files`/`ignored_folders` mencerminkan hitungan berjalan
    (bukan final) entry yang cocok `.nausyncignore` sejauh walk berjalan
    -- diisi dari `Scanner.ignored_files_count`/`ignored_folders_count`
    (lihat scanner.py). Default 0, backward-compatible.
    """

    root: str
    folders_scanned: int = 0
    files_scanned: int = 0
    current_folder: str = ""
    current_file: str = ""
    elapsed: float = 0.0
    files_per_second: float = 0.0
    eta_seconds: float | None = None
    total_files_hint: int | None = None
    ignored_files: int = 0
    ignored_folders: int = 0


@dataclass(slots=True)
class HashProgress:
    """Snapshot progres saat hashing NEW/MODIFIED (BUILDING_*_MANIFEST)."""

    files_done: int = 0
    files_total: int = 0
    current_file: str = ""
    elapsed: float = 0.0
    eta_seconds: float | None = None


@dataclass(slots=True)
class DeltaProgress:
    """Snapshot progres saat membandingkan dua manifest (GENERATING_DELTA).

    `conflict_count` hanya relevan untuk Two-Way Sync (selalu 0 di
    Mirror/Backup) -- lihat sync_modes/twoway.py.
    """

    compared: int = 0
    total: int = 0
    copy_count: int = 0
    update_count: int = 0
    delete_count: int = 0
    conflict_count: int = 0


@dataclass(slots=True)
class QueueBuildProgress:
    """Snapshot progres saat memasukkan Action ke queue (BUILDING_QUEUE)."""

    queued: int = 0
    total: int = 0
    action: str = ""
    path: str = ""


@dataclass(slots=True)
class ExecutionProgress:
    """Snapshot progres saat menjalankan queue (EXECUTING).

    `bytes_total`/`bytes_transferred` hanya menghitung action COPY/UPDATE
    (DELETE tidak memindahkan data). Granularitas progres adalah PER-FILE
    (bukan per-byte di dalam satu file), karena executor.py melakukan
    shutil.copy2() secara blocking tanpa hook internal -- lihat catatan
    di sync.py. Untuk sinkronisasi berisi banyak file kecil-menengah
    (kasus umum), ini tetap terasa hidup dan real-time.
    """

    completed: int = 0
    total: int = 0
    action: str = ""
    current_file: str = ""
    current_file_size: int = 0
    bytes_transferred: int = 0
    bytes_total: int = 0
    speed_bytes_per_sec: float = 0.0
    elapsed: float = 0.0
    eta_seconds: float | None = None
    success: bool = True
    error: str | None = None


@dataclass(slots=True)
class DryRunSummary:
    """Ringkasan akhir untuk sync run dengan `dry_run=True` (lihat sync.py).

    Berisi jumlah Action yang AKAN dijalankan, tanpa filesystem sungguhan
    disentuh sama sekali -- COPY/UPDATE/DELETE di sini murni hasil
    Scan + Manifest + Delta + Queue.
    """

    copy: int = 0
    update: int = 0
    delete: int = 0
    total: int = 0
    skipped: int = 0


@dataclass(slots=True)
class SyncFinalSummary:
    """Ringkasan akhir untuk ditampilkan di console (bukan SyncSummary
    yang dikembalikan oleh SyncEngine.sync() -- lihat sync.py).

    `total_actions` = copied + updated + deleted, ditambahkan agar
    ringkasan akhir menampilkan total aksi yang benar-benar dieksekusi
    (lihat SUMMARY AKHIR di spesifikasi) tanpa perlu pemanggil menghitung
    sendiri.
    """

    source_files: int
    destination_files: int
    copied: int
    updated: int
    deleted: int
    processed_bytes: int
    elapsed: float
    average_speed_bytes_per_sec: float
    skipped: int
    failed: int
    conflicts: int = 0
    total_actions: int = 0


@dataclass(slots=True)
class ProgressEvent:
    """Satu event progres, dikirim ke ProgressCallback milik SyncEngine.

    `data` berisi salah satu dari payload di atas sesuai `stage`, atau
    None untuk stage yang cuma butuh pesan singkat (INITIALIZING,
    VERIFYING).
    """

    stage: SyncStage
    current: int = 0
    total: int = 0
    message: str = ""
    data: object | None = None


# ---------------------------------------------------------------------------
# Rate / ETA estimation
# ---------------------------------------------------------------------------


class RateEstimator:
    """Menghitung kecepatan (item/detik atau byte/detik) dan ETA.

    Memakai exponential moving average (EMA) supaya angka kecepatan
    tidak "lompat-lompat" antar update, sekaligus tetap responsif
    terhadap perubahan kecepatan (mis. transfer melambat di file besar).
    """

    def __init__(self, smoothing: float = 0.3) -> None:
        self._smoothing = smoothing
        self._rate = 0.0
        self._last_time: float | None = None
        self._last_count = 0
        self.start_time = time.perf_counter()

    def update(self, count: int) -> float:
        """Mencatat titik data baru (count kumulatif) dan mengembalikan
        kecepatan ter-smoothing saat ini."""
        now = time.perf_counter()
        if self._last_time is not None:
            dt = now - self._last_time
            if dt > 0:
                instant_rate = max(0.0, (count - self._last_count) / dt)
                self._rate = (
                    self._smoothing * instant_rate + (1 - self._smoothing) * self._rate
                    if self._rate
                    else instant_rate
                )
        self._last_time = now
        self._last_count = count
        return self._rate

    def average_rate(self, count: int) -> float:
        """Kecepatan rata-rata sejak awal (dipakai untuk ringkasan akhir)."""
        elapsed = self.elapsed()
        return count / elapsed if elapsed > 0 else 0.0

    def eta_seconds(self, count: int, total: int | None) -> float | None:
        if not total or self._rate <= 0 or count >= total:
            return None
        return (total - count) / self._rate

    def elapsed(self) -> float:
        return time.perf_counter() - self.start_time


class ProgressThrottler:
    """Membatasi frekuensi emit progress agar console tidak banjir baris.

    Sesuai spesifikasi: update setiap 200-500ms, bukan per-item.
    """

    def __init__(self, min_interval: float = 0.3) -> None:
        self.min_interval = min_interval
        self._last_emit = 0.0

    def should_emit(self, force: bool = False) -> bool:
        now = time.perf_counter()
        if force or (now - self._last_emit) >= self.min_interval:
            self._last_emit = now
            return True
        return False


# ---------------------------------------------------------------------------
# Formatting helpers
# ---------------------------------------------------------------------------


def format_duration(seconds: float | None) -> str:
    """Format durasi (detik) menjadi 'HH:MM:SS', atau '--:--:--' jika None."""
    if seconds is None or seconds < 0:
        return "--:--:--"
    total = int(seconds)
    h, rem = divmod(total, 3600)
    m, s = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{s:02d}"


def format_bytes(n: float) -> str:
    """Format jumlah byte menjadi string mudah dibaca, mis. '6.42 GB'."""
    value = float(n)
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1024 or unit == "GB":
            return f"{int(value)} {unit}" if unit == "B" else f"{value:.2f} {unit}"
        value /= 1024
    return f"{value:.2f} TB"


def format_speed_bytes(n: float) -> str:
    return f"{format_bytes(n)}/s"


def format_speed_files(n: float) -> str:
    return f"{n:.0f} file/s"


def format_elapsed_human(seconds: float) -> str:
    """Format durasi ringkas ala '8m 31s' (dipakai di SUMMARY AKHIR),
    berbeda dari `format_duration` (format 'HH:MM:SS' untuk progress bar).
    """
    total = max(0, int(seconds))
    h, rem = divmod(total, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}h {m}m {s}s"
    if m:
        return f"{m}m {s}s"
    return f"{s}s"


# ---------------------------------------------------------------------------
# Console renderer
# ---------------------------------------------------------------------------


class ConsoleProgressPrinter:
    """Menampilkan ProgressEvent sebagai blok status yang di-redraw di
    tempat (in-place), bukan mencetak baris baru setiap update -- supaya
    console tetap bersih walau sync memproses jutaan file.

    Di terminal interaktif (TTY), blok sebelumnya dihapus lalu ditulis
    ulang memakai escape code ANSI. Di non-TTY (mis. output diarahkan ke
    file/log), blok dicetak apa adanya secara berurutan sebagai fallback,
    karena cursor-control tidak berguna di sana.
    """

    def __init__(self, stream: TextIO | None = None) -> None:
        self._stream = stream or sys.stdout
        self._last_line_count = 0
        self._is_tty = bool(getattr(self._stream, "isatty", lambda: False)())

    def render(self, event: ProgressEvent) -> None:
        data = event.data
        if isinstance(data, ScanProgress):
            lines = self._render_scan(event.stage, data)
        elif isinstance(data, HashProgress):
            lines = self._render_hash(event.stage, data)
        elif isinstance(data, DeltaProgress):
            lines = self._render_delta(data)
        elif isinstance(data, QueueBuildProgress):
            lines = self._render_queue(data)
        elif isinstance(data, ExecutionProgress):
            lines = self._render_execution(data)
        elif isinstance(data, DryRunSummary):
            self._render_dry_run(data)
            return
        elif isinstance(data, SyncFinalSummary):
            self._render_final(data)
            return
        else:
            lines = [f"[{event.stage.value}]", event.message]
        self._emit_block(lines)

    # -- per-stage renderers -------------------------------------------------

    @staticmethod
    def _render_scan(stage: SyncStage, p: ScanProgress) -> list[str]:
        lines = [
            f"[{stage.value}]",
            "",
            "Folder",
            str(p.folders_scanned),
            "",
            "File",
            str(p.files_scanned),
        ]
        if p.ignored_files or p.ignored_folders:
            lines += ["", "Ignored", str(p.ignored_files + p.ignored_folders)]
        lines += [
            "",
            "Current Folder",
            p.current_folder or "-",
            "",
            "Current File",
            p.current_file or "-",
            "",
            "Speed",
            format_speed_files(p.files_per_second),
            "",
            "Elapsed",
            format_duration(p.elapsed),
            "",
            "ETA",
            format_duration(p.eta_seconds),
        ]
        return lines

    @staticmethod
    def _render_hash(stage: SyncStage, p: HashProgress) -> list[str]:
        return [
            f"[{stage.value}]",
            "",
            "Hashing...",
            "",
            f"{p.files_done} / {p.files_total} file",
            "",
            "Current",
            p.current_file or "-",
            "",
            "Elapsed",
            format_duration(p.elapsed),
            "",
            "ETA",
            format_duration(p.eta_seconds),
        ]

    @staticmethod
    def _render_delta(p: DeltaProgress) -> list[str]:
        lines = [
            "[GENERATING_DELTA]",
            "",
            "Comparing...",
            "",
            f"{p.compared} / {p.total}",
            "",
            f"COPY : {p.copy_count}",
            f"UPDATE : {p.update_count}",
            f"DELETE : {p.delete_count}",
        ]
        if p.conflict_count:
            lines.append(f"CONFLICT : {p.conflict_count}")
        return lines

    @staticmethod
    def _render_queue(p: QueueBuildProgress) -> list[str]:
        return [
            "[BUILDING_QUEUE]",
            "",
            f"{p.queued} / {p.total}",
            "",
            f"Queued {p.action}",
            "",
            p.path,
        ]

    @staticmethod
    def _render_execution(p: ExecutionProgress) -> list[str]:
        return [
            "[EXECUTING]",
            "",
            f"{p.completed} / {p.total}",
            "",
            p.action + ("" if p.success else " (gagal)"),
            "",
            p.current_file,
            "",
            "Size",
            format_bytes(p.current_file_size),
            "",
            "Transferred",
            f"{format_bytes(p.bytes_transferred)} / {format_bytes(p.bytes_total)}",
            "",
            "Speed",
            format_speed_bytes(p.speed_bytes_per_sec),
            "",
            "Elapsed",
            format_duration(p.elapsed),
            "",
            "ETA",
            format_duration(p.eta_seconds),
        ]

    def _render_dry_run(self, s: DryRunSummary) -> None:
        bar = "=" * 32
        lines = [
            bar,
            "",
            "DRY RUN SUMMARY",
            "",
            bar,
            "",
            f"COPY : {s.copy}",
            f"UPDATE : {s.update}",
            f"DELETE : {s.delete}",
            "",
            f"Total Actions : {s.total}",
            f"Skipped : {s.skipped}",
            "",
            bar,
        ]
        self._clear_previous()
        for line in lines:
            self._stream.write(line + "\n")
        self._stream.flush()
        self._last_line_count = 0

    def _render_final(self, s: SyncFinalSummary) -> None:
        bar = "=" * 32
        lines = [
            bar,
            "",
            "SYNC FINISHED",
            "",
            bar,
            "",
            "Copied :",
            str(s.copied),
            "",
            "Updated :",
            str(s.updated),
            "",
            "Deleted :",
            str(s.deleted),
            "",
            "Skipped :",
            str(s.skipped),
            "",
            "Total Actions :",
            str(s.total_actions),
            "",
            "Data Copied :",
            format_bytes(s.processed_bytes),
            "",
            "Elapsed :",
            format_elapsed_human(s.elapsed),
            "",
            "Average Speed :",
            format_speed_bytes(s.average_speed_bytes_per_sec),
            "",
        ]
        if s.failed:
            lines += ["Failed :", str(s.failed), ""]
        if s.conflicts:
            lines += ["Conflicts :", str(s.conflicts), ""]
        lines += [
            "Source Files :",
            str(s.source_files),
            "",
            "Destination Files :",
            str(s.destination_files),
            "",
            bar,
        ]
        # Ringkasan akhir tidak boleh ditimpa oleh redraw berikutnya --
        # hapus blok progres terakhir, cetak ringkasan, lalu reset counter
        # supaya baris ini "menetap" di console.
        self._clear_previous()
        for line in lines:
            self._stream.write(line + "\n")
        self._stream.flush()
        self._last_line_count = 0

    # -- low-level block redraw ----------------------------------------------

    def _clear_previous(self) -> None:
        if self._is_tty and self._last_line_count:
            self._stream.write(f"\033[{self._last_line_count}A")
            for _ in range(self._last_line_count):
                self._stream.write("\033[K\n")
            self._stream.write(f"\033[{self._last_line_count}A")

    def _emit_block(self, lines: list[str]) -> None:
        if self._is_tty:
            self._clear_previous()
            for line in lines:
                self._stream.write(line + "\n")
            self._stream.flush()
            self._last_line_count = len(lines)
        else:
            # Non-TTY: tidak ada cursor control, cetak sebagai blok berurutan
            # dipisah garis kosong supaya masih terbaca di file log.
            self._stream.write("\n".join(lines) + "\n\n")
            self._stream.flush()
