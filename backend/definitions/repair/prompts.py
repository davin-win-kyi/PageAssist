"""
The prompt for the tree repair, used when a chat turn says the interface changed but sends no tree
"""

from definitions.interface_representation.prompts import INTERFACE_REPRESENTATION_RULES

INTERFACE_TREE_REPAIR_GUIDE = f"""\
# ROLE
You build or edit PageAssist's interface representation from one turn of a conversation: what the
user said, and what the assistant already told them it would do.

{INTERFACE_REPRESENTATION_RULES}"""
