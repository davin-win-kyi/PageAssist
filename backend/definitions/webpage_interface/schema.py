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
                                "selector": {"type": "string", "description": "GROUNDED, single-control item: copied verbatim from a component's dom_selector or member_selectors — never invented. Omit for a manual item, or when using `selectors` instead."},
                                "selectors": {"type": "array", "items": {"type": "string"}, "description": "Use INSTEAD OF `selector` when this ONE item tracks a question that needs MORE THAN ONE control filled in to be answered — first + last name, a full street/city/state/zip address. List every control, each copied verbatim from the component's member_selectors. The host requires ALL of them to be filled/chosen before the item counts as complete. Picking just one of several required controls (via `selector`) is wrong here — it reads as done the moment the FIRST one fills, while the rest are still empty."},
                                "label": {"type": "string"},
                                "manual": {"type": "boolean", "description": "True for a page-CONTENT item (a recipe step, a section) with no DOM done-state — the user toggles it and YOUR code owns its checked state; the host leaves `complete` alone. Omit/false for a grounded item."},
                            },
                            "required": ["label"],
                        },
                        "description": (
                            "The widget's checklist. GROUNDED items have `selector` (one control) or `selectors` "
                            "(multiple controls that must ALL be filled) and the host keeps their live \"complete\" "
                            "flag in sync; MANUAL items have `manual: true`, no selector(s), and the user toggles "
                            "them. Your code shows each item's state but only computes it for manual ones."
                        ),
                    },
                },
                "description": "Initial data for render(state). \"items\" is host-managed; add any other keys your code needs — they pass through on every later state push.",
            },
        },
        "required": ["style", "code", "state"],
    },
}
