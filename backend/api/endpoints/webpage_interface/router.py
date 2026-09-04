"""Webpage-interface routes — generate / fetch the concrete widget for the current page, plus the
model call + deterministic fallback that back the generate route."""
from pathlib import Path
from typing import Any
import json

from fastapi import APIRouter, HTTPException

from api.data.task import task_store
from api.data.interface_representation import get_active_tree
from api.data.webpage_interface import get_webpage_interface, set_webpage_interface
from api.utils.llm import get_client_and_model, create_message
from definitions.webpage_interface import WEBPAGE_INTERFACE_GUIDE, WEBPAGE_INTERFACE_TOOL

router = APIRouter()


@router.get("/webpage-interfaces/{site_id}")
def get_webpage_interface_route(site_id: str) -> dict[str, Any]:
    widget = get_webpage_interface()
    if task_store.get("site_id") != site_id or widget is None:
        raise HTTPException(status_code=404, detail="Webpage interface not found")
    return widget


@router.post("/webpage-interfaces/{site_id}/generate")
async def generate_webpage_interface(site_id: str) -> dict[str, Any]:
    if task_store.get("site_id") != site_id or task_store.get("task_representation") is None:
        raise HTTPException(status_code=404, detail="Analyze the page before generating its interface")
    widget = await build_webpage_interface(get_active_tree(), task_store["task_representation"], task_store.get("page_text", ""))
    set_webpage_interface(widget)
    return widget


# --- generation (model call + deterministic fallback) ----------------------------------------

async def model_webpage_interface(
    interface_representation: dict[str, Any], task_representation: dict[str, Any], page_text: str = ""
) -> dict[str, Any] | None:
    client, model = get_client_and_model()
    if client is None:
        return None
    try:
        user_message = (
            "These are the user's interface PREFERENCES (page-agnostic — realize them for this page):\n"
            f"{json.dumps(interface_representation)}\n\n"
            "This is the TASK REPRESENTATION of the current page (grounded in its real elements):\n"
            f"{json.dumps(task_representation)}\n\n"
            + ((
                "This is the readable TEXT of the page (use it for items that are page CONTENT, not "
                "form fields — recipe steps, article sections — whose done-state the user toggles):\n"
                f"{page_text[:12000]}\n\n") if page_text else "")
            + "Produce the widget via the build_webpage_interface tool."
        )
        response = await create_message(
            client,
            model=model,
            max_tokens=32000,
            system=WEBPAGE_INTERFACE_GUIDE,
            tools=[WEBPAGE_INTERFACE_TOOL],
            tool_choice={"type": "tool", "name": "build_webpage_interface"},
            messages=[{"role": "user", "content": user_message}],
        )
        tool_use = next((block for block in response.content if block.type == "tool_use"), None)
        if tool_use is None:
            print(f"webpage interface: no tool_use block (stop_reason={response.stop_reason}); using fallback.")
            return None
        return tool_use.input
    except Exception as error:
        print(f"webpage interface call failed; using fallback: {error}")
        return None


def components_to_items(task_representation: dict[str, Any], limit: int = 20) -> list[dict[str, Any]]:
    """One tracked item per component (each form question is its own component), using the best
    form-control-ish selector available and the component's own label."""
    items: list[dict[str, Any]] = []
    seen: set[str] = set()
    for component in task_representation.get("components", []):
        members = [s for s in component.get("member_selectors", []) if isinstance(s, str)]
        selector = next((s for s in members if any(t in s for t in ("input", "select", "textarea", "#"))), None)
        selector = selector or component.get("dom_selector") or (members[0] if members else None)
        if not selector or selector in seen:
            continue
        seen.add(selector)
        label = (component.get("label") or component.get("semantic_role") or "element").strip()
        items.append({"selector": selector, "label": label[:80]})
        if len(items) >= limit:
            break
    return items


# The hand-written fallback widget lives in fallback_widget.js (real JS, no escaping) and is loaded
# verbatim here — used whenever a model webpage-interface call fails.
FALLBACK_WIDGET_CODE = Path(__file__).with_name("fallback_widget.js").read_text(encoding="utf-8")


def fallback_webpage_interface(
    interface_representation: dict[str, Any], task_representation: dict[str, Any], _page_text: str = ""
) -> dict[str, Any]:
    """Model-free: built straight from the task representation's components. Marked `degraded` so the
    client can tell the user generation failed instead of pretending it's a normal widget."""
    items = components_to_items(task_representation)
    style = interface_representation.get("style")
    return {
        "style": style if isinstance(style, dict) else {},
        "code": FALLBACK_WIDGET_CODE,
        "degraded": True,
        "state": {
            "note": "TaskWeb couldn't build the support for this page.",
            "detail": "Showing the fields it found — try again in a moment.",
            "items": items,
        },
    }


async def build_webpage_interface(
    interface_representation: dict[str, Any], task_representation: dict[str, Any], page_text: str = ""
) -> dict[str, Any]:
    """The model result if it succeeds, otherwise the deterministic fallback (which carries
    `degraded: True`)."""
    return (
        await model_webpage_interface(interface_representation, task_representation, page_text)
        or fallback_webpage_interface(interface_representation, task_representation, page_text)
    )
