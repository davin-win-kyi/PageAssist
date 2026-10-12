"""/chat wire shapes + the respond_and_update_interface tool input_schema."""
from typing import Any, Literal

from pydantic import BaseModel


class ChatMessage(BaseModel):
    """One prior turn of the conversation, as replayed to the model. Sent by the client."""

    role: Literal["user", "assistant"]
    content: str


class ChatRequest(BaseModel):
    """The body of POST /chat: the user's new message plus the conversation so far."""

    message: str
    history: list[ChatMessage] = []


class ChatDecision(BaseModel):
    """Validates the model's `respond_and_update_interface` tool call. It carries the reply to show
    plus three decisions: replace the interface representation, latch it as agreed, offer to save it."""

    reply: str
    suggestions: list[str] = []
    interface_representation: dict[str, Any] | None = None
    tree_needs_update: bool = False
    agreed: bool = False
    offer_save: bool = False
    suggested_name: str = ""


CHAT_DECISION_TOOL = {
    "name": "respond_and_update_interface",
    "description": "Reply to the user and report whether the interface representation changed.",
    "input_schema": {
        "type": "object",
        "properties": {
            "reply": {"type": "string", "description": "What the user sees: at most 2-3 short sentences."},
            "suggestions": {
                "type": "array", "items": {"type": "string"}, "maxItems": 3,
                "description": "Up to 3 quick replies, 1-4 words each, e.g. \"Checklist\", \"Progress bar\".",
            },
            "interface_representation": {
                "type": ["object", "null"],
                "description": "The full {component, description, style, preferences, children} tree on a turn that changes it; null on every other turn.",
            },
            "tree_needs_update": {
                "type": "boolean",
                "description": "True when `reply` says or implies the tree changed, including the turn a strategy is picked; false otherwise.",
            },
            "agreed": {
                "type": "boolean",
                "description": "True once the user has settled on a strategy; false while they're still describing or choosing. Stays true once set.",
            },
            "offer_save": {"type": "boolean", "description": "True only on the turn you offer to save the interface."},
            "suggested_name": {
                "type": "string",
                "description": "2-5 words naming what the support does, e.g. \"Field completion checklist\", when offer_save is true; \"\" otherwise.",
            },
        },
        "required": ["reply", "suggestions", "agreed", "tree_needs_update"],
    },
}


# Repair-path tool (see chat/router.py's _repair_interface_tree): used only when the main call above
# says the tree changed (`tree_needs_update`) but sends no tree — observed live and reproducibly on
# Gemini, which does NOT self-correct when the same combined call is retried. Asking for ONLY the
# tree, split out of the reply/suggestions/agreed schema, reliably fills it. Its rules are
# INTERFACE_REPRESENTATION_GUIDE (definitions/interface_representation/prompts.py).
INTERFACE_TREE_TOOL = {
    "name": "build_interface_representation",
    "description": "Return the full interface representation tree.",
    "input_schema": {
        "type": "object",
        "properties": {
            "component": {"type": "string", "description": "Short slug for what the support is, e.g. \"checklist\"."},
            "description": {"type": "string", "description": "One sentence on what the support does."},
            "style": {"type": "object", "description": "CSS properties and values the user asked for."},
            "preferences": {
                "type": "array", "items": {"type": "string"},
                "description": "Short phrases for what the node shows or how it behaves. Never page-specific.",
            },
            "children": {
                "type": "array", "items": {"type": "object"},
                "description": "Generic parts of the support, each a node of this same shape. Never one per page item.",
            },
        },
        "required": ["component", "description", "preferences"],
    },
}
