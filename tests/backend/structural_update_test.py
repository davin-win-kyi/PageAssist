"""Does a structural page change actually flow into a regenerated webpage interface?

Scenario (real Greenhouse / Snorkel AI page, job 5709067004):
  1. user is on the application form; a widget is showing
  2. user answers "Are you Hispanic/Latino?"  -> the page reveals a NEW follow-up field
  3. the panel re-analyzes (POST /analyze) then regenerates (POST /generate)
  -> the regenerated widget MUST now include the new field

This exercises the backend half of App.tsx's processStructuralChange: /analyze must REPLACE the
stored task representation, and /generate must read that fresh copy (not a cached one).

Run (from repo root):  PYTHONPATH=backend backend/.venv/bin/python tests/backend/structural_update_test.py
Needs a configured model in backend/.env; without one the calls return an error.
"""
import os
import sys
import tempfile
from urllib.parse import quote
from fastapi.testclient import TestClient

# A throwaway data dir, so analyzing/patching here never overwrites a real session's backend/data.
os.environ["PAGEASSIST_DATA_DIR"] = tempfile.mkdtemp(prefix="pageassist-test-")
import main

c = TestClient(main.app)
FAIL = []


def check(name, cond, detail=""):
    if not cond:
        FAIL.append(name)
    print(f"  [{'ok  ' if cond else 'FAIL'}] {name}" + (f" — {detail}" if detail and not cond else ""))


SITE_RAW = "job-boards.greenhouse.io~snorkelai~jobs~5709067004?gh_src=Simplify"
SITE = quote(SITE_RAW, safe="")
URL = "https://job-boards.greenhouse.io/snorkelai/jobs/5709067004?gh_src=Simplify"


def field(fid, name, tag="input", role="textbox", text="", visible=True):
    return {"id": fid, "selector": f"#{fid}", "tag": tag, "text": text,
            "role": role, "accessibleName": name, "visible": visible}


# Identity + EEO section as it renders on first load (real field ids from the live page).
BEFORE = [
    {"id": "h1", "selector": "h1", "tag": "h1", "text": "Applied AI Engineer", "role": "heading",
     "accessibleName": "", "visible": True},
    field("first_name", "First Name"),
    field("last_name", "Last Name"),
    field("email", "Email"),
    field("phone", "Phone"),
    field("country", "Country", role="combobox"),
    field("gender", "Gender", role="combobox"),
    field("hispanic_ethnicity", "Are you Hispanic/Latino?", role="combobox"),
    field("veteran_status", "Veteran Status", role="combobox"),
    field("disability_status", "Disability Status", role="combobox"),
]

# After the user answers "Are you Hispanic/Latino?": that field now carries a value, AND the page
# has revealed a NEW follow-up field (#race) with its own label.
NEW_FIELD = "#race"
AFTER = [
    dict(e, text="Not Hispanic or Latino", accessibleName="Are you Hispanic/Latino?")
    if e["selector"] == "#hispanic_ethnicity" else e
    for e in BEFORE
] + [
    {"id": "race-label", "selector": "#race-label", "tag": "label",
     "text": "Please identify your race/ethnicity", "role": "", "accessibleName": "", "visible": True},
    field("race", "Please identify your race/ethnicity", role="combobox"),
]


def analyze(elements):
    r = c.post(f"/task-representations/{SITE}/analyze",
               json={"url": URL, "title": "Applied AI Engineer — Snorkel AI", "elements": elements})
    assert r.status_code == 200, r.text[:300]
    return r.json()


def generate():
    r = c.post(f"/webpage-interfaces/{SITE}/generate")
    assert r.status_code == 200, r.text[:300]
    return r.json()


def tracked_selectors(task_rep):
    sels = set()
    for comp in task_rep.get("components", []):
        if isinstance(comp.get("dom_selector"), str):
            sels.add(comp["dom_selector"])
        sels.update(s for s in comp.get("member_selectors", []) if isinstance(s, str))
    return sels


def item_selectors(widget):
    # An item tracks either one control (`selector`) or several that must ALL be filled to answer
    # one question (`selectors` — first+last name, a split address); flatten both to a flat list so
    # a membership check ("is #race tracked by some item") doesn't miss a bundled item's selectors.
    out = []
    for it in widget.get("state", {}).get("items", []):
        if isinstance(it.get("selectors"), list):
            out.extend(s for s in it["selectors"] if isinstance(s, str))
        elif isinstance(it.get("selector"), str):
            out.append(it["selector"])
    return out


print("== setup: activate a saved checklist so there's an agreed active tree ==")
c.post("/interface-representation/reset")
saved = c.get("/interface-representations").json()
if saved:
    c.post(f"/interface-representations/{saved[0]['id']}/activate")
    print(f"  activated {saved[0]['name']!r}")
else:
    print("  (no saved interfaces — generating against the blank tree)")

