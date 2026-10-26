"""
The schemas for the interface representation
- the tree's JSON schema, which the chat and tree repair tools answer with
- the request schemas for the working tree and the saved database
"""
from pydantic import BaseModel


# ****************************************************************************************************
# The tree
# ****************************************************************************************************

# The fields every node of the tree has, so the model fills each part instead of leaving it empty
NODE_PROPERTIES = {
    "component": {"type": "string", "description": "Short slug naming what this support, or this part of it, is."},
    "description": {"type": "string", "description": "What it does and how it helps, in plain sentences. Root node only; \"\" on parts."},
    "style": {"type": "object", "description": "CSS properties and values the user asked for; {} if none."},
    "preferences": {"type": "array", "items": {"type": "string"}, "description": "Short phrases for what it shows or how it behaves. Never page-specific."},
}

# One generic part of the support, which may have parts of its own
PART_SCHEMA = {
    "type": "object",
    "properties": {
        **NODE_PROPERTIES,
        "children": {"type": "array", "items": {"type": "object", "properties": NODE_PROPERTIES, "required": ["component", "preferences"]}},
    },
    "required": ["component", "preferences"],
}

# The whole tree: the support, and its generic parts in children ([] when it has none)
TREE_SCHEMA = {
    "type": "object",
    "properties": {
        **NODE_PROPERTIES,
        "children": {"type": "array", "items": PART_SCHEMA, "description": "Generic parts of the support; [] when it has none. Never one per page item."},
    },
    "required": ["component", "description", "preferences", "children"],
}


# ****************************************************************************************************
# Requests
# ****************************************************************************************************


class SaveInterfaceRepresentationRequest(BaseModel):
    """Body of POST /interface-representations: the name for a new saved copy of the working tree, and
    the interface showing when it was saved, which the study records file the save with."""

    name: str
    record_id: str | None = None


class UpdateInterfaceRepresentationRequest(BaseModel):
    """Optional body of POST /interface-representations/{id}/update: the interface showing when the
    saved entry was updated, which the study records file the update with."""

    record_id: str | None = None
