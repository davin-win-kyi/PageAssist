"""Task representation — a task-aware semantic model of ONE specific webpage, grounded strictly in its
real, visible elements.

Two tiers (flat lists, parent references — never opaque nesting):
- tasks       : coarse, goal-oriented activities the user could name; hierarchical via parent_task_id
- components  : semantic groupings of DOM nodes a user refers to as one thing. Every individual form
                question is its own component — this is what per-field completion tracking targets.

Live completion/state is read from the DOM by the content script — the model never asserts it, so
there are deliberately no status/relationship fields here.
"""
from __future__ import annotations
from typing import Any
import copy
import json

from fastapi import APIRouter, HTTPException

from api.state.task import task_store, replace_task_store
from definitions.task import (
    TASK_REPRESENTATION_GUIDE,
    PATCH_TASK_REPRESENTATION_GUIDE,
    TaskRepresentationRequest,
    TaskPatchRequest,
    TaskRepresentationOut,
    TASK_REPRESENTATION_TOOL,
    PATCH_COMPONENTS_TOOL,
)
from api.utils.llm import get_client_and_model, get_fast_client_and_model, call_structured_tool

router = APIRouter()

# content.ts already priority-sorts and caps its payload; this is the token-budget backstop.
MAX_ELEMENTS_TO_MODEL = 500


async def model_task_representation(request: TaskRepresentationRequest) -> dict[str, Any] | None:
    client, model = get_client_and_model()
    if client is None:
        return None
    try:
        elements = request.elements[:MAX_ELEMENTS_TO_MODEL]
        inputish = sum(1 for e in elements if e.tag in {"input", "textarea", "select"}
                       or e.role in {"textbox", "combobox", "checkbox", "radio", "searchbox", "spinbutton"})
        frames = request.frames or {}
        frame_note = f", frames same/cross={frames.get('sameOrigin', 0)}/{frames.get('crossOrigin', 0)}" if frames else ""
        print(f"analyze [{model}]: {len(request.elements)} elements received ({len(elements)} sent, {inputish} input-ish{frame_note})")
        if inputish == 0 and frames.get("crossOrigin", 0) > 0 and frames.get("sameOrigin", 0) == 0:
            print("analyze: 0 form controls and only cross-origin iframe(s) — the form is likely in an "
                  "iframe the extension can't read (needs all_frames content-script injection).")
        payload = {
            "url": request.url,
            "title": request.title,
            "elements": [element.model_dump() for element in elements],
        }
        return await call_structured_tool(
            client=client,
            model=model,
            system=TASK_REPRESENTATION_GUIDE,
            messages=[{"role": "user", "content": json.dumps(payload)}],
            tool=TASK_REPRESENTATION_TOOL,
            max_tokens=32000,
            validate=lambda data: TaskRepresentationOut.model_validate(data).model_dump(),
            label="task representation",
        )
    except Exception as error:
        print(f"task representation call failed; using fallback: {error}")
        return None


def fallback_task_representation(request: TaskRepresentationRequest) -> dict[str, Any]:
    """Model-free fallback: one form-completion task plus one component per real form control, so a
    transient model failure still yields a per-field-granular model grounded in the real page."""
    controls = [
        e for e in request.elements
        if e.tag in {"input", "textarea", "select"} or e.role in {"textbox", "combobox", "checkbox", "radio"}
    ]
    components = [
        {
            "component_id": f"c{i + 1}",
            "semantic_role": "field-group",
            "label": (e.accessibleName or e.text or e.tag).strip()[:80],
            "description": "",
            "dom_selector": e.selector,
            "member_selectors": [e.selector],
            "associated_task_ids": ["t1"],
            "required_for_task": "unknown",
            "importance": "primary",
        }
        for i, e in enumerate(controls[:40])
    ]
    return {
        "page_purpose": request.title or request.url,
        "page_type": "form" if components else "",
        "tasks": [{
            "task_id": "t1",
            "label": f"Complete {request.title or 'this page'}",
            "description": "",
            "task_type": "form-completion",
            "parent_task_id": None,
            "component_ids": [c["component_id"] for c in components],
            "importance": "primary",
        }] if components else [],
        "components": components,
        "modeling_notes": "Deterministic fallback — no model call.",
    }


# --- Routes --------------------------------------------------------------------------------------

@router.get("/task-representations/{site_id}")
def get_task_representation(site_id: str) -> dict[str, Any]:
    if task_store.get("site_id") != site_id or task_store.get("task_representation") is None:
        raise HTTPException(status_code=404, detail="Task representation not found")
    return task_store["task_representation"]


@router.post("/task-representations/{site_id}/analyze")
async def analyze_task_representation(site_id: str, request: TaskRepresentationRequest) -> dict[str, Any]:
    task_representation = await model_task_representation(request) or fallback_task_representation(request)
    replace_task_store(site_id, task_representation, request.page_text[:12000])
    return task_representation


# --- Incremental patch (fast path) ------------------------------------------------------------

def _next_component_id(rep: dict[str, Any]) -> int:
    nums = [int(c["component_id"][1:]) for c in rep.get("components", [])
            if isinstance(c.get("component_id"), str) and c["component_id"][1:].isdigit()]
    return (max(nums) + 1) if nums else 1


