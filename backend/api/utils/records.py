"""
Util methods for the study records: a folder per chat session with everything PageAssist made in it
- every task representation and every version of the interface representation
- the conversation, and each interface's code, items, screenshots and the representations it was
  built from
- errors from the backend, the side panel and the widget
- a summary with the counts, such as how many chat turns it took to agree on an interface
Records go in user_study/ at the top of the repo, and PAGEASSIST_RECORDS=off turns them off.
"""

from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit
import base64
import binascii
import functools
import json
import os
import re
import threading

from api.utils.json_store import DATA_DIR

ENABLED = (os.getenv("PAGEASSIST_RECORDS") or "on").strip().lower() not in {"off", "0", "false", "no"}
# The study records go in user_study/ at the top of the repo, where they're easy to find. A moved data
# directory (the tests use a throwaway one) takes them with it, so a test never adds to the study.
RECORDS_DIR = DATA_DIR / "user_study" if os.getenv("PAGEASSIST_DATA_DIR") else Path(__file__).resolve().parents[3] / "user_study"
MAX_SCREENSHOT_BYTES = 10_000_000
RECORD_ID_RE = re.compile(r"^\d{3}-[a-z0-9-]{1,60}$")
REASON_RE = re.compile(r"^[a-z-]{1,30}$")

# reentrant, since recording before the first reset starts the session from inside the lock
_lock = threading.RLock()
_session: dict[str, Any] | None = None


# ****************************************************************************************************
# The session
# ****************************************************************************************************

def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# A short name for a page, from its URL or site id, without its query string
def page_name(url_or_site_id: str) -> str:
    text = url_or_site_id.split("?", 1)[0].replace("~", "/")
    if "://" in text:
        parts = urlsplit(text)
        text = f"{parts.netloc}{parts.path}"
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:50] or "page"


# A URL without its query string or fragment, which can carry tracking ids or tokens
def clean_url(url: str) -> str:
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}{parts.path}" if parts.netloc else url.split("?", 1)[0]


# Recording never gets in the way of PageAssist, so a record that can't be written is logged and
# skipped
def _quietly(default: Any = None):
    def wrap(function):
        @functools.wraps(function)
        def run(*args, **kwargs):
            try:
                return function(*args, **kwargs)
            except Exception as error:
                print(f"records: couldn't record {function.__name__}: {error!r}")
                return default
        return run
    return wrap


# Starts a new session folder: the "new chat" trigger (opening the panel, or starting over)
@_quietly()
def start_session() -> None:
    global _session
    if not ENABLED:
        return
    with _lock:
        stamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        folder = RECORDS_DIR / stamp
        n = 2
        while folder.exists():
            folder = RECORDS_DIR / f"{stamp}_{n}"
            n += 1
        for sub in ("interface_representations", "task_representations", "interfaces"):
            (folder / sub).mkdir(parents=True, exist_ok=True)
        _session = {
            "folder": folder,
            "summary": {
                "session": folder.name,
                "started_at": _now(),
                "updated_at": _now(),
                "pages": [],
                "chat_turns": 0,
                "interface_representation_versions": 0,
                "turns_to_agreement": None,
                "refinements_after_agreement": 0,
                "task_representations": {"analyze": 0, "patch": 0},
                "interfaces_built": 0,
                "interfaces_built_by_reason": {},
                "screenshots": 0,
                "errors": 0,
                "model_seconds": {"chat": 0.0, "analyze": 0.0, "patch": 0.0, "generate": 0.0},
            },
        }
        _write_summary()


# The current session. A new one starts when something is recorded before the panel's first reset,
# or after the session's folder was removed, such as clearing the records between participants.
def _current() -> dict[str, Any] | None:
    if not ENABLED:
        return None
    if _session is None or not _session["folder"].exists():
        start_session()
    return _session


def _write_summary() -> None:
    if _session is None:
        return
    _session["summary"]["updated_at"] = _now()
    (_session["folder"] / "summary.json").write_text(json.dumps(_session["summary"], indent=2), encoding="utf-8")


def _append(name: str, entry: dict[str, Any]) -> None:
    with (_session["folder"] / name).open("a", encoding="utf-8") as file:
        file.write(json.dumps({"at": _now(), **entry}) + "\n")


