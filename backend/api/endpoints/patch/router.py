"""
The route for POST /task-representations/{site_id}/patch
- applies a page change to the stored task representation with the fast model, rather than
  analyzing the whole page again
- judges the change against the tasks the widget showing was built for
"""
from typing import Any
import copy
import time

from fastapi import APIRouter, HTTPException

from api.state.task import task_store, replace_task_store
from api.state.webpage_interface import get_webpage_interface
from definitions.patch import TaskPatchRequest
from api.endpoints.patch.helpers import (
    remove_components, append_components, unmapped_revealed, served_task_ids, part_of_tasks, model_patch_components,
)
from api.endpoints.webpage_interface.helpers import components_to_items
from api.utils import records

router = APIRouter()


# Returns the updated representation plus `changed` (did the widget's tasks change: a component of
# theirs came, or any component went; a cosmetic change often adds none), `added_items` (their new
# components as widget items, spliced into the widget) and `unrelated` (how many new components serve
# none of the widget's tasks; they're kept in the representation and left out of the widget).
@router.post("/task-representations/{site_id}/patch")
async def patch_task_representation(site_id: str, request: TaskPatchRequest) -> dict[str, Any]:
    if task_store.get("site_id") != site_id or task_store.get("task_representation") is None:
        raise HTTPException(status_code=404, detail="Analyze the page before patching it")
    started = time.perf_counter()
    rep = copy.deepcopy(task_store["task_representation"])
    task_ids = served_task_ids(rep, (get_webpage_interface() or {}).get("task_ids"))
    removed_count = remove_components(rep, request.removed)
    added = request.added + unmapped_revealed(rep, request.revealed)
    new_components: list[dict[str, Any]] = []
    if added:
        new_components, new_relationships = await model_patch_components(rep, added, request.containers)
        rep.setdefault("relationships", []).extend(new_relationships)
        append_components(rep, new_components)
    replace_task_store(site_id, rep, task_store.get("page_text", ""))

    related = part_of_tasks(rep, new_components, task_ids)
    unrelated = len(new_components) - len(related)
    changed = len(related) > 0 or removed_count > 0
    print(f"patch: +{len(new_components)} components ({unrelated} outside the widget's tasks {task_ids}), "
          f"-{removed_count} ({len(rep.get('components', []))} total); changed={changed}")
    records.task_representation("patch", site_id, "", rep, time.perf_counter() - started, {
        "changed": changed, "task_ids": task_ids, "components_added": len(new_components),
        "components_unrelated": unrelated, "components_removed": removed_count,
    })
    return {**rep, "changed": changed, "added_items": components_to_items({"components": related}), "unrelated": unrelated}
