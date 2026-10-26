"""
The task representation definitions: its prompt in prompts.py, and its schemas and tool in
schema.py
"""
from definitions.task.prompts import TASK_REPRESENTATION_GUIDE
from definitions.task.schema import (
    PageElement, ContextContainer, PAGE_TEXT_LIMIT, TaskRepresentationRequest,
    TaskItem, ComponentItem, ComponentType, Relationship, valid_relationships, TaskRepresentationOut,
    TASK_REPRESENTATION_TOOL,
)
