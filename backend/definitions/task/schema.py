"""
Task representation related schemas
"""

from __future__ import annotations
from typing import Literal

from pydantic import BaseModel


# --- Request -------------------------------------------------------------------------------------

class PageElement(BaseModel):
    """One pruned, accessibility-tree-like node from the client's page snapshot."""

    id: str
    selector: str
    tag: str
    text: str
    role: str = ""            # explicit role=, else inferred from tag/input-type by content.ts
    accessibleName: str = ""  # aria-label → aria-labelledby → associated <label> → placeholder → title
    visible: bool = True


class TaskRepresentationRequest(BaseModel):
    """Body of POST /task-representations/{id}/analyze: the page's URL/title + its element snapshot."""

    url: str
    title: str
    elements: list[PageElement]
    page_text: str = ""          # the page's readable prose (document.innerText, capped) — used at
    #                              generation time for content that isn't a form field (recipe steps…)
    frames: dict[str, int] = {}  # {sameOrigin, crossOrigin} — diagnostic; a form page with only
    #                              cross-origin frames means the fields are unreachable to the extension


# --- Closed enums ------------------------------------------------------------------------------
# `task_type` and `semantic_role` are OPEN free strings (short kebab-case) — webpages host more task
# shapes than a fixed list can name. `importance` and `required_for_task` are genuinely closed.

Importance = Literal["primary", "supporting", "peripheral"]
RequiredForTask = Literal["true", "false", "unknown"]


# --- Output models (validate the model's tool call) -------------------------------------------

class TaskItem(BaseModel):
    """One coarse, goal-oriented user task. Hierarchy via parent_task_id on a flat list."""

    task_id: str
    label: str
    description: str = ""
    task_type: str  # short kebab-case label
    parent_task_id: str | None = None
    component_ids: list[str] = []
    importance: Importance = "supporting"


class ComponentItem(BaseModel):
    """One semantic grouping of DOM nodes a user names as one thing. Each form question is its own."""

    component_id: str
    semantic_role: str  # short kebab-case label
    label: str = ""
    description: str = ""
    dom_selector: str
    member_selectors: list[str] = []
    associated_task_ids: list[str] = []
    required_for_task: RequiredForTask = "unknown"
    importance: Importance = "supporting"


class TaskRepresentationOut(BaseModel):
    """The whole task-aware model of one page — what the build_task_representation tool must return."""

    page_purpose: str
    page_type: str = ""
    tasks: list[TaskItem] = []
    components: list[ComponentItem] = []
    modeling_notes: str = ""


# --- Tool schema (mirrors the models above) -------------------------------------------------

_TASK_SCHEMA = {
    "type": "object",
    "properties": {
        "task_id": {"type": "string", "description": "Short stable id, e.g. \"t1\"."},
        "label": {"type": "string", "description": "Concise user-facing goal."},
        "description": {"type": "string"},
        "task_type": {"type": "string", "description": "Short kebab-case label for the kind of task."},
        "parent_task_id": {"type": ["string", "null"], "description": "Containing task id, or null."},
        "component_ids": {"type": "array", "items": {"type": "string"},
                          "description": "Ids of components that directly support this task."},
        "importance": {"type": "string", "enum": list(Importance.__args__)},
    },
    "required": ["task_id", "label", "task_type", "parent_task_id", "component_ids", "importance"],
}

_COMPONENT_SCHEMA = {
    "type": "object",
    "properties": {
        "component_id": {"type": "string", "description": "Short stable id, e.g. \"c1\"."},
        "semantic_role": {"type": "string", "description": "Short kebab-case label for what the component is."},
        "label": {"type": "string", "description": "Visible name/heading, when present."},
        "description": {"type": "string"},
        "dom_selector": {"type": "string",
                         "description": "Selector of the smallest element that represents the whole unit — copied VERBATIM from an input element's `selector`. Never invented."},
        "member_selectors": {"type": "array", "items": {"type": "string"},
                             "description": "Selectors of the key nodes in this component, each copied verbatim from the input."},
        "associated_task_ids": {"type": "array", "items": {"type": "string"}},
        "required_for_task": {"type": "string", "enum": list(RequiredForTask.__args__),
                              "description": "\"true\"/\"false\" only with visible evidence (an explicit required marker); otherwise \"unknown\"."},
        "importance": {"type": "string", "enum": list(Importance.__args__)},
    },
    "required": ["component_id", "semantic_role", "dom_selector", "member_selectors",
                 "associated_task_ids", "required_for_task", "importance"],
}

TASK_REPRESENTATION_TOOL = {
    "name": "build_task_representation",
    "description": "Transform a node-level page snapshot into a task-aware semantic model grounded in its real elements.",
    "input_schema": {
        "type": "object",
        "properties": {
            "page_purpose": {"type": "string", "description": "The page's primary purpose in ONE short plain-language clause, <= 10 words (e.g. \"Apply for the Senior Engineer role\"). Not a full paragraph."},
            "page_type": {"type": "string",
                          "description": "Concise category, e.g. form, checkout, dashboard, search-results, article, settings, authentication, application, upload, multi-step-workflow."},
            "tasks": {"type": "array", "items": _TASK_SCHEMA,
                      "description": "Every meaningful user task on the page. Flat list; hierarchy via parent_task_id. No cap — a single form field is NOT a task."},
            "components": {"type": "array", "items": _COMPONENT_SCHEMA,
                           "description": "Every semantic component. Flat list, NO cap. Each individual form question is its own component."},
            "modeling_notes": {"type": "string", "description": "Important ambiguity or unusual grouping decisions, or empty."},
        },
        "required": ["page_purpose", "page_type", "tasks", "components", "modeling_notes"],
    },
}


# --- Incremental patch (fast path — add/remove a few elements without re-modelling the page) -----

class TaskPatchRequest(BaseModel):
    """Body of POST /task-representations/{id}/patch: field elements that entered / left the DOM since
    the last analyze. A cheap incremental update instead of re-modelling the whole page."""

    added: list[PageElement] = []
    removed: list[str] = []  # selectors of components/fields that left the DOM


PATCH_COMPONENTS_TOOL = {
    "name": "add_components",
    "description": "Return only the NEW components to append to an existing task representation for a few just-appeared elements.",
    "input_schema": {
        "type": "object",
        "properties": {
            "components": {"type": "array", "items": _COMPONENT_SCHEMA,
                           "description": "New components only — one per distinct new question. Empty if the new elements aren't task-relevant."},
        },
        "required": ["components"],
    },
}