print("\n== 1. before the change: analyze + generate ==")
tr_before = analyze(BEFORE)
w_before = generate()
before_tracked = tracked_selectors(tr_before)
before_items = item_selectors(w_before)
print(f"  task rep: {len(tr_before.get('components', []))} components   widget: {len(before_items)} items")
check("new field NOT tracked before it exists", NEW_FIELD not in before_tracked)
check("new field NOT in widget before it exists", NEW_FIELD not in before_items)
check("hispanic_ethnicity IS tracked before", "#hispanic_ethnicity" in before_tracked)

print("\n== 2. user answers 'Are you Hispanic/Latino?' -> #race is revealed -> re-analyze + regenerate ==")
tr_after = analyze(AFTER)
w_after = generate()
after_tracked = tracked_selectors(tr_after)
after_items = item_selectors(w_after)
print(f"  task rep: {len(tr_after.get('components', []))} components   widget: {len(after_items)} items")
print(f"  widget items now: {after_items}")

check("re-analyze REPLACED the stored task representation (GET returns the new one)",
      "#race" in tracked_selectors(c.get(f"/task-representations/{SITE}").json()))
check("the revealed #race field is now tracked in the task representation", NEW_FIELD in after_tracked)
check("the revealed #race field is now in the regenerated widget's items", NEW_FIELD in after_items)
check("the widget actually changed (item set is not identical)", set(before_items) != set(after_items))
check("previously-tracked fields survived the regen (first_name still present)",
      "#first_name" in after_items or "#first_name" in after_tracked)

print("\n== 3. FAST PATH: /patch splices in the revealed field without a full re-analyze ==")
analyze(BEFORE)                                  # reset to the pre-reveal state
tr0 = c.get(f"/task-representations/{SITE}").json()
r = c.post(f"/task-representations/{SITE}/patch", json={
    "added": [{"id": "race", "selector": "#race", "tag": "input", "text": "",
               "role": "combobox", "accessibleName": "Please identify your race/ethnicity", "visible": True}],
    "removed": [],
})
check("patch 200", r.status_code == 200, r.text[:300])
tr_patched = r.json()
patched_tracked = tracked_selectors(tr_patched)
check("patch added #race to the task representation", "#race" in patched_tracked)
check("patch kept every pre-existing component",
      tracked_selectors(tr0) - {NEW_FIELD} <= patched_tracked)
check("patch linked #race to a task",
      any("#race" in {comp.get("dom_selector"), *comp.get("member_selectors", [])}
          and comp.get("component_id") in {cid for t in tr_patched.get("tasks", []) for cid in t.get("component_ids", [])}
          for comp in tr_patched.get("components", [])))
check("GET reflects the patched representation", "#race" in tracked_selectors(c.get(f"/task-representations/{SITE}").json()))
# The panel splices these into the widget already on the page instead of regenerating it.
check("patch returns the new question as a widget item (added_items)",
      any("#race" in ([it.get("selector")] + (it.get("selectors") or [])) for it in tr_patched.get("added_items", [])),
      str(tr_patched.get("added_items")))
w_patched = generate()
check("regenerated widget from the patched rep includes #race", "#race" in item_selectors(w_patched))
r = c.post(f"/task-representations/{SITE}/patch", json={"added": [], "removed": ["#race"]})
check("patch removes a departed field", "#race" not in tracked_selectors(r.json()))
check("patch 404 for an un-analyzed site", c.post("/task-representations/never~seen/patch", json={"added": [], "removed": []}).status_code == 404)

n_before_cosmetic = len(c.get(f"/task-representations/{SITE}").json()["components"])
r = c.post(f"/task-representations/{SITE}/patch", json={
    "added": [], "removed": [".upload-btn-attach", ".upload-btn-dropbox"],  # a file-upload UI swap —
    # these were never modelled as their own components, so removing them shouldn't register as a
    # real task-representation change (App.tsx skips /generate + the "detected a change" line on this).
})
check("cosmetic-only removal reports changed=false", r.json().get("changed") is False)
check("cosmetic-only removal has no widget items to splice in", r.json().get("added_items") == [])
check("cosmetic-only removal leaves components untouched",
      len(r.json()["components"]) == n_before_cosmetic)

print("\n== 4. long form: a field revealed LATE must not be truncated out of the widget ==")
# The real page has ~26 fields, and #race is appended after all of them — the 28th control here.
padded_before = BEFORE + [field(f"question_{i}", f"Screening question {i}") for i in range(18)]
padded_after = padded_before + [field("race", "Please identify your race/ethnicity", role="combobox")]
analyze(padded_before)
generate()
analyze(padded_after)
w_padded = generate()
padded_items = item_selectors(w_padded)
print(f"  padded widget: {len(padded_items)} items; #race present: {'#race' in padded_items}")
check("the newly revealed 28th control is in the widget on a long form", "#race" in padded_items)

