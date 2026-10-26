"""
Helper methods for the webpage interface routes
- the model call that builds the widget
- making a question with several controls track all of them
- the red warning widget shown when generation fails
"""
from pathlib import Path
from typing import Any
import json

from definitions.task import PAGE_TEXT_LIMIT
from definitions.webpage_interface import WEBPAGE_INTERFACE_GUIDE, WEBPAGE_INTERFACE_TOOL
from api.utils.llm import ModelError, get_client_and_model, create_message, THINKING_LEVELS
from api.utils import records


# ****************************************************************************************************
# Model call
# ****************************************************************************************************

# The widget (style, code, state) for the interface representation on this page.
async def model_webpage_interface(
    interface_representation: dict[str, Any], task_representation: dict[str, Any], page_text: str = "",
) -> dict[str, Any]:
    client, model = get_client_and_model()
    user_message = (
        "INTERFACE REPRESENTATION (what the user wants, page-agnostic):\n"
        f"{json.dumps(interface_representation)}\n\n"
        "TASK REPRESENTATION (this page, grounded in its real elements):\n"
        f"{json.dumps(task_representation)}\n\n"
        + (f"PAGE TEXT (for manual items: page content with no control):\n{page_text[:PAGE_TEXT_LIMIT]}\n\n" if page_text else "")
        + f"Produce the widget via the {WEBPAGE_INTERFACE_TOOL['name']} tool."
    )
    try:
        response = await create_message(
            client,
            model=model,
            max_tokens=32000,
            system=WEBPAGE_INTERFACE_GUIDE,
            tools=[WEBPAGE_INTERFACE_TOOL],
            tool_choice={"type": "tool", "name": WEBPAGE_INTERFACE_TOOL["name"]},
            messages=[{"role": "user", "content": user_message}],
            thinking_level=THINKING_LEVELS["webpage_interface"],
        )
    except Exception as error:
        raise ModelError(f"The widget call failed: {error}") from error
    tool_use = next((block for block in response.content if block.type == "tool_use"), None)
    if tool_use is None:
        raise ModelError(f"The widget call returned no result (stop reason: {response.stop_reason}).")
    return tool_use.input


# ****************************************************************************************************
# Grounded items
# ****************************************************************************************************

# Whether a selector points at a control rather than its label, help text or error message.
NON_CONTROL_ID_HINTS = ("label", "legend", "description", "-desc", "help", "error", "hint", "message", "caption")
def looks_control_like(selector: str) -> bool:
    lowered = selector.lower()
    if any(t in lowered for t in ("input", "select", "textarea")):
        return True
    if "#" in selector:
        return not any(hint in lowered for hint in NON_CONTROL_ID_HINTS)
    return False


# Each control of a component that bundles several (first + last name), mapped to the whole bundle.
def bundled_selector_groups(task_representation: dict[str, Any]) -> dict[str, list[str]]:
    groups: dict[str, list[str]] = {}
    for component in task_representation.get("components", []):
        control_like = [s for s in component.get("member_selectors", []) if isinstance(s, str) and looks_control_like(s)]
        if len(control_like) > 1:
            for selector in control_like:
                groups[selector] = control_like
    return groups


# A question with several controls is complete only once all of them are filled. An item grounded on
# one of them is widened to `selectors` naming the whole bundle from the task representation.
def enforce_bundled_selectors(items: list[dict[str, Any]], task_representation: dict[str, Any]) -> list[dict[str, Any]]:
    groups = bundled_selector_groups(task_representation)
    fixed: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict) or item.get("manual"):
            fixed.append(item)
            continue
        selector = item.get("selector") if isinstance(item.get("selector"), str) else None
        selectors = [s for s in item.get("selectors", []) if isinstance(s, str)] if isinstance(item.get("selectors"), list) else []
        bundle = next((groups[s] for s in ([selector] if selector else []) + selectors if s in groups), None)
        if bundle:
            item = {k: v for k, v in item.items() if k != "selector"}
            item["selectors"] = bundle
        fixed.append(item)
    return fixed


# One grounded item per component, used for questions a page change adds to a live widget.
def components_to_items(task_representation: dict[str, Any]) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    seen: set[str] = set()
    for component in task_representation.get("components", []):
        members = [s for s in component.get("member_selectors", []) if isinstance(s, str)]
        control_like = [s for s in members if looks_control_like(s)]
        label = (component.get("label") or component.get("component_type") or "element").strip()[:80]
        if len(control_like) > 1:
            key = "|".join(control_like)
            if key in seen:
                continue
            seen.add(key)
            items.append({"selectors": control_like, "label": label})
        else:
            selector = control_like[0] if control_like else (component.get("dom_selector") or (members[0] if members else None))
            if not selector or selector in seen:
                continue
            seen.add(selector)
            items.append({"selector": selector, "label": label})
    return items


# ****************************************************************************************************
# Failure widget
# ****************************************************************************************************

FAILED_WIDGET_CODE = Path(__file__).with_name("failed_widget.js").read_text(encoding="utf-8")


# A red warning in the widget's place saying generation failed, so the user isn't left with nothing.
def failed_webpage_interface(error: ModelError) -> dict[str, Any]:
    return {
        "style": {},
        "code": FAILED_WIDGET_CODE,
        "degraded": True,
        "state": {"title": "PageAssist couldn't build your support for this page", "error": str(error), "items": []},
    }


# The model's widget with bundled selectors enforced, or the warning widget if the model failed.
async def build_webpage_interface(
    interface_representation: dict[str, Any], task_representation: dict[str, Any], page_text: str = "",
) -> dict[str, Any]:
    try:
        widget = await model_webpage_interface(interface_representation, task_representation, page_text)
    except ModelError as error:
        print(f"webpage interface: {error}")
        records.error("backend", "generate", str(error))
        return failed_webpage_interface(error)
    items = widget.get("state", {}).get("items")
    if isinstance(items, list):
        widget["state"]["items"] = enforce_bundled_selectors(items, task_representation)
    return widget
