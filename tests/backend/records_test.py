"""
Tests the study records without a model: the session folder, what each recording writes into it,
and the routes the side panel sends screenshots, errors and events to.
  PYTHONPATH=backend backend/.venv/bin/python tests/backend/records_test.py
"""
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
from pathlib import Path
from urllib.parse import quote

# A throwaway data dir, so the records never land in the study's own user_study/ folder
os.environ["PAGEASSIST_DATA_DIR"] = tempfile.mkdtemp(prefix="pageassist-records-")
from fastapi.testclient import TestClient

import main
from api.utils import records

c = TestClient(main.app)
FAIL = []


def check(name, cond, detail=""):
    print(f"  [{'ok  ' if cond else 'FAIL'}] {name}{'' if cond else f'  {detail}'}")
    if not cond:
        FAIL.append(name)


def session_folder():
    return records.RECORDS_DIR / sorted(os.listdir(records.RECORDS_DIR))[-1]


def summary():
    return json.loads((session_folder() / "summary.json").read_text())


def lines(name):
    path = session_folder() / name
    return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []


TREE = {"component": "question-checklist", "description": "A checklist of the page's questions.", "style": {},
        "preferences": ["ticks off answered questions"], "children": []}
BIGGER = {**TREE, "style": {"font-size": "18px"}}
SITE = "job-boards.greenhouse.io~kargo~jobs~6100170004?utm_source=test"
URL = "https://job-boards.greenhouse.io/kargo/jobs/6100170004?utm_source=test"
PNG = "data:image/png;base64," + base64.b64encode(
    bytes.fromhex("89504e470d0a1a0a0000000d4948445200000001000000010806000000"
                  "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082")).decode()

print("== where the records go ==")
check("a throwaway data dir takes the records with it", records.RECORDS_DIR == Path(os.environ["PAGEASSIST_DATA_DIR"]) / "user_study", str(records.RECORDS_DIR))
default = subprocess.run([sys.executable, "-c", "from api.utils import records; print(records.RECORDS_DIR)"], capture_output=True, text=True,
                         env={k: v for k, v in os.environ.items() if k != "PAGEASSIST_DATA_DIR"}).stdout.strip()
check("  and otherwise they go in user_study/ at the top of the repo", default == str(Path(__file__).resolve().parents[2] / "user_study"), default)

print("\n== recording before the first reset starts a session ==")
early = threading.Thread(target=records.event, args=("before any reset", {}), daemon=True)
early.start()
early.join(timeout=5)
check("recording before any reset doesn't hang", not early.is_alive())
check("  it starts a session folder", records.RECORDS_DIR.exists() and len(os.listdir(records.RECORDS_DIR)) == 1)

print("\n== a new chat starts a session folder ==")
c.post("/interface-representation/reset")
check("the reset made a folder with a summary", (session_folder() / "summary.json").exists())
first = session_folder()

print("\n== the conversation, and how many iterations it took ==")
records.chat_turn("I lose track of the questions I've answered.", {"reply": "Is that right?", "agreed": False}, None, False, 2.0)
records.chat_turn("Yes.", {"reply": "Three options: ...", "agreed": False, "suggestions": ["Checklist"]}, None, False, 1.5)
records.chat_turn("The checklist.", {"reply": "Here it is.", "agreed": True}, TREE, True, 3.0)
records.chat_turn("Make the text bigger.", {"reply": "Done.", "agreed": True}, BIGGER, True, 2.5)
turns = lines("conversation.jsonl")
check("every turn is in conversation.jsonl, in order", [t["turn"] for t in turns] == [1, 2, 3, 4], str(turns))
check("  with what the user said and the reply", turns[1]["user"] == "Yes." and turns[1]["reply"] == "Three options: ...")
s = summary()
check("the turn the user agreed on is counted", s["turns_to_agreement"] == 3, str(s))
check("  and a change after agreeing counts as a refinement", s["refinements_after_agreement"] == 1, str(s))
versions = sorted((session_folder() / "interface_representations").iterdir())
check("each changed tree is kept as its own version", [v.name for v in versions] == ["001.json", "002.json"])
check("  with the turn that made it", json.loads(versions[1].read_text())["chat_turn"] == 4)

print("\n== task representations ==")
records.task_representation("analyze", SITE, URL, {"tasks": [], "components": [{"component_id": "c1"}]}, 31.4)
records.task_representation("patch", SITE, "", {"tasks": [], "components": []}, 2.2, {"changed": True})
files = sorted(p.name for p in (session_folder() / "task_representations").iterdir())
check("every analysis and patch is kept", files == ["001-analyze-job-boards-greenhouse-io-kargo-jobs-6100170004.json",
                                                    "002-patch-job-boards-greenhouse-io-kargo-jobs-6100170004.json"], str(files))
analyzed = json.loads((session_folder() / "task_representations" / files[0]).read_text())
check("  the page address is kept without its query string", analyzed["page"] == "https://job-boards.greenhouse.io/kargo/jobs/6100170004", analyzed["page"])
check("  nothing of the page's text is kept", "page_text" not in json.dumps(analyzed))

print("\n== interfaces: code, items, iterations and screenshots ==")
widget = {"style": {}, "code": "window.render = function (state) {};", "state": {"items": [
    {"label": "First Name", "selector": "#first_name"}, {"label": "Read the guide", "id": "s1", "manual": True}]}}
