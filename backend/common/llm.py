"""Anthropic client plumbing shared by every model-backed endpoint.

- `get_client_and_model()` — the api-key/model env lookup all three call sites used to duplicate.
- `call_structured_tool()` — forced tool-use + typed validation + retry-on-validation-error, so a
  "nearly right" tool call becomes an "always right" one instead of silently falling back.
"""
from typing import Any, Callable
import os
from anthropic import AsyncAnthropic

ToolInput = dict[str, Any]


def get_client_and_model() -> tuple[AsyncAnthropic | None, str | None]:
    api_key = os.getenv("ANTHROPIC_API_KEY")
    model = os.getenv("ANTHROPIC_MODEL")
    if not api_key or not model:
        return None, None
    return AsyncAnthropic(api_key=api_key), model


async def call_structured_tool(
    *,
    client: AsyncAnthropic,
    model: str,
    system: str,
    messages: list[dict[str, Any]],
    tool: dict[str, Any],
    max_tokens: int,
    validate: Callable[[ToolInput], Any],
    label: str,
    max_retries: int = 2,
) -> Any | None:
    """Force `tool`, then validate its input with `validate` (which must raise on bad data).

    On a validation failure the exact error is fed back as an `is_error` tool_result and the model is
    asked to call the tool again — up to `max_retries` extra times. Returns whatever `validate` returns,
    or None if the model never produced a tool call or never produced valid input.
    """
    tool_name = tool["name"]
    convo: list[dict[str, Any]] = list(messages)
    last_error: Exception | None = None

    for _ in range(max_retries + 1):
        response = await client.messages.create(
            model=model,
            max_tokens=max_tokens,
            system=system,
            tools=[tool],
            tool_choice={"type": "tool", "name": tool_name},
            messages=convo,
        )
        tool_use = next((block for block in response.content if block.type == "tool_use"), None)
        if tool_use is None:
            print(f"{label}: no tool_use block (stop_reason={response.stop_reason}); using fallback.")
            return None
        try:
            return validate(tool_use.input)
        except Exception as error:  # bad enum literal, missing field, wrong shape, ...
            last_error = error
            convo = convo + [
                {"role": "assistant", "content": [
                    {"type": "tool_use", "id": tool_use.id, "name": tool_use.name, "input": tool_use.input},
                ]},
                {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": tool_use.id, "is_error": True,
                     "content": f"That input was rejected: {error}. Call {tool_name} again with corrected input."},
                ]},
            ]

    print(f"{label}: tool input still invalid after {max_retries} retries ({last_error}); using fallback.")
    return None
