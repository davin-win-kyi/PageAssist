"""
The routes for the task representation: getting the stored one, and analyzing a page into a new one
- a task representation is the page's tasks hierarchy, the components within it, and their
  relationships
- completion is read live from the page by content.ts, so there is no state in it
"""
from typing import Any
import time

from fastapi import APIRouter, HTTPException

from api.state.task import task_store, replace_task_store
from api.state.webpage_interface import clear_webpage_interface
from definitions.task import PAGE_TEXT_LIMIT, TaskRepresentationRequest
from api.endpoints.task.helpers import model_task_representation
from api.utils import records

router = APIRouter()


@router.get("/task-representations/{site_id}")
def get_task_representation(site_id: str) -> dict[str, Any]:
    if task_store.get("site_id") != site_id or task_store.get("task_representation") is None:
        raise HTTPException(status_code=404, detail="Task representation not found")
    return task_store["task_representation"]


@router.post("/task-representations/{site_id}/analyze")
async def analyze_task_representation(site_id: str, request: TaskRepresentationRequest) -> dict[str, Any]:
    started = time.perf_counter()
    task_representation = await model_task_representation(request)
    replace_task_store(site_id, task_representation, request.page_text[:PAGE_TEXT_LIMIT])
    # the widget held was built from the old representation, whose task ids this one doesn't share
    clear_webpage_interface()
    records.task_representation("analyze", site_id, request.url, task_representation, time.perf_counter() - started,
                                {"elements_scanned": len(request.elements)})
    return task_representation