def _write(path: Path, value: Any) -> None:
    path.write_text(value if isinstance(value, str) else json.dumps(value, indent=2), encoding="utf-8")


def _next_number(folder: Path) -> int:
    return len(list(folder.iterdir())) + 1


def _add_page(name: str) -> None:
    if name not in _session["summary"]["pages"]:
        _session["summary"]["pages"].append(name)


def _add_seconds(kind: str, seconds: float) -> None:
    times = _session["summary"]["model_seconds"]
    times[kind] = round(times.get(kind, 0.0) + seconds, 1)


# ****************************************************************************************************
# What gets recorded
# ****************************************************************************************************

# One chat turn. A changed tree is kept as a new interface representation version. Returns the
# turn's number.
@_quietly(0)
def chat_turn(message: str, reply: dict[str, Any], tree: dict[str, Any] | None, tree_changed: bool, seconds: float) -> int:
    with _lock:
        session = _current()
        if session is None:
            return 0
        summary = session["summary"]
        summary["chat_turns"] += 1
        turn = summary["chat_turns"]
        version = _interface_version(tree, f"chat turn {turn}", turn) if tree_changed else None
        if reply.get("agreed") and summary["turns_to_agreement"] is None:
            summary["turns_to_agreement"] = turn
        elif tree_changed and summary["turns_to_agreement"] is not None:
            summary["refinements_after_agreement"] += 1
        _add_seconds("chat", seconds)
        _append("conversation.jsonl", {
            "turn": turn, "user": message, "reply": reply.get("reply", ""), "suggestions": reply.get("suggestions", []),
            "agreed": reply.get("agreed", False), "offer_save": reply.get("offer_save", False),
            "suggested_name": reply.get("suggested_name", ""), "interface_representation_version": version,
            "seconds": round(seconds, 1),
        })
        _write_summary()
        return turn


def _interface_version(tree: dict[str, Any] | None, source: str, turn: int) -> int:
    summary = _session["summary"]
    summary["interface_representation_versions"] += 1
    version = summary["interface_representation_versions"]
    _write(_session["folder"] / "interface_representations" / f"{version:03d}.json",
           {"version": version, "at": _now(), "source": source, "chat_turn": turn, "tree": tree})
    return version


# A version of the interface representation that didn't come from the chat, such as a saved one
# being used again
@_quietly()
def interface_representation(tree: dict[str, Any] | None, source: str, agreed: bool = False) -> None:
    with _lock:
        session = _current()
        if session is None:
            return
        summary = session["summary"]
        _interface_version(tree, source, summary["chat_turns"])
        if agreed and summary["turns_to_agreement"] is None:
            summary["turns_to_agreement"] = summary["chat_turns"]
        _write_summary()


# A task representation from analyzing a page or patching it after a page change
@_quietly()
def task_representation(kind: str, site_id: str, url: str, representation: dict[str, Any], seconds: float, details: dict[str, Any] | None = None) -> None:
    with _lock:
        session = _current()
        if session is None:
            return
        name = page_name(url or site_id)
        folder = session["folder"] / "task_representations"
        number = _next_number(folder)
        _write(folder / f"{number:03d}-{kind}-{name}.json", {
            "number": number, "at": _now(), "kind": kind, "page": clean_url(url) if url else name,
            "seconds": round(seconds, 1), **(details or {}), "task_representation": representation,
        })
        counts = session["summary"]["task_representations"]
        counts[kind] = counts.get(kind, 0) + 1
        _add_page(name)
        _add_seconds(kind, seconds)
        _write_summary()


