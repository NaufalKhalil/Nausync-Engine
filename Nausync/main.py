"""
NauSync — Tahap 1: Deteksi Perubahan File (+ Manifest Metadata & Folder)

Entry point CLI. Alur:
    1. Parse argumen (folder yang ingin di-scan).
    2. Baca snapshot lama dari database (files, folders, manifest_info).
    3. Scan folder & bandingkan -> hasilkan status per file dan per folder.
    4. Simpan hasil ke database dalam satu transaction (termasuk update
       manifest_info, yang di-denormalisasi dari hasil scan).
    5. Cetak ringkasan ke terminal.

Contoh pemakaian:
    python main.py "D:\\Project"
    python main.py /home/user/myfolder
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from config import APPLICATION_VERSION, MANIFEST_VERSION
from database import Database
from models import FileStatus, ManifestInfo, ScanSummary
from scanner import Scanner
from utils import current_timestamp, format_count


def parse_args() -> argparse.Namespace:
    """Mendefinisikan dan mem-parsing argumen command line."""
    parser = argparse.ArgumentParser(
        prog="nausync",
        description="NauSync - deteksi perubahan file pada sebuah folder kerja.",
    )
    parser.add_argument(
        "folder",
        type=str,
        help="Path folder yang akan di-scan",
    )
    return parser.parse_args()


def validate_folder(folder_arg: str) -> Path:
    """Memvalidasi bahwa path yang diberikan ada dan merupakan folder.

    Keluar dari program dengan pesan jelas jika path tidak valid,
    daripada membiarkan exception mentah muncul ke pengguna.
    """
    folder = Path(folder_arg)

    if not folder.exists():
        print(f"Error: folder tidak ditemukan -> {folder}", file=sys.stderr)
        sys.exit(1)

    if not folder.is_dir():
        print(f"Error: path yang diberikan bukan folder -> {folder}", file=sys.stderr)
        sys.exit(1)

    return folder


def print_summary(summary: ScanSummary) -> None:
    """Menampilkan ringkasan hasil scan sesuai format yang ditentukan."""
    print(f"Folder: {summary.folder}")
    print(f"Total: {format_count(summary.total)}")
    print(f"NEW: {format_count(summary.new)}")
    print(f"MODIFIED: {format_count(summary.modified)}")
    print(f"DELETED: {format_count(summary.deleted)}")
    print(f"UNCHANGED: {format_count(summary.unchanged)}")
    print("Folders:")
    print(f"  NEW: {format_count(summary.folders_new)}")
    print(f"  DELETED: {format_count(summary.folders_deleted)}")
    print(f"  UNCHANGED: {format_count(summary.folders_unchanged)}")


def _build_manifest_info(
    existing: ManifestInfo | None,
    folder: Path,
    total_files: int,
    total_size: int,
    timestamp: str,
) -> ManifestInfo:
    """Menyiapkan `ManifestInfo` terbaru untuk disimpan.

    Pada scan pertama (belum ada `manifest_info` di database), `root_folder`
    dan `created_at` ditetapkan sekali dan tidak berubah lagi di scan
    berikutnya -- keduanya identitas manifest, bukan data yang di-refresh
    setiap scan (lihat `Database.save_manifest_info`, yang memang
    mengecualikan kedua kolom ini dari `ON CONFLICT ... UPDATE SET`).
    """
    if existing is None:
        return ManifestInfo(
            manifest_version=MANIFEST_VERSION,
            application_version=APPLICATION_VERSION,
            root_folder=str(folder.resolve()),
            created_at=timestamp,
            last_scan=timestamp,
            total_files=total_files,
            total_size=total_size,
        )

    return ManifestInfo(
        manifest_version=MANIFEST_VERSION,
        application_version=APPLICATION_VERSION,
        root_folder=existing.root_folder,
        created_at=existing.created_at,
        last_scan=timestamp,
        total_files=total_files,
        total_size=total_size,
    )


def run_scan(folder: Path) -> ScanSummary:
    """Menjalankan satu siklus scan penuh: baca DB -> scan -> simpan.

    Dipisah dari `main()` agar bisa dipanggil langsung dari kode lain
    (mis. saat GUI/sinkronisasi ditambahkan di tahap berikutnya) tanpa
    melalui argparse.
    """
    with Database() as db:
        previous_files = db.get_all_files()
        previous_folders = db.get_all_folders()
        existing_manifest = db.get_manifest_info()

        scanner = Scanner(folder)
        new_files, summary = scanner.compare(previous_files)
        new_folders = scanner.compare_folders(previous_folders, summary)

        # total_files/total_size hanya menghitung file yang MASIH ADA
        # (bukan DELETED) -- itulah kenapa dihitung dari `new_files`,
        # bukan diambil langsung dari summary.total (yang punya makna
        # sama tapi lebih eksplisit untuk dibaca ulang di sini).
        live_files = [r for r in new_files if r.status is not FileStatus.DELETED]
        total_files = len(live_files)
        total_size = sum(r.size for r in live_files)

        manifest_info = _build_manifest_info(
            existing_manifest,
            folder,
            total_files,
            total_size,
            current_timestamp(),
        )

        db.save_records(new_files)
        db.save_folders(new_folders)
        db.save_manifest_info(manifest_info)

    return summary


def main() -> None:
    args = parse_args()
    folder = validate_folder(args.folder)

    summary = run_scan(folder)
    print_summary(summary)


if __name__ == "__main__":
    main()
