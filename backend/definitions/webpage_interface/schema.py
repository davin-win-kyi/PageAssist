"""The build_webpage_interface tool input_schema."""
WEBPAGE_INTERFACE_TOOL = {
    "name": "build_webpage_interface",
    "description": "Produce a concrete, code-driven interface widget grounded in a specific webpage's real task representation.",
    "input_schema": {
        "type": "object",
        "properties": {
            "style": {
                "type": "object",
                "description": (
                    "Real CSS for the widget's OUTER frame — position and size only (bottom, right, width, "
                    "height), applied by the host to the frame. The widget's own look lives in your code; "
                    "never put look-and-feel properties here."
                ),
            },
            "code": {
                "type": "string",
                "description": (
                    "JavaScript that assigns window.render = function(state) { ... } and nothing else at the "
                    "top level. Runs in a locked-down sandboxed iframe: no access to the real page, cookies, "
                    "storage, or network (fetch/XMLHttpRequest/WebSocket/window.open/navigator.sendBeacon all "
                    "throw). Build the widget's DOM inside document.body with ordinary APIs. render(state) is "
                    "re-called on every state change, so it must be idempotent — reset document.body and its "
                    "inline style at the start of each call."
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
                                "selector": {"type": "string", "description": "GROUNDED item: copied verbatim from a component's dom_selector or member_selectors — never invented. Omit for a manual item."},
                                "label": {"type": "string"},
                                "manual": {"type": "boolean", "description": "True for a page-CONTENT item (a recipe step, a section) with no DOM done-state — the user toggles it and YOUR code owns its checked state; the host leaves `complete` alone. Omit/false for a grounded item."},
                            },
                            "required": ["label"],
                        },
                        "description": (
                            "The widget's checklist. GROUNDED items have a `selector` and the host keeps their live "
                            "\"complete\" flag in sync (filled field / clicked button); MANUAL items have `manual: true`, "
                            "no selector, and the user toggles them. Your code shows each item's state but only "
                            "computes it for manual ones."
                        ),
                    },
                },
                "description": "Initial data for render(state). \"items\" is host-managed; add any other keys your code needs — they pass through on every later state push.",
            },
        },
        "required": ["style", "code", "state"],
    },
}
