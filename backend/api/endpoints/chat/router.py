"""POST /chat — the conversational turn that shapes the active interface representation.

Separate from api/endpoints/interface_representation/ (working-tree + saved-database CRUD) because it's a
distinct concern: a model call with its own tool, decision model, and fallback.
"""
from datetime import datetime, timezone
from typing import Any
import json

from fastapi import APIRouter

from api.data.interface_representation import interface_store, save_interface_store, get_active_tree, is_agreed
from definitions.chat import TASKWEB_GUIDE, ChatMessage, ChatRequest, ChatDecision, CHAT_DECISION_TOOL
from api.utils.llm import get_client_and_model, call_structured_tool
from api.utils.debuglog import append_jsonl

router = APIRouter()

# Only the most recent turns go to the model — older context adds tokens without changing the reply,
# and this conversation can run long.
MAX_HISTORY_MESSAGES = 10


async def model_chat_decision(current_interface: dict[str, Any], message: str, history: list[ChatMessage]) -> ChatDecision | None:
    """Get the three decisions (interface_representation, agreed, offer_save) + the reply for one turn.

    The prior turns go in as real messages (role fidelity); the final user turn is a labelled block
    carrying the current representation + the new message, so the model isn't parsing one JSON blob.
    """
    client, model = get_client_and_model()
    if client is None:
        return None
    try:
        messages = [{"role": entry.role, "content": entry.content} for entry in history[-MAX_HISTORY_MESSAGES:]]
        messages.append({"role": "user", "content": (
            "CURRENT INTERFACE REPRESENTATION:\n"
            f"{json.dumps(current_interface)}\n\n"
            "MY MESSAGE:\n"
            f"{message}\n\n"
            "Reply, and report any interface-representation change via the respond_and_update_interface tool."
        )})
        return await call_structured_tool(
            client=client,
            model=model,
            system=TASKWEB_GUIDE,
            messages=messages,
            tool=CHAT_DECISION_TOOL,
            max_tokens=32000,
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
    # Three possible effects: replace the working tree, latch it as agreed, and (client-side) offer to save.
    current = get_active_tree()
    decision = await model_chat_decision(current, request.message, request.history) or fallback_chat_decision()
    if decision.interface_representation is not None:
        interface_store["active_tree"] = decision.interface_representation
    if decision.agreed:
        interface_store["active_agreed"] = True
    if decision.interface_representation is not None or decision.agreed:
        save_interface_store()

    # data/chat_log.jsonl — one line per turn, for debugging. Wiped on a new chat (see /reset).
    append_jsonl("chat_log.jsonl", {
        "user": request.message,
        "history_len": len(request.history),
        "reply": decision.reply,
        "agreed": is_agreed(),
        "offer_save": decision.offer_save,
        "tree_changed": decision.interface_representation is not None,
        "interface_representation": get_active_tree(),
    })

    return {
        "reply": decision.reply,
        "suggestions": decision.suggestions,
        "interface_representation": get_active_tree(),
        "agreed": is_agreed(),
        "offer_save": decision.offer_save,
        "suggested_name": decision.suggested_name,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
