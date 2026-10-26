"""
Helper methods for the task representation routes
- the model call that analyzes a whole page
- logging what the page sent
"""
from typing import Any
import json

from definitions.task import TASK_REPRESENTATION_GUIDE, TaskRepresentationRequest, TaskRepresentationOut, TASK_REPRESENTATION_TOOL
from api.utils.llm import get_client_and_model, call_structured_tool, THINKING_LEVELS

# content.ts already sorts and caps the elements; this is a backstop for the token budget.
MAX_ELEMENTS_TO_MODEL = 500
INPUT_TAGS = {"input", "textarea", "select"}
INPUT_ROLES = {"textbox", "combobox", "checkbox", "radio", "searchbox", "spinbutton"}


# Logs what the page sent. No form controls next to only cross-origin iframes usually means the
# form is in a frame the extension can't read.
def log_request(request: TaskRepresentationRequest, model: str, sent: int) -> None:
    inputs = sum(1 for e in request.elements[:sent] if e.tag in INPUT_TAGS or e.role in INPUT_ROLES)
    frames = request.frames or {}
    print(f"analyze [{model}]: {len(request.elements)} elements ({sent} sent, {inputs} inputs), frames {frames or 'none'}")
    if inputs == 0 and frames.get("crossOrigin", 0) > 0 and frames.get("sameOrigin", 0) == 0:
        print("analyze: no form controls and only cross-origin iframes; the form is likely in a frame the extension can't read.")


# Tasks, components and relationships for the whole page.
async def model_task_representation(request: TaskRepresentationRequest) -> dict[str, Any]:
    client, model = get_client_and_model()
    elements = request.elements[:MAX_ELEMENTS_TO_MODEL]
    log_request(request, model, len(elements))
    payload = {
        "url": request.url,
        "title": request.title,
        "elements": [element.model_dump() for element in elements],
        "containers": [container.model_dump() for container in request.containers],
    }
    return await call_structured_tool(
        client=client,
        model=model,
        system=TASK_REPRESENTATION_GUIDE,
        messages=[{"role": "user", "content": json.dumps(payload)}],
        tool=TASK_REPRESENTATION_TOOL,
        max_tokens=32000,
        validate=lambda data: TaskRepresentationOut.model_validate(data).model_dump(),
        label="task representation",
        thinking_level=THINKING_LEVELS["task_representation"],
    )
