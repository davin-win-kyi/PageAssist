"""Webpage interface — the concrete widget for ONE site: its task representation realized through the
active interface representation. Model-generated JS that runs in a sandboxed iframe.
"""
from typing import Any
import json

from fastapi import APIRouter, HTTPException

from common import store
from common.llm import get_client_and_model
from interface.representation import get_active_tree

router = APIRouter()

WEBPAGE_INTERFACE_TOOL = {
    "name": "build_webpage_interface",
    "description": "Produce a concrete, code-driven interface widget grounded in a specific webpage's real task representation.",
    "input_schema": {
        "type": "object",
        "properties": {
            "style": {
                "type": "object",
                "description": (
                    "Real CSS for the widget's OUTER frame — position and size only (bottom, right, width, "
                    "height), applied by the host to the frame. The widget's own look lives in your code; "
                    "never put look-and-feel properties here."
                ),
            },
            "code": {
                "type": "string",
                "description": (
                    "JavaScript that assigns window.render = function(state) { ... } and nothing else at the "
                    "top level. Runs in a locked-down sandboxed iframe: no access to the real page, cookies, "
                    "storage, or network (fetch/XMLHttpRequest/WebSocket/window.open/navigator.sendBeacon all "
                    "throw). Build the widget's DOM inside document.body with ordinary APIs. render(state) is "
                    "re-called on every state change, so it must be idempotent — reset document.body and its "
                    "inline style at the start of each call."
                ),
            },
            "state": {
                "type": "object",
                "properties": {
                    "items": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "selector": {"type": "string", "description": "Copied verbatim from task_elements — never invent one."},
                                "label": {"type": "string"},
                            },
                            "required": ["selector", "label"],
                        },
                        "description": (
                            "One entry per real page element the widget tracks. The host keeps each item's live "
                            "\"complete\" flag in sync (filled, for a field; clicked, for a button/link) and "
                            "re-calls render(state) on change. Your code never computes that flag but IS "
                            "responsible for showing it (e.g. checkmark vs. empty circle)."
                        ),
                    },
                },
                "description": "Initial data for render(state). \"items\" is host-managed; add any other keys your code needs — they pass through on every later state push.",
            },
        },
        "required": ["style", "code", "state"],
    },
}

_SYSTEM = (
    "Given a user's interface preferences and a task representation of a specific webpage, produce a "
    "concrete, code-driven widget grounded in that page's real elements.\n"
    "- The preferences are reusable and webpage-agnostic: \"content\" is short phrases describing what to "
    "show / how to behave; \"children\" are structural groupings generic to the kind of task. Your job is "
    "to REALIZE those against this page's actual task_elements.\n"
    "- Only reference elements genuinely in task_elements. Never invent a selector or a plausible field. "
    "If a form has not loaded, show fewer items or a status message rather than guessing.\n"
    "\n"
    "Code contract:\n"
    "- Assign window.render = function(state) {...} and nothing else at the top level.\n"
    "- Sandboxed iframe: no real page, cookies, storage, or network (those APIs throw). Build freely "
    "inside document.body with ordinary DOM APIs.\n"
    "- render(state) is re-called on every state change — make it idempotent (reset document.body at the "
    "start of each call).\n"
    "- For every state.items entry, show its item.complete flag as part of that item's display. The host "
    "keeps that flag live and accurate; you never compute it, you only decide how to show it.\n"
    "- Style the widget's whole look (background, spacing, border, typography, colors) inside your code. "
    "The separate \"style\" field controls ONLY the outer frame's position/size on the host page, and the "
    "frame already defaults to a readable size docked bottom-right — only set position/size there if the "
    "user explicitly asked for something different.\n"
    "\n"
    "Frame controls: the host exposes window.taskweb inside the sandbox — call these ONLY if the user's "
    "preferences call for that affordance, and draw the control yourself (there is no host-drawn chrome):\n"
    "- window.taskweb.move(dx, dy) — nudge the frame by a pixel delta (implement a drag handle by "
    "streaming deltas during mousemove).\n"
    "- window.taskweb.close() — remove the widget.\n"
    "- window.taskweb.setHeight(px) / window.taskweb.resetHeight() — pin or release the frame height "
    "(height otherwise auto-fits your content).\n"
    "Do not attempt to resize or reposition the frame by any other means."
)


