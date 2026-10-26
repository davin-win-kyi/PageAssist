"""
The schemas for the task representation: the analyze request (the page scan), the model's output,
and its tool
- the patch reuses these in definitions/patch
"""

from __future__ import annotations
from typing import Literal

from pydantic import BaseModel, model_validator


# ****************************************************************************************************
# Request: the page scan (mirrors ScannedElement / ScannedContainer in plugin/lib/page-scan.ts)
# ****************************************************************************************************

class PageElement(BaseModel):
    """One scanned element of the page."""

    # its HTML id, else its selector (never its position)
    id: str
    selector: str
    tag: str
    # its text, cut to 120 characters
    text: str
    # explicit role, else inferred from the tag
    role: str = ""
    # its label, the way a screen reader reads it
    accessibleName: str = ""
    # its help text, hint or validation message
    description: str = ""
    # "complete" / "incomplete" for a control as of the scan, else ""
    completion_status: str = ""
    # selector of the container it sits in, "" if none
    container: str = ""
    visible: bool = True


class ContextContainer(BaseModel):
    """A group elements sit in: a form, fieldset, list, table row, section or dialog."""

    selector: str
    tag: str
    role: str = ""
    # its legend, caption, summary or heading
    label: str = ""
    # selector of the container it sits in, "" at the top
    parent: str = ""


# How much page text is kept for widget generation (~15k tokens). Mirrors getPageText's cap in
# plugin/lib/page-scan.ts.
PAGE_TEXT_LIMIT = 60_000


class TaskRepresentationRequest(BaseModel):
    """Body of POST /task-representations/{id}/analyze."""

    url: str
    title: str
    elements: list[PageElement]
    containers: list[ContextContainer] = []
    # the page's readable text, kept for widget generation
    page_text: str = ""
    # {sameOrigin, crossOrigin} iframe counts, logged to explain an empty result
    frames: dict[str, int] = {}


# ****************************************************************************************************
# Output: what the build_task_representation tool must return
# ****************************************************************************************************

# What a component is. A *-question is answered in a control on the page; a step is something the
# user does; the rest are read or used. The two "other" values catch anything that fits no type.
ComponentType = Literal[
    "text-question", "long-text-question", "single-choice-question", "multi-choice-question",
    "toggle-question", "date-question", "file-question", "other-question",
    "step", "content", "heading", "action", "navigation", "status", "media", "other",
]

# depends_on: source applies only given an answer to target. precedes: source comes first in the
# page's order. alternative_to: either one satisfies the same need.
RelationshipType = Literal["depends_on", "precedes", "alternative_to"]


class TaskItem(BaseModel):
    """A goal the user comes to the page to do. Sub-goals point at their parent task."""

    task_id: str
    label: str
    description: str = ""
    task_type: str
    parent_task_id: str | None = None
    component_ids: list[str] = []


class ComponentItem(BaseModel):
    """A unit the user acts on or reads. Each form question is its own component."""

    component_id: str
    component_type: ComponentType
    label: str = ""
    description: str = ""
    dom_selector: str
    member_selectors: list[str] = []
    associated_task_ids: list[str] = []


class Relationship(BaseModel):
    """A link between two components, by component_id."""

    type: RelationshipType
    source: str
    target: str


# Keeps only links between two different, real components, once each. A bad link is dropped rather
# than failing the whole answer.
def valid_relationships(relationships: list[Relationship], component_ids: set[str]) -> list[Relationship]:
    kept: list[Relationship] = []
    seen: set[tuple[str, str, str]] = set()
    for rel in relationships:
        key = (rel.type, rel.source, rel.target)
        if rel.source in component_ids and rel.target in component_ids and rel.source != rel.target and key not in seen:
            seen.add(key)
            kept.append(rel)
    return kept


class TaskRepresentationOut(BaseModel):
    """The whole task representation of one page."""

    page_purpose: str
    tasks: list[TaskItem] = []
    components: list[ComponentItem] = []
    relationships: list[Relationship] = []
    modeling_notes: str = ""

    @model_validator(mode="after")
    def _drop_dangling_relationships(self) -> "TaskRepresentationOut":
        self.relationships = valid_relationships(self.relationships, {c.component_id for c in self.components})
        return self


# ****************************************************************************************************
# Tool schema (mirrors the models above)
# ****************************************************************************************************

TASK_SCHEMA = {
    "type": "object",
    "properties": {
        "task_id": {"type": "string", "description": "Short stable id."},
        "label": {"type": "string", "description": "The goal, in a few words."},
        "description": {"type": "string", "description": "What the goal involves, from the page; \"\" only when the page says nothing more."},
        "task_type": {"type": "string", "description": "Short kebab-case kind of task."},
        "parent_task_id": {"type": ["string", "null"], "description": "The containing task's id, or null."},
        "component_ids": {"type": "array", "items": {"type": "string"}, "description": "Components that serve this task directly."},
    },
    "required": ["task_id", "label", "description", "task_type", "parent_task_id", "component_ids"],
}

COMPONENT_SCHEMA = {
    "type": "object",
    "properties": {
        "component_id": {"type": "string", "description": "Short stable id."},
        "component_type": {"type": "string", "enum": list(ComponentType.__args__), "description": "What kind of thing it is; see COMPONENT TYPES."},
        "label": {"type": "string", "description": "What it does or asks for, in a few words, from its visible name."},
        "description": {"type": "string", "description": "What else the user needs to know about it, from the page, without repeating the label; \"\" only when the page gives nothing more."},
        "dom_selector": {"type": "string", "description": "Selector of the smallest element covering the whole component, copied verbatim from an element."},
        "member_selectors": {"type": "array", "items": {"type": "string"}, "description": "Selectors of its key elements, each copied verbatim."},
        "associated_task_ids": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["component_id", "component_type", "label", "description", "dom_selector", "member_selectors", "associated_task_ids"],
}

RELATIONSHIP_SCHEMA = {
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
    "description": "Model one page as a hierarchy of the user's tasks and the components that carry them out, grounded in its real elements.",
    "input_schema": {
        "type": "object",
        "properties": {
            "page_purpose": {"type": "string", "description": "The page's main purpose, one clause."},
            "tasks": {"type": "array", "items": TASK_SCHEMA, "description": "Every task. Flat list; hierarchy via parent_task_id."},
            "components": {"type": "array", "items": COMPONENT_SCHEMA, "description": "Every component. Each form question is its own."},
            "relationships": {"type": "array", "items": RELATIONSHIP_SCHEMA, "description": "Links with visible evidence; [] if none."},
            "modeling_notes": {"type": "string", "description": "Real ambiguity worth noting; \"\" if none."},
        },
        "required": ["page_purpose", "tasks", "components", "relationships", "modeling_notes"],
    },
}
