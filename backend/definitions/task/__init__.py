"""Task-representation domain definitions: prompts.py + schema.py."""
from definitions.task.prompts import TASK_REPRESENTATION_GUIDE, PATCH_TASK_REPRESENTATION_GUIDE
from definitions.task.schema import (
    PageElement, ContextContainer, PAGE_TEXT_LIMIT, TaskRepresentationRequest, TaskPatchRequest, Importance, RequiredForTask,
    TaskItem, ComponentItem, ComponentType, Relationship, valid_relationships, TaskRepresentationOut, PatchOut,
    TASK_REPRESENTATION_TOOL, PATCH_COMPONENTS_TOOL,
)