async def model_webpage_interface(interface_representation: dict[str, Any], task_representation: dict[str, Any]) -> dict[str, Any] | None:
    client, model = get_client_and_model()
    if client is None:
        return None
    try:
        response = await client.messages.create(
            model=model,
            max_tokens=3000,
            system=_SYSTEM,
            tools=[WEBPAGE_INTERFACE_TOOL],
            tool_choice={"type": "tool", "name": "build_webpage_interface"},
            messages=[{"role": "user", "content": json.dumps({
                "interface_representation": interface_representation,
                "task_representation": task_representation,
            })}],
        )
        tool_use = next((block for block in response.content if block.type == "tool_use"), None)
        if tool_use is None:
            print(f"webpage interface: no tool_use block (stop_reason={response.stop_reason}); using fallback.")
            return None
        return tool_use.input
    except Exception as error:
        print(f"webpage interface call failed; using fallback: {error}")
        return None


def flatten_task_elements(task: dict[str, Any]) -> list[dict[str, Any]]:
    elements = list(task.get("task_elements", []))
    for child in task.get("children_tasks", []):
        elements += flatten_task_elements(child)
    return elements


# Ships with the backend, not model-generated — a transient model failure always has this known-good
# widget to fall back to instead of showing nothing.
FALLBACK_WIDGET_CODE = (
    "window.render = function(state) {\n"
    "  document.body.style.cssText = 'box-sizing:border-box;padding:12px;background:#ffffff;"
    "border:1px solid #e0e0e0;border-radius:8px;font:13px -apple-system,BlinkMacSystemFont,sans-serif;color:#111;';\n"
    "  document.body.innerHTML = '';\n"
    "  var note = document.createElement('div');\n"
    "  note.style.cssText = 'font-weight:600;margin-bottom:8px;';\n"
    "  note.textContent = state.note || 'Available page elements';\n"
    "  document.body.appendChild(note);\n"
    "  (state.items || []).forEach(function(item) {\n"
    "    var row = document.createElement('div');\n"
    "    row.style.cssText = 'padding:2px 0;';\n"
    "    row.textContent = (item.complete ? '\\u2713 ' : '\\u25cb ') + item.label;\n"
    "    document.body.appendChild(row);\n"
    "  });\n"
    "};\n"
)


def fallback_webpage_interface(interface_representation: dict[str, Any], task_representation: dict[str, Any]) -> dict[str, Any]:
    """Model-free: built straight from the task representation's real elements so a model failure never
    means showing nothing grounded in the actual page."""
    seen_selectors: set[str] = set()
    items = []
    for element in flatten_task_elements(task_representation):
        selector = element.get("selector")
        if not selector or selector in seen_selectors:
            continue
        seen_selectors.add(selector)
        label = (element.get("text") or "").strip() or element.get("tag", "element")
        items.append({"selector": selector, "label": label[:80]})
        if len(items) >= 12:
            break
    style = interface_representation.get("style")
    return {
        "style": style if isinstance(style, dict) else {},
        "code": FALLBACK_WIDGET_CODE,
        "state": {"note": "Showing available page elements while support is regenerated", "items": items},
    }


@router.get("/webpage-interfaces/{site_id}")
def get_webpage_interface(site_id: str) -> dict[str, Any]:
    if store.task_store.get("site_id") != site_id or store.task_store.get("webpage_interface") is None:
        raise HTTPException(status_code=404, detail="Webpage interface not found")
    return store.task_store["webpage_interface"]


@router.post("/webpage-interfaces/{site_id}/generate")
async def generate_webpage_interface(site_id: str) -> dict[str, Any]:
    if store.task_store.get("site_id") != site_id or store.task_store.get("task_representation") is None:
        raise HTTPException(status_code=404, detail="Analyze the page before generating its interface")
    task_representation = store.task_store["task_representation"]
    interface_representation = get_active_tree()
    webpage_interface = (
        await model_webpage_interface(interface_representation, task_representation)
        or fallback_webpage_interface(interface_representation, task_representation)
    )
    store.task_store["webpage_interface"] = webpage_interface
    store.save_task_store()
    return webpage_interface
