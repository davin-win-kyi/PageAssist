"""Shared JSON persistence. Each domain package keeps its own store module (task/store.py,
interface_representation/store.py) and uses these to read/write a file under backend/data/."""
from pathlib import Path
from typing import Any
import json

# backend/data/ (runtime JSON) — this file is at backend/api/utils/json_store.py, so parents[2] is
# backend/. Not to be confused with the api/data/ package (in-process state modules).
DATA_DIR = Path(__file__).resolve().parents[2] / "data"
DATA_DIR.mkdir(exist_ok=True)


def load_json(name: str, default: Any) -> Any:
    path = DATA_DIR / name
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def dump_json(name: str, value: Any) -> None:
    (DATA_DIR / name).write_text(json.dumps(value, indent=2), encoding="utf-8")
