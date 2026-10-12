"""POST /chat — the conversational turn that shapes the active interface representation.

Separate from api/endpoints/interface_representation/ (working-tree + saved-database CRUD) because it's a
distinct concern: a model call with its own tool, decision model, and fallback.
"""
from datetime import datetime, timezone
from typing import Any
import json

from fastapi import APIRouter

from api.state.interface_representation import interface_store, save_interface_store, get_active_tree, is_agreed
from definitions.chat import PAGEASSIST_GUIDE, ChatMessage, ChatRequest, ChatDecision, CHAT_DECISION_TOOL, INTERFACE_TREE_TOOL
from definitions.interface_representation import INTERFACE_REPRESENTATION_GUIDE
from api.utils.llm import get_client_and_model, call_structured_tool
from api.utils.debuglog import append_jsonl

router = APIRouter()

# Only the most recent turns go to the model — older context adds tokens without changing the reply,
# and this conversation can run long.
MAX_HISTORY_MESSAGES = 10


async def _repair_interface_tree(
    client: Any, model: str, user_message: str, reply: str, current_tree: dict[str, Any] | None,
) -> dict[str, Any] | None:
    """Fallback for a gap observed live and reproducibly on Gemini (not Claude, given identical input):
    `tree_needs_update` comes back true and `reply` describes a change ("I've set up a checklist...",
    "I added expandable instructions...") — on both the turn a concept is first picked AND a later
    refinement turn — while interface_representation stays empty or unchanged. It does NOT self-correct
    when the same combined call is retried with explicit feedback (confirmed: 3/3 identical failures).
    A focused follow-up call asking for ONLY the tree, out of the reply/suggestions/agreed schema,
    reliably fills it — confirmed live for both a fresh build (current_tree has no content) and an edit
    (current_tree already has a concept and the change should apply on top of it)."""
    try:
        if _tree_has_content(current_tree):
            task = (
                f"CURRENT interface_representation tree:\n{json.dumps(current_tree)}\n\n"
                f"The user said: {user_message!r}\nYou already told them: {reply!r}\n\n"
                "Produce the FULL UPDATED tree — start from CURRENT above and apply the change — via "
                "build_interface_representation."
            )
        else:
            task = (
                f"The user said: {user_message!r}\nYou already told them: {reply!r}\n\n"
                "Build the interface_representation tree for the concept described above, via "
                "build_interface_representation."
            )
        tree = await call_structured_tool(
            client=client, model=model,
            system=INTERFACE_REPRESENTATION_GUIDE,
            messages=[{"role": "user", "content": task}],
            tool=INTERFACE_TREE_TOOL,
            max_tokens=8000,
            validate=lambda data: data,
            label="interface tree repair",
            max_retries=1,
        )
        return tree if _tree_has_content(tree) else None
    except Exception as error:
        print(f"interface tree repair failed: {error}")
        return None


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
        decision = await call_structured_tool(
            client=client,
            model=model,
            system=PAGEASSIST_GUIDE,
            messages=messages,
            tool=CHAT_DECISION_TOOL,
            max_tokens=32000,
            validate=ChatDecision.model_validate,
            label="chat decision",
        )
        if decision and decision.tree_needs_update and not _tree_has_content(decision.interface_representation):
            decision.interface_representation = await _repair_interface_tree(
                client, model, message, decision.reply, current_interface,
            )
        return decision
    except Exception as error:
        print(f"chat decision call failed; using fallback: {error}")
        return None


def fallback_chat_decision() -> ChatDecision:
    return ChatDecision(reply="I'm having trouble reaching the assistant right now. Please try again shortly.", suggestions=[])


def _tree_has_content(tree: dict[str, Any] | None) -> bool:
    """Mirrors the frontend's treeHasContent (App.tsx) — is there an actual concept here, vs. the
    blank {component: "", description: "", style: {}, preferences: [], children: []} shape a model
    sometimes sends instead of null on a turn that doesn't really change the tree. The tool schema
    allows the model to omit `interface_representation` for "unchanged" (-> None, handled fine below),
    but both Claude and Gemini have been observed sending a content-less {} instead — which this
    endpoint used to treat as a real update, silently blanking out whatever tree existed before (this
    is how two "Field checklist" saves in data/interface_representations.json ended up empty)."""
    if not tree:
        return False
    prefs = tree.get("preferences")
    pref_count = len(prefs) if isinstance(prefs, list) else len(prefs or {})
    return bool((tree.get("component") or "").strip() or (tree.get("description") or "").strip()
                or pref_count > 0 or len(tree.get("children") or []) > 0)


@router.post("/chat")
async def chat(request: ChatRequest) -> dict[str, Any]:
    # Three possible effects: replace the working tree, latch it as agreed, and (client-side) offer to save.
    current = get_active_tree()
    decision = await model_chat_decision(current, request.message, request.history) or fallback_chat_decision()
    tree_update = decision.interface_representation if _tree_has_content(decision.interface_representation) else None
    if tree_update is not None:
        interface_store["active_tree"] = tree_update
    if decision.agreed:
        interface_store["active_agreed"] = True
    if tree_update is not None or decision.agreed:
        save_interface_store()

    # data/chat_log.jsonl — one line per turn, for debugging. Wiped on a new chat (see /reset).
    append_jsonl("chat_log.jsonl", {
        "user": request.message,
        "history_len": len(request.history),
        "reply": decision.reply,
        "agreed": is_agreed(),
        "offer_save": decision.offer_save,
        "tree_changed": tree_update is not None,
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
