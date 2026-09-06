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
    agreed: bool = False
    offer_save: bool = False
    suggested_name: str = ""


CHAT_DECISION_TOOL = {
    "name": "respond_and_update_interface",
    "description": "Reply to the user and report whether/how the interface representation should change.",
    "input_schema": {
        "type": "object",
        "properties": {
            "reply": {"type": "string", "description": "The concise, precise reply to show the user."},
            "suggestions": {
                "type": "array",
                "items": {"type": "string"},
                "maxItems": 3,
                "description": "At most 3 quick-reply chips, each 1-4 words (e.g. \"Checklist\", \"Progress bar\", \"Both\"). Never full sentences.",
            },
            "interface_representation": {
                "type": ["object", "null"],
                "description": (
                    "The full updated {component, description, style, preferences, children} tree, ONLY "
                    "when this reply actually changes it; null otherwise — including a turn that merely "
                    "confirms it ('looks good', 'yes, save that'). Non-null re-triggers showing the widget "
                    "on the page, so resending an unchanged tree makes that happen for no reason. Not tied "
                    "to `agreed`, which stays true across many later turns this must stay null on. "
                    "\"preferences\" is short phrases (never literal instance text — the representation is "
                    "structure-independent). \"description\" is one sentence on what this support is and "
                    "does (useful when \"component\" is a bespoke name). \"children\" are structural "
                    "groupings generic to the kind of task (e.g. \"a section for the first person\"), never "
                    "concrete real-page items."
                ),
            },
            "agreed": {
                "type": "boolean",
                "description": "True only on the turn the user has just confirmed a specific concrete support concept.",
            },
            "offer_save": {
                "type": "boolean",
                "description": (
                    "True when the concept is agreed and has been stable for a turn or two (or the user said it "
                    "looks good) — the client shows a one-click Save affordance. Keep false otherwise, and once "
                    "the user has saved or declined."
                ),
            },
            "suggested_name": {
                "type": "string",
                "description": (
                    "A short, human-readable name for this support concept — 2-5 words describing what it is "
                    "and does, e.g. \"Field completion checklist\", \"Two-person section tracker\", \"Next-step "
                    "prompt\". Set it on every turn where offer_save is true; leave \"\" otherwise. Not a "
                    "generic label like \"Interface 1\"."
                ),
            },
        },
        "required": ["reply", "suggestions", "agreed"],
    },
}