# An interface built for a page: its code, its state, the representations it was built from and
# what it took to get there. Returns the record id that the panel's screenshots of it are filed under.
@_quietly()
def interface(site_id: str, widget: dict[str, Any], tree: dict[str, Any] | None, task_representation: dict[str, Any] | None,
              reason: str, seconds: float) -> str | None:
    with _lock:
        session = _current()
        if session is None:
            return None
        summary = session["summary"]
        name = page_name(site_id)
        folder = session["folder"] / "interfaces"
        number = _next_number(folder)
        record_id = f"{number:03d}-{name}"
        target = folder / record_id
        target.mkdir()
        items = (widget.get("state") or {}).get("items") or []
        _write(target / "code.js", widget.get("code") or "")
        _write(target / "widget.json", {"style": widget.get("style"), "state": widget.get("state"), "degraded": widget.get("degraded", False)})
        _write(target / "interface_representation.json", tree)
        _write(target / "task_representation.json", task_representation)
        _write(target / "meta.json", {
            "record_id": record_id, "at": _now(), "page": name, "reason": reason, "seconds": round(seconds, 1),
            "degraded": widget.get("degraded", False),
            "items": {
                "total": len(items),
                "tracked": sum(1 for item in items if isinstance(item, dict) and (item.get("selector") or item.get("selectors"))),
                "by_hand": sum(1 for item in items if isinstance(item, dict) and item.get("manual")),
            },
            "iterations": {
                "chat_turns": summary["chat_turns"],
                "interface_representation_version": summary["interface_representation_versions"],
                "turns_to_agreement": summary["turns_to_agreement"],
                "refinements_after_agreement": summary["refinements_after_agreement"],
            },
        })
        summary["interfaces_built"] += 1
        by_reason = summary["interfaces_built_by_reason"]
        by_reason[reason] = by_reason.get(reason, 0) + 1
        _add_page(name)
        _add_seconds("generate", seconds)
        _write_summary()
        return record_id


# The folder an interface's record id points to in the session, if it's there
def _interface_folder(session: dict[str, Any], record_id: str | None) -> Path | None:
    if not record_id or not RECORD_ID_RE.match(record_id):
        return None
    folder = session["folder"] / "interfaces" / record_id
    return folder if folder.is_dir() else None


# A screenshot of an interface, filed with it. Each reason gets its own file, numbered when there are
# several, except "final", which is replaced. Returns false when the record id or image is unusable.
@_quietly(False)
def screenshot(record_id: str, reason: str, image: str) -> bool:
    if not RECORD_ID_RE.match(record_id or "") or not REASON_RE.match(reason or ""):
        return False
    match = re.match(r"^data:image/(png|jpeg);base64,(.+)$", image or "", re.S)
    if not match:
        return False
    try:
        data = base64.b64decode(match.group(2), validate=True)
    except (binascii.Error, ValueError):
        return False
    if len(data) > MAX_SCREENSHOT_BYTES:
        return False
    with _lock:
        session = _current()
        if session is None:
            return False
        target = _interface_folder(session, record_id)
        if target is None:
            return False
        extension = "png" if match.group(1) == "png" else "jpg"
        name = f"screenshot-{reason}.{extension}"
        # the final screenshot is the interface as it was last seen, so it's replaced as it changes
        new = reason != "final" or not (target / name).exists()
        n = 2
        while reason != "final" and (target / name).exists():
            name = f"screenshot-{reason}-{n}.{extension}"
            n += 1
        (target / name).write_bytes(data)
        if new:
            session["summary"]["screenshots"] += 1
        _write_summary()
        return True


# An error from the backend, the side panel or the widget
@_quietly()
def error(source: str, where: str, message: str) -> None:
    with _lock:
        session = _current()
        if session is None:
            return
        _append("errors.jsonl", {"source": source[:30], "where": where[:80], "message": message[:2000]})
        session["summary"]["errors"] += 1
        _write_summary()


# Saving the working interface representation, or updating a saved one: the event, and in the meta of
# the interface that was showing, the name it was saved as
@_quietly()
def saved(kind: str, entry_id: str, name: str, record_id: str | None) -> None:
    with _lock:
        session = _current()
        if session is None:
            return
        target = _interface_folder(session, record_id)
        _append("events.jsonl", {"kind": kind, "id": entry_id, "name": name[:200], "interface": target.name if target else None})
        if target is not None:
            meta = json.loads((target / "meta.json").read_text(encoding="utf-8"))
            meta.setdefault("saved", []).append({"name": name[:200], "at": _now(), "how": kind})
            _write(target / "meta.json", meta)
        _write_summary()


# Something else worth keeping: deleting a saved interface, or how a page change was applied to the
# interface
@_quietly()
def event(kind: str, details: dict[str, Any]) -> None:
    with _lock:
        session = _current()
        if session is None:
            return
        _append("events.jsonl", {"kind": kind[:40], **details})
        _write_summary()
