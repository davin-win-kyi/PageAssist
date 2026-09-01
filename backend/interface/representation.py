"""Interface representation — a single, webpage-agnostic set of support preferences.

Shape: {component, style: {CSS prop/value}, content: [short phrases], children: [same shape]}

- One "active" tree at a time (what /chat edits); it is NOT itself a saved entry.
- Saved entries form a reusable database — any can be activated onto a different site later.
- `active_agreed` is a one-way latch: only /chat (on real agreement) or activating a saved entry sets
  it true; only reset clears it. It gates ever showing the support on a real page.
"""
from datetime import datetime, timezone
from typing import Any, Literal
import copy
import json
import uuid

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from common import store
from common.llm import get_client_and_model, call_structured_tool
from interface.prompts import TASKWEB_GUIDE

router = APIRouter()


def default_interface_representation() -> dict[str, Any]:
    # "component" starts empty; /chat names it once a concept is chosen (e.g. "checklist").
    return {"component": "", "style": {}, "content": [], "children": []}


def get_active_tree() -> dict[str, Any]:
    if store.interface_store.get("active_tree") is None:
        store.interface_store["active_tree"] = default_interface_representation()
    return store.interface_store["active_tree"]


def is_agreed() -> bool:
    return bool(store.interface_store.get("active_agreed", False))


def set_active_tree(tree: dict[str, Any], agreed: bool | None = None) -> None:
    store.interface_store["active_tree"] = tree
    if agreed is not None:
        store.interface_store["active_agreed"] = agreed
    store.save_interface_store()


# --- Working-tree + saved-database routes -------------------------------------------------------

@router.get("/interface-representation")
def get_interface_representation() -> dict[str, Any]:
    return {"tree": get_active_tree(), "agreed": is_agreed()}


@router.post("/interface-representation/reset")
def reset_interface_representation() -> dict[str, Any]:
    set_active_tree(default_interface_representation(), agreed=False)
    return {"tree": store.interface_store["active_tree"], "agreed": False}


@router.get("/interface-representations")
def list_interface_representations() -> list[dict[str, Any]]:
    return [
        {"id": entry["id"], "name": entry["name"], "created_at": entry["created_at"], "updated_at": entry["updated_at"]}
        for entry in store.interface_store["representations"].values()
    ]


class SaveInterfaceRepresentationRequest(BaseModel):
    name: str


@router.post("/interface-representations")
def save_interface_representation(request: SaveInterfaceRepresentationRequest) -> dict[str, Any]:
    """Save a copy of the current working tree as a new, named, reusable entry."""
    entry_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    entry = {"id": entry_id, "name": request.name, "created_at": now, "updated_at": now, "tree": copy.deepcopy(get_active_tree())}
    store.interface_store["representations"][entry_id] = entry
    store.save_interface_store()
    return entry


@router.post("/interface-representations/{entry_id}/activate")
def activate_interface_representation(entry_id: str) -> dict[str, Any]:
    """Copy a saved entry into the working tree. Later chat edits don't touch the saved entry, so it can
    be reused unchanged elsewhere. Reusing a saved concept counts as agreement → shown immediately."""
    if entry_id not in store.interface_store["representations"]:
        raise HTTPException(status_code=404, detail="Interface representation not found")
    set_active_tree(copy.deepcopy(store.interface_store["representations"][entry_id]["tree"]), agreed=True)
    return {"tree": store.interface_store["active_tree"], "agreed": True}


# --- /chat -------------------------------------------------------------------------------------
# TASKWEB_GUIDE (the long system prompt) lives in interface/prompts.py.


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class ChatRequest(BaseModel):
    message: str
    history: list[ChatMessage] = []


class ChatDecision(BaseModel):
    reply: str
    suggestions: list[str] = []
    interface_representation: dict[str, Any] | None = None
    agreed: bool = False


CHAT_DECISION_TOOL = {
    "name": "respond_and_update_interface",
    "description": "Reply to the user and report whether/how the interface representation should change.",
    "input_schema": {
        "type": "object",
        "properties": {
            "reply": {"type": "string", "description": "The concise, precise reply to show the user."},
            "suggestions": {
                "type": "array",
                "items": {"type": "string"},
                "maxItems": 3,
                "description": "At most 3 short quick-reply options.",
            },
            "interface_representation": {
                "type": ["object", "null"],
                "description": (
                    "The full updated {component, style, content, children} tree, only when this reply changes "
                    "it; otherwise null. \"content\" is short phrases (never literal instance text — the preview "
                    "is webpage-agnostic). \"children\" are structural groupings generic to the kind of task "
                    "(e.g. \"a section for the first person\"), never concrete real-page items."
                ),
            },
            "agreed": {
                "type": "boolean",
                "description": "True only on the turn the user has just confirmed a specific concrete support concept.",
            },
        },
        "required": ["reply", "suggestions", "agreed"],
    },
}


async def model_chat_decision(current_interface: dict[str, Any], message: str, history: list[ChatMessage]) -> ChatDecision | None:
    client, model = get_client_and_model()
    if client is None:
        return None
    try:
        system = TASKWEB_GUIDE + "\n\nCurrent interface representation: " + json.dumps(current_interface) + "."
        messages = [{"role": entry.role, "content": entry.content} for entry in history]
        messages.append({"role": "user", "content": message})
        return await call_structured_tool(
            client=client,
            model=model,
            system=system,
            messages=messages,
            tool=CHAT_DECISION_TOOL,
            max_tokens=4096,
            validate=ChatDecision.model_validate,
            label="chat decision",
        )
    except Exception as error:
        print(f"chat decision call failed; using fallback: {error}")
        return None


def fallback_chat_decision() -> ChatDecision:
    return ChatDecision(reply="I'm having trouble reaching the assistant right now. Please try again shortly.", suggestions=[])


@router.post("/chat")
async def chat(request: ChatRequest) -> dict[str, Any]:
    current = get_active_tree()
    decision = await model_chat_decision(current, request.message, request.history) or fallback_chat_decision()
    if decision.interface_representation is not None:
        store.interface_store["active_tree"] = decision.interface_representation
    if decision.agreed:
        store.interface_store["active_agreed"] = True
    if decision.interface_representation is not None or decision.agreed:
        store.save_interface_store()
    return {
        "reply": decision.reply,
        "suggestions": decision.suggestions,
        "interface_representation": get_active_tree(),
        "agreed": is_agreed(),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
