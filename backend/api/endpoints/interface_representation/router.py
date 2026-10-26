"""
The routes for the interface representation: the working tree and the saved database
- a tree is {component, description, style, preferences, children}
- the store is in api/state/interface_representation.py, and the chat that shapes the tree is in
  api/endpoints/chat/
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
from definitions.interface_representation import SaveInterfaceRepresentationRequest, UpdateInterfaceRepresentationRequest
from api.utils import records

router = APIRouter()


@router.get("/interface-representation")
def get_interface_representation() -> dict[str, Any]:
    """The working tree, and whether the user has agreed to it."""
    return {"tree": get_active_tree(), "agreed": is_agreed()}


@router.post("/interface-representation/reset")
def reset_interface_representation() -> dict[str, Any]:
    """Blank the working tree and clear the agreement latch: the "new chat" trigger, which also
    starts a new folder in the records."""
    set_active_tree(default_interface_representation(), agreed=False)
    records.start_session()
    return {"tree": interface_store["active_tree"], "agreed": False}


@router.get("/interface-representations")
def list_interface_representations() -> list[dict[str, Any]]:
    return [
        {"id": entry["id"], "name": entry["name"]}
        for entry in interface_store["representations"].values()
    ]


@router.post("/interface-representations")
def save_interface_representation(request: SaveInterfaceRepresentationRequest) -> dict[str, Any]:
    """Save a copy of the working tree as a new, named entry, from the Saved tab or the chat's offer."""
    entry_id = str(uuid.uuid4())
    entry = {"id": entry_id, "name": request.name, "tree": copy.deepcopy(get_active_tree())}
    interface_store["representations"][entry_id] = entry
    save_interface_store()
    records.saved("saved interface", entry_id, request.name, request.record_id)
    return {"id": entry_id, "name": request.name}


@router.post("/interface-representations/{entry_id}/activate")
def activate_interface_representation(entry_id: str) -> dict[str, Any]:
    """Copy a saved entry into the working tree, which is how an interface made on one page is reused
    on another. Reusing one counts as agreeing to it, so it shows right away."""
    if entry_id not in interface_store["representations"]:
        raise HTTPException(status_code=404, detail="Interface representation not found")
    entry = interface_store["representations"][entry_id]
    set_active_tree(copy.deepcopy(entry["tree"]), agreed=True)
    records.interface_representation(entry["tree"], f'activated saved interface "{entry["name"]}"', agreed=True)
    return {"tree": interface_store["active_tree"], "agreed": True}


@router.post("/interface-representations/{entry_id}/update")
def update_interface_representation(entry_id: str, request: UpdateInterfaceRepresentationRequest | None = None) -> dict[str, Any]:
    """Write the working tree back onto a saved entry, to keep the changes made to the one in use."""
    if entry_id not in interface_store["representations"]:
        raise HTTPException(status_code=404, detail="Interface representation not found")
    entry = interface_store["representations"][entry_id]
    entry["tree"] = copy.deepcopy(get_active_tree())
    save_interface_store()
    records.saved("updated saved interface", entry_id, entry["name"], request.record_id if request else None)
    return {"id": entry_id, "name": entry["name"]}


@router.delete("/interface-representations/{entry_id}")
def delete_interface_representation(entry_id: str) -> dict[str, bool]:
    """Remove a saved entry. The working tree stays as it is."""
    removed = interface_store["representations"].pop(entry_id, None)
    if removed is None:
        raise HTTPException(status_code=404, detail="Interface representation not found")
    save_interface_store()
    records.event("deleted saved interface", {"id": entry_id, "name": removed["name"]})
    return {"ok": True}
