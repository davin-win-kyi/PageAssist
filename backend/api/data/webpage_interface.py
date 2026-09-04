"""The current webpage interface — IN MEMORY ONLY, never written to disk. Cheap to regenerate;
only meaningful while the client that asked for it is still on the page."""
from typing import Any


_current: dict[str, Any] | None = None


def get_webpage_interface() -> dict[str, Any] | None:
    return _current


def set_webpage_interface(widget: dict[str, Any] | None) -> None:
    global _current
    _current = widget


def clear_webpage_interface() -> None:
    global _current
    _current = None
