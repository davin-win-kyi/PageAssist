"""
Util methods for JSON files
"""

from pathlib import Path
from typing import Any
import json
import os

# backend/data/ (runtime JSON) — this file is at backend/api/utils/json_store.py, so parents[2] is
# backend/. Not to be confused with the api/state/ package (in-process state modules).
# PAGEASSIST_DATA_DIR points it elsewhere — the test scripts use a throwaway directory so they never
# overwrite a real session's saved interfaces and task representation.
DATA_DIR = Path(os.environ.get("PAGEASSIST_DATA_DIR") or Path(__file__).resolve().parents[2] / "data")
DATA_DIR.mkdir(parents=True, exist_ok=True)


def load_json(name: str, default: Any) -> Any:
    path = DATA_DIR / name
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def dump_json(name: str, value: Any) -> None:
    (DATA_DIR / name).write_text(json.dumps(value, indent=2), encoding="utf-8")
