"""
Tests, without a model, how a page change is judged against the tasks the widget showing serves:
which tasks a widget serves, how new components are filed under tasks, which of them join the
widget, and what the patch, generate and analyze routes return and record. The model calls answer
with fixed components.
  PYTHONPATH=backend backend/.venv/bin/python tests/backend/task_relevance_test.py
"""
import copy
import importlib
import json
import os
import sys
import tempfile
from urllib.parse import quote

# A throwaway data dir, so nothing here lands in backend/data or the study's user_study/ folder
os.environ["PAGEASSIST_DATA_DIR"] = tempfile.mkdtemp(prefix="pageassist-relevance-")
from fastapi.testclient import TestClient

import main
from api.state.task import replace_task_store
from api.state.webpage_interface import get_webpage_interface, set_webpage_interface
from api.endpoints.patch.helpers import served_task_ids, append_components, part_of_tasks
from api.utils import records

# the route modules, whose model calls are replaced (each package's `router` is its APIRouter)
patch_routes = importlib.import_module("api.endpoints.patch.router")
interface_routes = importlib.import_module("api.endpoints.webpage_interface.router")
task_routes = importlib.import_module("api.endpoints.task.router")

c = TestClient(main.app)
FAIL = []


def check(name, cond, detail=""):
    print(f"  [{'ok  ' if cond else 'FAIL'}] {name}{'' if cond else f'  {detail}'}")
    if not cond:
        FAIL.append(name)


def component(cid, label, selector, task_ids, kind="text-question"):
    return {"component_id": cid, "component_type": kind, "label": label, "description": "",
            "dom_selector": selector, "member_selectors": [selector], "associated_task_ids": task_ids}


def task(tid, label, parent, component_ids):
    return {"task_id": tid, "label": label, "description": "", "task_type": "fill-form",
            "parent_task_id": parent, "component_ids": component_ids}


# A job application: applying, with two sections under it, and apart from it, searching other jobs
REP = {
    "page_purpose": "Apply for a job",
    "tasks": [
        task("t1", "Apply for the job", None, ["c1"]),
        task("t2", "Personal details", "t1", ["c2"]),
        task("t3", "Voluntary self-identification", "t1", ["c3"]),
        task("t4", "Search other jobs", None, ["c4"]),
    ],
    "components": [
        component("c1", "Resume", "#resume", ["t1"], "file-question"),
        component("c2", "First name", "#first_name", ["t2"]),
        component("c3", "Are you Hispanic/Latino?", "#hispanic_ethnicity", ["t3"], "single-choice-question"),
        component("c4", "Search jobs", "#search", ["t4"]),
    ],
    "relationships": [],
    "modeling_notes": "",
}
SITE_RAW = "job-boards.greenhouse.io~example~jobs~1"
SITE = quote(SITE_RAW, safe="")
URL = "https://job-boards.greenhouse.io/example/jobs/1"

# What the fast model answers for each new element: its label, the tasks it files it under, and the
# question it depends on. The race question isn't filed, so it goes with the question it follows.
ANSWERS = {
    "#race": ("Race", [], "c3"),
    "#middle_name": ("Middle name", ["t2"], None),
    "#newsletter_email": ("Newsletter email", [], None),
    "#job_alerts": ("Job alert email", ["t4"], None),
}


async def fake_patch(rep, added, containers):
    start = max(int(comp["component_id"][1:]) for comp in rep["components"]) + 1
    comps, links = [], []
    for i, element in enumerate(added):
        label, task_ids, follows = ANSWERS[element.selector]
        comps.append(component(f"c{start + i}", label, element.selector, list(task_ids)))
        if follows:
            links.append({"type": "depends_on", "source": f"c{start + i}", "target": follows})
    return comps, links

patch_routes.model_patch_components = fake_patch


def start(widget_task_ids):
    replace_task_store(SITE_RAW, copy.deepcopy(REP), "")
    set_webpage_interface(None if widget_task_ids is None else
                          {"style": {}, "code": "", "state": {"items": []}, "task_ids": widget_task_ids})


