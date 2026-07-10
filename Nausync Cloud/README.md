# Nausync Cloud

Kendalikan file di laptop rumah dari jarak jauh lewat WhatsApp, pakai Google Drive sebagai perantara transfer.

## Cara kerja

1. Laptop di rumah dinyalakan (oleh orang rumah) dan sudah terhubung internet.
2. Bot WhatsApp otomatis jalan di background (auto-start).
3. Kamu kirim command dari WhatsApp HP kamu.
4. Bot menjalankan `copy` / `move` / `delete` langsung di laptop, atau upload file ke Google Drive lewat rclone untuk command `download`.
5. Kamu ambil file dari aplikasi Google Drive di HP.

Tidak perlu port forwarding, VPN, atau IP publik — semua koneksi keluar dari laptop (outbound), bukan masuk.

## Setup awal (sekali saja)

### 1. Install Node.js
Download dari https://nodejs.org (LTS version) dan install di laptop rumah.

### 2. Install rclone
- Download dari https://rclone.org/downloads/
- Jalankan `rclone config` di Command Prompt / PowerShell
- Pilih `n` (new remote), kasih nama misalnya `gdrive`
- Pilih storage type `Google Drive`
- Ikuti instruksi login OAuth (buka browser, login akun Google, izinkan akses)
- Setelah selesai, tes dengan: `rclone lsd gdrive:`

### 3. Install project ini
```
cd nausync-cloud
npm install
```

### 4. Buat file `.env`
Copy `.env.example` jadi `.env`, lalu isi:
```
OWNER_NUMBER=628xxxxxxxxxx      # nomor WA kamu, tanpa tanda + dan tanpa spasi
BASE_DIR=D:\Shared              # folder yang boleh diakses bot (WAJIB dibatasi, jangan C:\)
RCLONE_REMOTE=gdrive            # nama remote yang dibuat di langkah 2
RCLONE_STAGING_FOLDER=nausync-staging
```

### 5. Jalankan pertama kali & scan QR
```
npm start
```
QR code akan muncul di terminal — scan dengan WhatsApp di HP (Menu > Perangkat Tertaut > Tautkan Perangkat). Sesi login tersimpan di folder `auth_session/`, jadi tidak perlu scan ulang setiap start.

### 6. Coba command
Kirim pesan WA ke nomor yang baru saja kamu tautkan (chat ke diri sendiri / nomor bot):
```
help
```

## Auto-start saat laptop nyala (Windows)

Supaya bot otomatis jalan begitu laptop dinyalakan, tanpa perlu ada yang login manual:

1. Buka **Task Scheduler** (cari di Start Menu)
2. **Create Task** (bukan "Create Basic Task")
3. Tab **General**:
   - Beri nama: `Nausync Cloud Bot`
   - Centang **Run whether user is logged on or not**
   - Centang **Run with highest privileges**
4. Tab **Triggers** > New:
   - Begin the task: **At startup**
5. Tab **Actions** > New:
   - Program/script: `node`
   - Add arguments: `src/index.js`
   - Start in: `C:\path\ke\nausync-cloud` (path lengkap folder project)
6. Tab **Settings**:
   - Centang **If the task fails, restart every** 1 minute, up to 3 kali
7. Save, masukkan password akun Windows saat diminta

Sekarang begitu laptop dinyalakan (walau tidak ada yang login ke desktop), bot otomatis jalan.

## Daftar command WhatsApp

```
list <folder>            lihat isi folder (kosongkan untuk root)
copy <src> <dst>         copy file/folder
move <src> <dst>         move file/folder
delete <path>            hapus file/folder
download <path>          upload file ke Google Drive folder staging
help                     tampilkan daftar command
```

Path yang mengandung spasi harus pakai tanda kutip:
```
download "Video Liburan.mp4"
```

## Catatan keamanan

- Bot **hanya** merespons pesan dari `OWNER_NUMBER` yang diset di `.env` — pesan dari nomor lain, atau dari grup, diabaikan sepenuhnya.
- Semua path dibatasi ke dalam `BASE_DIR` (whitelist). Percobaan path seperti `../../Windows` akan ditolak otomatis.
- Sesi WhatsApp (`auth_session/`) setara dengan akses penuh ke akun WA kamu di perangkat itu — jangan bagikan folder ini ke siapa pun, dan jangan commit ke git publik.
- File `.env` juga jangan pernah di-commit / dibagikan (berisi nomor HP dan konfigurasi akses).

## Kalau file besar / upload lama

Command `download` menunggu sampai `rclone copy` selesai baru membalas WA. Untuk file besar (video, dsb), ini bisa makan waktu tergantung kecepatan upload internet rumah — bot akan diam dulu sampai proses selesai, lalu kirim konfirmasi. Ini normal, bukan bug.
