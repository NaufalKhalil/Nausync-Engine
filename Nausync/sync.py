"""
Sync Engine.

SyncEngine adalah ORCHESTRATOR murni. Ia TIDAK menghitung hash,
TIDAK membandingkan manifest, TIDAK menyalin/update/delete file
sendiri, dan TIDAK tahu aturan COPY/UPDATE/DELETE/CONFLICT spesifik
tiap mode. Semua operasi tersebut sudah ada di modul lain -- SyncEngine
hanya memanggilnya dalam urutan yang benar:

    Scanner (source)  -> Database (source)
    Scanner (destination) -> Database (destination)
    SyncMode.generate_actions(...)  -> Action[] (bisa berisi CONFLICT)
    QueueEngine.enqueue(...)      -> QueueItem tersimpan (CONFLICT dibuang)
    Executor.run(...)             -> ExecutionSummary

`SyncMode` (lihat sync_modes/) adalah Strategy Pattern: MirrorMode,
BackupMode, TwoWayMode, atau mode custom apa pun yang mewarisi
`SyncMode`, semuanya punya signature `generate_actions()` yang sama --
SyncEngine memanggilnya secara seragam tanpa if/elif mode di mana pun.
Default-nya `MirrorMode()`, yaitu PERSIS perilaku engine sebelum
arsitektur multi-mode ini ada.

Satu-satunya "logika" milik SyncEngine sendiri adalah: urutan
pemanggilan, penghitungan ringkasan (SyncSummary) dari hasil
modul-modul di atas, memisahkan Action CONFLICT dari Action yang
benar-benar dieksekusi, progress callback, logging, dan early-exit saat
mode tidak menghasilkan Action yang bisa dieksekusi sama sekali.

CATATAN PROGRESS REPORTING (lihat progress.py):
    Modul ini TIDAK mengubah algoritma Scanner/DeltaEngine/Executor sama
    sekali -- ia hanya menyambungkan hook OPSIONAL yang sudah ada di
    scanner.py (`scan_progress_callback`, `hash_progress_callback`),
    tiap SyncMode (`progress_callback`), dan executor.py (`on_item`)
    ke satu ProgressCallback yang dipegang pemanggil (mis. CLI/GUI).
    Setiap payload di-throttle di sumbernya (scanner.py/sync_modes/)
    atau di sini (build_queue/execute), sehingga console tidak pernah
    dibanjiri walau memproses jutaan file.

CATATAN FITUR MIRROR MODE TAMBAHAN (ignore, dry-run, delete safety,
empty dir -- lihat permintaan fitur):
    - `.nausyncignore` ditangani SEPENUHNYA oleh Scanner (lihat
      scanner.py/ignore_parser.py); SyncEngine hanya meneruskan nama
      filenya. Delta/Manifest TIDAK disentuh sama sekali -- file yang
      di-ignore tidak pernah masuk manifest sejak awal.
    - `dry_run` menghentikan pipeline TEPAT SEBELUM `execute()`, setelah
      Scan + Manifest + Delta + Queue selesai seperti biasa.
    - Delete safety memeriksa rasio DELETE terhadap total file source
      SEBELUM `build_queue()`/`execute()` dipanggil -- jika terlampaui,
      `DeleteSafetyError` dilempar dan TIDAK ADA file yang dihapus.
    - Empty directory mirroring berjalan sebagai langkah TERPISAH
      setelah Executor selesai, murni operasi `Path.mkdir()` berdasarkan
      hasil `Scanner.scan_current_folders()` -- tidak menyentuh
      Delta/Manifest/database folders sama sekali.
"""

from __future__ import annotations

