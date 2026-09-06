"""End-to-end backend test.

Run (from repo root):  PYTHONPATH=backend backend/.venv/bin/python tests/backend/full_flow_test.py
"""
import json
import os
import sys
from urllib.parse import quote
from fastapi.testclient import TestClient

import main

c = TestClient(main.app)
FAIL = []

# The real client builds this id then encodeURIComponent()s it into the path.
SITE_RAW = "jobs.example.com~apply?req=42&src=board"
SITE = quote(SITE_RAW, safe="")


def check(name, cond, detail=""):
    mark = "ok  " if cond else "FAIL"
    if not cond:
        FAIL.append(name)
    print(f"  [{mark}] {name}" + (f" — {detail}" if detail and not cond else ""))


PAGE = {
    "url": "https://jobs.example.com/apply?req=42",
    "title": "Apply — Senior Engineer",
    "elements": [
        {"id": "e1", "selector": "h1", "tag": "h1", "text": "Apply for Senior Engineer",
         "role": "heading", "accessibleName": "", "visible": True},
        {"id": "full_name", "selector": "#full_name", "tag": "input", "text": "",
         "role": "textbox", "accessibleName": "Full name", "visible": True},
        {"id": "email", "selector": "#email", "tag": "input", "text": "",
         "role": "textbox", "accessibleName": "Email address", "visible": True},
        {"id": "resume", "selector": "#resume", "tag": "input", "text": "",
         "role": "button", "accessibleName": "Upload resume", "visible": True},
        {"id": "cover", "selector": "#cover_letter", "tag": "textarea", "text": "",
         "role": "textbox", "accessibleName": "Cover letter", "visible": True},
        {"id": "submit", "selector": "#submit", "tag": "button", "text": "Submit application",
         "role": "button", "accessibleName": "", "visible": True},
        {"id": "hidden_field", "selector": "#promo", "tag": "input", "text": "",
         "role": "textbox", "accessibleName": "Promo code", "visible": False},
    ],
    "page_text": "Apply for Senior Engineer\n\nWe are hiring. Fill in your details and submit.",
}

print("\n== 1. health ==")
r = c.get("/health")
check("health 200", r.status_code == 200 and r.json() == {"status": "ok"})

print("\n== 2. analyze (model or fallback) ==")
r = c.post(f"/task-representations/{SITE}/analyze", json=PAGE)
check("analyze 200", r.status_code == 200, r.text[:200])
tr = r.json()
for key in ("page_purpose", "page_type", "tasks", "components", "modeling_notes"):
    check(f"analyze has {key}", key in tr)
check("analyze dropped example_difficulties", "example_difficulties" not in tr)
check("tasks is list", isinstance(tr.get("tasks"), list))
check("components is list", isinstance(tr.get("components"), list))
from api.data.task import task_store as _ts
check("analyze stored page_text for generation", _ts.get("page_text", "").startswith("Apply for Senior Engineer"))

given = {e["selector"] for e in PAGE["elements"]}
comps = tr.get("components", [])
visible_fields = {e["selector"] for e in PAGE["elements"]
                  if e.get("visible") and (e["tag"] in ("input", "textarea", "select") or e.get("role") in ("textbox", "combobox"))}
tracked = {c.get("dom_selector") for c in comps} | {s for c in comps for s in c.get("member_selectors", [])}
print(f"       ({len(tr.get('tasks', []))} tasks, {len(comps)} components; "
      f"{len(visible_fields & tracked)}/{len(visible_fields)} visible fields covered)")
if comps:
    check("component dom_selectors are all real (verbatim)",
          all(c.get("dom_selector") in given for c in comps),
          str([c.get("dom_selector") for c in comps if c.get("dom_selector") not in given]))
    check("every visible form field is covered by some component",
          visible_fields <= tracked, str(sorted(visible_fields - tracked)))
    check("closed enums valid",
          all(c["semantic_role"] and c["importance"] in ("primary", "supporting", "peripheral") for c in comps))

print("\n== 3. GET task representation ==")
r = c.get(f"/task-representations/{SITE}")
check("GET task rep 200 + matches", r.status_code == 200 and r.json()["page_purpose"] == tr["page_purpose"])
check("GET task rep other site 404", c.get("/task-representations/other~site").status_code == 404)

print("\n== 4. interface representation ==")
r = c.post("/interface-representation/reset")
check("reset 200, component blank", r.status_code == 200 and r.json()["tree"]["component"] == "")
check("reset clears agreed", r.json()["agreed"] is False)
r = c.get("/interface-representation")
check("GET interface 200", r.status_code == 200 and "tree" in r.json() and "agreed" in r.json())

print("\n== 5. /chat ==")
r = c.post("/chat", json={"message": "I keep losing track of which fields I've finished", "history": []})
check("chat 200", r.status_code == 200, r.text[:200])
body = r.json()
for key in ("reply", "suggestions", "interface_representation", "agreed", "created_at"):
    check(f"chat has {key}", key in body)
check("chat reply non-empty", isinstance(body.get("reply"), str) and len(body["reply"]) > 0)
check("chat suggestions <= 3", len(body.get("suggestions", [])) <= 3)

