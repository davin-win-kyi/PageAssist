"""
Helper methods for the chat route
- the model call that decides one turn of the chat
- checking if an interface representation tree has any content
"""
from typing import Any
import json

from definitions.chat import PAGEASSIST_GUIDE, ChatMessage, ChatDecision, REPLY_AND_UPDATE_PREFERENCES_TOOL
from api.utils.llm import ModelError, get_client_and_model, call_structured_tool, THINKING_LEVELS
from api.endpoints.chat.repair import repair_interface_tree

# Only the latest turns go to the model; older ones add tokens without changing the reply.
MAX_HISTORY_MESSAGES = 10


# Whether a tree holds an actual concept, not the blank shape a model sometimes sends for "unchanged".
# Mirrors treeHasContent in the panel.
def tree_has_content(tree: dict[str, Any] | None) -> bool:
    if not tree:
        return False
    prefs = tree.get("preferences")
    pref_count = len(prefs) if isinstance(prefs, list) else len(prefs or {})
    return bool((tree.get("component") or "").strip() or (tree.get("description") or "").strip()
                or pref_count > 0 or len(tree.get("children") or []) > 0)


# The tree without parts that hold nothing, which the model sometimes sends as {} for a part it
# didn't fill. They would otherwise be saved and reused on every page.
def prune_empty_parts(tree: dict[str, Any] | None) -> dict[str, Any] | None:
    if not isinstance(tree, dict):
        return tree
    children = [prune_empty_parts(child) for child in tree.get("children") or [] if isinstance(child, dict)]
    return {**tree, "children": [child for child in children if tree_has_content(child)]}


# The reply plus the interface representation, agreed and offer_save decisions for one turn. Earlier
# turns go in as real messages; the last one carries the current tree and the new message.
async def model_chat_decision(current_tree: dict[str, Any], message: str, history: list[ChatMessage]) -> ChatDecision:
    client, model = get_client_and_model()
    messages = [{"role": entry.role, "content": entry.content} for entry in history[-MAX_HISTORY_MESSAGES:]]
    messages.append({"role": "user", "content": (
        "CURRENT INTERFACE REPRESENTATION:\n"
        f"{json.dumps(current_tree)}\n\n"
        "MY MESSAGE:\n"
        f"{message}\n\n"
        f"Reply, and report any interface representation change via the {REPLY_AND_UPDATE_PREFERENCES_TOOL['name']} tool."
    )})
    decision: ChatDecision = await call_structured_tool(
        client=client,
        model=model,
        system=PAGEASSIST_GUIDE,
        messages=messages,
        tool=REPLY_AND_UPDATE_PREFERENCES_TOOL,
        max_tokens=32000,
        validate=ChatDecision.model_validate,
        label="chat",
        thinking_level=THINKING_LEVELS["chat"],
    )
    decision.interface_representation = prune_empty_parts(decision.interface_representation)
    # Gemini sometimes says it changed the tree but leaves it empty; a tree-only call fills it in.
    if decision.tree_needs_update and not tree_has_content(decision.interface_representation):
        tree = await repair_interface_tree(
            client, model, message, decision.reply, current_tree if tree_has_content(current_tree) else None,
        )
        if not tree_has_content(tree):
            raise ModelError("The chat reply described a change, but the model returned no interface representation.")
        decision.interface_representation = prune_empty_parts(tree)
    return decision
