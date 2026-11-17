"""
The schemas for the page-change patch: the elements that appeared, left or came into view, and the
new components the model returns for them
- components are shaped like the full analysis's, in definitions/task
"""

from pydantic import BaseModel

from definitions.task.schema import (
    PageElement, ContextContainer, ComponentItem, Relationship, COMPONENT_SCHEMA, RELATIONSHIP_SCHEMA,
)


class TaskPatchRequest(BaseModel):
    """Body of POST /task-representations/{id}/patch."""

    added: list[PageElement] = []
    # selectors of fields that left the page or went hidden
    removed: list[str] = []
    # per question: was hidden, now visible
    revealed: list[list[PageElement]] = []
    # the containers the added and revealed elements sit in
    containers: list[ContextContainer] = []


class PatchOut(BaseModel):
    """What the add_components tool must return: the new components, and any links from them."""

    components: list[ComponentItem] = []
    relationships: list[Relationship] = []


PATCH_COMPONENTS_TOOL = {
    "name": "add_components",
    "description": "Return only the NEW components for elements that just appeared on a page, plus any links from them.",
    "input_schema": {
        "type": "object",
        "properties": {
            "components": {"type": "array", "items": COMPONENT_SCHEMA, "description": "New components only, each filed under the tasks it serves; [] if no new element is a component."},
            "relationships": {"type": "array", "items": RELATIONSHIP_SCHEMA, "description": "Links from new components to each other or to existing ones (by component_id); [] if none."},
        },
        "required": ["components", "relationships"],
    },
}
