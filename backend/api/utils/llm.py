"""
Util methods for the model calls
- LLM_PROVIDER picks Anthropic (the default) or Gemini for every call
- the thinking level of each kind of call
- a model that isn't set up, or a call that fails, raises ModelError, which the API returns to the
  side panel
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable
import os

from anthropic import AsyncAnthropic
from google import genai
from google.genai import types as genai_types

ToolInput = dict[str, Any]

PROVIDER = (os.getenv("LLM_PROVIDER") or "anthropic").strip().lower()


# ****************************************************************************************************
# Thinking levels (Gemini only; the Anthropic branch ignores them)
# ****************************************************************************************************

# Seconds per call over 3 runs: averages, and medians on a real Greenhouse form for the last two:
#   chat reply                low 2.0   medium 3.1    high 6.3
#   chat turn with the tree   low 4.7   medium 13.5   high 29.1
#   page-change patch         low 1.9   medium 11.1   high 24.2
#   task representation       low 28    medium 52     high 293 (over the panel's 240s timeout)
#   widget                    low 20    medium 71     high 156
# A higher level is used only when it costs little extra time, and no step up here does. Chat stays
# low: on average medium is over twice as slow, since its turns that build the tree take 3 times as long.
THINKING_LEVELS = {
    "chat": "low",
    "task_representation": "medium",
    "webpage_interface": "medium",
    "task_patch": "low",
}
DEFAULT_THINKING_LEVEL = "medium"


class ModelError(Exception):
    """No model is configured, or a model call failed. The API turns it into an error the panel shows."""


# ****************************************************************************************************
# Clients
# ****************************************************************************************************

def _client_for(key_name: str, model: str | None) -> tuple[AsyncAnthropic | genai.Client, str]:
    api_key = os.getenv(key_name)
    if not api_key or not model:
        raise ModelError(f"No model is configured: set {key_name} and the model name in backend/.env.")
    client = genai.Client(api_key=api_key) if key_name == "GEMINI_API_KEY" else AsyncAnthropic(api_key=api_key)
    return client, model


def get_client_and_model() -> tuple[AsyncAnthropic | genai.Client, str]:
    if PROVIDER == "gemini":
        return _client_for("GEMINI_API_KEY", os.getenv("GEMINI_MODEL"))
    return _client_for("ANTHROPIC_API_KEY", os.getenv("ANTHROPIC_MODEL"))


# A faster model for page-change patches, falling back to the main model when unset.
def get_fast_client_and_model() -> tuple[AsyncAnthropic | genai.Client, str]:
    if PROVIDER == "gemini":
        return _client_for("GEMINI_API_KEY", os.getenv("GEMINI_MODEL_FAST") or os.getenv("GEMINI_MODEL"))
    return _client_for("ANTHROPIC_API_KEY", os.getenv("ANTHROPIC_MODEL_FAST") or os.getenv("ANTHROPIC_MODEL"))


# ****************************************************************************************************
# One response shape for both providers
# ****************************************************************************************************

# Anthropic's own Message already has this shape; Gemini responses are translated into it.
@dataclass
class ToolUseBlock:
    type: str
    id: str
    name: str
    input: dict[str, Any]
    # Gemini rejects a later turn that replays this call without its thought signature.
    thought_signature: bytes | None = None


@dataclass
class TextBlock:
    type: str
    text: str


@dataclass
class LLMMessage:
    content: list[ToolUseBlock | TextBlock]
    stop_reason: str | None = None


# ****************************************************************************************************
# Sending a message
# ****************************************************************************************************

# Sends one request to whichever provider the client belongs to.
async def create_message(client: AsyncAnthropic | genai.Client, **kwargs: Any):
    if isinstance(client, AsyncAnthropic):
        return await anthropic_create_message(client, **kwargs)
    return await gemini_create_message(client, **kwargs)


# Anthropic, through the streaming API (required for large max_tokens).
async def anthropic_create_message(client: AsyncAnthropic, **kwargs: Any):
    kwargs.pop("thinking_level", None)
    async with client.messages.stream(**kwargs) as stream:
        return await stream.get_final_message()


# Gemini, translated to and from the Anthropic-shaped messages the rest of the code uses.
async def gemini_create_message(
    client: genai.Client,
    *,
    model: str,
    system: str,
    messages: list[dict[str, Any]],
    max_tokens: int,
    tools: list[dict[str, Any]] | None = None,
    tool_choice: dict[str, Any] | None = None,
    thinking_level: str | None = None,
) -> LLMMessage:
    gemini_tools = None
    if tools:
        gemini_tools = [genai_types.Tool(function_declarations=[
            genai_types.FunctionDeclaration(
                name=tool["name"],
                description=tool.get("description", ""),
                parameters_json_schema=tool["input_schema"],
            )
            for tool in tools
        ])]

    tool_config = None
    if tool_choice and tool_choice.get("type") == "tool":
        tool_config = genai_types.ToolConfig(
            function_calling_config=genai_types.FunctionCallingConfig(
                mode="ANY", allowed_function_names=[tool_choice["name"]],
            )
        )

    response = await client.aio.models.generate_content(
        model=model,
        contents=_to_gemini_contents(messages),
        config=genai_types.GenerateContentConfig(
            system_instruction=system,
            max_output_tokens=max_tokens,
            tools=gemini_tools,
            tool_config=tool_config,
            thinking_config=genai_types.ThinkingConfig(thinking_level=thinking_level or DEFAULT_THINKING_LEVEL),
        ),
    )
    return _from_gemini_response(response)


# Plain-text and tool_use / tool_result messages -> Gemini contents.
def _to_gemini_contents(messages: list[dict[str, Any]]) -> list[genai_types.Content]:
    contents: list[genai_types.Content] = []
    last_tool_name: str | None = None
    for message in messages:
        role = "model" if message["role"] == "assistant" else "user"
        raw_content = message["content"]
        parts: list[genai_types.Part] = []
        blocks = [{"type": "text", "text": raw_content}] if isinstance(raw_content, str) else raw_content
        for block in blocks:
            block_type = block.get("type")
            if block_type == "text":
                parts.append(genai_types.Part.from_text(text=block["text"]))
            elif block_type == "tool_use":
                last_tool_name = block["name"]
                part = genai_types.Part.from_function_call(name=block["name"], args=block["input"])
                if block.get("thought_signature") is not None:
                    part.thought_signature = block["thought_signature"]
                parts.append(part)
            elif block_type == "tool_result":
                payload = {"error": block["content"]} if block.get("is_error") else {"result": block["content"]}
                parts.append(genai_types.Part.from_function_response(name=last_tool_name or "tool", response=payload))
        contents.append(genai_types.Content(role=role, parts=parts))
    return contents


# A Gemini response -> the shared LLMMessage shape.
def _from_gemini_response(response: Any) -> LLMMessage:
    candidate = response.candidates[0] if response.candidates else None
    blocks: list[ToolUseBlock | TextBlock] = []
    parts = candidate.content.parts if candidate and candidate.content and candidate.content.parts else []
    for i, part in enumerate(parts):
        if getattr(part, "function_call", None) is not None:
            blocks.append(ToolUseBlock(
                type="tool_use", id=f"call_{i}", name=part.function_call.name,
                input=dict(part.function_call.args or {}),
                thought_signature=getattr(part, "thought_signature", None),
            ))
        elif getattr(part, "text", None):
            blocks.append(TextBlock(type="text", text=part.text))
    stop_reason = str(candidate.finish_reason) if candidate and candidate.finish_reason else None
    return LLMMessage(content=blocks, stop_reason=stop_reason)


# ****************************************************************************************************
# Structured calls: force one tool, validate its input, retry with the error
# ****************************************************************************************************

# Forces `tool` and returns `validate(input)`. A rejected input is sent back with its error, up to
# max_retries more times. Raises ModelError when there's no result or no valid one.
async def call_structured_tool(
    *,
    client: AsyncAnthropic | genai.Client,
    model: str,
    system: str,
    messages: list[dict[str, Any]],
    tool: dict[str, Any],
    max_tokens: int,
    validate: Callable[[ToolInput], Any],
    label: str,
    max_retries: int = 2,
    thinking_level: str | None = None,
) -> Any:
    tool_name = tool["name"]
    convo: list[dict[str, Any]] = list(messages)
    last_error: Exception | None = None

    for _ in range(max_retries + 1):
        try:
            response = await create_message(
                client,
                model=model,
                max_tokens=max_tokens,
                system=system,
                tools=[tool],
                tool_choice={"type": "tool", "name": tool_name},
                messages=convo,
                thinking_level=thinking_level,
            )
        except Exception as error:
            raise ModelError(f"The {label} call failed: {error}") from error
        tool_use = next((block for block in response.content if block.type == "tool_use"), None)
        if tool_use is None:
            raise ModelError(f"The {label} call returned no result (stop reason: {response.stop_reason}).")
        try:
            return validate(tool_use.input)
        except Exception as error:
            last_error = error
            assistant_block = {"type": "tool_use", "id": tool_use.id, "name": tool_use.name, "input": tool_use.input}
            thought_signature = getattr(tool_use, "thought_signature", None)
            if thought_signature is not None:
                assistant_block["thought_signature"] = thought_signature
            convo = convo + [
                {"role": "assistant", "content": [assistant_block]},
                {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": tool_use.id, "is_error": True,
                     "content": f"That input was rejected: {error}. Call {tool_name} again with corrected input."},
                ]},
            ]

    raise ModelError(f"The {label} call kept returning invalid results ({last_error}).")