def patch(*selectors, removed=()):
    added = [{"id": s[1:], "selector": s, "tag": "input", "text": "", "role": "textbox",
              "accessibleName": ANSWERS[s][0], "visible": True} for s in selectors]
    r = c.post(f"/task-representations/{SITE}/patch", json={"added": added, "removed": list(removed)})
    assert r.status_code == 200, r.text[:300]
    return r.json()


def spliced(body):
    return [s for item in body.get("added_items", []) for s in ([item["selector"]] if item.get("selector") else item.get("selectors", []))]


def filed(body, selector):
    return next((comp.get("associated_task_ids") for comp in body["components"] if comp["dom_selector"] == selector), None)


def session_folder():
    return records.RECORDS_DIR / sorted(os.listdir(records.RECORDS_DIR))[-1]


def ids(comps):
    return [comp["component_id"] for comp in comps]


print("== 1. the tasks a widget serves ==")
check("the tasks it names", served_task_ids(REP, ["t3"]) == ["t3"])
check("unknown and repeated task ids are dropped", served_task_ids(REP, ["t9", "t3", "t3"]) == ["t3"])
check("plus the tasks its tracked questions are filed under",
      served_task_ids(REP, ["t2"], [{"label": "Hispanic/Latino", "selector": "#hispanic_ethnicity"}, {"id": "s1", "label": "Read", "manual": True}]) == ["t2", "t3"])
check("a bundled item's questions count too", served_task_ids(REP, [], [{"label": "Name", "selectors": ["#first_name", "#resume"]}]) == ["t1", "t2"])
check("naming none, or nothing the page has: every task on the page",
      all(served_task_ids(REP, named) == ["t1", "t4"] for named in (None, [], "t3", [{"task_id": "t3"}], ["t9"])))
check("a page with no tasks has none", served_task_ids({"tasks": []}, ["t1"]) == [])

print("\n== 2. filing new components, and which of them are part of the widget's tasks ==")
rep = copy.deepcopy(REP)
rep["relationships"].append({"type": "depends_on", "source": "c6", "target": "c3"})
new = [component("c5", "Middle name", "#middle_name", ["t2", "t9"]),
       component("c6", "Race", "#race", []),
       component("c7", "Newsletter email", "#newsletter_email", [])]
append_components(rep, new)
by_id = {comp["component_id"]: comp["associated_task_ids"] for comp in rep["components"]}
check("filed under the tasks the model gave, dropping one the page doesn't have", by_id["c5"] == ["t2"], str(by_id))
check("a follow-up question is filed with the question it follows", by_id["c6"] == ["t3"], str(by_id))
check("one that serves no task is kept, filed under none", by_id["c7"] == [], str(by_id))
check("each task lists its new components",
      "c5" in rep["tasks"][1]["component_ids"] and "c6" in rep["tasks"][2]["component_ids"], str(rep["tasks"]))
check("a task covers its sub-tasks", ids(part_of_tasks(rep, new, ["t1"])) == ["c5", "c6"])
check("only the tasks the widget serves count", ids(part_of_tasks(rep, new, ["t2"])) == ["c5"])
check("on a page with no tasks, every new component counts", ids(part_of_tasks({"tasks": []}, new, [])) == ["c5", "c6", "c7"])
deep = copy.deepcopy(REP)
deep["tasks"].append(task("t5", "Race and ethnicity", "t3", []))
grandchild = [component("c5", "Race", "#race", ["t5"])]
append_components(deep, grandchild)
check("a sub-task's own sub-tasks count too", ids(part_of_tasks(deep, grandchild, ["t1"])) == ["c5"])

print("\n== 3. the patch route judges a change against the widget's tasks ==")
start(["t1"])
body = patch("#race", "#newsletter_email")
check("a follow-up question joins the widget", spliced(body) == ["#race"], str(body.get("added_items")))
check("a question outside the widget's tasks is counted, not added",
      body.get("unrelated") == 1 and body.get("changed") is True, json.dumps({k: body.get(k) for k in ("changed", "unrelated")}))