TASK = {"tasks": [], "components": [{"component_id": "c1", "dom_selector": "#first_name"}]}
record_id = records.interface(SITE, widget, BIGGER, TASK, "chat", 40.0)
folder = session_folder() / "interfaces" / record_id
check("the interface's code is kept as code.js", (folder / "code.js").read_text() == widget["code"])
check("  with the interface representation and task representation it was built from",
      json.loads((folder / "interface_representation.json").read_text()) == BIGGER
      and json.loads((folder / "task_representation.json").read_text()) == TASK)
meta = json.loads((folder / "meta.json").read_text())
check("  with its items, tracked and by hand", meta["items"] == {"total": 2, "tracked": 1, "by_hand": 1}, str(meta["items"]))
check("  and the iterations that led to it", meta["iterations"]["chat_turns"] == 4 and meta["iterations"]["interface_representation_version"] == 2, str(meta["iterations"]))
r = c.post("/records/screenshots", json={"record_id": record_id, "reason": "applied", "image": PNG})
check("a screenshot is filed with its interface", r.status_code == 200 and (folder / "screenshot-applied.png").exists(), r.text)
c.post("/records/screenshots", json={"record_id": record_id, "reason": "updated", "image": PNG})
c.post("/records/screenshots", json={"record_id": record_id, "reason": "updated", "image": PNG})
check("  later ones are numbered, not overwritten", (folder / "screenshot-updated-2.png").exists())
shots_before = summary()["screenshots"]
c.post("/records/screenshots", json={"record_id": record_id, "reason": "final", "image": PNG})
c.post("/records/screenshots", json={"record_id": record_id, "reason": "final", "image": PNG})
check("the final screenshot is replaced as the interface changes, not numbered",
      (folder / "screenshot-final.png").exists() and not (folder / "screenshot-final-2.png").exists())
check("  and counted once", summary()["screenshots"] == shots_before + 1, str(summary()["screenshots"]))
check("a record id that points outside the session is refused",
      c.post("/records/screenshots", json={"record_id": "../../escape", "image": PNG}).status_code == 400)
check("  as is one for an interface that doesn't exist", c.post("/records/screenshots", json={"record_id": "099-nothing", "image": PNG}).status_code == 400)
check("  and anything that isn't an image", c.post("/records/screenshots", json={"record_id": record_id, "image": "data:text/html;base64,PGI+"}).status_code == 400)

print("\n== errors and events ==")
c.post("/records/errors", json={"source": "widget", "where": "render", "message": "items is not iterable"})
saved = c.post("/interface-representations", json={"name": "Question checklist", "record_id": record_id}).json()
c.post(f"/interface-representations/{saved['id']}/update", json={"record_id": record_id})
c.post("/interface-representations", json={"name": "Saved with nothing showing"})
c.post(f"/interface-representations/{saved['id']}/activate")
c.post("/records/events", json={"kind": "page change", "details": {"outcome": "spliced", "added": 1}})
errors = lines("errors.jsonl")
check("an error from the widget is kept", errors and errors[-1]["source"] == "widget", str(errors))
events = [e["kind"] for e in lines("events.jsonl")]
check("saving and updating an interface and a page change are kept as events",
      events == ["saved interface", "updated saved interface", "saved interface", "page change"], str(events))
saves = [e for e in lines("events.jsonl") if "saved interface" in e["kind"]]
check("  each save names the interface that was showing", [e["interface"] for e in saves] == [record_id, record_id, None], str(saves))
meta = json.loads((folder / "meta.json").read_text())
check("  and that interface's meta lists what it was saved as",
      [(e["name"], e["how"]) for e in meta.get("saved", [])] == [("Question checklist", "saved interface"), ("Question checklist", "updated saved interface")], str(meta.get("saved")))
activated = json.loads(sorted((session_folder() / "interface_representations").iterdir())[-1].read_text())
check("using a saved interface again is kept as a new version", activated["source"] == 'activated saved interface "Question checklist"', activated["source"])

_keys = {k: os.environ.pop(k) for k in ("ANTHROPIC_API_KEY", "GEMINI_API_KEY") if k in os.environ}
try:
    c.post(f"/task-representations/{quote(SITE, safe='')}/analyze", json={"url": URL, "title": "t", "elements": []})
finally:
    os.environ.update(_keys)
backend_error = lines("errors.jsonl")[-1]
check("a failed model call is kept, by its route rather than the page address",
      backend_error["source"] == "backend" and backend_error["where"] == "/task-representations/{site_id}/analyze", str(backend_error))
check("the summary counts all of it", summary()["errors"] == 2 and summary()["screenshots"] == 4 and summary()["interfaces_built"] == 1, str(summary()))

print("\n== a new chat starts a new folder ==")
c.post("/interface-representation/reset")
check("the next session gets its own folder", session_folder() != first and summary()["chat_turns"] == 0)

print("\n== recording never gets in the way ==")
shutil.rmtree(session_folder())
records.chat_turn("Hello again.", {"reply": "Hi."}, None, False, 1.0)
check("a session folder removed while running is started again", [t["user"] for t in lines("conversation.jsonl")] == ["Hello again."])


def full_disk(*args):
    raise OSError(28, "No space left on device")


kept, records._append = records._append, full_disk
try:
    turn = records.chat_turn("Is this kept?", {"reply": "No."}, None, False, 1.0)
finally:
    records._append = kept
check("a record that can't be written is skipped instead of failing the chat", turn == 0, str(turn))

print("\n== RESULT ==")
if FAIL:
    print(f"  {len(FAIL)} FAILED: {FAIL}")
    sys.exit(1)
print("  all passed")
