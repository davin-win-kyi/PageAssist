"""
The rules for the interface representation, the page-agnostic tree the chat builds
- shared by the chat prompt (definitions/chat) and the tree repair prompt (definitions/repair)
"""

INTERFACE_REPRESENTATION_RULES = """\
# THE INTERFACE REPRESENTATION
A tree of the user's preferences for their support interface. It is page-agnostic: it never names a
specific page's fields, text, counts or layout. A later step applies it to the page they're on.

Each node is {"component", "description", "style", "preferences", "children"}:
- component: a short slug naming what the support is. "" until a strategy is picked.
- description: what the support does and how it helps, in plain sentences. Root node only.
- style: CSS properties and values the user asked for.
- preferences: short phrases for what the node shows or how it behaves. Never page-specific text,
  counts, selectors, ids, classes, colors or true/false. They are reused on other kinds of pages, so
  name the parts of the user's task in general terms rather than one kind of page's own terms.
- children: generic parts of the support. Items from the page are never children: a list of them is
  one generic child, whatever the page holds.

Rules:
- Add only what the user asked for or clearly implied.
- Default: a plain static panel. Add no feature beyond that unless the user asks for it.
- Position: docked bottom-right at a readable size. Set position or size only if the user asks.
- Completion: the interface tracks completion of real page fields itself. Never put checked or done
  state in the tree.
"""