def _remove_components(rep: dict[str, Any], selectors: list[str]) -> int:
    """Drop any EXISTING component whose dom_selector/member_selectors match a departed selector.
    Returns how many were actually dropped — a UI-only DOM swap inside an already-modelled question
    (a file-upload button row replaced by a "<filename> x" chip) almost never matches a real
    component's selector, so this is usually 0; the caller uses that to stay quiet."""
    gone = set(selectors)
    if not gone:
        return 0
    kept, dropped_ids = [], set()
    for comp in rep.get("components", []):
        sels = {comp.get("dom_selector"), *comp.get("member_selectors", [])}
        if sels & gone:
            dropped_ids.add(comp.get("component_id"))
        else:
            kept.append(comp)
    rep["components"] = kept
    for task in rep.get("tasks", []):
        task["component_ids"] = [cid for cid in task.get("component_ids", []) if cid not in dropped_ids]
    return len(dropped_ids)


def _primary_task_id(rep: dict[str, Any]) -> str | None:
    tasks = rep.get("tasks", [])
    for task in tasks:
        if task.get("importance") == "primary":
            return task.get("task_id")
    return tasks[0].get("task_id") if tasks else None


def _append_components(rep: dict[str, Any], new_components: list[dict[str, Any]]) -> None:
    if not new_components:
        return
    task_id = _primary_task_id(rep)
    rep.setdefault("components", []).extend(new_components)
    if task_id:
        for comp in new_components:
            if task_id not in comp.get("associated_task_ids", []):
                comp.setdefault("associated_task_ids", []).append(task_id)
        for task in rep.get("tasks", []):
            if task.get("task_id") == task_id:
                task.setdefault("component_ids", []).extend(c["component_id"] for c in new_components)


def _fallback_patch_components(rep: dict[str, Any], added) -> list[dict[str, Any]]:
    controls = [e for e in added if e.tag in {"input", "textarea", "select"}
                or e.role in {"textbox", "combobox", "checkbox", "radio", "searchbox", "spinbutton"}]
    start = _next_component_id(rep)
    return [{
        "component_id": f"c{start + i}",
        "semantic_role": "field-group",
        "label": (e.accessibleName or e.text or e.tag).strip()[:80],
        "description": "",
        "dom_selector": e.selector,
        "member_selectors": [e.selector],
        "associated_task_ids": [],
        "required_for_task": "unknown",
        "importance": "primary",
    } for i, e in enumerate(controls[:10])]


async def _model_patch_components(rep: dict[str, Any], added) -> list[dict[str, Any]] | None:
    # ANTHROPIC_MODEL_FAST (falls back to ANTHROPIC_MODEL if unset) — used HERE ONLY, i.e. only when
    # /patch is called, which only happens for a genuine structural DOM change while a widget is
    # showing (see App.tsx processStructuralChange). The full /analyze always uses get_client_and_model().
    client, model = get_fast_client_and_model()
    if client is None:
        return None
    try:
        print(f"patch [{model}]: {len(added)} added element(s), {len(rep.get('components', []))} existing component(s)")
        existing = [{"semantic_role": c.get("semantic_role"), "label": c.get("label"),
                     "dom_selector": c.get("dom_selector")} for c in rep.get("components", [])]
        user = (
            "EXISTING components (summary — do not repeat these):\n"
            f"{json.dumps(existing)}\n\n"
            "NEW elements that just appeared:\n"
            f"{json.dumps([e.model_dump() for e in added])}\n\n"
            "Return only the new component(s) via add_components."
        )
        out = await call_structured_tool(
            client=client, model=model, system=PATCH_TASK_REPRESENTATION_GUIDE,
            messages=[{"role": "user", "content": user}],
            tool=PATCH_COMPONENTS_TOOL, max_tokens=4000,
            validate=lambda d: d, label="task representation patch",
        )
        comps = (out or {}).get("components") or []
        start = _next_component_id(rep)
        for i, comp in enumerate(comps):        # re-id to avoid collisions with existing components
            comp["component_id"] = f"c{start + i}"
        return comps
    except Exception as error:
        print(f"task representation patch call failed; using fallback: {error}")
        return None


@router.post("/task-representations/{site_id}/patch")
async def patch_task_representation(site_id: str, request: TaskPatchRequest) -> dict[str, Any]:
    """Cheap incremental update: splice a few just-added fields into the stored representation (and
    drop removed ones) instead of re-modelling the whole page. Uses the fast model for the new
    component(s), with a deterministic fallback. Returns the full updated representation."""
    if task_store.get("site_id") != site_id or task_store.get("task_representation") is None:
        raise HTTPException(status_code=404, detail="Analyze the page before patching it")
    rep = copy.deepcopy(task_store["task_representation"])
    removed_count = _remove_components(rep, request.removed)
    new_components: list[dict[str, Any]] = []
    if request.added:
        new_components = await _model_patch_components(rep, request.added) or _fallback_patch_components(rep, request.added)
    _append_components(rep, new_components)
    replace_task_store(site_id, rep, task_store.get("page_text", ""))
    # `changed` = did the task representation actually gain/lose a component. A DOM change the client
    # flagged as structural often turns out to be cosmetic (a file-upload button row swapping for a
    # "<filename> x" chip within the SAME already-modelled question) — added elements the model correctly
    # judged not task-relevant, or removed selectors that never belonged to a real component. The client
    # uses this to skip regenerating the widget and stay quiet instead of claiming an update happened.
    changed = len(new_components) > 0 or removed_count > 0
    print(f"patch: +{len(new_components)} components, -{removed_count} selectors "
          f"({len(rep.get('components', []))} total); changed={changed}")
    return {**rep, "changed": changed}
