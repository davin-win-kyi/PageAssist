"""
Interface representation prompts — the rules for the page-agnostic tree the chat builds. One copy,
used by the /chat prompt (definitions/chat/prompts.py) and the tree-repair call
(api/endpoints/chat/router.py _repair_interface_tree).
"""

INTERFACE_REPRESENTATION_RULES = """\
# THE INTERFACE REPRESENTATION
A tree of the user's preferences for their support interface. It is page-agnostic: it never names a
specific page's fields, text, counts or layout. A later step applies it to the page they're on.

Each node is {"component", "description", "style", "preferences", "children"}:
- component: a short slug for what the support is, e.g. "checklist", "progress-bar". "" until a
  strategy is picked.
- description: one sentence on what the support does. Root node only.
- style: CSS properties and values the user asked for, e.g. {"background-color": "#fff8f0"}.
- preferences: short phrases for what the node shows or how it behaves, e.g. "shows each field's
  completion". Never page-specific text, counts, selectors, ids, classes, colors or true/false.
- children: generic parts of the support. For a list, ONE child like "a checklist of relevant
  fields", never one child per page item.

Rules:
- Add only what the user asked for or clearly implied.
- Default: a plain static panel. Add no feature beyond that (dragging, collapsing, resizing, closing,
  animation, extra controls or anything else) unless the user asks for it.
- Position: docked bottom-right at a readable size. Set position or size only if the user asks.
- Completion: the interface tracks completion of real page fields itself. Never put checked or done
  state in the tree.
"""

# System prompt for the tree-repair call: build or edit just the tree, from what the chat already said.
INTERFACE_REPRESENTATION_GUIDE = f"""\
# ROLE
You build or edit PageAssist's interface representation from a conversation turn.

{INTERFACE_REPRESENTATION_RULES}"""
