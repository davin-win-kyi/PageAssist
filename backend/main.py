from datetime import datetime, timezone
import copy
import os
import json
import uuid
from pathlib import Path
from typing import Any, Literal
from anthropic import Anthropic
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

load_dotenv(Path(__file__).with_name(".env"))

app = FastAPI(title="TaskWeb API", version="0.1.0")
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5173"], allow_methods=["*"], allow_headers=["*"])

# Two separate stores, two separate files:
#
# task_representations.json — task_store[site_id] = {"task_representation": ..., "webpage_interface": ...}
#   Grounded in one specific webpage's real DOM. Different for every site. webpage_interface is the concrete
#   interface actually applied to that site, produced by combining its task representation with an interface
#   representation (below) — kept alongside its site since it's just as site-specific.
#
# interface_representations.json — a genuine database of saved, webpage-agnostic preference sets, each shaped
# by chatting against an abstract preview, independent of any specific site. One is "active" at a time (what
# /chat edits); any saved one can be reused later on a different site by activating it.
TASK_STORE_FILE = Path(__file__).with_name("task_representations.json")
INTERFACE_STORE_FILE = Path(__file__).with_name("interface_representations.json")


def load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


task_store: dict[str, Any] = load_json(TASK_STORE_FILE, {})
interface_store: dict[str, Any] = load_json(INTERFACE_STORE_FILE, {"active_tree": None, "representations": {}})


def save_task_store() -> None:
    TASK_STORE_FILE.write_text(json.dumps(task_store, indent=2), encoding="utf-8")


def save_interface_store() -> None:
    INTERFACE_STORE_FILE.write_text(json.dumps(interface_store, indent=2), encoding="utf-8")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


