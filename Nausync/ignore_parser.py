"""
Ignore Engine untuk NauSync (.nausyncignore).

Parser pattern sederhana bergaya .gitignore. TIDAK mengklaim
kompatibilitas 100% dengan spesifikasi gitignore penuh (tidak mendukung
negasi "!pattern", character class "[abc]", atau escape "\\#") --
cukup untuk kebutuhan yang diminta: folder, wildcard (*.tmp), nama
file, dan folder rekursif.

Dipisah dari scanner.py supaya:
    - Bisa dites secara independen tanpa filesystem sungguhan (murni
      operasi string, tidak menyentuh disk sama sekali).
    - scanner.py tetap fokus pada walk + status file/folder, tidak
      tercampur dengan logic pattern-matching.

Scanner (lihat scanner.py) memanggil `IgnoreParser.from_root()` SEKALI
di awal setiap scan, sesuai spesifikasi ("Scanner harus membaca file
ini sekali di awal").
"""

from __future__ import annotations

import fnmatch
from dataclasses import dataclass
from pathlib import Path


def _normalize(pattern: str) -> str:
    return pattern.strip().replace("\\", "/")


@dataclass(slots=True)
class IgnoreRule:
    """Satu baris pattern dari .nausyncignore, sudah dinormalisasi."""

    raw: str
    dir_only: bool  # pattern diakhiri "/" -> hanya cocok untuk folder
    anchored: bool  # pattern mengandung "/" di tengah -> relatif ke root
    pattern: str  # pattern final yang dipakai fnmatch (tanpa trailing "/")

    def matches(self, rel_path: str, is_dir: bool) -> bool:
        if self.dir_only and not is_dir:
            return False

        name = rel_path.rsplit("/", 1)[-1]

        if self.anchored:
            # Pattern relatif terhadap root (mis. "backup/data") -- hanya
            # cocok persis di path tsb atau turunannya, TIDAK di level lain.
            if rel_path == self.pattern:
                return True
            return rel_path.startswith(self.pattern + "/")

        # Pattern tanpa "/" -> cocok di level manapun (folder rekursif),
        # persis semantik .gitignore untuk pattern semacam ini.
        if fnmatch.fnmatch(name, self.pattern):
            return True
        if fnmatch.fnmatch(rel_path, self.pattern):
            return True
        # Jaga-jaga untuk pemanggil yang tidak melakukan pruning direktori
        # (mis. compare_folders terhadap data lama) -- pattern seperti
        # "backup" tetap harus meng-ignore "backup/isi/dalam.txt", bukan
        # cuma "backup" itu sendiri.
        parts = rel_path.split("/")
        return any(fnmatch.fnmatch(part, self.pattern) for part in parts[:-1])


class IgnoreParser:
    """Memuat & mengevaluasi pattern dari sebuah file .nausyncignore."""

    def __init__(self, rules: list[IgnoreRule] | None = None) -> None:
        self._rules: list[IgnoreRule] = rules or []

    @classmethod
    def from_root(cls, root: Path, filename: str) -> "IgnoreParser":
        """Membaca `<root>/<filename>` sekali. Jika file tidak ada (atau
        tidak bisa dibaca), mengembalikan parser kosong -- tidak ada yang
        di-ignore, perilaku identik dengan sebelum fitur ini ditambahkan.
        """
        ignore_path = root / filename
        if not ignore_path.exists() or not ignore_path.is_file():
            return cls([])

        try:
            content = ignore_path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            return cls([])

        rules: list[IgnoreRule] = []
        for line in content.splitlines():
            rule = cls._parse_line(line)
            if rule is not None:
                rules.append(rule)
        return cls(rules)

    @staticmethod
    def _parse_line(line: str) -> IgnoreRule | None:
        text = _normalize(line)
        if not text or text.startswith("#"):
            return None

        dir_only = text.endswith("/")
        if dir_only:
            text = text[:-1]
        if not text:
            return None

        # Anchored jika ada "/" di tengah pattern (bukan cuma trailing
        # yang sudah dibuang) -- mis. "backup/data" (anchored) vs
        # "*.tmp" / "manifest.db" (tidak, cocok di level manapun).
        anchored = "/" in text.strip("/")
        text = text.lstrip("/")

        return IgnoreRule(raw=line, dir_only=dir_only, anchored=anchored, pattern=text)

    @property
    def is_empty(self) -> bool:
        """True jika tidak ada rule sama sekali (file tidak ada/kosong)."""
        return not self._rules

    def is_ignored(self, rel_path: str, is_dir: bool) -> bool:
        """True jika `rel_path` (relative posix, tanpa prefix "./") cocok
        salah satu rule. `is_dir` menentukan apakah entry ini folder atau
        file -- dibutuhkan untuk rule yang diakhiri "/".
        """
        if not self._rules or rel_path in ("", "."):
            return False
        return any(rule.matches(rel_path, is_dir) for rule in self._rules)
