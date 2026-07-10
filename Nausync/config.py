"""
Konfigurasi terpusat untuk NauSync.

Semua path, nama tabel, dan parameter yang bisa berubah di masa depan
diletakkan di sini agar tidak ada "magic value" tersebar di modul lain.
"""

from __future__ import annotations

from pathlib import Path

# Root proyek (folder tempat file config.py ini berada)
PROJECT_ROOT: Path = Path(__file__).resolve().parent

# Lokasi database manifest
DATA_DIR: Path = PROJECT_ROOT / "data"
DATABASE_PATH: Path = DATA_DIR / "manifest.db"

# Nama tabel utama
FILES_TABLE: str = "files"

# Nama tabel manifest_info (single-row, menyimpan info tingkat-manifest)
MANIFEST_INFO_TABLE: str = "manifest_info"

# Nama tabel folders (mencatat struktur folder, termasuk folder kosong)
FOLDERS_TABLE: str = "folders"

# Versi skema manifest (dinaikkan setiap kali struktur tabel berubah
# dengan cara yang tidak backward-compatible). Dipakai nanti saat
# validasi kompatibilitas antar manifest untuk fitur sinkronisasi.
MANIFEST_VERSION: str = "1.0"

# Versi aplikasi NauSync saat ini.
APPLICATION_VERSION: str = "0.1.0"

# Algoritma hash yang dipakai saat ini.
# Tahap berikutnya bisa diganti/ditambah "blake3" tanpa mengubah modul lain,
# karena hanya hasher.py yang bergantung pada nilai ini.
HASH_ALGORITHM: str = "sha256"

# Ukuran chunk (bytes) saat membaca file untuk hashing.
# Mencegah pemakaian memori berlebih pada file besar.
HASH_CHUNK_SIZE: int = 65536  # 64 KB

# Format timestamp yang disimpan di kolom last_scan
TIMESTAMP_FORMAT: str = "%Y-%m-%d %H:%M:%S"

# ---------------------------------------------------------------------------
# Fast Manifest Scan -- Metadata First (lihat scanner.py: Scanner.compare)
# ---------------------------------------------------------------------------
#
# Sebelum fitur ini, scan pertama meng-hash SELURUH file (SHA-256) saat
# membangun manifest -- sangat lambat pada dataset besar (ratusan GB -- TB,
# ratusan ribu file). HASH_POLICY mengontrol kapan hashing benar-benar
# dijalankan; LARGE_FILE_THRESHOLD memberi batas tambahan khusus file besar.
#
# Nilai HASH_POLICY yang valid:
#   "never"          -- tidak pernah menghitung hash sama sekali.
#   "changed_only"   -- (DEFAULT) hash hanya file berstatus NEW/MODIFIED.
#                        File UNCHANGED (path+size+modified_time sama)
#                        tidak pernah dibaca isinya. Ini perilaku yang
#                        sudah berjalan di scanner.py sebelum konfigurasi
#                        ini ditambahkan -- dijadikan default eksplisit.
#   "verify"         -- hash TIDAK dihitung saat scan biasa; hanya
#                        dihitung lewat proses verifikasi terpisah
#                        (mis. verify_after_write di executor.py, atau
#                        pemanggilan hasher.compute_hash manual).
#   "always"         -- perilaku lama: hash seluruh file setiap scan.
HASH_POLICY: str = "changed_only"

# File berukuran lebih besar dari ini (bytes) TIDAK di-hash saat scanning
# normal, terlepas dari HASH_POLICY -- hanya nama, ukuran, dan modified
# time yang dipakai untuk deteksi perubahan. Signifikan mengurangi waktu
# scan pada dataset dengan banyak file video/arsip besar. Set None untuk
# menonaktifkan (tidak ada batas ukuran).
LARGE_FILE_THRESHOLD: int | None = 50 * 1024 * 1024  # 50 MB

# ---------------------------------------------------------------------------
# Queue Engine
# ---------------------------------------------------------------------------

# Lokasi database queue. Dipisah dari manifest.db karena queue.db bersifat
# operasional (job yang sedang berjalan), bukan snapshot state file --
# siklus hidupnya berbeda (bisa di-clear per sync run, manifest tidak).
QUEUE_DATABASE_PATH: Path = DATA_DIR / "queue.db"

# Nama tabel queue.
QUEUE_TABLE: str = "queue"

# ---------------------------------------------------------------------------
# Mirror Mode -- ignore, dry-run, delete safety, empty directory
# ---------------------------------------------------------------------------
#
# Semua nilai di bawah ini murni DEFAULT. SyncEngine (lihat sync.py)
# menerima parameter constructor yang sama untuk override per-instance
# tanpa perlu mengubah file config ini -- persis pola yang sudah dipakai
# `max_retries`/`verify_after_write` sebelumnya.

# Nama file ignore, dicari di root folder yang di-scan (source & destination
# masing-masing punya file-nya sendiri). Dibaca sekali di awal tiap scan
# oleh Scanner (lihat ignore_parser.py).
IGNORE_FILE_NAME: str = ".nausyncignore"

# Ambang batas rasio DELETE terhadap total file source yang dianggap
# "mencurigakan" (mis. salah memilih folder source). Jika terlampaui,
# SyncEngine membatalkan eksekusi dan melempar DeleteSafetyError alih-alih
# langsung menghapus file di destination -- lihat sync.py.
DELETE_SAFETY_RATIO: float = 0.2

# Jika True, sync_once() hanya melakukan Scan + Manifest + Delta + Queue,
# TANPA benar-benar copy/update/delete file apa pun -- lihat sync.py.
DRY_RUN: bool = False

# Jika True, folder kosong yang ada di source tapi belum ada di destination
# ikut dibuat agar struktur folder mirror sepenuhnya -- lihat sync.py.
CREATE_EMPTY_DIRS: bool = True
