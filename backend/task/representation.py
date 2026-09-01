"""Task representation — a semantic model of what the user is trying to do on ONE specific webpage,
grounded strictly in that page's real, visible elements.

Shape: {task_id, task_name, children_tasks: [same shape], task_elements: [PageElement], example_difficulties}
"""
from __future__ import annotations
from typing import Any
import json

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from common import store
from common.llm import get_client_and_model, call_structured_tool

router = APIRouter()

# Cap the elements sent to the model. content.ts already caps its own scan; this is the token-budget
# backstop. Richer per-element payload (role/accessibleName/visible, below) makes the cap matter more.
MAX_ELEMENTS_TO_MODEL = 300


# --- Wire shapes ------------------------------------------------------------------------------------

class PageElement(BaseModel):
    id: str
    selector: str
    tag: str
    text: str
    role: str = ""            # explicit role=, else inferred from tag/input-type by content.ts
    accessibleName: str = ""  # aria-label → aria-labelledby → associated <label> → placeholder → title
    visible: bool = True


class TaskRepresentationRequest(BaseModel):
    url: str
    title: str
    elements: list[PageElement]


class TaskNodeOut(BaseModel):
    task_id: str
    task_name: str
    children_tasks: list[TaskNodeOut] = []
    task_elements: list[PageElement] = []


class TaskRepresentationOut(TaskNodeOut):
    example_difficulties: list[str] = []


TaskNodeOut.model_rebuild()


# --- Model call -----------------------------------------------------------------------------------

_TASK_ELEMENT_SCHEMA = {
    "type": "object",
    "properties": {
        "id": {"type": "string"},
        "selector": {"type": "string"},
        "tag": {"type": "string"},
        "text": {"type": "string"},
        "role": {"type": "string"},
        "accessibleName": {"type": "string"},
        "visible": {"type": "boolean"},
    },
    "required": ["id", "selector", "tag", "text"],
}

TASK_REPRESENTATION_TOOL = {
    "name": "build_task_representation",
    "description": "Produce a task representation of what the user is trying to accomplish on this page, grounded in its real elements.",
    "input_schema": {
        "type": "object",
        "properties": {
            "task_id": {"type": "string"},
            "task_name": {
                "type": "string",
                "description": "The user's concrete inferred goal, reasoned from real elements (labelled inputs near a submit button → form completion; a list with per-item actions → selection/management; a lone search box → lookup). Not a restatement of the page title.",
            },
            "children_tasks": {
                "type": "array",
                "items": {"type": "object"},
                "description": "The task split into logical sub-steps (same shape, recursive), each grounded in the elements that belong to it. At most 6.",
            },
            "task_elements": {
                "type": "array",
                "items": _TASK_ELEMENT_SCHEMA,
                "description": "Elements belonging to THIS node, each copied verbatim from the given elements. Never invent one.",
            },
            "example_difficulties": {
                "type": "array",
                "items": {"type": "string"},
                "maxItems": 3,
                "description": "2-3 short, first-person difficulties a user might plausibly have on THIS page, grounded in its real content and labels — not phrasing that fits any page.",
            },
        },
        "required": ["task_id", "task_name", "children_tasks", "task_elements", "example_difficulties"],
    },
}

_SYSTEM = (
    "You turn a webpage into a task representation: what the user is trying to accomplish here, grounded "
    "strictly in the page's real elements.\n"
    "- Reason from the elements present (tag, role, accessibleName, text), not from the title alone.\n"
    "- Group elements into logical sub-steps (children_tasks) that reflect real structure — one form "
    "section per node, not one flat bucket.\n"
    "- Atomic unit: each distinct form control / labelled input is its OWN leaf node. Never merge several "
    "inputs into one node just because they are adjacent or share a section.\n"
    "- Grounding: every task_elements entry is copied verbatim from the given elements. Never invent a "
    "selector or a plausible-sounding field. Prefer elements with visible=true; if the page seems "
    "half-loaded, produce a smaller/flatter tree rather than guessing missing structure.\n"
    "- Never assert a field's value or whether it is complete/required — that is read live elsewhere."
)


async def model_task_representation(request: TaskRepresentationRequest) -> dict[str, Any] | None:
    client, model = get_client_and_model()
    if client is None:
        return None
    try:
        payload = {
            "url": request.url,
            "title": request.title,
            "elements": [element.model_dump() for element in request.elements[:MAX_ELEMENTS_TO_MODEL]],
        }
        result = await call_structured_tool(
            client=client,
            model=model,
            system=_SYSTEM,
            messages=[{"role": "user", "content": json.dumps(payload)}],
            tool=TASK_REPRESENTATION_TOOL,
            max_tokens=1500,
            validate=lambda data: TaskRepresentationOut.model_validate(data).model_dump(),
            label="task representation",
        )
        return result
    except Exception as error:
        print(f"task representation call failed; using fallback: {error}")
        return None


def fallback_task_representation(request: TaskRepresentationRequest) -> dict[str, Any]:
    """Model-free fallback: one child per <form> so a transient model failure still yields something
    grounded in the real page."""
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
        "example_difficulties": [
            f"I'm not sure what {request.title or 'this page'} wants me to do next",
            "I can't tell what's still required here",
        ],
    }


# --- Routes --------------------------------------------------------------------------------------

@router.get("/task-representations/{site_id}")
def get_task_representation(site_id: str) -> dict[str, Any]:
    if store.task_store.get("site_id") != site_id or store.task_store.get("task_representation") is None:
        raise HTTPException(status_code=404, detail="Task representation not found")
    return store.task_store["task_representation"]


@router.post("/task-representations/{site_id}/analyze")
async def analyze_task_representation(site_id: str, request: TaskRepresentationRequest) -> dict[str, Any]:
    task_representation = await model_task_representation(request) or fallback_task_representation(request)
    # Replace the single slot outright. Re-analyzing the SAME site keeps its webpage_interface (still
    # valid until regenerated); a different site starts with none.
    carried = store.task_store.get("webpage_interface") if store.task_store.get("site_id") == site_id else None
    store.replace_task_store(site_id, task_representation, carried)
    return task_representation