print("\n== 6. saved database ==")
r = c.post("/interface-representations", json={"name": "Field checklist"})
check("save 200 + id", r.status_code == 200 and "id" in r.json())
saved_id = r.json()["id"]
r = c.get("/interface-representations")
check("list contains saved", any(e["id"] == saved_id for e in r.json()))
r = c.post(f"/interface-representations/{saved_id}/activate")
check("activate 200 + agreed true", r.status_code == 200 and r.json()["agreed"] is True)
check("activate unknown 404", c.post("/interface-representations/deadbeef/activate").status_code == 404)
tmp_id = c.post("/interface-representations", json={"name": "To delete"}).json()["id"]
check("delete 200", c.delete(f"/interface-representations/{tmp_id}").status_code == 200)
check("deleted entry is gone from the list", all(e["id"] != tmp_id for e in c.get("/interface-representations").json()))
check("delete unknown 404", c.delete("/interface-representations/deadbeef").status_code == 404)

print("\n== 7. generate webpage interface ==")
r = c.post(f"/webpage-interfaces/{SITE}/generate")
check("generate 200", r.status_code == 200, r.text[:300])
w = r.json()
for key in ("style", "code", "state"):
    check(f"widget has {key}", key in w)
check("widget code assigns window.render", "window.render" in w.get("code", ""))
check("widget state.items is list", isinstance(w.get("state", {}).get("items"), list))
w_items = w.get("state", {}).get("items", [])
if w_items:
    given = {e["selector"] for e in PAGE["elements"]}

    def _item_selectors(it):
        return it.get("selectors") if isinstance(it.get("selectors"), list) else [it.get("selector")]

    bad = [s for it in w_items for s in _item_selectors(it) if s not in given]
    check("widget items reference real selectors", not bad, str(bad))
r = c.get(f"/webpage-interfaces/{SITE}")
check("GET webpage interface 200", r.status_code == 200 and "code" in r.json())
check("GET webpage interface other site 404", c.get("/webpage-interfaces/nope~x").status_code == 404)

print("\n== 8. widget not persisted, chat log truncates on new chat ==")
import json as _json
from api.utils.json_store import DATA_DIR
_task_file = _json.loads((DATA_DIR / "task_representations.json").read_text())
check("task_representations.json has no webpage_interface key", "webpage_interface" not in _task_file)
c.post("/chat", json={"message": "hi", "history": []})  # writes a chat_log line
c.post("/interface-representation/reset")               # new chat -> should wipe it
_log = DATA_DIR / "chat_log.jsonl"
check("chat_log.jsonl empty after /reset", not _log.exists() or _log.read_text().strip() == "")

print("\n== 9. enforce_bundled_selectors (model can't be trusted to pick the right single control) ==")
from api.endpoints.webpage_interface.router import enforce_bundled_selectors

_bundle_tr = {"components": [
    {"component_id": "c1", "member_selectors": ["#country", "#phone"]},
    {"component_id": "c2", "member_selectors": ["#email"]},
]}
check("model grounds on the auxiliary control alone -> upgraded to the full bundle",
      enforce_bundled_selectors([{"label": "Phone", "selector": "#country"}], _bundle_tr)
      == [{"label": "Phone", "selectors": ["#country", "#phone"]}])
check("model grounds on the real-answer control alone -> same upgraded result",
      enforce_bundled_selectors([{"label": "Phone", "selector": "#phone"}], _bundle_tr)
      == [{"label": "Phone", "selectors": ["#country", "#phone"]}])
check("model under-selects via `selectors` -> upgraded to the full bundle",
      enforce_bundled_selectors([{"label": "Phone", "selectors": ["#phone"]}], _bundle_tr)
      == [{"label": "Phone", "selectors": ["#country", "#phone"]}])
check("single-control item is left alone",
      enforce_bundled_selectors([{"label": "Email", "selector": "#email"}], _bundle_tr)
      == [{"label": "Email", "selector": "#email"}])
check("manual item is left alone",
      enforce_bundled_selectors([{"label": "Step 1", "manual": True}], _bundle_tr)
      == [{"label": "Step 1", "manual": True}])

# Regression: a plain field's component legitimately bundles its own <label>'s id alongside the
# input's id in member_selectors (id="first_name-label" next to id="first_name" is a near-universal
# aria-labelledby pattern) -- that must NOT be treated as "2 controls that must both be filled",
# since a <label> can never read as filled and would lock the item incomplete forever.
_label_tr = {"components": [
    {"component_id": "c2", "member_selectors": ["#first_name-label", "#first_name"]},
    {"component_id": "c3", "member_selectors": ["#phone-description", "#phone-error", "#phone-help", "#phone"]},
]}
check("a component's own <label> id is not mistaken for a second required control",
      enforce_bundled_selectors([{"label": "First Name", "selector": "#first_name"}], _label_tr)
      == [{"label": "First Name", "selector": "#first_name"}])
check("description/error/help scaffolding ids are not mistaken for required controls either",
      enforce_bundled_selectors([{"label": "Phone", "selector": "#phone"}], _label_tr)
      == [{"label": "Phone", "selector": "#phone"}])

print("\n== RESULT ==")
if FAIL:
    print(f"  {len(FAIL)} FAILED: {FAIL}")
    sys.exit(1)
print("  all passed")
