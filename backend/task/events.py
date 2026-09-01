"""Page-change events — detected client-side, forwarded here. When a change looks like genuinely new
structure appeared, silently regenerate and store the webpage interface (the client does NOT auto-apply
it — it just becomes the version shown next time the user applies the widget).
"""
from typing import Any
import time

from fastapi import APIRouter
from pydantic import BaseModel

from common import store
from interface.representation import get_active_tree, is_agreed
from interface.webpage import model_webpage_interface, fallback_webpage_interface

router = APIRouter()


class EventRequest(BaseModel):
    type: str
    url: str
    target: dict[str, Any] = {}
    payload: dict[str, Any] = {}


class ProcessedEvent(BaseModel):
    related: bool
    webpage_interface: dict[str, Any] | None = None


def task_event_is_related(task_representation: dict[str, Any] | None, event: EventRequest) -> bool:
    """True only when a batch of nodes appeared/disappeared together — i.e. real structural change (a
    wizard advancing a step, new fields revealed). NOT routine value changes on known fields: those are
    reflected instantly client-side by the live fill indicator, with no model call.

    History: matching "page has any form" or "title contains task" fired a real Anthropic call roughly
    every 400ms of typing — the dominant cause of runaway spend.
    """
    if task_representation is None:
        return False
    mutations = event.payload.get("mutations", [])
    added = sum(int(mutation.get("addedNodes", 0)) for mutation in mutations)
    removed = sum(int(mutation.get("removedNodes", 0)) for mutation in mutations)
    return (added + removed) >= 5


# Hard cost floor, independent of the heuristic: never regenerate via this passive pipeline more than
# once per cooldown window. Process-local (resets on restart) — only needs to bound worst-case spend.
_last_event_regeneration_at: float = 0.0
EVENT_REGENERATION_COOLDOWN_SECONDS = 30.0


@router.post("/task-representations/{site_id}/events/process", response_model=ProcessedEvent)
async def process_event(site_id: str, event: EventRequest) -> ProcessedEvent:
    global _last_event_regeneration_at
    is_current_site = store.task_store.get("site_id") == site_id
    task_representation = store.task_store.get("task_representation") if is_current_site else None
    related = task_event_is_related(task_representation, event)

    webpage_interface = None
    now = time.monotonic()
    cooled_down = (now - _last_event_regeneration_at) >= EVENT_REGENERATION_COOLDOWN_SECONDS
    if related and is_current_site and is_agreed() and cooled_down:
        _last_event_regeneration_at = now
        interface_representation = get_active_tree()
        webpage_interface = (
            await model_webpage_interface(interface_representation, task_representation)
            or fallback_webpage_interface(interface_representation, task_representation)
        )
        store.task_store["webpage_interface"] = webpage_interface
        store.save_task_store()

    return ProcessedEvent(related=related, webpage_interface=webpage_interface)
