"""Task representation — a task-aware semantic model of ONE specific webpage, grounded strictly in its
real, visible elements.

Flat lists, linked by id (never opaque nesting):
- tasks         : coarse, goal-oriented activities the user could name; hierarchical via parent_task_id
- components    : semantic groupings of DOM nodes a user refers to as one thing, each with a closed
                  component_type. Every individual form question is its own component — this is what
                  per-field completion tracking targets.
- relationships : depends_on / precedes / alternative_to links between components, only with visible
                  evidence on the page

Live completion/state is read from the DOM by the content script — the model never asserts it, so
there are deliberately no status fields here.
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
    PAGE_TEXT_LIMIT,
    PageElement,
    TaskRepresentationRequest,
    TaskPatchRequest,
    TaskRepresentationOut,
    PatchOut,
    Relationship,
    valid_relationships,
    TASK_REPRESENTATION_TOOL,
    PATCH_COMPONENTS_TOOL,
)
from api.utils.llm import get_client_and_model, get_fast_client_and_model, call_structured_tool
from api.endpoints.webpage_interface.router import components_to_items

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
            "containers": [container.model_dump() for container in request.containers],
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


def _fallback_component_type(element: PageElement) -> str:
    """A best guess at a control's component_type from its tag and role, for the model-free fallbacks."""
    if element.tag == "textarea":
        return "long-text-question"
    if element.tag == "select" or element.role in {"combobox", "listbox", "radio", "radiogroup"}:
        return "single-choice-question"
    if element.role in {"checkbox", "switch"}:
        return "toggle-question"
    return "text-question"


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
            "component_type": _fallback_component_type(e),
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
        "relationships": [],
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
    replace_task_store(site_id, task_representation, request.page_text[:PAGE_TEXT_LIMIT])
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
    rep["relationships"] = [rel for rel in rep.get("relationships", [])
                            if rel.get("source") not in dropped_ids and rel.get("target") not in dropped_ids]
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
        "component_type": _fallback_component_type(e),
        "semantic_role": "field-group",
        "label": (e.accessibleName or e.text or e.tag).strip()[:80],
        "description": "",
        "dom_selector": e.selector,
        "member_selectors": [e.selector],
        "associated_task_ids": [],
        "required_for_task": "unknown",
        "importance": "primary",
    } for i, e in enumerate(controls[:10])]


def _mapped_selectors(rep: dict[str, Any]) -> set[str]:
    return {s for comp in rep.get("components", [])
            for s in (comp.get("dom_selector"), *comp.get("member_selectors", [])) if isinstance(s, str)}


def _unmapped_revealed(rep: dict[str, Any], revealed: list[list[PageElement]]) -> list[PageElement]:
    """A question that was in the DOM but hidden at analyze time may already be modelled — its coming
    into view is an availability change, not a new component. Only questions with no control mapped at
    all are added (all of a radio group's options together, so one unmapped option of an otherwise
    mapped group can't become a lone component)."""
    mapped = _mapped_selectors(rep)
    return [e for group in revealed if not any(e.selector in mapped for e in group) for e in group]


async def _model_patch_components(rep: dict[str, Any], added, containers) -> tuple[list[dict[str, Any]], list[dict[str, Any]]] | None:
    # ANTHROPIC_MODEL_FAST (falls back to ANTHROPIC_MODEL if unset) — used HERE ONLY, i.e. only when
    # /patch is called, which only happens for a genuine structural DOM change while a widget is
    # showing (see App.tsx processStructuralChange). The full /analyze always uses get_client_and_model().
    # Low thinking on Gemini: on a real Greenhouse form it added a revealed question correctly 3 of 3
    # times at every level, in ~2.6s vs. ~11s at medium.
    client, model = get_fast_client_and_model()
    if client is None:
        return None
    try:
        print(f"patch [{model}]: {len(added)} added element(s), {len(rep.get('components', []))} existing component(s)")
        existing = [{"component_id": c.get("component_id"), "component_type": c.get("component_type"),
                     "label": c.get("label"), "dom_selector": c.get("dom_selector")} for c in rep.get("components", [])]
        user = (
            "EXISTING components (summary — do not repeat these):\n"
            f"{json.dumps(existing)}\n\n"
            "NEW elements that just appeared:\n"
            f"{json.dumps([e.model_dump() for e in added])}\n\n"
            + (f"CONTAINERS those elements sit in (each element's `container` is one of these `selector`s):\n"
               f"{json.dumps([c.model_dump() for c in containers])}\n\n" if containers else "")
            + "Return only the new component(s), and any relationships from them, via add_components."
        )
        out: PatchOut | None = await call_structured_tool(
            client=client, model=model, system=PATCH_TASK_REPRESENTATION_GUIDE,
            messages=[{"role": "user", "content": user}],
            tool=PATCH_COMPONENTS_TOOL, max_tokens=4000,
            validate=PatchOut.model_validate, label="task representation patch",
            thinking_level="low",
        )
        if out is None:
            return None
        comps = [comp.model_dump() for comp in out.components]
        # Re-id to avoid collisions with existing components, and point the new links at the new ids.
        start = _next_component_id(rep)
        new_ids = {}
        for i, comp in enumerate(comps):
            new_ids[comp["component_id"]] = f"c{start + i}"
            comp["component_id"] = new_ids[comp["component_id"]]
        existing_ids = {c.get("component_id") for c in rep.get("components", [])}
        links = [Relationship(type=rel.type,
                              source=new_ids.get(rel.source, rel.source if rel.source in existing_ids else ""),
                              target=new_ids.get(rel.target, rel.target if rel.target in existing_ids else ""))
                 for rel in out.relationships]
        known = existing_ids | set(new_ids.values())
        return comps, [rel.model_dump() for rel in valid_relationships(links, known)]
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
    added = request.added + _unmapped_revealed(rep, request.revealed)
    new_components: list[dict[str, Any]] = []
    new_relationships: list[dict[str, Any]] = []
    if added:
        patched = await _model_patch_components(rep, added, request.containers)
        new_components, new_relationships = patched if patched is not None else (_fallback_patch_components(rep, added), [])
    _append_components(rep, new_components)
    if new_relationships:
        rep.setdefault("relationships", []).extend(new_relationships)
    replace_task_store(site_id, rep, task_store.get("page_text", ""))
    # `changed` = did the task representation actually gain/lose a component. A DOM change the client
    # flagged as structural often turns out to be cosmetic (a file-upload button row swapping for a
    # "<filename> x" chip within the SAME already-modelled question) — added elements the model correctly
    # judged not task-relevant, or removed selectors that never belonged to a real component. The client
    # uses this to skip regenerating the widget and stay quiet instead of claiming an update happened.
    changed = len(new_components) > 0 or removed_count > 0
    print(f"patch: +{len(new_components)} components, -{removed_count} selectors "
          f"({len(rep.get('components', []))} total); changed={changed}")
    # `added_items`: the new components as widget items, so the panel can splice them into the widget
    # already on the page (content.ts spliceWidgetItems) instead of regenerating it — ~70s at medium
    # thinking for a page change that only added or removed a question.
    return {**rep, "changed": changed, "added_items": components_to_items({"components": new_components})}
