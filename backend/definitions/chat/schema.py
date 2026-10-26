"""
The schemas for the chat: its request, the model's decision for a turn, and the
reply_and_update_preferences tool
"""

from typing import Any, Literal

from pydantic import BaseModel

from definitions.interface_representation.schema import TREE_SCHEMA


class ChatMessage(BaseModel):
    """One earlier turn of the conversation, sent by the panel."""

    role: Literal["user", "assistant"]
    content: str


class ChatRequest(BaseModel):
    """Body of POST /chat: the user's new message and the conversation so far."""

    message: str
    history: list[ChatMessage] = []


class ChatDecision(BaseModel):
    """The model's answer for one turn: the reply, plus what it changed about the interface."""

    reply: str
    suggestions: list[str] = []
    interface_representation: dict[str, Any] | None = None
    tree_needs_update: bool = False
    agreed: bool = False
    offer_save: bool = False
    suggested_name: str = ""


REPLY_AND_UPDATE_PREFERENCES_TOOL = {
    "name": "reply_and_update_preferences",
    "description": (
        "Answer one turn of the PageAssist side panel chat. There the user describes something that's difficult "
        "about a task on a webpage, or a support they already have in mind; you confirm your understanding, offer "
        "support strategies, and shape the one they pick. Returns the reply and quick replies shown in the panel, "
        "plus any change to the user's preferences: the interface representation, which is applied to the page "
        "they're on and can be saved to reuse on other sites. Also returns whether they've settled on a strategy, "
        "and whether to offer saving it."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "reply": {"type": "string", "description": "What the user sees in the chat: 1-3 short sentences."},
            "suggestions": {
                "type": "array", "items": {"type": "string"}, "maxItems": 3,
                "description": "Up to 3 quick replies shown under the reply, 1-4 words each.",
            },
            "interface_representation": {
                **TREE_SCHEMA,
                "type": ["object", "null"],
                "description": "The full tree on a turn that changes it; null on every other turn.",
            },
            "tree_needs_update": {
                "type": "boolean",
                "description": "True when `reply` says or implies the tree changed, including the turn a strategy is picked; false otherwise.",
            },
            "agreed": {
                "type": "boolean",
                "description": "True once the user has settled on a strategy; false while they're still describing or choosing. Stays true once set.",
            },
            "offer_save": {
                "type": "boolean",
                "description": (
                    "True only on the turn you offer to save the interface for reuse on other sites. The panel then shows a "
                    "save option with suggested_name filled in. The user can keep it, or replace it with their own name or "
                    "description, which can be longer."
                ),
            },
            "suggested_name": {
                "type": "string",
                "description": "A short name for what the support does, when offer_save is true; \"\" otherwise.",
            },
        },
        "required": ["reply", "suggestions", "agreed", "tree_needs_update"],
    },
}