check("both are kept in the task representation", filed(body, "#race") == ["t3"] and filed(body, "#newsletter_email") == [])
stored = c.get(f"/task-representations/{SITE}").json()
check("the stored representation has both", filed(stored, "#race") == ["t3"] and filed(stored, "#newsletter_email") == [])
patches = sorted((session_folder() / "turn-00" / "task_representations").glob("*-patch-*.json"))
record = json.loads(patches[-1].read_text()) if patches else {}
check("the records keep the tasks it was judged against and what was left out",
      record.get("task_ids") == ["t1"] and record.get("components_added") == 2 and record.get("components_unrelated") == 1
      and record.get("changed") is True, json.dumps({k: record.get(k) for k in ("task_ids", "components_added", "components_unrelated", "changed")}))

start(["t1"])
body = patch("#newsletter_email")
check("only a question outside the widget's tasks: changed=false, nothing to splice",
      body.get("changed") is False and body.get("added_items") == [] and body.get("unrelated") == 1, str(body.get("added_items")))
start(["t1"])
body = patch("#job_alerts")
check("a question of another task is outside the widget's tasks",
      body.get("changed") is False and body.get("unrelated") == 1 and filed(body, "#job_alerts") == ["t4"])
start(["t2"])
body = patch("#race", "#middle_name")
check("a widget for one section takes only that section's new questions",
      spliced(body) == ["#middle_name"] and body.get("unrelated") == 1, str(body.get("added_items")))
start(["t4"])
body = patch("#middle_name")
check("an application question is outside a job search widget", body.get("changed") is False and body.get("unrelated") == 1)
start(None)
body = patch("#race", "#job_alerts", "#newsletter_email")
check("with no widget held, only what serves none of the page's tasks is left out",
      spliced(body) == ["#race", "#job_alerts"] and body.get("unrelated") == 1, str(body.get("added_items")))
start(["t1"])
body = patch(removed=["#first_name"])
check("a question leaving the page is still a change", body.get("changed") is True and body.get("unrelated") == 0)

print("\n== 4. a widget names the tasks it serves ==")
picked = {"task_ids": ["t3", "t9"]}
items = []


async def fake_build(tree, task_representation, page_text=""):
    return {"style": {}, "code": "window.render = function () {}", "state": {"items": items}, **picked}

interface_routes.build_webpage_interface = fake_build
replace_task_store(SITE_RAW, copy.deepcopy(REP), "")
widget = c.post(f"/webpage-interfaces/{SITE}/generate?reason=chat").json()
check("generate returns the tasks the widget serves, only ones the page has", widget.get("task_ids") == ["t3"], str(widget.get("task_ids")))
check("the widget held keeps them for later page changes", (get_webpage_interface() or {}).get("task_ids") == ["t3"])
folders = list(session_folder().glob(f"turn-*/interface-{widget.get('record_id')}"))
meta = json.loads((folders[0] / "meta.json").read_text()) if folders else {}
check("the interface's records name them", meta.get("task_ids") == ["t3"], str(meta.get("task_ids")))
picked = {"task_ids": ["t2"]}
items = [{"label": "First name", "selector": "#first_name"}, {"label": "Hispanic/Latino", "selector": "#hispanic_ethnicity"}]
widget = c.post(f"/webpage-interfaces/{SITE}/generate?reason=chat").json()
check("and the tasks of the questions it tracks", widget.get("task_ids") == ["t2", "t3"], str(widget.get("task_ids")))
picked, items = {}, []
widget = c.post(f"/webpage-interfaces/{SITE}/generate?reason=chat").json()
check("a widget that names none, like the warning shown when building fails, serves every task",
      widget.get("task_ids") == ["t1", "t4"], str(widget.get("task_ids")))

print("\n== 5. analyzing the page again ==")


async def fake_analyze(request):
    return copy.deepcopy(REP)

task_routes.model_task_representation = fake_analyze
set_webpage_interface({"style": {}, "code": "", "state": {"items": []}, "task_ids": ["t3"]})
r = c.post(f"/task-representations/{SITE}/analyze", json={"url": URL, "title": "Example", "elements": []})
check("drops the widget held, since its task ids belong to the old representation",
      r.status_code == 200 and get_webpage_interface() is None, r.text[:200])

print("\n== RESULT ==")
if FAIL:
    print(f"  {len(FAIL)} FAILED: {FAIL}")
    sys.exit(1)
print("  all passed")
