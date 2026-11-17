"""
Util methods for the study records: a folder per chat session with everything PageAssist made in it,
split into a folder per chat turn
- turn-00 holds what happens before the first chat turn, like analyzing the page
- each turn's folder holds what was said and replied, the interface representation it made, and each
  interface built from it (or after it, before the next turn) in its own folder: its code, items, the
  representations it was built from, and its screenshots, with a picture of every step of an
  interface that shows one step at a time
- the task representations, events and errors are kept with the turn they happened in
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
MAX_STEPS = 40
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
        folder.mkdir(parents=True)
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


# The folder of the turn under way: turn-00 before the first chat turn, then one per turn
def _turn_folder() -> Path:
    folder = _session["folder"] / f"turn-{_session['summary']['chat_turns']:02d}"
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def _write_summary() -> None:
    if _session is None:
        return
    _session["summary"]["updated_at"] = _now()
    (_session["folder"] / "summary.json").write_text(json.dumps(_session["summary"], indent=2), encoding="utf-8")


# A line in one of the turn's logs, like events.jsonl or errors.jsonl
def _append(name: str, entry: dict[str, Any]) -> None:
    with (_turn_folder() / name).open("a", encoding="utf-8") as file:
        file.write(json.dumps({"at": _now(), **entry}) + "\n")


def _write(path: Path, value: Any) -> None:
    path.write_text(value if isinstance(value, str) else json.dumps(value, indent=2), encoding="utf-8")


# A file name not used yet in a folder: name.json, then name-2.json, name-3.json ...
def _free_name(folder: Path, stem: str, suffix: str) -> str:
    name = f"{stem}{suffix}"
    n = 2
    while (folder / name).exists():
        name = f"{stem}-{n}{suffix}"
        n += 1
    return name


def _add_page(name: str) -> None:
    if name not in _session["summary"]["pages"]:
        _session["summary"]["pages"].append(name)


def _add_seconds(kind: str, seconds: float) -> None:
    times = _session["summary"]["model_seconds"]
    times[kind] = round(times.get(kind, 0.0) + seconds, 1)


# The folder an interface's record id points to in the session, in whichever turn built it
def _interface_folder(session: dict[str, Any], record_id: str | None) -> Path | None:
    if not record_id or not RECORD_ID_RE.match(record_id):
        return None
    return next((folder for folder in session["folder"].glob(f"turn-*/interface-{record_id}") if folder.is_dir()), None)


# An image sent as a PNG or JPEG data URL, as its bytes and file extension, or None when unusable
def _decode_image(image: str) -> tuple[bytes, str] | None:
    match = re.match(r"^data:image/(png|jpeg);base64,(.+)$", image or "", re.S)
    if not match:
        return None
    try:
        data = base64.b64decode(match.group(2), validate=True)
    except (binascii.Error, ValueError):
        return None
    if len(data) > MAX_SCREENSHOT_BYTES:
        return None
    return data, "png" if match.group(1) == "png" else "jpg"


# ****************************************************************************************************
# What gets recorded
# ****************************************************************************************************

# One chat turn, in a new turn folder. A changed tree is kept there as a new interface
# representation version. Returns the turn's number.
@_quietly(0)
def chat_turn(message: str, reply: dict[str, Any], tree: dict[str, Any] | None, tree_changed: bool, seconds: float) -> int:
    with _lock:
        session = _current()
        if session is None:
            return 0
        summary = session["summary"]
        summary["chat_turns"] += 1
        turn = summary["chat_turns"]
        folder = _turn_folder()
        version = _interface_version(folder, tree, f"chat turn {turn}", turn) if tree_changed else None
        if reply.get("agreed") and summary["turns_to_agreement"] is None:
            summary["turns_to_agreement"] = turn
        elif tree_changed and summary["turns_to_agreement"] is not None:
            summary["refinements_after_agreement"] += 1
        _add_seconds("chat", seconds)
        _write(folder / "turn.json", {
            "turn": turn, "at": _now(), "user": message, "reply": reply.get("reply", ""), "suggestions": reply.get("suggestions", []),
            "agreed": reply.get("agreed", False), "offer_save": reply.get("offer_save", False),
            "suggested_name": reply.get("suggested_name", ""), "interface_representation_version": version,
            "seconds": round(seconds, 1),
        })
        _write_summary()
        return turn


def _interface_version(folder: Path, tree: dict[str, Any] | None, source: str, turn: int) -> int:
    summary = _session["summary"]
    summary["interface_representation_versions"] += 1
    version = summary["interface_representation_versions"]
    _write(folder / _free_name(folder, "interface_representation", ".json"),
           {"version": version, "at": _now(), "source": source, "chat_turn": turn, "tree": tree})
    return version


# A version of the interface representation that didn't come from the chat, such as a saved one
# being used again, kept with the turn under way
@_quietly()
def interface_representation(tree: dict[str, Any] | None, source: str, agreed: bool = False) -> None:
    with _lock:
        session = _current()
        if session is None:
            return
        summary = session["summary"]
        _interface_version(_turn_folder(), tree, source, summary["chat_turns"])
        if agreed and summary["turns_to_agreement"] is None:
            summary["turns_to_agreement"] = summary["chat_turns"]
        _write_summary()


# A task representation from analyzing a page or patching it after a page change. They're numbered
# across the session, so their order shows across turns.
@_quietly()
def task_representation(kind: str, site_id: str, url: str, representation: dict[str, Any], seconds: float, details: dict[str, Any] | None = None) -> None:
    with _lock:
        session = _current()
        if session is None:
            return
        counts = session["summary"]["task_representations"]
        number = sum(counts.values()) + 1
        name = page_name(url or site_id)
        folder = _turn_folder() / "task_representations"
        folder.mkdir(exist_ok=True)
        _write(folder / f"{number:03d}-{kind}-{name}.json", {
            "number": number, "at": _now(), "kind": kind, "page": clean_url(url) if url else name,
            "seconds": round(seconds, 1), **(details or {}), "task_representation": representation,
        })
        counts[kind] = counts.get(kind, 0) + 1
        _add_page(name)
        _add_seconds(kind, seconds)
        _write_summary()


# An interface built for a page, in its own folder in the turn under way: its code, its state, the
# representations it was built from and what it took to get there. Interfaces are numbered across the
# session. Returns the record id that the panel's screenshots of it are filed under.
@_quietly()
def interface(site_id: str, widget: dict[str, Any], tree: dict[str, Any] | None, task_representation: dict[str, Any] | None,
              reason: str, seconds: float) -> str | None:
    with _lock:
        session = _current()
        if session is None:
            return None
        summary = session["summary"]
        name = page_name(site_id)
        record_id = f"{summary['interfaces_built'] + 1:03d}-{name}"
        target = _turn_folder() / f"interface-{record_id}"
        target.mkdir()
        items = (widget.get("state") or {}).get("items") or []
        _write(target / "code.js", widget.get("code") or "")
        _write(target / "widget.json", {"style": widget.get("style"), "state": widget.get("state"), "degraded": widget.get("degraded", False)})
        _write(target / "interface_representation.json", tree)
        _write(target / "task_representation.json", task_representation)
        _write(target / "meta.json", {
            "record_id": record_id, "at": _now(), "turn": summary["chat_turns"], "page": name, "reason": reason,
            "seconds": round(seconds, 1), "degraded": widget.get("degraded", False), "task_ids": widget.get("task_ids", []),
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
            "steps": None,
        })
        summary["interfaces_built"] += 1
        by_reason = summary["interfaces_built_by_reason"]
        by_reason[reason] = by_reason.get(reason, 0) + 1
        _add_page(name)
        _add_seconds("generate", seconds)
        _write_summary()
        return record_id


# A screenshot of an interface, filed with it. Each reason gets its own file, numbered when there are
# several, except "final", which is replaced. Returns false when the record id or image is unusable.
@_quietly(False)
def screenshot(record_id: str, reason: str, image: str) -> bool:
    if not RECORD_ID_RE.match(record_id or "") or not REASON_RE.match(reason or ""):
        return False
    decoded = _decode_image(image)
    if decoded is None:
        return False
    data, extension = decoded
    with _lock:
        session = _current()
        if session is None:
            return False
        target = _interface_folder(session, record_id)
        if target is None:
            return False
        # the final screenshot is the interface as it was last seen, so it's replaced as it changes
        if reason == "final":
            name = f"screenshot-final.{extension}"
            new = not (target / name).exists()
        else:
            name = _free_name(target, f"screenshot-{reason}", f".{extension}")
            new = True
        (target / name).write_bytes(data)
        if new:
            session["summary"]["screenshots"] += 1
        _write_summary()
        return True


# Pictures of every step of an interface that shows one step at a time, replacing any taken before,
# since a page change can add or remove steps. Returns false when the record id or an image is
# unusable.
@_quietly(False)
def steps(record_id: str, images: list[str]) -> bool:
    if not RECORD_ID_RE.match(record_id or "") or not images or len(images) > MAX_STEPS:
        return False
    decoded = [_decode_image(image) for image in images]
    if any(picture is None for picture in decoded):
        return False
    with _lock:
        session = _current()
        if session is None:
            return False
        target = _interface_folder(session, record_id)
        if target is None:
            return False
        before = list(target.glob("screenshot-step-*"))
        for old in before:
            old.unlink()
        for number, (data, extension) in enumerate(decoded, start=1):
            (target / f"screenshot-step-{number:02d}.{extension}").write_bytes(data)
        meta = json.loads((target / "meta.json").read_text(encoding="utf-8"))
        meta["steps"] = len(decoded)
        _write(target / "meta.json", meta)
        session["summary"]["screenshots"] += max(0, len(decoded) - len(before))
        _write_summary()
        return True


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


# An error from the backend, the side panel or the widget, kept with the turn under way
@_quietly()
def error(source: str, where: str, message: str) -> None:
    with _lock:
        session = _current()
        if session is None:
            return
        _append("errors.jsonl", {"source": source[:30], "where": where[:80], "message": message[:2000]})
        session["summary"]["errors"] += 1
        _write_summary()


# Something else worth keeping, with the turn under way: deleting a saved interface, or how a page
# change was applied to the interface
@_quietly()
def event(kind: str, details: dict[str, Any]) -> None:
    with _lock:
        session = _current()
        if session is None:
            return
        _append("events.jsonl", {"kind": kind[:40], **details})
        _write_summary()
