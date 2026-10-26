"""
The route for POST /chat, one turn of the conversation that shapes the interface representation
- the model call is in helpers.py, and the tree repair in repair.py
- the stored tree and the saved database are in api/endpoints/interface_representation/
"""
from datetime import datetime, timezone
from typing import Any
import time

from fastapi import APIRouter

from api.state.interface_representation import interface_store, save_interface_store, get_active_tree, is_agreed
from definitions.chat import ChatRequest
from api.endpoints.chat.helpers import model_chat_decision, tree_has_content
from api.utils import records

router = APIRouter()


# A turn can replace the working tree, mark it agreed, and offer to save it (the panel shows the offer).
# Each turn is kept in the records, with the tree whenever it changes.
@router.post("/chat")
async def chat(request: ChatRequest) -> dict[str, Any]:
    started = time.perf_counter()
    decision = await model_chat_decision(get_active_tree(), request.message, request.history)
    tree_update = decision.interface_representation if tree_has_content(decision.interface_representation) else None
    if tree_update is not None:
        interface_store["active_tree"] = tree_update
    if decision.agreed:
        interface_store["active_agreed"] = True
    if tree_update is not None or decision.agreed:
        save_interface_store()

    reply = {
        "reply": decision.reply,
        "suggestions": decision.suggestions,
        "interface_representation": get_active_tree(),
        "agreed": is_agreed(),
        "offer_save": decision.offer_save,
        "suggested_name": decision.suggested_name,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    records.chat_turn(request.message, reply, get_active_tree(), tree_update is not None, time.perf_counter() - started)
    return reply
