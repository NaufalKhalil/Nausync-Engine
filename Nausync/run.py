from progress import ConsoleProgressPrinter, ProgressEvent
from sync import SyncEngine
from sync_modes import MirrorMode, BackupMode, TwoWayMode

printer = ConsoleProgressPrinter()

def on_progress(event: ProgressEvent) -> None:
    printer.render(event)

engine = SyncEngine(
    progress_callback=on_progress,
    mode=MirrorMode(),          # ganti: MirrorMode() / BackupMode() / TwoWayMode()
)

folder_utama = r"D:\Kenangan"
foleder_backup = r"\\Naulnv\d\Kenangan"

summary = engine.sync(folder_utama, foleder_backup)
print(summary)

if engine.conflicts:
    print(f"\n{len(engine.conflicts)} file konflik (Two-Way saja):")
    for c in engine.conflicts:
        print(" -", c.path)