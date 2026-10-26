"""
Helper methods for the patch route
- removing and adding components in the stored task representation
- deciding which revealed questions are new
- the model call for the new components
"""
from typing import Any
import json

from definitions.task import PageElement, ContextContainer, Relationship, valid_relationships
from definitions.patch import PATCH_TASK_REPRESENTATION_GUIDE, PatchOut, PATCH_COMPONENTS_TOOL
from api.utils.llm import get_fast_client_and_model, call_structured_tool, THINKING_LEVELS


# ****************************************************************************************************
# Editing the stored representation
# ****************************************************************************************************

def next_component_id(rep: dict[str, Any]) -> int:
    nums = [int(c["component_id"][1:]) for c in rep.get("components", [])
            if isinstance(c.get("component_id"), str) and c["component_id"][1:].isdigit()]
    return (max(nums) + 1) if nums else 1


def mapped_selectors(rep: dict[str, Any]) -> set[str]:
    return {s for comp in rep.get("components", [])
            for s in (comp.get("dom_selector"), *comp.get("member_selectors", [])) if isinstance(s, str)}


# Drops every component that tracks a removed selector, along with its task links and relationships.
# Returns how many were dropped; a cosmetic swap inside a question usually drops none.
def remove_components(rep: dict[str, Any], selectors: list[str]) -> int:
    gone = set(selectors)
    if not gone:
        return 0
    kept, dropped_ids = [], set()
    for comp in rep.get("components", []):
        if {comp.get("dom_selector"), *comp.get("member_selectors", [])} & gone:
            dropped_ids.add(comp.get("component_id"))
        else:
            kept.append(comp)
    rep["components"] = kept
    for task in rep.get("tasks", []):
        task["component_ids"] = [cid for cid in task.get("component_ids", []) if cid not in dropped_ids]
    rep["relationships"] = [rel for rel in rep.get("relationships", [])
                            if rel.get("source") not in dropped_ids and rel.get("target") not in dropped_ids]
    return len(dropped_ids)


# Adds the new components under the first top-level task, the page's main one.
def append_components(rep: dict[str, Any], new_components: list[dict[str, Any]]) -> None:
    if not new_components:
        return
    rep.setdefault("components", []).extend(new_components)
    tasks = rep.get("tasks", [])
    task = next((t for t in tasks if not t.get("parent_task_id")), tasks[0] if tasks else None)
    if task is None:
        return
    for comp in new_components:
        if task["task_id"] not in comp.setdefault("associated_task_ids", []):
            comp["associated_task_ids"].append(task["task_id"])
    task.setdefault("component_ids", []).extend(c["component_id"] for c in new_components)


# A question that was hidden at analyze time may already be modelled, so only groups with no mapped
# control count as new. A radio group's options go together so one option can't become its own question.
def unmapped_revealed(rep: dict[str, Any], revealed: list[list[PageElement]]) -> list[PageElement]:
    mapped = mapped_selectors(rep)
    return [e for group in revealed if not any(e.selector in mapped for e in group) for e in group]


# ****************************************************************************************************
# Model call
# ****************************************************************************************************

# New components (re-id'd after the existing ones) and their relationships, from the fast model.
async def model_patch_components(
    rep: dict[str, Any], added: list[PageElement], containers: list[ContextContainer],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    client, model = get_fast_client_and_model()
    print(f"patch [{model}]: {len(added)} added element(s), {len(rep.get('components', []))} existing component(s)")
    existing = [{"component_id": c.get("component_id"), "component_type": c.get("component_type"),
                 "label": c.get("label"), "dom_selector": c.get("dom_selector")} for c in rep.get("components", [])]
    user = (
        "EXISTING components (summary, do not repeat these):\n"
        f"{json.dumps(existing)}\n\n"
        "NEW elements that just appeared:\n"
        f"{json.dumps([e.model_dump() for e in added])}\n\n"
        + (f"CONTAINERS those elements sit in (each element's `container` is one of these `selector`s):\n"
           f"{json.dumps([c.model_dump() for c in containers])}\n\n" if containers else "")
        + f"Return only the new component(s), and any relationships from them, via {PATCH_COMPONENTS_TOOL['name']}."
    )
    out: PatchOut = await call_structured_tool(
        client=client, model=model, system=PATCH_TASK_REPRESENTATION_GUIDE,
        messages=[{"role": "user", "content": user}],
        tool=PATCH_COMPONENTS_TOOL, max_tokens=4000,
        validate=PatchOut.model_validate, label="task representation patch",
        thinking_level=THINKING_LEVELS["task_patch"],
    )

    comps = [comp.model_dump() for comp in out.components]
    start = next_component_id(rep)
    new_ids = {}
    for i, comp in enumerate(comps):
        new_ids[comp["component_id"]] = f"c{start + i}"
        comp["component_id"] = new_ids[comp["component_id"]]
    existing_ids = {c.get("component_id") for c in rep.get("components", [])}
    links = [Relationship(type=rel.type,
                          source=new_ids.get(rel.source, rel.source if rel.source in existing_ids else ""),
                          target=new_ids.get(rel.target, rel.target if rel.target in existing_ids else ""))
             for rel in out.relationships]
    return comps, [rel.model_dump() for rel in valid_relationships(links, existing_ids | set(new_ids.values()))]
