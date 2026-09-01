"""Shared persistent state for the two JSON-backed stores.

- task_representations.json → `task_store` = {site_id, task_representation, webpage_interface}
  - ONE slot for the current webpage only, never a history. Analyzing a new site_id replaces it.
  - `webpage_interface` is the concrete widget applied to that site (task representation + interface
    representation, combined) — kept here since it's just as site-specific.
- interface_representations.json → `interface_store` = {active_tree, active_agreed, representations}
  - A real database of saved, webpage-agnostic preference sets. One is "active" at a time (what /chat
    edits); any saved one can be reused later on a different site.

Every module accesses these as `store.task_store` / `store.interface_store` (attribute access), never a
`from store import task_store` binding — `replace_task_store()` mutates in place so those stay valid.
"""
from pathlib import Path
from typing import Any
import json

# The JSON data files live in backend/, one level up from this package.
_DATA_DIR = Path(__file__).resolve().parent.parent
TASK_STORE_FILE = _DATA_DIR / "task_representations.json"
INTERFACE_STORE_FILE = _DATA_DIR / "interface_representations.json"

EMPTY_TASK_STORE: dict[str, Any] = {"site_id": None, "task_representation": None, "webpage_interface": None}


def _load(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


task_store: dict[str, Any] = _load(TASK_STORE_FILE, dict(EMPTY_TASK_STORE))
# No "site_id" key → file predates the single-slot design (was keyed by every site ever visited). Discard.
if "site_id" not in task_store:
    task_store = dict(EMPTY_TASK_STORE)

interface_store: dict[str, Any] = _load(INTERFACE_STORE_FILE, {"active_tree": None, "representations": {}})


def save_task_store() -> None:
    TASK_STORE_FILE.write_text(json.dumps(task_store, indent=2), encoding="utf-8")


def save_interface_store() -> None:
    INTERFACE_STORE_FILE.write_text(json.dumps(interface_store, indent=2), encoding="utf-8")


def replace_task_store(site_id: str, task_representation: Any, webpage_interface: Any) -> None:
    """Swap the whole task_store in place (keeps `store.task_store` valid for every importer) and persist."""
    task_store.clear()
    task_store.update(site_id=site_id, task_representation=task_representation, webpage_interface=webpage_interface)
    save_task_store()
