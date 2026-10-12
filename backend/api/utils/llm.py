"""Model-provider plumbing. Switch providers for every generative call in the backend with one env
var — `LLM_PROVIDER=anthropic` (default) or `LLM_PROVIDER=gemini` — no changes needed at any call site.

Every caller in api/endpoints/ only ever touches:
  - get_client_and_model() / get_fast_client_and_model() -> (client, model) | (None, None)
  - create_message(client, model=..., max_tokens=..., system=..., messages=..., tools=..., tool_choice=...)
  - call_structured_tool(...)  (forced tool call + validate/retry loop, built on create_message)

Either one takes an optional `thinking_level` ("low" / "medium" / "high") for that one call. Only
Gemini uses it; the Anthropic branch drops it.

Anthropic's native `Message` already has the shape every caller reads (`.content` blocks with `.type`,
and `.id`/`.name`/`.input` on `tool_use` ones, plus `.stop_reason`), so the Anthropic branch returns it
untouched. The Gemini branch translates to/from that same shape so the rest of the codebase never has
to know which provider answered.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable
import os

from anthropic import AsyncAnthropic
from google import genai
from google.genai import types as genai_types

ToolInput = dict[str, Any]

PROVIDER = (os.getenv("LLM_PROVIDER") or "anthropic").strip().lower()
DEFAULT_THINKING_LEVEL = "medium"  # Gemini only — see _gemini_create_message


# --- Client/model lookup, per provider --------------------------------------------------------

def _anthropic_client_and_model(model: str | None) -> tuple[AsyncAnthropic | None, str | None]:
    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key or not model:
        return None, None
    return AsyncAnthropic(api_key=api_key), model


def _gemini_client_and_model(model: str | None) -> tuple[genai.Client | None, str | None]:
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key or not model:
        return None, None
    return genai.Client(api_key=api_key), model


def get_client_and_model() -> tuple[AsyncAnthropic | genai.Client | None, str | None]:
    if PROVIDER == "gemini":
        return _gemini_client_and_model(os.getenv("GEMINI_MODEL"))
    return _anthropic_client_and_model(os.getenv("ANTHROPIC_MODEL"))


def get_fast_client_and_model() -> tuple[AsyncAnthropic | genai.Client | None, str | None]:
    """A smaller/faster model for cheap incremental work (e.g. patching a task representation with one
    newly-revealed field). Falls back to the main model when the FAST variant isn't set."""
    if PROVIDER == "gemini":
        return _gemini_client_and_model(os.getenv("GEMINI_MODEL_FAST") or os.getenv("GEMINI_MODEL"))
    return _anthropic_client_and_model(os.getenv("ANTHROPIC_MODEL_FAST") or os.getenv("ANTHROPIC_MODEL"))


# --- Unified response shape (only the Gemini branch needs to build one) -----------------------

@dataclass
class ToolUseBlock:
    type: str
    id: str
    name: str
    input: dict[str, Any]
    # Gemini 3 ties a function call to the model's internal reasoning state and rejects (400) any
    # later turn that replays the call without echoing this back — same idea as Claude's thinking
    # blocks needing to be sent back unchanged. Always None on the Anthropic branch's native blocks
    # (plain SDK objects with no such attribute); getattr(..., None) at every read site handles that.
    thought_signature: bytes | None = None


@dataclass
class TextBlock:
    type: str
    text: str


@dataclass
class LLMMessage:
    content: list[ToolUseBlock | TextBlock]
    stop_reason: str | None = None


# --- create_message: dispatches on the client's provider --------------------------------------

async def create_message(client: AsyncAnthropic | genai.Client, **kwargs: Any):
    """messages.create via the streaming API (Anthropic) or generate_content (Gemini), returning an
    object with `.content` (blocks with `.type`, `.id`/`.name`/`.input` for tool_use) and
    `.stop_reason` — the same shape regardless of provider."""
    if isinstance(client, AsyncAnthropic):
        kwargs.pop("thinking_level", None)
        async with client.messages.stream(**kwargs) as stream:
            return await stream.get_final_message()
    return await _gemini_create_message(client, **kwargs)


async def _gemini_create_message(
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
                parameters_json_schema=tool["input_schema"],  # raw JSON Schema — no lossy conversion
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
            # Gemini 3 defaults to thinking_level="high" when unset. Measured on a real Greenhouse form
            # (median of 3): high took 293s to build the task representation (over the panel's 240s
            # timeout every time) and 156s to build the widget, vs. 52s / 71s at "medium", with no
            # coverage gain — so "medium" is the default, and a caller can ask for less per call.
            thinking_config=genai_types.ThinkingConfig(thinking_level=thinking_level or DEFAULT_THINKING_LEVEL),
        ),
    )
    return _from_gemini_response(response)


# --- Translation: our Anthropic-shaped `messages` list <-> Gemini Content/Part ----------------
# Every call site in this repo already builds `messages` as plain strings or Anthropic tool_use /
# tool_result blocks (see call_structured_tool's retry loop below) — that shape is this module's
# internal lingua franca, not something tied to the Anthropic SDK, so the Gemini branch just has to
# translate it both ways.

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


# --- Forced tool call + validate/retry loop — provider-agnostic -------------------------------

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
        tool_use = next((block for block in response.content if block.type == "tool_use"), None)
        if tool_use is None:
            print(f"{label}: no tool_use block (stop_reason={response.stop_reason}); using fallback.")
            return None
        try:
            return validate(tool_use.input)
        except Exception as error:  # bad enum literal, missing field, wrong shape, ...
            last_error = error
            assistant_block = {"type": "tool_use", "id": tool_use.id, "name": tool_use.name, "input": tool_use.input}
            thought_signature = getattr(tool_use, "thought_signature", None)  # Gemini only — see ToolUseBlock
            if thought_signature is not None:
                assistant_block["thought_signature"] = thought_signature
            convo = convo + [
                {"role": "assistant", "content": [assistant_block]},
                {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": tool_use.id, "is_error": True,
                     "content": f"That input was rejected: {error}. Call {tool_name} again with corrected input."},
                ]},
            ]

    print(f"{label}: tool input still invalid after {max_retries} retries ({last_error}); using fallback.")
    return None
