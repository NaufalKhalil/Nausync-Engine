<table>
  <tr>
    <td align="left">
      <img src="./design/logo/icon.svg" width="120">
    </td>
    <td>
      <h1>NauSync Engine</h1>
      <p>
        A fast, metadata-driven local file synchronization engine designed for Windows.
      </p>
    </td>
  </tr>
</table>

[![Version](https://img.shields.io/badge/version-1.0-orange?style=flat-square)](https://github.com/NaufalKhalil/Nausync-Engine/releases/latest)
[![Platform](https://img.shields.io/badge/platform-Windows-blue?style=flat-square)](https://github.com/NaufalKhalil/Nausync-Engine)
[![Language](https://img.shields.io/badge/language-Python-yellow?style=flat-square)](https://python.org)
[![Status](https://img.shields.io/badge/status-Active-success?style=flat-square)](https://github.com/NaufalKhalil/Nausync-Engine)
[![License](https://img.shields.io/badge/license-MIT-lightgrey?style=flat-square)](./LICENSE)

---

# 📖 Table of Contents

- [About](#about)
- [Features](#-features)
- [Synchronization Modes](#-synchronization-modes)
- [Performance Philosophy](#-performance-philosophy)
- [Comparison](#-comparison)
- [Preview](#-preview)
- [Project Structure](#-project-structure)
- [Installation](#-installation)
- [Usage](#-usage)
- [Roadmap](#-roadmap)
- [Built With](#-built-with)
- [Developer](#-developer)
- [Support](#-support)
- [Contact](#-contact)
- [License](#-license)

---

# About

**NauSync Engine** is a modern local file synchronization engine built for Windows.

Unlike traditional synchronization software, NauSync uses **metadata-based detection** instead of hashing every file. This dramatically reduces scan time while maintaining reliable synchronization for everyday workloads.

Designed for creators, programmers, photographers, and anyone managing thousands of files.

---

# ✨ Features

- ⚡ Metadata-based scanning
- 📂 Mirror Mode
- 💾 One-Way Backup Mode
- 🔄 Two-Way Sync Mode
- 🚀 High-speed synchronization
- 📊 Live progress tracking
- ⏱ ETA estimation
- 📈 Transfer speed monitoring
- 📁 Exclude files & folders
- 🔒 Safe temporary file replacement
- 🧩 Modular synchronization engine
- 🖥 Modern desktop interface

---

# 🔄 Synchronization Modes

## 📂 Mirror

Keeps the destination identical to the source.

- Copy new files
- Update modified files
- Delete files removed from source

---

## 💾 One-Way Backup

Copies changes from Source → Destination.

- Copy new files
- Update modified files
- Never delete destination files

---

## 🔄 Two-Way Sync

Synchronizes both folders.

- Detect changes from both locations
- Copy newer files
- Keep folders synchronized

---

# ⚡ Performance Philosophy

NauSync Engine intentionally **does not hash files**.

Instead, every file is compared using:

- Relative Path
- File Size
- Last Modified Time

This approach allows extremely fast scanning even when working with:

- Blender Projects
- Photoshop Files
- Videos
- Archives
- Programming Projects
- Large Asset Libraries

Fast synchronization is the primary goal.

---

# 🆚 Comparison

| Feature | NauSync Engine | Traditional Sync |
|----------|---------------|------------------|
| Metadata Scan | ✅ Yes | ⚠️ Sometimes |
| File Hashing | ❌ No | ✅ Usually |
| Fast Large Folder Scan | ✅ Excellent | ❌ Slower |
| Mirror Mode | ✅ Yes | ✅ Yes |
| Backup Mode | ✅ Yes | ✅ Yes |
| Two-Way Sync | ✅ Yes | ✅ Yes |
| ETA & Speed Monitor | ✅ Yes | ⚠️ Depends |
| Lightweight | ✅ Yes | ⚠️ Depends |

---

# 🖼 Preview

> Coming Soon

```
assets/images/preview.png
```

---

# 📁 Project Structure

```text
Nausync Engine/
│
├── assets/
├── docs/
├── core/
├── modes/
├── gui/
│
├── app.py
├── requirements.txt
├── README.md
└── LICENSE
```

---

# 📥 Installation

## Requirements

- Windows 10 / 11
- Python 3.13+

## Development

```bash
git clone https://github.com/NaufalKhalil/Nausync-Engine.git

cd Nausync-Engine

pip install -r requirements.txt

python app.py
```

---

# 🎯 Usage

1. Select Source Folder

2. Select Destination Folder

3. Choose Synchronization Mode

- Mirror
- Backup
- Two-Way

4. Press **Start Sync**

5. Monitor progress, speed, ETA, and completed operations.

---

# 🛣 Roadmap

## ✅ Current

- Metadata Scanner
- Mirror Mode
- Backup Mode
- Two-Way Sync
- Exclude Rules
- Desktop GUI
- Progress & ETA

## 🚧 Next

- Scheduled Sync
- Job Profiles
- Portable Version
- Better Statistics
- Command Line Interface

## 🔮 Future

- NauSync Local
- NauSync Impera
- Plugin System
- Cloud Integration

---

# ⚙ Built With

- Python
- Tkinter
- SQLite
- Multithreading
- Metadata-based Detection

---

# 👨‍💻 Developer

<div align="left">
<table>
<tr>
<td align="center">
<a href="https://github.com/NaufalKhalil">
<img src="https://github.com/NaufalKhalil.png" width="80"><br>
<strong>Naufal Khalil</strong>
</a><br>
<sub>Creator & Developer</sub>
</td>
</tr>
</table>
</div>

---

# 💬 Support

If you like this project:

- ⭐ Star the repository
- 🍴 Fork and contribute
- 🐞 Report bugs
- 💡 Suggest new features

Every contribution helps improve NauSync.

---

# 📧 Contact

Instagram

https://www.instagram.com/khalil.naufal_/

---

# 📄 License

This project is licensed under the **MIT License**.

See the **LICENSE** file for more information.