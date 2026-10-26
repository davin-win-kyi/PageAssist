"""
The tool for the tree repair
- Gemini sometimes says a chat turn changed the interface but sends no tree, and retrying the same
  call doesn't fix it, while asking for only the tree does
"""

from definitions.interface_representation.schema import TREE_SCHEMA

INTERFACE_TREE_TOOL = {
    "name": "build_interface_representation",
    "description": "Return the full interface representation: the page-agnostic tree of the user's preferences for their support interface.",
    "input_schema": TREE_SCHEMA,
}