import hashlib
import logging
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from action import Action, ActionType
from config import (
    APPLICATION_VERSION,
    CREATE_EMPTY_DIRS,
    DATA_DIR,
    DELETE_SAFETY_RATIO,
    DRY_RUN,
    IGNORE_FILE_NAME,
    MANIFEST_VERSION,
    QUEUE_DATABASE_PATH,
)
from database import Database
from executor import Executor, ExecutionSummary, ExecutorConfig
from models import FileRecord, FileStatus, ManifestInfo, ScanSummary
from progress import (
    DeltaProgress,
    DryRunSummary,
    ExecutionProgress,
    HashProgress,
    ProgressEvent,
    ProgressThrottler,
    QueueBuildProgress,
    RateEstimator,
    ScanProgress,
    SyncFinalSummary,
    SyncStage,
)
from queue import QueueEngine
from queue_models import QueueItem
from scanner import Scanner
from sync_modes import MirrorMode
from sync_modes.base import SyncMode
from utils import current_timestamp

logger = logging.getLogger(__name__)

# Reexport supaya kode lama yang memakai `from sync import SyncStage` tetap
# berjalan -- definisi asli sekarang ada di progress.py (lihat catatan di sana).
__all__ = ["SyncEngine", "SyncSummary", "SyncStage", "DeleteSafetyError"]


ProgressCallback = Callable[[ProgressEvent], None]
"""progress_callback(event) -- lihat ProgressEvent di progress.py."""


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class DeleteSafetyError(RuntimeError):
    """Dilempar saat rasio DELETE terhadap total file source melewati
    `delete_safety_ratio`, sebelum satu pun file dihapus di destination.

    Kemungkinan penyebab paling umum: source/destination folder yang
    salah dipilih (mis. tertukar), sehingga hampir semua file di
    destination "terlihat" seperti harus dihapus. Pemanggil bisa
    menangkap exception ini untuk menampilkan konfirmasi ke user, lalu
    mengulang dengan `SyncEngine(force_delete=True)` jika memang
    disengaja.
    """

    def __init__(self, delete_count: int, source_total: int, ratio: float, threshold: float) -> None:
        self.delete_count = delete_count
        self.source_total = source_total
        self.ratio = ratio
        self.threshold = threshold
        super().__init__(
            f"DELETE ratio too high ({ratio:.1%} > {threshold:.1%}). "
            f"Possible wrong source. Abort? "
            f"({delete_count} DELETE dari {source_total} file source)"
        )


# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class SyncSummary:
    """Ringkasan akhir satu kali sync, dikembalikan oleh SyncEngine.sync().

    `scanned_files` dan `skipped_files` mengacu pada hasil scan SOURCE
    (bukan destination) -- source tetap jadi acuan utama untuk kedua
    angka ini di semua mode (termasuk Two-Way), karena keduanya murni
    turunan dari hasil scan, bukan dari hasil delta/mode.

    `conflicts` hanya relevan untuk mode bidirectional (Two-Way Sync) --
    selalu 0 di Mirror/Backup. Action ber-tipe CONFLICT TIDAK dihitung
    di `copied_files`/`updated_files`/`deleted_files` karena memang
    tidak pernah dieksekusi (lihat sync_modes/twoway.py).

    `dry_run` True berarti `copied_files`/`updated_files`/`deleted_files`
    adalah jumlah action yang AKAN dijalankan (bukan yang sungguh
    dijalankan) -- lihat catatan `SyncEngine`.

    Struktur ini TIDAK berubah dari versi sebelumnya selain penambahan
    `conflicts`/`dry_run`/`ignored_files` (semua default backward-compatible)
    -- ringkasan yang lebih detail untuk console (bytes, speed, dst.) ada
    di `progress.SyncFinalSummary`, dikirim lewat progress_callback pada
    stage FINISHED, terpisah dari nilai balik method ini.
    """

    scanned_files: int = 0
    copied_files: int = 0
    updated_files: int = 0
    deleted_files: int = 0
    failed_files: int = 0
    skipped_files: int = 0
    execution_time: float = 0.0
    conflicts: int = 0
    dry_run: bool = False
    ignored_files: int = 0


