"""
The routes for the records: what the side panel sends to be kept with the session
- screenshots of the interfaces, and a picture of every step of one that shows one step at a time
- errors it showed, and errors from the widget
- events, such as how a page change was applied to the interface
"""
from typing import Any

from fastapi import APIRouter, HTTPException

from definitions.records import ScreenshotRecord, StepsRecord, ErrorRecord, EventRecord
from api.utils import records

router = APIRouter()


@router.post("/records/screenshots")
def save_screenshot(request: ScreenshotRecord) -> dict[str, Any]:
    if not records.screenshot(request.record_id, request.reason, request.image):
        raise HTTPException(status_code=400, detail="Not a screenshot of an interface in this session")
    return {"ok": True}


@router.post("/records/steps")
def save_steps(request: StepsRecord) -> dict[str, Any]:
    if not records.steps(request.record_id, request.images):
        raise HTTPException(status_code=400, detail="Not pictures of the steps of an interface in this session")
    return {"ok": True}


@router.post("/records/errors")
def save_error(request: ErrorRecord) -> dict[str, Any]:
    records.error(request.source, request.where, request.message)
    return {"ok": True}


@router.post("/records/events")
def save_event(request: EventRecord) -> dict[str, Any]:
    records.event(request.kind, request.details)
    return {"ok": True}
