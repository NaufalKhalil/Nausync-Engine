from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from typing import Optional

from action import ActionDirection


class QueueStatus(Enum):
    PENDING = "PENDING"
    RUNNING = "RUNNING"
    SUCCESS = "SUCCESS"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"


class QueuePriority(Enum):
    HIGH = 3
    NORMAL = 2
    LOW = 1


@dataclass(slots=True)
class QueueItem:

    queue_id: Optional[int]

    action: str

    path: str

    source_hash: str | None

    destination_hash: str | None

    size: int

    modified_time: float

    status: QueueStatus = QueueStatus.PENDING

    priority: QueuePriority = QueuePriority.NORMAL

    retry_count: int = 0

    last_error: str | None = None

    created_at: datetime | None = None

    started_at: datetime | None = None

    finished_at: datetime | None = None

    # Arah eksekusi (source->destination atau destination->source).
    # Default TO_DESTINATION menjaga perilaku lama persis sama untuk
    # queue item yang dibuat sebelum field ini ada -- lihat action.py.
    direction: ActionDirection = ActionDirection.TO_DESTINATION