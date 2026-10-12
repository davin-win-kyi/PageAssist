"""
Webpage interface schema
"""

WEBPAGE_INTERFACE_TOOL = {
    "name": "build_webpage_interface",
    "description": "Produce a concrete, code-driven interface widget grounded in a specific webpage's real task representation.",
    "input_schema": {
        "type": "object",
        "properties": {
            "style": {
                "type": "object",
                "description": "CSS for the widget's OUTER frame: position and size only (bottom, right, width, height). {} unless the user asked.",
            },
            "code": {
                "type": "string",
                "description": (
                    "JavaScript that assigns window.render = function (state) { ... }, plus only the plain "
                    "state variables and document/window listeners it needs at top level. Runs in a sandboxed "
                    "iframe with no network (fetch, XMLHttpRequest, WebSocket, window.open and "
                    "navigator.sendBeacon throw). render(state) is re-called on every state change."
                ),
            },
            "state": {
                "type": "object",
                "properties": {
                    "items": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "label": {"type": "string"},
                                "selector": {"type": "string", "description": "GROUNDED item: copied verbatim from a component's dom_selector or member_selectors. Omit on a manual item."},
                                "manual": {"type": "boolean", "description": "True for a MANUAL item (page content with no control); your code owns its done state."},
                                "id": {"type": "string", "description": "MANUAL item: a short unique id, e.g. \"step-3\"; key its done state by it."},
                                "section": {"type": "string", "description": "Optional group name. If your code groups by it, set it on every item."},
                                "detail": {"type": "string", "description": "Optional fuller text for the item, copied from the page (the whole instruction: what to do, where to click, what you'll see). Your code shows it under the label."},
                            },
                            "required": ["label"],
                        },
                        "description": "The widget's items. The host keeps `complete` and `required` live on grounded items.",
                    },
                },
                "description": "Initial data for render(state). Any other keys you add pass through on every later state push.",
            },
        },
        "required": ["style", "code", "state"],
    },
}
