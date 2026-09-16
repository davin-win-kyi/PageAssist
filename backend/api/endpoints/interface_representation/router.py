"""Interface representation routes — the working tree and the saved, reusable database.

Shape: {component, description, style: {CSS prop/value}, preferences: [short phrases], children: [same]}

The store + active-tree accessors live in api/state/interface_representation.py; /chat is api/endpoints/chat/.
"""
from typing import Any
import copy
import uuid

from fastapi import APIRouter, HTTPException

from api.state.interface_representation import (
    interface_store,
    save_interface_store,
    default_interface_representation,
    get_active_tree,
    is_agreed,
    set_active_tree,
)
from definitions.interface_representation import SaveInterfaceRepresentationRequest
from api.utils.debuglog import truncate_jsonl

router = APIRouter()


@router.get("/interface-representation")
def get_interface_representation() -> dict[str, Any]:
    """The current working tree + whether the user has agreed to it."""
    return {"tree": get_active_tree(), "agreed": is_agreed()}


@router.post("/interface-representation/reset")
def reset_interface_representation() -> dict[str, Any]:
    """Blank the working tree and clear the agreement latch. This is the "new chat" trigger (panel
    mount + "End chat & start over"), so also wipe the chat log — it's per-conversation debug output,
    not a running archive."""
    set_active_tree(default_interface_representation(), agreed=False)
    truncate_jsonl("chat_log.jsonl")
    return {"tree": interface_store["active_tree"], "agreed": False}


@router.get("/interface-representations")
def list_interface_representations() -> list[dict[str, Any]]:
    return [
        {"id": entry["id"], "name": entry["name"]}
        for entry in interface_store["representations"].values()
    ]


@router.post("/interface-representations")
def save_interface_representation(request: SaveInterfaceRepresentationRequest) -> dict[str, Any]:
    """Save a copy of the current working tree as a new, named, reusable entry (Saved tab / chat offer)."""
    entry_id = str(uuid.uuid4())
    entry = {"id": entry_id, "name": request.name, "tree": copy.deepcopy(get_active_tree())}
    interface_store["representations"][entry_id] = entry
    save_interface_store()
    return {"id": entry_id, "name": request.name}


@router.post("/interface-representations/{entry_id}/activate")
def activate_interface_representation(entry_id: str) -> dict[str, Any]:
    """Copy a saved entry into the working tree — the way a concept shaped for one site is reused on
    another. Later chat edits don't touch the saved entry (use /update for that). Reusing a saved
    concept counts as agreement → shown immediately."""
    if entry_id not in interface_store["representations"]:
        raise HTTPException(status_code=404, detail="Interface representation not found")
    set_active_tree(copy.deepcopy(interface_store["representations"][entry_id]["tree"]), agreed=True)
    return {"tree": interface_store["active_tree"], "agreed": True}


@router.post("/interface-representations/{entry_id}/update")
def update_interface_representation(entry_id: str) -> dict[str, Any]:
    """Write the current working tree back onto an existing saved entry — "save my changes to the one
    I'm working from" (as opposed to POST /interface-representations, which makes a new entry)."""
    if entry_id not in interface_store["representations"]:
        raise HTTPException(status_code=404, detail="Interface representation not found")
    entry = interface_store["representations"][entry_id]
    entry["tree"] = copy.deepcopy(get_active_tree())
    save_interface_store()
    return {"id": entry_id, "name": entry["name"]}


@router.delete("/interface-representations/{entry_id}")
def delete_interface_representation(entry_id: str) -> dict[str, bool]:
    """Remove a saved entry from the reusable database. The working tree is untouched — deleting the
    entry you're currently working from just unlinks it (further changes become a fresh save)."""
    if interface_store["representations"].pop(entry_id, None) is None:
        raise HTTPException(status_code=404, detail="Interface representation not found")
    save_interface_store()
    return {"ok": True}
