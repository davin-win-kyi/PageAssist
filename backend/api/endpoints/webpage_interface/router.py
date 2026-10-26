"""
The routes for the webpage interface: generating the widget for the current page, and getting the
last one
"""
from typing import Any
import time

from fastapi import APIRouter, HTTPException, Query

from api.state.task import task_store
from api.state.interface_representation import get_active_tree
from api.state.webpage_interface import get_webpage_interface, set_webpage_interface
from api.endpoints.webpage_interface.helpers import build_webpage_interface
from api.utils import records

router = APIRouter()


@router.get("/webpage-interfaces/{site_id}")
def get_webpage_interface_route(site_id: str) -> dict[str, Any]:
    widget = get_webpage_interface()
    if task_store.get("site_id") != site_id or widget is None:
        raise HTTPException(status_code=404, detail="Webpage interface not found")
    return widget


# `reason` says why it was built (the chat, a saved interface, or a page change). The widget comes
# back with the `record_id` its screenshots are filed under in the records.
@router.post("/webpage-interfaces/{site_id}/generate")
async def generate_webpage_interface(site_id: str, reason: str = Query("unspecified", pattern="^[a-z-]{1,30}$")) -> dict[str, Any]:
    if task_store.get("site_id") != site_id or task_store.get("task_representation") is None:
        raise HTTPException(status_code=404, detail="Analyze the page before generating its interface")
    # what it's built from, taken now, since the chat or a page change can replace either while it builds
    tree, task_representation = get_active_tree(), task_store["task_representation"]
    started = time.perf_counter()
    widget = await build_webpage_interface(tree, task_representation, task_store.get("page_text", ""))
    record_id = records.interface(site_id, widget, tree, task_representation, reason, time.perf_counter() - started)
    widget = {**widget, "record_id": record_id}
    set_webpage_interface(widget)
    return widget
