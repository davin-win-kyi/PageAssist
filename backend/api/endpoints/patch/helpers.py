"""
Helper methods for the patch route
- removing and adding components in the stored task representation
- deciding which revealed questions are new
- deciding which new components are part of the tasks the widget serves
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


# The task ids each component is filed under, from the component's side and the task's.
def filed_under(rep: dict[str, Any]) -> dict[str, set[str]]:
    filed = {c.get("component_id"): {tid for tid in c.get("associated_task_ids", []) if isinstance(tid, str)}
             for c in rep.get("components", [])}
    for task in rep.get("tasks", []):
        if isinstance(task.get("task_id"), str):
            for cid in task.get("component_ids", []):
                filed.setdefault(cid, set()).add(task["task_id"])
    return filed


# Adds the new components, each filed under the tasks the model gave it that the page has. A question
# that applies only given another's answer is also filed with that question's tasks. One that serves
# none of the tasks is kept, filed under none. Run after the new relationships are added.
def append_components(rep: dict[str, Any], new_components: list[dict[str, Any]]) -> None:
    if not new_components:
        return
    tasks = {t.get("task_id"): t for t in rep.get("tasks", [])}
    rep.setdefault("components", []).extend(new_components)
    filed = filed_under(rep)
    for comp in new_components:
        task_ids = list(comp.get("associated_task_ids", []))
        for rel in rep.get("relationships", []):
            if rel.get("type") == "depends_on" and rel.get("source") == comp["component_id"]:
                task_ids += sorted(filed.get(rel.get("target"), set()))
        comp["associated_task_ids"] = [tid for tid in dict.fromkeys(task_ids) if tid in tasks]
        filed[comp["component_id"]] = set(comp["associated_task_ids"])
        for tid in comp["associated_task_ids"]:
            tasks[tid].setdefault("component_ids", []).append(comp["component_id"])


# A question that was hidden at analyze time may already be modelled, so only groups with no mapped
# control count as new. A radio group's options go together so one option can't become its own question.
def unmapped_revealed(rep: dict[str, Any], revealed: list[list[PageElement]]) -> list[PageElement]:
    mapped = mapped_selectors(rep)
    return [e for group in revealed if not any(e.selector in mapped for e in group) for e in group]


# ****************************************************************************************************
# The widget's tasks
# ****************************************************************************************************

# The tasks a widget serves, of those the representation has: the ones it names, plus the ones its
# tracked questions are filed under. A widget that names none serves every task on the page, so only
# what serves no task is left out of it. Empty only on a page with no tasks.
def served_task_ids(rep: dict[str, Any], named: Any, items: list[Any] | None = None) -> list[str]:
    known = {t.get("task_id") for t in rep.get("tasks", []) if isinstance(t.get("task_id"), str)}
    ids = [tid for tid in (named if isinstance(named, list) else []) if isinstance(tid, str)]
    tracked = {s for item in items or [] if isinstance(item, dict)
               for s in ([item.get("selector")] + (item.get("selectors") if isinstance(item.get("selectors"), list) else []))
               if isinstance(s, str)}
    if tracked:
        filed = filed_under(rep)
        for comp in rep.get("components", []):
            if {comp.get("dom_selector"), *comp.get("member_selectors", [])} & tracked:
                ids += sorted(filed.get(comp.get("component_id"), set()))
    ids = [tid for tid in dict.fromkeys(ids) if tid in known]
    top = [t["task_id"] for t in rep.get("tasks", []) if not t.get("parent_task_id") and t.get("task_id") in known]
    return ids or top or sorted(known)


# The new components that are part of the widget's tasks: filed under one of them or one of their
# sub-tasks. On a page with no tasks, all of them are.
def part_of_tasks(rep: dict[str, Any], new_components: list[dict[str, Any]], task_ids: list[str]) -> list[dict[str, Any]]:
    if not task_ids:
        return new_components
    family = set(task_ids)
    while True:
        children = {t.get("task_id") for t in rep.get("tasks", []) if t.get("parent_task_id") in family} - family
        if not children:
            break
        family |= children
    filed = filed_under(rep)
    return [c for c in new_components if filed.get(c["component_id"], set()) & family]


# ****************************************************************************************************
# Model call
# ****************************************************************************************************

# New components (re-id'd after the existing ones) and their relationships, from the fast model.
async def model_patch_components(
    rep: dict[str, Any], added: list[PageElement], containers: list[ContextContainer],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    client, model = get_fast_client_and_model()
    print(f"patch [{model}]: {len(added)} added element(s), {len(rep.get('components', []))} existing component(s)")
    tasks = [{"task_id": t.get("task_id"), "label": t.get("label"), "description": t.get("description"),
              "parent_task_id": t.get("parent_task_id")} for t in rep.get("tasks", [])]
    existing = [{"component_id": c.get("component_id"), "component_type": c.get("component_type"),
                 "label": c.get("label"), "dom_selector": c.get("dom_selector"),
                 "associated_task_ids": c.get("associated_task_ids", [])} for c in rep.get("components", [])]
    user = (
        f"PAGE PURPOSE: {rep.get('page_purpose', '')}\n\n"
        f"TASKS:\n{json.dumps(tasks)}\n\n"
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
