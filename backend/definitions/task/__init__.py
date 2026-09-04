"""Task-representation domain definitions: prompts.py + schema.py."""
from definitions.task.prompts import TASK_REPRESENTATION_GUIDE, PATCH_TASK_REPRESENTATION_GUIDE
from definitions.task.schema import (
    PageElement, TaskRepresentationRequest, TaskPatchRequest, Importance, RequiredForTask,
    TaskItem, ComponentItem, TaskRepresentationOut, TASK_REPRESENTATION_TOOL, PATCH_COMPONENTS_TOOL,
)
