"""
The tree repair for the chat route
- on Gemini, a chat turn can say it changed the interface but send no tree, and retrying the
  same call doesn't fix it
- a separate call that asks for only the tree fills it, for a new tree and for an edit
"""
from typing import Any
import json

from definitions.repair import INTERFACE_TREE_REPAIR_GUIDE, INTERFACE_TREE_TOOL
from api.utils.llm import call_structured_tool, THINKING_LEVELS


# Builds the full tree the chat reply described, starting from current_tree when one is given
# (None when the tree is still blank).
async def repair_interface_tree(
    client: Any, model: str, user_message: str, reply: str, current_tree: dict[str, Any] | None,
) -> dict[str, Any]:
    said = f"The user said: {user_message!r}\nYou already told them: {reply!r}\n\n"
    if current_tree:
        task = (
            f"CURRENT interface representation:\n{json.dumps(current_tree)}\n\n{said}"
            f"Produce the FULL updated tree, starting from CURRENT and applying the change, via {INTERFACE_TREE_TOOL['name']}."
        )
    else:
        task = f"{said}Build the interface representation for the concept described above, via {INTERFACE_TREE_TOOL['name']}."
    return await call_structured_tool(
        client=client,
        model=model,
        system=INTERFACE_TREE_REPAIR_GUIDE,
        messages=[{"role": "user", "content": task}],
        tool=INTERFACE_TREE_TOOL,
        max_tokens=8000,
        validate=lambda data: data,
        label="interface tree repair",
        max_retries=1,
        thinking_level=THINKING_LEVELS["chat"],
    )
