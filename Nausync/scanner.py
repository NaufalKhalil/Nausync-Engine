"""
Modul inti: scan folder dan menentukan status setiap file (dan folder).

Scanner sengaja tidak bergantung langsung pada `database.py`. Ia hanya
menerima data lama (dict[str, FileRecord] / dict[str, FolderRecord])
sebagai parameter dan mengembalikan data baru. Pemisahan ini membuat
scanner mudah diuji tanpa perlu database sungguhan.

CATATAN .nausyncignore (lihat ignore_parser.py):
    Scanner membaca file ignore SEKALI di `__init__` (bukan per-panggilan
    method), sesuai spesifikasi. Semua method walk (`count_entries`,
    `scan_current_files`, `scan_current_folders`, dan karenanya `compare`/
    `compare_folders`) memakai generator internal `_walk()` yang sama --
    entry yang cocok pattern ignore dilewati SEJAK proses walk (folder
    yang di-ignore bahkan tidak pernah di-descend ke dalamnya sama
    sekali), bukan sekadar disaring setelah didapat.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Callable, Iterator

from config import IGNORE_FILE_NAME
from ignore_parser import IgnoreParser
from models import FileRecord, FileStatus, FolderRecord, FolderStatus, ScanSummary
from progress import HashProgress, ProgressThrottler, RateEstimator, ScanProgress
from utils import current_timestamp, to_relative_posix

ScanProgressCallback = Callable[[ScanProgress], None]
HashProgressCallback = Callable[[HashProgress], None]


class Scanner:
    """Melakukan scan rekursif pada sebuah folder kerja."""

    def __init__(self, root_folder: Path, ignore_filename: str | None = None) -> None:
        self.root_folder = root_folder.resolve()

        # Dibaca SEKALI di sini (bukan per-scan) sesuai spesifikasi. Jika
        # file ignore tidak ada, IgnoreParser kosong -> perilaku identik
        # dengan sebelum fitur ini ditambahkan (tidak ada yang di-ignore).
        self._ignore = IgnoreParser.from_root(
            self.root_folder, ignore_filename or IGNORE_FILE_NAME
        )

        # Diisi ulang setiap kali `_walk()` dijalankan (count_entries,
        # scan_current_files, scan_current_folders masing-masing memicu
        # satu walk baru) -- dipakai untuk mengisi ScanSummary.ignored_*.
        self.ignored_files_count = 0
        self.ignored_folders_count = 0

    @property
    def ignore(self) -> IgnoreParser:
        """IgnoreParser yang dipakai scanner ini (read-only)."""
        return self._ignore

    # -- Internal: satu-satunya sumber walk filesystem ----------------------

    def _walk(self) -> Iterator[tuple[str, Path]]:
        """Generator internal: yield ("dir", Path) untuk tiap folder dan
        ("file", Path) untuk tiap file di bawah `root_folder`, dengan
        pruning terhadap folder yang cocok `.nausyncignore` SEBELUM
        `os.walk` turun ke dalamnya (folder besar seperti `.git/` tidak
        ikut dijelajahi sama sekali, bukan cuma dibuang belakangan).

        Mengisi ulang `self.ignored_files_count`/`ignored_folders_count`
        setiap kali dipanggil.
        """
        self.ignored_files_count = 0
        self.ignored_folders_count = 0
        root = self.root_folder

        for dirpath, dirnames, filenames in os.walk(root):
            dir_path = Path(dirpath)

            kept_dirnames: list[str] = []
            for name in dirnames:
                child = dir_path / name
                rel = to_relative_posix(child, root)
                if self._ignore.is_ignored(rel, is_dir=True):
                    self.ignored_folders_count += 1
                    continue
                kept_dirnames.append(name)
            # Modifikasi in-place adalah cara os.walk melakukan pruning --
            # subfolder yang dibuang dari list ini tidak akan di-walk.
            dirnames[:] = kept_dirnames

            if dir_path != root:
                yield "dir", dir_path

            for name in filenames:
                file_path = dir_path / name
                rel = to_relative_posix(file_path, root)
                if self._ignore.is_ignored(rel, is_dir=False):
                    self.ignored_files_count += 1
                    continue
                yield "file", file_path

    # -- Public API -----------------------------------------------------

    def count_entries(self) -> tuple[int, int]:
        """Estimasi cepat (total_folders, total_files) via satu kali walk.

        HANYA dipakai untuk memberi angka "total" pada progress bar (ETA)
        -- tidak memanggil stat() sama sekali, jadi jauh lebih murah
        dibanding scan_current_files() (stat per file) atau compare()
        (stat per file, tanpa hash sejak v0.5). Ini murni tambahan UX;
        jika dilewati (mis. pada folder sangat besar via
        SyncEngine(estimate_totals=False)), scan tetap berjalan sama
        persis -- hanya ETA yang tidak tersedia.

        File/folder yang di-ignore TIDAK ikut dihitung.
        """
        total_folders = 0
        total_files = 0
        for kind, _entry in self._walk():
            if kind == "dir":
                total_folders += 1
            else:
                total_files += 1
        return total_folders, total_files

    def scan_current_files(
        self,
        progress_callback: ScanProgressCallback | None = None,
        total_files_hint: int | None = None,
    ) -> dict[str, tuple[Path, int, float]]:
        """Menjelajahi seluruh file dalam folder secara rekursif.

        `progress_callback`/`total_files_hint` bersifat OPSIONAL dan
        murni untuk pelaporan progres -- tidak mengubah data yang
        dikembalikan maupun urutan pemrosesan. File/folder yang cocok
        `.nausyncignore` dilewati sepenuhnya (lihat `_walk()`).

        Returns:
            Dict dengan key = relative path (posix), value = tuple berisi
            (path absolut, ukuran file, modified timestamp). Path absolut
            ikut disimpan agar tidak perlu dibangun ulang saat membentuk
            FileRecord di `compare()`.
        """
        current: dict[str, tuple[Path, int, float]] = {}

        if progress_callback is None:
            for kind, entry in self._walk():
                if kind != "file":
                    continue
                stat = entry.stat()
                rel_path = to_relative_posix(entry, self.root_folder)
                current[rel_path] = (entry, stat.st_size, stat.st_mtime)
            return current

        throttle = ProgressThrottler()
        rate = RateEstimator()
        seen_folders: set[str] = set()
        folders_scanned = 0
        files_scanned = 0
        current_folder = ""

        def _folder_rel(entry: Path) -> str:
            return "." if entry == self.root_folder else to_relative_posix(entry, self.root_folder)

        def _mark_folder(rel_folder: str) -> None:
            nonlocal folders_scanned, current_folder
            if rel_folder not in seen_folders:
                seen_folders.add(rel_folder)
                folders_scanned += 1
            current_folder = rel_folder

        for kind, entry in self._walk():
            if kind == "dir":
                _mark_folder(_folder_rel(entry))
                continue

            stat = entry.stat()
            rel_path = to_relative_posix(entry, self.root_folder)
            current[rel_path] = (entry, stat.st_size, stat.st_mtime)
            files_scanned += 1
            _mark_folder(_folder_rel(entry.parent))

            if throttle.should_emit():
                speed = rate.update(files_scanned)
                progress_callback(
                    ScanProgress(
                        root=str(self.root_folder),
                        folders_scanned=folders_scanned,
                        files_scanned=files_scanned,
                        current_folder=current_folder,
                        current_file=rel_path,
                        elapsed=rate.elapsed(),
                        files_per_second=speed,
                        eta_seconds=rate.eta_seconds(files_scanned, total_files_hint),
                        total_files_hint=total_files_hint,
                        ignored_files=self.ignored_files_count,
                        ignored_folders=self.ignored_folders_count,
                    )
                )

        # Emit final agar UI tidak "macet" di angka sebelum 100%.
        speed = rate.update(files_scanned)
        progress_callback(
            ScanProgress(
                root=str(self.root_folder),
                folders_scanned=folders_scanned,
                files_scanned=files_scanned,
                current_folder=current_folder,
                current_file="",
                elapsed=rate.elapsed(),
                files_per_second=speed,
                eta_seconds=None,
                total_files_hint=total_files_hint,
                ignored_files=self.ignored_files_count,
                ignored_folders=self.ignored_folders_count,
            )
        )

        return current

    def scan_current_folders(self) -> dict[str, Path]:
        """Menjelajahi seluruh subfolder dalam folder kerja secara rekursif.

        Dipisah dari `scan_current_files` (folder alih-alih file) agar
        folder kosong tercatat di manifest — folder tanpa isi tidak
        pernah muncul saat hanya file yang di-scan. Folder yang cocok
        `.nausyncignore` dilewati sepenuhnya (lihat `_walk()`).

        Returns:
            Dict dengan key = relative path (posix), value = path absolut.
        """
        current: dict[str, Path] = {}

        for kind, entry in self._walk():
            if kind != "dir":
                continue
            rel_path = to_relative_posix(entry, self.root_folder)
            current[rel_path] = entry

        return current

    def compare(
        self,
        previous_records: dict[str, FileRecord],
        scan_progress_callback: ScanProgressCallback | None = None,
        hash_progress_callback: HashProgressCallback | None = None,
        total_files_hint: int | None = None,
    ) -> tuple[list[FileRecord], ScanSummary]:
        """Membandingkan kondisi folder saat ini dengan data lama di database.

        v0.5 -- METADATA ONLY: hash TIDAK PERNAH dihitung di sini atau di
        mana pun dalam Scanner. Status NEW/MODIFIED/UNCHANGED/DELETED
        murni ditentukan dari relative_path + file_size + modified_time
        (lihat blok if/elif di bawah) -- isi file tidak pernah dibaca.
        Kolom `hash` pada `FileRecord` dipertahankan (selalu None) demi
        kompatibilitas struktur manifest, bukan karena masih dipakai.
        Parameter `*_progress_callback`/`total_files_hint` seluruhnya
        OPSIONAL dan murni pelaporan progres (lihat progress.py) -- tidak
        mengubah aturan di atas maupun urutan/isi hasil.

        Args:
            previous_records: Snapshot lama dari database (path -> FileRecord).
            scan_progress_callback: dipanggil (throttled) selama fase
                penjelajahan filesystem (SCANNING_SOURCE/DESTINATION).
            hash_progress_callback: dipanggil (throttled) selama fase
                pembentukan manifest (BUILDING_*_MANIFEST) -- nama
                dipertahankan apa adanya (tidak diganti) supaya
                pemanggil (sync.py/progress.py) tidak perlu diubah,
                walau sejak v0.5 tidak ada hashing yang terjadi di
                baliknya.
            total_files_hint: total file perkiraan (dari `count_entries()`),
                dipakai untuk menghitung ETA scan. None jika tidak dihitung.

        Returns:
            Tuple berisi (daftar FileRecord terbaru untuk disimpan, ringkasan scan).
            `ScanSummary.ignored_files` diisi dari hasil walk (lihat `_walk()`).
        """
        timestamp = current_timestamp()
        current_files = self.scan_current_files(
            progress_callback=scan_progress_callback,
            total_files_hint=total_files_hint,
        )
        summary = ScanSummary(folder=str(self.root_folder))
        summary.ignored_files = self.ignored_files_count
        results: list[FileRecord] = []

        hash_throttle = ProgressThrottler()
        hash_rate = RateEstimator()
        hash_done = 0
        hash_total = len(current_files)

        # 1. Cek setiap file yang ada saat ini -> NEW, MODIFIED, atau UNCHANGED
        #    Murni berbasis path + size + modified_time -- tidak ada hashing.
        for rel_path, (abs_path, size, mtime) in current_files.items():
            old = previous_records.get(rel_path)

            if old is None:
                status = FileStatus.NEW
            elif old.status is FileStatus.DELETED:
                # File pernah tercatat DELETED lalu muncul lagi -> perlakukan sebagai NEW
                status = FileStatus.NEW
            elif old.size != size or old.modified_time != mtime:
                status = FileStatus.MODIFIED
            else:
                status = FileStatus.UNCHANGED

            # v0.5: Metadata Only Scanner -- hash tidak pernah dihitung.
            # Delta detection sudah selesai lewat if/elif status di atas
            # (path + size + modified_time saja), jadi isi file tidak
            # pernah perlu dibaca sama sekali.
            file_hash = None

            results.append(
                FileRecord(
                    path=rel_path,
                    size=size,
                    modified_time=mtime,
                    hash=file_hash,
                    status=status,
                    last_scan=timestamp,
                )
            )
            summary.add(status)

            hash_done += 1
            if hash_progress_callback is not None and hash_throttle.should_emit():
                hash_rate.update(hash_done)
                hash_progress_callback(
                    HashProgress(
                        files_done=hash_done,
                        files_total=hash_total,
                        current_file=rel_path,
                        elapsed=hash_rate.elapsed(),
                        eta_seconds=hash_rate.eta_seconds(hash_done, hash_total),
                    )
                )

        if hash_progress_callback is not None:
            hash_progress_callback(
                HashProgress(
                    files_done=hash_done,
                    files_total=hash_total,
                    current_file="",
                    elapsed=hash_rate.elapsed(),
                    eta_seconds=None,
                )
            )

        # 2. Cek file lama yang sekarang tidak ditemukan -> DELETED
        #
        # PENTING: file lama yang sekarang di-ignore (bukan benar-benar
        # hilang dari disk, hanya masuk .nausyncignore) TIDAK dianggap
        # DELETED -- kalau tidak, menambahkan pattern baru ke
        # .nausyncignore akan langsung memicu penghapusan massal di
        # destination pada sync berikutnya, yang jelas bukan maksud user.
        for rel_path, old in previous_records.items():
            if rel_path in current_files:
                continue
            if old.status is FileStatus.DELETED:
                # Sudah tercatat DELETED sebelumnya, tidak perlu dihitung ulang
                continue
            if self._ignore.is_ignored(rel_path, is_dir=False):
                continue

            results.append(
                FileRecord(
                    path=rel_path,
                    size=old.size,
                    modified_time=old.modified_time,
                    hash=old.hash,
                    status=FileStatus.DELETED,
                    last_scan=timestamp,
                )
            )
            summary.add(FileStatus.DELETED)

        return results, summary

    def compare_folders(
        self,
        previous_records: dict[str, FolderRecord],
        summary: ScanSummary,
    ) -> list[FolderRecord]:
        """Membandingkan struktur folder saat ini dengan data lama di database.

        Menerima `summary` yang sama dengan yang dipakai `compare()` (bukan
        membuat objek baru) supaya satu scan menghasilkan satu ringkasan
        gabungan file + folder, sesuai pola `print_summary` di main.py.
        `summary.ignored_folders` diisi dari hasil walk (lihat `_walk()`).

        Folder tidak punya status MODIFIED (tidak ada size/hash yang bisa
        berubah) — hanya NEW, DELETED, atau UNCHANGED.

        Args:
            previous_records: Snapshot lama dari database (path -> FolderRecord).
            summary: ScanSummary yang sedang berjalan, diupdate in-place.

        Returns:
            Daftar FolderRecord terbaru untuk disimpan.
        """
        timestamp = current_timestamp()
        current_folders = self.scan_current_folders()
        summary.ignored_folders = self.ignored_folders_count
        results: list[FolderRecord] = []

        # 1. Cek setiap folder yang ada saat ini -> NEW atau UNCHANGED
        for rel_path in current_folders:
            old = previous_records.get(rel_path)

            if old is None or old.status is FolderStatus.DELETED:
                # Belum pernah tercatat, atau pernah DELETED lalu muncul lagi -> NEW
                status = FolderStatus.NEW
                created_at = timestamp
            else:
                status = FolderStatus.UNCHANGED
                created_at = old.created_at

            results.append(
                FolderRecord(
                    path=rel_path,
                    status=status,
                    created_at=created_at,
                    last_scan=timestamp,
                )
            )
            summary.add_folder(status)

        # 2. Cek folder lama yang sekarang tidak ditemukan -> DELETED
        # (sama seperti file di atas, folder yang sekadar masuk
        # .nausyncignore TIDAK dianggap DELETED.)
        for rel_path, old in previous_records.items():
            if rel_path in current_folders:
                continue
            if old.status is FolderStatus.DELETED:
                continue
            if self._ignore.is_ignored(rel_path, is_dir=True):
                continue

            results.append(
                FolderRecord(
                    path=rel_path,
                    status=FolderStatus.DELETED,
                    created_at=old.created_at,
                    last_scan=timestamp,
                )
            )
            summary.add_folder(FolderStatus.DELETED)

        return results