print("\n== 5. a REVEALED question (in the DOM all along, hidden, now visible) ==")
# content.ts sends these grouped per question; the backend adds one only if nothing of it is mapped.
analyze(BEFORE)
race = {"id": "race", "selector": "#race", "tag": "input", "text": "", "role": "combobox",
        "accessibleName": "Please identify your race/ethnicity", "visible": True}
r = c.post(f"/task-representations/{SITE}/patch", json={"revealed": [[race]]})
check("revealed + not yet mapped -> added, changed=true",
      "#race" in tracked_selectors(r.json()) and r.json().get("changed") is True, r.text[:300])
n_mapped = len(r.json()["components"])
r = c.post(f"/task-representations/{SITE}/patch", json={"revealed": [[race]]})
check("revealed + already mapped -> availability only: no duplicate component, changed=false",
      r.json().get("changed") is False and len(r.json()["components"]) == n_mapped, r.text[:300])

vet = [{"id": f"vet-{v}", "selector": f"#vet-{v}", "tag": "input", "text": "", "role": "radio",
        "accessibleName": v.capitalize(), "visible": True} for v in ("yes", "no", "decline")]
# The group is mapped via ONE option — put straight into the stored representation, not via a patch:
# whether the model models a lone, unlabelled "Yes" radio is its judgment call, and this check is about
# the deterministic already-mapped rule (unmapped_revealed), not that call.
from api.state.task import task_store, replace_task_store
_rep = c.get(f"/task-representations/{SITE}").json()
_rep["components"].append({"component_id": "c900", "component_type": "single-choice-question",
                           "label": "Veteran status", "description": "", "dom_selector": "#vet-yes", "member_selectors": ["#vet-yes"],
                           "associated_task_ids": []})
replace_task_store(task_store["site_id"], _rep, task_store.get("page_text", ""))
n_mapped = len(_rep["components"])
r = c.post(f"/task-representations/{SITE}/patch", json={"revealed": [vet]})
check("a revealed radio group with ANY option already mapped adds nothing (no lone-option component)",
      r.json().get("changed") is False and len(r.json()["components"]) == n_mapped, r.text[:300])

print("\n== 6. context containers flow through analyze and patch ==")
eeo = {"selector": "#eeo", "tag": "section", "role": "", "label": "Voluntary self-identification", "parent": ""}
r = c.post(f"/task-representations/{SITE}/analyze", json={
    "url": URL, "title": "Applied AI Engineer — Snorkel AI",
    "elements": [dict(e, container="#eeo") for e in BEFORE], "containers": [eeo]})
check("analyze accepts elements with container/description/completion_status + a containers list", r.status_code == 200, r.text[:300])
r = c.post(f"/task-representations/{SITE}/patch", json={"added": [dict(race, container="#eeo")], "containers": [eeo]})
check("patch accepts the containers its added elements sit in", r.status_code == 200, r.text[:300])

print("\n== 7. a question outside the widget's tasks leaves the widget as it is ==")
# A page change is judged against the tasks the widget showing serves, which it names when it's built.
# A newsletter signup appearing on the application serves none of them: it's kept in the task
# representation, with nothing to splice in and nothing to rebuild. A follow-up question still joins.
analyze(BEFORE)
w = generate()
known = {t["task_id"] for t in c.get(f"/task-representations/{SITE}").json().get("tasks", [])}
check("the widget names the tasks it serves, all of them the page's",
      bool(w.get("task_ids")) and set(w["task_ids"]) <= known, f"{w.get('task_ids')} of {sorted(known)}")
newsletter = {"selector": "#newsletter", "tag": "form", "role": "", "label": "Subscribe to our newsletter", "parent": ""}
r = c.post(f"/task-representations/{SITE}/patch", json={
    "added": [{"id": "newsletter_email", "selector": "#newsletter_email", "tag": "input", "text": "", "role": "textbox",
               "accessibleName": "Your email", "visible": True, "container": "#newsletter"}],
    "containers": [newsletter]})
body = r.json()
check("a newsletter signup appearing on the application: nothing to splice, nothing to rebuild",
      r.status_code == 200 and body.get("changed") is False and body.get("added_items") == [],
      str({k: body.get(k) for k in ("changed", "added_items", "unrelated")}))
r = c.post(f"/task-representations/{SITE}/patch", json={"added": [race]})
body = r.json()
check("a follow-up question revealed by an answer still joins the widget",
      body.get("changed") is True and any("#race" in ([it.get("selector")] + (it.get("selectors") or [])) for it in body.get("added_items", [])),
      str({k: body.get(k) for k in ("changed", "added_items", "unrelated")}))

print("\n== RESULT ==")
if FAIL:
    print(f"  {len(FAIL)} FAILED: {FAIL}")
    sys.exit(1)
print("  all passed")
