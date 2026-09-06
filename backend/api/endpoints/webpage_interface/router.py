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


# `member_selectors` is "the key nodes in this component" (see definitions/task/schema.py), NOT
# "the controls that must each be filled" — it routinely includes the component's own <label> (a
# near-universal aria-labelledby pattern gives it its own id, e.g. id="first_name-label" beside
# id="first_name"), plus description/error/help text nodes. A bare "#" (any id) or "input"/"select"/
# "textarea" substring check can't tell those apart from a real second control, and a <label> can
# never read as "filled" — so treating it as one wrongly locks the item incomplete forever. Exclude
# selectors whose id names this kind of scaffolding before counting what's left as control-like.
_NON_CONTROL_ID_HINTS = ("label", "legend", "description", "-desc", "help", "error", "hint", "message", "caption")
def _looks_control_like(selector: str) -> bool:
    lowered = selector.lower()
    if any(t in lowered for t in ("input", "select", "textarea")):
        return True
    if "#" in selector:
        return not any(hint in lowered for hint in _NON_CONTROL_ID_HINTS)
    return False


def _bundled_selector_groups(task_representation: dict[str, Any]) -> dict[str, list[str]]:
    """Map every control-like selector to the full sibling list of control-like selectors in its
    component, for each component whose `member_selectors` bundle more than one control. A selector
    belonging to a single-control component has no entry."""
    groups: dict[str, list[str]] = {}
    for component in task_representation.get("components", []):
        members = [s for s in component.get("member_selectors", []) if isinstance(s, str)]
        control_like = [s for s in members if _looks_control_like(s)]
        if len(control_like) > 1:
            for selector in control_like:
                groups[selector] = control_like
    return groups


def enforce_bundled_selectors(items: list[dict[str, Any]], task_representation: dict[str, Any]) -> list[dict[str, Any]]:
    """The prompt asks the model to use `selectors: [...]` (not a single `selector`) for an item that
    answers one question via more than one required control (first + last name; a phone number's
    country + number) — but this call has no schema-validation retry loop (its output is executable
    code, not a closed schema), so the model doesn't always comply, and when it picks a single control
    to ground on there's no way to know in advance whether it picked the genuinely-answered one or an
    auxiliary one with a quietly-defaulted value (a country-code picker isn't reliably pre-filled —
    e.g. Greenhouse's own phone widget ships it blank). Re-derive the grouping straight from the task
    representation's own `member_selectors` (data we already trust) and upgrade any item naming ONE
    member of a bundle to `selectors` naming every member of that bundle — this makes which single
    control the model happened to pick irrelevant, since the item now requires all of them regardless."""
    groups = _bundled_selector_groups(task_representation)
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


def components_to_items(task_representation: dict[str, Any], limit: int = 20) -> list[dict[str, Any]]:
    """One tracked item per component (each form question is its own component), using the best
    form-control-ish selector(s) available and the component's own label. When a component genuinely
    bundles more than one control (a first+last name pair, a split address — see the guide's
    form-question exception), track ALL of them via `selectors` rather than picking just one; a
    single selector can only ever reflect one part of a multi-control answer."""
    items: list[dict[str, Any]] = []
    seen: set[str] = set()
    for component in task_representation.get("components", []):
        members = [s for s in component.get("member_selectors", []) if isinstance(s, str)]
        control_like = [s for s in members if _looks_control_like(s)]
        label = (component.get("label") or component.get("semantic_role") or "element").strip()[:80]
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
    widget = (
        await model_webpage_interface(interface_representation, task_representation, page_text)
        or fallback_webpage_interface(interface_representation, task_representation, page_text)
    )
    items = widget.get("state", {}).get("items")
    if isinstance(items, list):
        widget["state"]["items"] = enforce_bundled_selectors(items, task_representation)
    return widget
