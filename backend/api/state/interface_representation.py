"""
Interface representation getter and setter functions.
These are used to store and retrive the interface representation tree in a JSON file.

"""
from typing import Any

from api.utils.json_store import load_json, dump_json

_FILE = "interface_representations.json"

interface_store: dict[str, Any] = load_json(_FILE, {"active_tree": None, "representations": {}})


def save_interface_store() -> None:
    dump_json(_FILE, interface_store)


def default_interface_representation() -> dict[str, Any]:
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