def strip_json_fence(text: str) -> str:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`")
        cleaned = cleaned[cleaned.index("\n") + 1:] if "\n" in cleaned else cleaned
        cleaned = cleaned.removeprefix("json").strip()
    return cleaned


# ---------------------------------------------------------------------------
# Task representation — grounded in one specific webpage's real DOM.
# Shape: {task_id, task_name, children_tasks: [same shape], task_elements: [{id, selector, tag, text}]}
# ---------------------------------------------------------------------------

class PageElement(BaseModel):
    id: str
    selector: str
    tag: str
    text: str


class TaskRepresentationRequest(BaseModel):
    url: str
    title: str
    elements: list[PageElement]


def model_task_representation(request: TaskRepresentationRequest) -> dict[str, Any] | None:
    api_key = os.getenv("ANTHROPIC_API_KEY")
    model = os.getenv("ANTHROPIC_MODEL")
    if not api_key or not model:
        return None
    try:
        client = Anthropic(api_key=api_key)
        response = client.messages.create(
            model=model,
            max_tokens=1500,
            system=(
                "Given a webpage's URL, title, and a sample of its interactive/labelled elements, produce a task "
                "representation describing what a user is likely trying to accomplish on this page. Respond with "
                "only valid JSON matching {\"task_id\":string,\"task_name\":string,"
                "\"children_tasks\":array of the same shape,\"task_elements\":array of "
                "{\"id\":string,\"selector\":string,\"tag\":string,\"text\":string}}. Every task_elements entry "
                "must be copied verbatim from the given elements — never invent one. List at most 6 "
                "children_tasks. Do not wrap the JSON in markdown code fences or add any other text."
            ),
            messages=[{"role": "user", "content": json.dumps({
                "url": request.url,
                "title": request.title,
                "elements": [element.model_dump() for element in request.elements[:150]],
            })}],
        )
        text = next((block.text for block in response.content if block.type == "text"), "")
        cleaned = strip_json_fence(text)
        return json.loads(cleaned) if cleaned else None
    except Exception as error:
        print(f"Anthropic task representation synthesis failed; using fallback: {error}")
        return None


def fallback_task_representation(request: TaskRepresentationRequest) -> dict[str, Any]:
    forms = [element for element in request.elements if element.tag == "form"]
    children_tasks = [
        {
            "task_id": f"task-{index + 1}",
            "task_name": f"Complete {element.text or element.tag}",
            "children_tasks": [],
            "task_elements": [element.model_dump()],
        }
        for index, element in enumerate(forms[:3])
    ]
    return {
        "task_id": "page-task",
        "task_name": request.title or request.url,
        "children_tasks": children_tasks,
        "task_elements": [],
    }


@app.get("/task-representations/{site_id}")
def get_task_representation(site_id: str) -> dict[str, Any]:
    task_representation = task_store.get(site_id, {}).get("task_representation")
    if task_representation is None:
        raise HTTPException(status_code=404, detail="Task representation not found")
    return task_representation


@app.post("/task-representations/{site_id}/analyze")
def analyze_task_representation(site_id: str, request: TaskRepresentationRequest) -> dict[str, Any]:
    task_representation = model_task_representation(request) or fallback_task_representation(request)
    entry = task_store.setdefault(site_id, {"task_representation": None, "webpage_interface": None})
    entry["task_representation"] = task_representation
    save_task_store()
    return task_representation


# ---------------------------------------------------------------------------
# Interface representation — a single, webpage-agnostic set of preferences.
# Shape: {component, component_preferences: {...}, children: [same shape]}
# ---------------------------------------------------------------------------

def default_interface_representation() -> dict[str, Any]:
    return {"component": "support-panel", "component_preferences": {}, "children": []}


def get_active_tree() -> dict[str, Any]:
    """The current, unsaved working interface representation that /chat edits. This is never itself an entry
    in the saved database — nothing appears in the Saved list until the user explicitly saves it, and a fresh
    install starts with an empty database and a blank working tree."""
    if interface_store.get("active_tree") is None:
        interface_store["active_tree"] = default_interface_representation()
    return interface_store["active_tree"]


def is_agreed() -> bool:
    """Whether the user has actually confirmed a specific support concept for the current working tree — the
    gate on ever showing it on a real page. A one-way latch: only /chat (on real agreement) or activating a
    saved entry sets it true; only reset clears it."""
    return bool(interface_store.get("active_agreed", False))


def set_active_tree(tree: dict[str, Any], agreed: bool | None = None) -> None:
    interface_store["active_tree"] = tree
    if agreed is not None:
        interface_store["active_agreed"] = agreed
    save_interface_store()


@app.get("/interface-representation")
def get_interface_representation() -> dict[str, Any]:
    return {"tree": get_active_tree(), "agreed": is_agreed()}


@app.post("/interface-representation/reset")
def reset_interface_representation() -> dict[str, Any]:
    set_active_tree(default_interface_representation(), agreed=False)
    return {"tree": interface_store["active_tree"], "agreed": False}


@app.get("/interface-representations")
def list_interface_representations() -> list[dict[str, Any]]:
    """The reusable database: every representation the user has explicitly saved, so one shaped for a
    previous site can be picked up and applied to a different one later. Empty until something is saved."""
    return [
        {"id": entry["id"], "name": entry["name"], "created_at": entry["created_at"], "updated_at": entry["updated_at"]}
        for entry in interface_store["representations"].values()
    ]


class SaveInterfaceRepresentationRequest(BaseModel):
    name: str


@app.post("/interface-representations")
def save_interface_representation(request: SaveInterfaceRepresentationRequest) -> dict[str, Any]:
    """Saves a copy of the current working interface representation as a new, named, reusable entry."""
    entry_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    entry = {"id": entry_id, "name": request.name, "created_at": now, "updated_at": now, "tree": copy.deepcopy(get_active_tree())}
    interface_store["representations"][entry_id] = entry
    save_interface_store()
    return entry


@app.post("/interface-representations/{entry_id}/activate")
def activate_interface_representation(entry_id: str) -> dict[str, Any]:
    """Copies a saved entry into the working tree — editing it afterward via chat does not modify the saved
    entry itself, so the same saved preferences can be reused again unchanged on yet another site. Choosing to
    reuse a saved concept counts as agreement, so it's shown on the page immediately."""
    if entry_id not in interface_store["representations"]:
        raise HTTPException(status_code=404, detail="Interface representation not found")
    set_active_tree(copy.deepcopy(interface_store["representations"][entry_id]["tree"]), agreed=True)
    return {"tree": interface_store["active_tree"], "agreed": True}


TASKWEB_GUIDE = """You are TaskWeb, a conversational assistant that helps a user define their preferences for an \
interface support component. They see a preview of a generic example interface — not any specific webpage — \
while you talk.

Follow this shape, in order, without ever exposing it to the user as numbered steps:
1. If their message doesn't yet describe a concrete difficulty, ask them to describe one.
2. Once they describe a difficulty, restate your understanding of it in one sentence and ask if that's correct. \
Do this in its own turn — never propose a support strategy in the same reply. Wait for confirmation or a \
correction before moving on.
3. Once the difficulty is confirmed, offer 2-3 concrete support strategy options (or respond to one they already \
described), and let them choose, combine, ask for more, or describe their own.
4. Once a strategy is chosen, collaboratively fill in what it represents, how it behaves as the task changes, \
when it appears or updates, and how it's presented — ask only what's still genuinely unclear, in as few \
questions as possible.
5. Once something is showing, keep refining it based on feedback.

Ask a focused clarifying question whenever a message is ambiguous rather than guessing — this matters most right \
after the difficulty is described, where jumping straight to a proposed design skips the user's chance to \
correct your understanding of it. Keep replies concise and precise: convey the same meaning in as few words as \
possible; never restate the user's message back to them at length beyond the one-sentence confirmation in step \
2. Follow the Microsoft Guidelines for Human-AI Interaction: make clear what you can do and how well you can do \
it, let the user correct your interpretation, and convey the consequences of choices.

The support is not shown to the user on any real page until they have actually agreed to a specific concept —
set agreed to true only on the turn where the user has just confirmed something concrete you proposed or they
described (e.g. they say "yes" to a checklist you offered, or clearly state an idea you're both now aligned on)
— never just because they mentioned a preference in passing. Before that point, keep agreed false. Once true, it
stays true for the rest of this conversation — keep refining component_preferences and children as normal, no
need to ask for agreement again unless the user wants to start over.

component_preferences is free-form — invent whatever keys fit what the user actually described, in their own \
terms. There is one convention the renderer understands, used only when the user gives you something to put in \
it: position and size are read from raw CSS values on the keys top/right/bottom/left/width/height (e.g. "20px", \
"10%"), set as DIRECT top-level keys of component_preferences — never nested inside a sub-object like "position" \
or "size". The renderer already defaults to the bottom-right corner on its own — never ask the user to choose a \
position from a list of options (top-right, bottom-left, etc.) and don't bring position up at all unless they \
do. Only set top/right/bottom/left when the user explicitly asks for something different, in their own words; \
size works the same way. Never invent a value they didn't ask for or clearly imply.

Once something is agreed and has gone a turn or two without further change requests (or the user says it looks \
good), mention once that they can save it in the Saved tab to reuse on other sites, and ask if they'd like to \
shape another interface for a different difficulty."""


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class ChatRequest(BaseModel):
    message: str
    history: list[ChatMessage] = []


class ChatDecision(BaseModel):
    reply: str
    suggestions: list[str] = []
    interface_representation: dict[str, Any] | None = None
    agreed: bool = False


CHAT_DECISION_TOOL = {
    "name": "respond_and_update_interface",
    "description": "Reply to the user in the conversation and report whether/how the interface representation should be updated.",
    "input_schema": {
        "type": "object",
        "properties": {
            "reply": {"type": "string", "description": "The concise, precise reply to show the user."},
            "suggestions": {
                "type": "array",
                "items": {"type": "string"},
                "maxItems": 3,
                "description": "At most 3 short quick-reply options.",
            },
            "interface_representation": {
                "type": ["object", "null"],
                "description": "The full updated {component, component_preferences, children} tree, only when this reply changes it; otherwise null.",
            },
            "agreed": {
                "type": "boolean",
                "description": "True only on the turn where the user has just confirmed a specific concrete support concept.",
            },
        },
        "required": ["reply", "suggestions", "agreed"],
    },
}


def model_chat_decision(current_interface: dict[str, Any], message: str, history: list[ChatMessage]) -> ChatDecision | None:
    api_key = os.getenv("ANTHROPIC_API_KEY")
    model = os.getenv("ANTHROPIC_MODEL")
    if not api_key or not model:
        return None
    try:
        client = Anthropic(api_key=api_key)
        known_state = f"Current interface representation: {json.dumps(current_interface)}."
        response = client.messages.create(
            model=model,
            max_tokens=4096,
            system=TASKWEB_GUIDE + "\n\n" + known_state,
            tools=[CHAT_DECISION_TOOL],
            tool_choice={"type": "tool", "name": "respond_and_update_interface"},
            messages=[{"role": entry.role, "content": entry.content} for entry in history] + [{"role": "user", "content": message}],
        )
        tool_use = next((block for block in response.content if block.type == "tool_use"), None)
        if tool_use is None:
            print(f"Anthropic chat decision returned no tool_use block; using fallback. stop_reason={response.stop_reason}")
            return None
        return ChatDecision.model_validate(tool_use.input)
    except Exception as error:
        print(f"Anthropic chat decision failed; using fallback: {error}")
        return None


def fallback_chat_decision() -> ChatDecision:
    return ChatDecision(
        reply="I'm having trouble reaching the assistant right now. Please try again shortly.",
        suggestions=[],
    )


@app.post("/chat")
def chat(request: ChatRequest) -> dict[str, Any]:
    current = get_active_tree()
    decision = model_chat_decision(current, request.message, request.history) or fallback_chat_decision()
    if decision.interface_representation is not None:
        interface_store["active_tree"] = decision.interface_representation
    if decision.agreed:
        interface_store["active_agreed"] = True
    if decision.interface_representation is not None or decision.agreed:
        save_interface_store()
    return {
        "reply": decision.reply,
        "suggestions": decision.suggestions,
        "interface_representation": get_active_tree(),
        "agreed": is_agreed(),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }


# ---------------------------------------------------------------------------
# Webpage interface — interface_representation + a site's task_representation, combined.
# Same shape as interface_representation, grounded in one specific site's real elements.
# ---------------------------------------------------------------------------

def model_webpage_interface(interface_representation: dict[str, Any], task_representation: dict[str, Any]) -> dict[str, Any] | None:
    api_key = os.getenv("ANTHROPIC_API_KEY")
    model = os.getenv("ANTHROPIC_MODEL")
    if not api_key or not model:
        return None
    try:
        client = Anthropic(api_key=api_key)
        response = client.messages.create(
            model=model,
            max_tokens=2000,
            system=(
                "Given a user's interface preferences and a task representation of a specific webpage, produce a "
                "concrete interface representation grounded in that page's real tasks. Respond with only valid "
                "JSON matching {\"component\":string,\"component_preferences\":object,\"children\":array of the "
                "same shape}. Preserve component_preferences as given — do not restructure or rename its keys. "
                "If it sets any of top/right/bottom/left/width/height, keep them as direct top-level keys, never "
                "nested inside a sub-object. Every selector referenced anywhere in component_preferences or "
                "children must be copied verbatim from the task representation's task_elements — never invent "
                "one. Do not wrap the JSON in markdown code fences or add any other text."
            ),
            messages=[{"role": "user", "content": json.dumps({
                "interface_representation": interface_representation,
                "task_representation": task_representation,
            })}],
        )
        text = next((block.text for block in response.content if block.type == "text"), "")
        cleaned = strip_json_fence(text)
        return json.loads(cleaned) if cleaned else None
    except Exception as error:
        print(f"Anthropic webpage interface generation failed; using fallback: {error}")
        return None


def fallback_webpage_interface(interface_representation: dict[str, Any], _task_representation: dict[str, Any]) -> dict[str, Any]:
    return interface_representation


@app.get("/webpage-interfaces/{site_id}")
def get_webpage_interface(site_id: str) -> dict[str, Any]:
    webpage_interface = task_store.get(site_id, {}).get("webpage_interface")
    if webpage_interface is None:
        raise HTTPException(status_code=404, detail="Webpage interface not found")
    return webpage_interface


@app.post("/webpage-interfaces/{site_id}/generate")
def generate_webpage_interface(site_id: str) -> dict[str, Any]:
    entry = task_store.get(site_id)
    task_representation = entry.get("task_representation") if entry else None
    if task_representation is None:
        raise HTTPException(status_code=404, detail="Analyze the page before generating its interface")
    interface_representation = get_active_tree()
    webpage_interface = model_webpage_interface(interface_representation, task_representation) or fallback_webpage_interface(interface_representation, task_representation)
    entry["webpage_interface"] = webpage_interface
    save_task_store()
    return webpage_interface


# ---------------------------------------------------------------------------
# Page-change events — detected client-side; re-generates the webpage interface when relevant.
# ---------------------------------------------------------------------------

class EventRequest(BaseModel):
    type: str
    url: str
    target: dict[str, Any] = {}
    payload: dict[str, Any] = {}


class ProcessedEvent(BaseModel):
    related: bool
    webpage_interface: dict[str, Any] | None = None


def flatten_task_selectors(task: dict[str, Any]) -> list[str]:
    selectors = [element.get("selector") for element in task.get("task_elements", [])]
    for child in task.get("children_tasks", []):
        selectors += flatten_task_selectors(child)
    return selectors


def task_event_is_related(task_representation: dict[str, Any] | None, event: EventRequest) -> bool:
    if task_representation is None:
        return False
    selectors = flatten_task_selectors(task_representation)
    selector = event.target.get("selector")
    return bool(
        selector in selectors
        or event.target.get("forms", 0) > 0
        or "task" in str(event.target.get("title", "")).lower()
    )


@app.post("/task-representations/{site_id}/events/process", response_model=ProcessedEvent)
def process_event(site_id: str, event: EventRequest) -> ProcessedEvent:
    entry = task_store.get(site_id)
    task_representation = entry.get("task_representation") if entry else None
    related = task_event_is_related(task_representation, event)
    webpage_interface = None
    if related and entry is not None and is_agreed():
        interface_representation = get_active_tree()
        webpage_interface = model_webpage_interface(interface_representation, task_representation) or fallback_webpage_interface(interface_representation, task_representation)
        entry["webpage_interface"] = webpage_interface
        save_task_store()
    return ProcessedEvent(related=related, webpage_interface=webpage_interface)
