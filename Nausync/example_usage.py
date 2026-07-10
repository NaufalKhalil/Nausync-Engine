"""
Contoh penggunaan SyncEngine dengan progress reporting real-time.

Jalankan langsung: python example_usage.py
(Sesuaikan path source/destination di bagian bawah file.)
"""

from __future__ import annotations

import logging

from progress import ConsoleProgressPrinter, ProgressEvent
from sync import SyncEngine

# Konfigurasi logging adalah tanggung jawab aplikasi (entry point),
# bukan sync.py itu sendiri -- sync.py hanya memanggil logging.getLogger(__name__)
# dan membiarkan pemanggil yang menentukan level/format/handler.
#
# Level dibiarkan WARNING (bukan INFO) di sini supaya log tidak
# bertabrakan dengan blok progress yang di-redraw di tempat oleh
# ConsoleProgressPrinter -- ubah ke INFO/DEBUG kalau butuh log detail
# dan tidak keberatan tampilannya sedikit berantakan.
logging.basicConfig(
    level=logging.WARNING,
    format="%(asctime)s %(levelname)-8s %(name)s: %(message)s",
)

printer = ConsoleProgressPrinter()


def on_progress(event: ProgressEvent) -> None:
    """Progress callback -- teruskan setiap event ke console printer.

    Bisa diganti dengan update progress bar GUI, publish ke event bus,
    dsb. tanpa mengubah SyncEngine sama sekali -- SyncEngine hanya tahu
    ada satu ProgressCallback, tidak tahu-menahu ini dirender ke mana.
    """
    printer.render(event)


def main() -> None:
    engine = SyncEngine(
        progress_callback=on_progress,
        max_retries=3,
        verify_after_write=True,
        # Set False jika source/destination punya jutaan file dan ingin
        # menghindari walk tambahan untuk estimasi ETA scan.
        estimate_totals=True,
    )

    summary = engine.sync(
        source=r"D:\Font",
        destination=r"\\Naulnv\d\Font",
    )

    print(summary)


if __name__ == "__main__":
    main()
