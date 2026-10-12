"""
Task representation related schemas
"""

from __future__ import annotations
from typing import Literal

from pydantic import BaseModel, model_validator


# --- Request -------------------------------------------------------------------------------------

class PageElement(BaseModel):
    """One pruned, accessibility-tree-like node from the client's page snapshot (plugin/lib/page-scan.ts)."""

    id: str                      # its own HTML id, else its selector — never its position
    selector: str
    tag: str
    text: str
    role: str = ""               # explicit role=, else inferred from tag/input-type by content.ts
    accessibleName: str = ""     # aria-label → aria-labelledby → alt → associated <label> → placeholder → title
    description: str = ""        # help text / hint / validation message (aria-describedby, aria-errormessage)
    completion_status: str = ""  # "complete" / "incomplete" for answerable controls as of the scan, else ""
    container: str = ""          # selector of its nearest ContextContainer, "" when none
    visible: bool = True


class ContextContainer(BaseModel):
    """A structural grouping elements sit in (form, fieldset, list, table row, dialog, section…)."""

    selector: str
    tag: str
    role: str = ""
    label: str = ""   # legend / caption / summary / figcaption / heading / ARIA name
    parent: str = ""  # selector of the container this one sits in, "" at top level


# How much of a page's readable prose is kept and handed to widget generation (~15k tokens). Generous on
# purpose: for a tutorial or recipe the prose IS the steps, and anything past the cut can never become an
# item. Mirrors getPageText's default cap in plugin/lib/page-scan.ts.
PAGE_TEXT_LIMIT = 60_000


class TaskRepresentationRequest(BaseModel):
    """Body of POST /task-representations/{id}/analyze: the page's URL/title + its element snapshot."""

    url: str
    title: str
    elements: list[PageElement]
    containers: list[ContextContainer] = []
    page_text: str = ""          # the page's readable prose (document.innerText, capped) — used at
    #                              generation time for content that isn't a form field (recipe steps…)
    frames: dict[str, int] = {}  # {sameOrigin, crossOrigin} — diagnostic; a form page with only
    #                              cross-origin frames means the fields are unreachable to the extension


# --- Closed enums ------------------------------------------------------------------------------
# `task_type` and `semantic_role` are OPEN free strings (short kebab-case) — webpages host more task
# shapes than a fixed list can name. The rest are closed.

Importance = Literal["primary", "supporting", "peripheral"]
RequiredForTask = Literal["true", "false", "unknown"]
# What kind of thing a component is — tells widget generation how to treat it: a *-question is answered
# in a control (a grounded item whose completion the host tracks), a step is done by the user (a manual
# item), a heading names a section, an action is a button or link that does something.
ComponentType = Literal[
    "text-question", "long-text-question", "single-choice-question", "multi-choice-question",
    "toggle-question", "date-question", "file-question",
    "step", "content", "heading", "action", "navigation", "status", "media",
]
# source depends_on target: source applies only given an answer to target (a follow-up question).
# source precedes target: source comes first in the page's own order (numbered steps, a wizard).
# source alternative_to target: either one satisfies the same need (upload a resume OR enter it).
RelationshipType = Literal["depends_on", "precedes", "alternative_to"]


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
    component_type: ComponentType
    semantic_role: str  # short kebab-case label
    label: str = ""
    description: str = ""
    dom_selector: str
    member_selectors: list[str] = []
    associated_task_ids: list[str] = []
    required_for_task: RequiredForTask = "unknown"
    importance: Importance = "supporting"


class Relationship(BaseModel):
    """A link between two components, by component_id (see RelationshipType)."""

    type: RelationshipType
    source: str
    target: str


def valid_relationships(relationships: list[Relationship], component_ids: set[str]) -> list[Relationship]:
    """Only links between two different, real components, once each — a dangling or duplicate link
    is dropped rather than failing the whole call."""
    kept: list[Relationship] = []
    seen: set[tuple[str, str, str]] = set()
    for rel in relationships:
        key = (rel.type, rel.source, rel.target)
        if rel.source in component_ids and rel.target in component_ids and rel.source != rel.target and key not in seen:
            seen.add(key)
            kept.append(rel)
    return kept


class TaskRepresentationOut(BaseModel):
    """The whole task-aware model of one page — what the build_task_representation tool must return."""

    page_purpose: str
    page_type: str = ""
    tasks: list[TaskItem] = []
    components: list[ComponentItem] = []
    relationships: list[Relationship] = []
    modeling_notes: str = ""

    @model_validator(mode="after")
    def _drop_dangling_relationships(self) -> "TaskRepresentationOut":
        self.relationships = valid_relationships(self.relationships, {c.component_id for c in self.components})
        return self


class PatchOut(BaseModel):
    """What the add_components tool must return: the new components, plus any links from them."""

    components: list[ComponentItem] = []
    relationships: list[Relationship] = []


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
        "component_type": {"type": "string", "enum": list(ComponentType.__args__),
                           "description": "What kind of thing it is; see COMPONENT TYPES."},
        "semantic_role": {"type": "string", "description": "What it is on this page, 1-3 kebab-case words, e.g. \"phone-number\"."},
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
    "required": ["component_id", "component_type", "semantic_role", "dom_selector", "member_selectors",
                 "associated_task_ids", "required_for_task", "importance"],
}

_RELATIONSHIP_SCHEMA = {
    "type": "object",
    "properties": {
        "type": {"type": "string", "enum": list(RelationshipType.__args__)},
        "source": {"type": "string", "description": "A component_id."},
        "target": {"type": "string", "description": "A component_id."},
    },
    "required": ["type", "source", "target"],
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
            "relationships": {"type": "array", "items": _RELATIONSHIP_SCHEMA,
                              "description": "Links between components with visible evidence on the page; empty if none."},
            "modeling_notes": {"type": "string", "description": "Important ambiguity or unusual grouping decisions, or empty."},
        },
        "required": ["page_purpose", "page_type", "tasks", "components", "relationships", "modeling_notes"],
    },
}


# --- Incremental patch (fast path — add/remove a few elements without re-modelling the page) -----

class TaskPatchRequest(BaseModel):
    """Body of POST /task-representations/{id}/patch: field elements that entered / left / came into
    view since the last analyze. A cheap incremental update instead of re-modelling the whole page."""

    added: list[PageElement] = []
    removed: list[str] = []                  # selectors of components/fields that left the DOM
    revealed: list[list[PageElement]] = []   # per question: was in the DOM hidden, now visible
    containers: list[ContextContainer] = []  # the containers the added/revealed elements sit in


PATCH_COMPONENTS_TOOL = {
    "name": "add_components",
    "description": "Return only the NEW components to append to an existing task representation for a few just-appeared elements.",
    "input_schema": {
        "type": "object",
        "properties": {
            "components": {"type": "array", "items": _COMPONENT_SCHEMA,
                           "description": "New components only — one per distinct new question. Empty if the new elements aren't task-relevant."},
            "relationships": {"type": "array", "items": _RELATIONSHIP_SCHEMA,
                              "description": "Links from the new components to each other or to EXISTING components (by component_id); empty if none."},
        },
        "required": ["components", "relationships"],
    },
}
