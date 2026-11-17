"""
The schema for the webpage interface: the build_webpage_interface tool
"""

WEBPAGE_INTERFACE_TOOL = {
    "name": "build_webpage_interface",
    "description": (
        "Build a widget that realizes the user's interface representation (their page-agnostic preferences for "
        "their support) on one webpage, grounded in that page's task representation."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "task_ids": {
                "type": "array",
                "items": {"type": "string"},
                "description": (
                    "The task_id of each task the widget serves, picked in PROCESS step 2. A question that "
                    "appears on the page later joins the widget only when it's part of one of these."
                ),
            },
            "style": {
                "type": "object",
                "description": "CSS for the widget's OUTER frame, its position and size only. {} unless the user asked.",
            },
            "code": {
                "type": "string",
                "description": (
                    "JavaScript that assigns window.render = function (state) { ... }, plus only the plain "
                    "state variables and document/window listeners it needs at top level. It runs in a sandboxed "
                    "iframe with no network access, and render(state) is called again on every state change."
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
                                "id": {"type": "string", "description": "MANUAL item: a short unique id; key its done state by it."},
                                "section": {"type": "string", "description": "Optional group name. If your code groups by it, set it on every item."},
                                "detail": {"type": "string", "description": "Optional fuller text for the item, copied from the page. Your code shows it under the label."},
                            },
                            "required": ["label"],
                        },
                        "description": "The widget's items. The host keeps `complete` and `required` live on grounded items.",
                    },
                },
                "description": "Initial data for render(state). Any other keys you add pass through on every later state push.",
            },
        },
        "required": ["task_ids", "style", "code", "state"],
    },
}