# ---------------------------------------------------------------------------
# SyncEngine
# ---------------------------------------------------------------------------


class SyncEngine:
    """Orchestrator sinkronisasi folder lokal source -> destination."""

    def __init__(
        self,
        progress_callback: ProgressCallback | None = None,
        max_retries: int = 3,
        verify_after_write: bool = True,
        manifest_dir: Path | None = None,
        queue_db_path: Path | None = None,
        estimate_totals: bool = True,
        mode: SyncMode | None = None,
        ignore_filename: str | None = None,
        dry_run: bool = DRY_RUN,
        delete_safety_ratio: float | None = None,
        force_delete: bool = False,
        create_empty_dirs: bool = CREATE_EMPTY_DIRS,
    ) -> None:
        """
        Args:
            estimate_totals: jika True (default), setiap fase scan
                didahului satu kali walk ringan (`Scanner.count_entries`,
                tanpa stat()) untuk mendapatkan ETA yang akurat sejak
                awal. Set False pada folder EXTREMELY besar jika ingin
                menghindari walk ganda -- progres tetap tampil real-time,
                hanya ETA scan yang tidak tersedia sampai fase selesai.
            mode: strategi sinkronisasi (lihat sync_modes/). Default
                `MirrorMode()` -- perilaku ENGINE YANG SUDAH ADA sebelum
                arsitektur multi-mode ini ditambahkan, tidak berubah
                sama sekali kalau parameter ini tidak diisi. Ganti
                dengan `BackupMode()` atau `TwoWayMode()` (atau mode
                custom buatan sendiri yang mewarisi `SyncMode`) untuk
                strategi lain -- SyncEngine tidak perlu tahu bedanya.
            ignore_filename: nama file `.nausyncignore` yang dicari di
                root source & destination masing-masing (lihat
                scanner.py/ignore_parser.py). Default dari config.py.
            dry_run: jika True, pipeline berhenti setelah Queue selesai
                dibangun -- TIDAK ADA copy/update/delete yang dijalankan.
                Scan, Manifest, dan Delta tetap berjalan penuh seperti
                biasa (manifest.db tetap ter-update, sesuai perilaku
                Scanner yang sudah ada; hanya filesystem destination
                yang tidak disentuh).
            delete_safety_ratio: ambang rasio DELETE/total-file-source.
                Jika None, memakai `config.DELETE_SAFETY_RATIO`. Lihat
                `DeleteSafetyError`.
            force_delete: jika True, melewati pemeriksaan delete safety
                sama sekali (mis. untuk automasi non-interaktif yang
                sudah yakin dengan source-nya).
            create_empty_dirs: jika True (default), folder kosong yang
                ada di source tapi belum ada di destination ikut dibuat
                setelah Executor selesai -- lihat `_sync_empty_dirs()`.
                Tidak berlaku saat `dry_run=True` (tidak ada yang ditulis
                ke filesystem sama sekali).
        """
        self._progress_callback = progress_callback
        self._max_retries = max_retries
        self._verify_after_write = verify_after_write
        self._manifest_dir = manifest_dir or DATA_DIR
        self._queue_db_path = queue_db_path or QUEUE_DATABASE_PATH
        self._estimate_totals = estimate_totals
        self._mode: SyncMode = mode or MirrorMode()
        self._ignore_filename = ignore_filename or IGNORE_FILE_NAME
        self._dry_run = dry_run
        self._delete_safety_ratio = (
            delete_safety_ratio if delete_safety_ratio is not None else DELETE_SAFETY_RATIO
        )
        self._force_delete = force_delete
        self._create_empty_dirs = create_empty_dirs

        self.source: Path | None = None
        self.destination: Path | None = None

        self._actions: list[Action] = []
        self._conflicts: list[Action] = []
        self._queue_ids: list[int] = []
        self._execution_summary: ExecutionSummary | None = None
        self._summary: SyncSummary | None = None

        # Tally per jenis action, diisi oleh execute() lewat callback Executor.
        self._copied = 0
        self._updated = 0
        self._deleted = 0
        self._bytes_transferred = 0
        self._empty_dirs_created = 0
        self._ignored_files = 0

    @property
    def mode(self) -> SyncMode:
        """Strategi sinkronisasi yang sedang dipakai engine ini."""
        return self._mode

    @property
    def conflicts(self) -> list[Action]:
        """Daftar Action ber-tipe CONFLICT dari sync run terakhir (bisa
        kosong -- selalu kosong untuk Mirror/Backup Mode). Berguna untuk
        ditampilkan ke user setelah sync selesai, sebelum resolver
        CONFLICT dikembangkan."""
        return list(self._conflicts)

    @property
    def dry_run(self) -> bool:
        return self._dry_run

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def sync(self, source: Path | str, destination: Path | str) -> SyncSummary:
        """Menjalankan sinkronisasi penuh dari source ke destination."""
        self.source = Path(source)
        self.destination = Path(destination)
        return self.sync_once()

    def sync_once(self) -> SyncSummary:
        """Menjalankan seluruh pipeline memakai self.source/self.destination
        yang sudah diset (lewat sync(), atau diset manual sebelumnya).

        Raises:
            DeleteSafetyError: jika rasio DELETE melebihi
                `delete_safety_ratio` dan `force_delete=False`. Tidak ada
                file yang dihapus/ditulis sebelum exception ini dilempar.
        """
        if self.source is None or self.destination is None:
            raise RuntimeError(
                "source/destination belum diset. Panggil sync(source, destination) "
                "atau set engine.source / engine.destination terlebih dahulu."
            )

        start = time.perf_counter()
        logger.info("Sync dimulai: %s -> %s", self.source, self.destination)

        self._report(SyncStage.INITIALIZING, 0, 1, "Memuat konfigurasi")

        logger.info("[SCAN] Scanning Source...")
        source_manifest, source_scan_summary = self._scan(
            self.source, SyncStage.SCANNING_SOURCE, SyncStage.BUILDING_SOURCE_MANIFEST
        )
        logger.info("[SCAN] Scanning Destination...")
        destination_manifest, _ = self._scan(
            self.destination, SyncStage.SCANNING_DESTINATION, SyncStage.BUILDING_DESTINATION_MANIFEST
        )
        self._ignored_files = source_scan_summary.ignored_files

        logger.info("[DELTA] Comparing manifests...")
        all_actions = self._generate_delta(source_manifest, destination_manifest)
        self._actions = [a for a in all_actions if a.action is not ActionType.CONFLICT]
        self._conflicts = [a for a in all_actions if a.action is ActionType.CONFLICT]

        if self._conflicts:
            logger.warning(
                "%d file berstatus CONFLICT (mode=%s) -- tidak dieksekusi, lihat SyncEngine.conflicts",
                len(self._conflicts),
                self._mode.name,
            )

        self._check_delete_safety(source_manifest)

        if not self._actions:
            logger.info("Tidak ada perubahan; Executor tidak dijalankan")
            self._execution_summary = ExecutionSummary()
            self._copied = self._updated = self._deleted = 0
            self._bytes_transferred = 0
            self._queue_ids = []
            self._report(SyncStage.FINISHED, 0, 0, "Tidak ada perubahan")
        elif self._dry_run:
            logger.info("[QUEUE] Building action queue... (dry-run)")
            self.build_queue()
            self._copied = sum(1 for a in self._actions if a.action is ActionType.COPY)
            self._updated = sum(1 for a in self._actions if a.action is ActionType.UPDATE)
            self._deleted = sum(1 for a in self._actions if a.action is ActionType.DELETE)
            self._bytes_transferred = 0
            self._execution_summary = ExecutionSummary()
            logger.info(
                "[SUMMARY] Dry-run selesai -- COPY : %d, UPDATE : %d, DELETE : %d",
                self._copied,
                self._updated,
                self._deleted,
            )
            self._report(
                SyncStage.FINISHED,
                len(self._queue_ids),
                len(self._queue_ids),
                "Dry-run selesai -- tidak ada file yang diubah",
                data=DryRunSummary(
                    copy=self._copied,
                    update=self._updated,
                    delete=self._deleted,
                    total=len(self._actions),
                    skipped=source_scan_summary.unchanged,
                ),
            )
        else:
            logger.info("[QUEUE] Building action queue...")
            self.build_queue()
            logger.info("[EXECUTOR] Executing %d actions...", len(self._actions))
            self.execute()
            self._report(
                SyncStage.VERIFYING,
                len(self._queue_ids),
                len(self._queue_ids),
                "Verifikasi sudah dilakukan inline per-file selama EXECUTING",
            )
            self._empty_dirs_created = self._sync_empty_dirs()

        elapsed = time.perf_counter() - start
        self._summary = SyncSummary(
            scanned_files=source_scan_summary.total,
            copied_files=self._copied,
            updated_files=self._updated,
            deleted_files=self._deleted,
            failed_files=self._execution_summary.failed if self._execution_summary else 0,
            skipped_files=source_scan_summary.unchanged,
            execution_time=elapsed,
            conflicts=len(self._conflicts),
            dry_run=self._dry_run,
            ignored_files=self._ignored_files,
        )

        if not self._dry_run:
            logger.info("[SUMMARY] Sync Finished.")
            self._report(
                SyncStage.FINISHED,
                len(self._queue_ids),
                len(self._queue_ids),
                "Sync selesai",
                data=self._build_final_summary(source_manifest, destination_manifest, elapsed),
            )
        logger.info("Sync selesai dalam %.3fs: %s", elapsed, self._summary)
        return self._summary

    def build_queue(self) -> list[int]:
        """Memasukkan seluruh Action (hasil sync_once()) ke Queue Engine.

        Queue dikosongkan (clear()) sebelum diisi, agar setiap sync run
        mulai dari queue yang bersih -- item PENDING/FAILED dari run
        sebelumnya tidak ikut tercampur dan tereksekusi ulang secara
        tidak sengaja pada run berikutnya.

        Dipanggil juga saat `dry_run=True` (sesuai spesifikasi: Queue
        tetap dibangun, hanya `execute()` yang dilewati oleh `sync_once()`).
        """
        if not self._actions:
            self._queue_ids = []
            return []

        total = len(self._actions)
        ids: list[int] = []
        throttle = ProgressThrottler()

        with QueueEngine(db_path=self._queue_db_path) as queue:
            queue.clear()
            for index, action in enumerate(self._actions, start=1):
                queue_id = queue.enqueue(action)
                ids.append(queue_id)
                if throttle.should_emit(force=(index == total)):
                    self._report(
                        SyncStage.BUILDING_QUEUE,
                        index,
                        total,
                        f"Queued {action.action.value} {action.path}",
                        data=QueueBuildProgress(
                            queued=index,
                            total=total,
                            action=action.action.value,
                            path=action.path,
                        ),
                    )

        self._queue_ids = ids
        logger.info("%d action masuk ke queue", len(ids))
        return ids

    def execute(self) -> ExecutionSummary:
        """Menjalankan Executor Engine terhadap seluruh item di queue.

        Progress byte-level (Transferred/Speed/ETA) dihitung DI SINI dari
        `item.size` dan callback `on_item` yang sudah ada di Executor --
        executor.py sendiri tidak disentuh. Granularitas karenanya
        per-file (bukan per-byte di dalam satu file besar), lihat catatan
        di progress.ExecutionProgress.
        """
        total = len(self._queue_ids)
        completed = 0
        self._copied = self._updated = self._deleted = 0
        self._bytes_transferred = 0

        bytes_total = sum(
            (action.size or 0)
            for action in self._actions
            if action.action in (ActionType.COPY, ActionType.UPDATE)
        )
        rate = RateEstimator()
        throttle = ProgressThrottler()

        def _on_item(item: QueueItem, success: bool, error: str | None) -> None:
            nonlocal completed
            completed += 1
            if success:
                if item.action == "COPY":
                    self._copied += 1
                    self._bytes_transferred += item.size or 0
                elif item.action == "UPDATE":
                    self._updated += 1
                    self._bytes_transferred += item.size or 0
                elif item.action == "DELETE":
                    self._deleted += 1

            speed = rate.update(self._bytes_transferred)

            if throttle.should_emit(force=(completed == total)):
                message = (
                    f"{item.action} {item.path}"
                    if success
                    else f"{item.action} {item.path} gagal: {error}"
                )
                self._report(
                    SyncStage.EXECUTING,
                    completed,
                    total,
                    message,
                    data=ExecutionProgress(
                        completed=completed,
                        total=total,
                        action=item.action,
                        current_file=item.path,
                        current_file_size=item.size or 0,
                        bytes_transferred=self._bytes_transferred,
                        bytes_total=bytes_total,
                        speed_bytes_per_sec=speed,
                        elapsed=rate.elapsed(),
                        eta_seconds=rate.eta_seconds(self._bytes_transferred, bytes_total),
                        success=success,
                        error=error,
                    ),
                )

        with QueueEngine(db_path=self._queue_db_path) as queue:
            executor = Executor(
                queue,
                ExecutorConfig(
                    source_root=self.source,
                    destination_root=self.destination,
                    verify_after_write=self._verify_after_write,
                    max_retries=self._max_retries,
                ),
            )
            execution_summary = executor.run(on_item=_on_item)

        self._execution_summary = execution_summary
        logger.info(
            "Eksekusi selesai: %d sukses, %d gagal",
            execution_summary.success,
            execution_summary.failed,
        )
        return execution_summary

    def summary(self) -> SyncSummary:
        """Mengembalikan SyncSummary dari sync run terakhir."""
        if self._summary is None:
            raise RuntimeError(
                "Belum ada sync yang dijalankan. Panggil sync() atau sync_once() dulu."
            )
        return self._summary

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _report(
        self, stage: SyncStage, current: int = 0, total: int = 0, message: str = "", data: object | None = None
    ) -> None:
        logger.debug("[%s] %d/%d - %s", stage.value, current, total, message)
        if self._progress_callback is not None:
            self._progress_callback(
                ProgressEvent(stage=stage, current=current, total=total, message=message, data=data)
            )

    def _check_delete_safety(self, source_manifest: dict[str, FileRecord]) -> None:
        """Memvalidasi rasio DELETE terhadap total file source SEBELUM
        queue/eksekusi dimulai (lihat `DeleteSafetyError`).

        Diletakkan setelah `_generate_delta()` (butuh `self._actions`)
        tapi sebelum `build_queue()`/`execute()` -- kalau rasio
        terlampaui, tidak ada satu pun file yang sempat dihapus.
        """
        delete_count = sum(1 for a in self._actions if a.action is ActionType.DELETE)
        if delete_count == 0 or self._force_delete:
            return

        source_total = sum(1 for r in source_manifest.values() if r.status is not FileStatus.DELETED)
        if source_total == 0:
            return

        ratio = delete_count / source_total
        if ratio <= self._delete_safety_ratio:
            return

        logger.warning(
            "DELETE ratio too high (%.1f%% > %.1f%%). Possible wrong source. Abort?",
            ratio * 100,
            self._delete_safety_ratio * 100,
        )
        raise DeleteSafetyError(delete_count, source_total, ratio, self._delete_safety_ratio)

    def _sync_empty_dirs(self) -> int:
        """Membuat folder kosong di destination yang ada di source tapi
        belum ada di destination, agar struktur folder mirror sepenuhnya
        (poin 5: EMPTY DIRECTORY SUPPORT).

        Dijalankan sebagai langkah TERPISAH setelah Executor selesai --
        folder yang berisi file sudah otomatis terbuat lewat
        `write_path.parent.mkdir(parents=True, exist_ok=True)` di
        executor.py; langkah ini hanya menutup celah untuk folder yang
        BENAR-BENAR kosong (tidak berisi file sama sekali). Murni operasi
        filesystem (`Path.mkdir`) -- TIDAK menyentuh database folders,
        Delta, atau Manifest sama sekali.

        Tidak dipanggil saat `dry_run=True`.
        """
        if not self._create_empty_dirs:
            return 0

        source_folders = Scanner(self.source, ignore_filename=self._ignore_filename).scan_current_folders()
        destination_folders = Scanner(
            self.destination, ignore_filename=self._ignore_filename
        ).scan_current_folders()

        created = 0
        for rel_path in sorted(source_folders):
            if rel_path in destination_folders:
                continue
            target = self.destination / rel_path
            try:
                target.mkdir(parents=True, exist_ok=True)
                created += 1
            except OSError as exc:
                logger.warning("Gagal membuat folder kosong %s: %s", target, exc)

        if created:
            logger.info("%d folder kosong dibuat di destination", created)
        return created

    def _generate_delta(
        self,
        source_manifest: dict[str, FileRecord],
        destination_manifest: dict[str, FileRecord],
    ) -> list[Action]:
        """Menghasilkan daftar Action lewat strategi `self._mode` (Strategy
        Pattern -- lihat sync_modes/). Bisa berisi Action ber-tipe
        CONFLICT; pemanggil (`sync_once`) yang memisahkannya dari action
        yang benar-benar dieksekusi.
        """
        self._report(SyncStage.GENERATING_DELTA, 0, 1, f"Membandingkan manifest ({self._mode.name})")

        def _on_delta_progress(p: DeltaProgress) -> None:
            self._report(
                SyncStage.GENERATING_DELTA,
                p.compared,
                p.total,
                "Comparing...",
                data=p,
            )

        actions = self._mode.generate_actions(
            source_manifest, destination_manifest, progress_callback=_on_delta_progress
        )
        self._report(
            SyncStage.GENERATING_DELTA,
            1,
            1,
            f"{len(actions)} action ditemukan",
        )
        return actions

    def _scan(
        self, root: Path, scan_stage: SyncStage, hash_stage: SyncStage
    ) -> tuple[dict[str, FileRecord], ScanSummary]:
        """Menjalankan Scanner + Database untuk satu root folder.

        Mengembalikan manifest dalam bentuk dict[str, FileRecord] --
        format yang sama persis yang dibutuhkan DeltaEngine.compare(),
        dibangun langsung dari hasil Scanner.compare() (yang sudah
        mencakup seluruh file saat ini + riwayat DELETED), tanpa perlu
        query ulang ke database.

        `scan_stage`/`hash_stage` memisahkan dua fase yang sebenarnya
        terjadi dalam SATU pemanggilan `scanner.compare()` (walk lalu
        hash) -- lihat catatan di scanner.py.

        File/folder yang cocok `.nausyncignore` (lihat scanner.py) TIDAK
        pernah masuk manifest -- Scanner menanganinya sejak proses walk,
        modul ini hanya meneruskan `self._ignore_filename`.
        """
        db_path = self._manifest_db_path(root)
        scanner = Scanner(root, ignore_filename=self._ignore_filename)

        total_files_hint: int | None = None
        if self._estimate_totals:
            self._report(scan_stage, 0, 0, f"Menghitung estimasi jumlah file di {root}")
            _, total_files_hint = scanner.count_entries()

        self._report(scan_stage, 0, total_files_hint or 0, f"Scanning {root}")

        def _on_scan_progress(p: ScanProgress) -> None:
            self._report(
                scan_stage,
                p.files_scanned,
                total_files_hint or 0,
                f"Scanning {p.current_file}" if p.current_file else "Scanning",
                data=p,
            )

        def _on_hash_progress(p: HashProgress) -> None:
            self._report(
                hash_stage,
                p.files_done,
                p.files_total,
                f"Hashing {p.current_file}" if p.current_file else "Hashing",
                data=p,
            )

        with Database(db_path=db_path) as db:
            previous_records = db.get_all_files()
            records, scan_summary = scanner.compare(
                previous_records,
                scan_progress_callback=_on_scan_progress,
                hash_progress_callback=_on_hash_progress,
                total_files_hint=total_files_hint,
            )
            db.save_records(records)

            previous_info = db.get_manifest_info()
            manifest_info = self._build_manifest_info(root, records, previous_info)
            db.save_manifest_info(manifest_info)

        self._report(
            hash_stage,
            scan_summary.total,
            scan_summary.total,
            f"{scan_summary.total} file di-scan, {scan_summary.ignored_files} di-ignore",
        )
        logger.info(
            "Scanning %s selesai: %d file di-scan, %d di-ignore",
            root,
            scan_summary.total,
            scan_summary.ignored_files,
        )

        manifest = {record.path: record for record in records}
        return manifest, scan_summary

    def _build_final_summary(
        self,
        source_manifest: dict[str, FileRecord],
        destination_manifest: dict[str, FileRecord],
        elapsed: float,
    ) -> SyncFinalSummary:
        source_files = sum(1 for r in source_manifest.values() if r.status is not FileStatus.DELETED)
        destination_files = sum(
            1 for r in destination_manifest.values() if r.status is not FileStatus.DELETED
        )
        return SyncFinalSummary(
            source_files=source_files,
            destination_files=destination_files,
            copied=self._copied,
            updated=self._updated,
            deleted=self._deleted,
            processed_bytes=self._bytes_transferred,
            elapsed=elapsed,
            average_speed_bytes_per_sec=(self._bytes_transferred / elapsed) if elapsed > 0 else 0.0,
            skipped=self._summary.skipped_files if self._summary else 0,
            failed=self._execution_summary.failed if self._execution_summary else 0,
            conflicts=len(self._conflicts),
            total_actions=self._copied + self._updated + self._deleted,
        )

    def _manifest_db_path(self, root: Path) -> Path:
        """Menentukan path manifest.db khusus untuk satu root folder.

        Setiap root (source, destination) butuh manifest terpisah --
        schema database.py didesain sebagai satu manifest per file DB
        (tabel `files`/`folders` tidak punya kolom root, dan
        `manifest_info` singleton). Nama file diturunkan dari hash
        path absolut root, supaya deterministik antar run tanpa perlu
        registry terpisah.
        """
        resolved = root.resolve()
        digest = hashlib.sha256(str(resolved).encode("utf-8")).hexdigest()[:16]
        return self._manifest_dir / f"manifest_{digest}.db"

    @staticmethod
    def _build_manifest_info(
        root: Path, records: list[FileRecord], previous_info: ManifestInfo | None
    ) -> ManifestInfo:
        now = current_timestamp()
        total_files = sum(1 for r in records if r.status is not FileStatus.DELETED)
        total_size = sum(r.size for r in records if r.status is not FileStatus.DELETED)

        if previous_info is None:
            return ManifestInfo(
                manifest_version=MANIFEST_VERSION,
                application_version=APPLICATION_VERSION,
                root_folder=str(root),
                created_at=now,
                last_scan=now,
                total_files=total_files,
                total_size=total_size,
            )

        previous_info.last_scan = now
        previous_info.total_files = total_files
        previous_info.total_size = total_size
        return previous_info
