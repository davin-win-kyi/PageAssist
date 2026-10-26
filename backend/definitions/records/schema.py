"""
The request schemas for the records: what the side panel sends to be kept with the session
"""

from typing import Any

from pydantic import BaseModel, Field


class ScreenshotRecord(BaseModel):
    """Body of POST /records/screenshots: a screenshot of an interface, as a PNG or JPEG data URL."""

    # the interface's record id, from the widget the generate route returned
    record_id: str
    # when it was taken, such as "applied" or "updated"
    reason: str = "applied"
    image: str


class ErrorRecord(BaseModel):
    """Body of POST /records/errors: an error the side panel showed, or one from the widget."""

    source: str = "panel"
    where: str
    message: str


class EventRecord(BaseModel):
    """Body of POST /records/events: something else worth keeping, such as how a page change was applied."""

    kind: str
    details: dict[str, Any] = Field(default_factory=dict)
