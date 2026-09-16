"""
Getter and setter methods for webpage interface
"""

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
