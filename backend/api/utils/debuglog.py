"""
Util methods for chat logs 
"""

from datetime import datetime, timezone
from typing import Any
import json

from api.utils.json_store import DATA_DIR


def append_jsonl(name: str, record: dict[str, Any]) -> None:
    try:
        line = json.dumps({"ts": datetime.now(timezone.utc).isoformat(), **record}, ensure_ascii=False)
        with open(DATA_DIR / name, "a", encoding="utf-8") as handle:
            handle.write(line + "\n")
    except Exception as error:  # a debug log must never break the endpoint it's logging
        print(f"debuglog {name} failed: {error}")


def truncate_jsonl(name: str) -> None:
    """Empty a log file (called on a new chat so the log is per-conversation, not a running archive)."""
    try:
        (DATA_DIR / name).write_text("", encoding="utf-8")
    except Exception as error:
        print(f"debuglog truncate {name} failed: {error}")
