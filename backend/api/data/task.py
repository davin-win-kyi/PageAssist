"""Persistent state for the task side: the single current-webpage slot.

`task_store` = {site_id, task_representation, page_text}. ONE page, never a history — analyzing a new
site_id replaces it. `page_text` is the page's readable prose, kept for widget generation (a recipe
step tracker, an article progress bar — content that isn't a form field). The generated widget is NOT
kept here (or on disk); see api/data/webpage_interface.py.

Accessed as `from api.data.task import task_store`; `replace_task_store()` mutates in place so that
binding stays valid.
"""
from typing import Any

from api.utils.json_store import load_json, dump_json

_FILE = "task_representations.json"
_EMPTY: dict[str, Any] = {"site_id": None, "task_representation": None, "page_text": ""}

task_store: dict[str, Any] = load_json(_FILE, dict(_EMPTY))
# Old shape (no "site_id", or a stale "webpage_interface" key) → discard and start clean.
if "site_id" not in task_store or "webpage_interface" in task_store:
    task_store = dict(_EMPTY)
task_store.setdefault("page_text", "")


def save_task_store() -> None:
    dump_json(_FILE, task_store)


def replace_task_store(site_id: str, task_representation: Any, page_text: str = "") -> None:
    """Swap the whole slot in place (keeps every importer's binding valid) and persist."""
    task_store.clear()
    task_store.update(site_id=site_id, task_representation=task_representation, page_text=page_text or "")
    save_task_store()
