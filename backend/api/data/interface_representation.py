"""Persistent state for the interface side, plus the active-tree accessors.

`interface_store` = {active_tree, active_agreed, representations{}}.
- One "active" tree at a time (what /chat edits); it is NOT itself a saved entry.
- Saved entries form a reusable database — any can be activated onto a different site later.
- `active_agreed` is a one-way latch: only /chat (on real agreement) or activating a saved entry
  sets it true; only reset clears it. It gates whether support may ever show on a real page.
"""
from typing import Any

from api.utils.json_store import load_json, dump_json

_FILE = "interface_representations.json"

interface_store: dict[str, Any] = load_json(_FILE, {"active_tree": None, "representations": {}})


def save_interface_store() -> None:
    dump_json(_FILE, interface_store)


def default_interface_representation() -> dict[str, Any]:
    # "component" starts empty; /chat names it once a concept is chosen (e.g. "checklist").
    # "description" is the human-readable "what/why", set once the concept is concrete.
    # "preferences" is a list of short page-agnostic phrases (was "content").
    return {"component": "", "description": "", "style": {}, "preferences": [], "children": []}


def get_active_tree() -> dict[str, Any]:
    if interface_store.get("active_tree") is None:
        interface_store["active_tree"] = default_interface_representation()
    return interface_store["active_tree"]


def is_agreed() -> bool:
    return bool(interface_store.get("active_agreed", False))


def set_active_tree(tree: dict[str, Any], agreed: bool | None = None) -> None:
    interface_store["active_tree"] = tree
    if agreed is not None:
        interface_store["active_agreed"] = agreed
    save_interface_store()
