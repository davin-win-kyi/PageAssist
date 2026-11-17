"""
Tests the study records without a model: the session folder and its folder per chat turn, what each
recording writes into them, and the routes the side panel sends screenshots, step pictures, errors
and events to.
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


def turn(number):
    return session_folder() / f"turn-{number:02d}"


def read(path):
    return json.loads(path.read_text())


def lines(path):
    return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []


TREE = {"component": "step-guide", "description": "One step of the page at a time.", "style": {},
        "preferences": ["shows one step at a time"], "children": []}
BIGGER = {**TREE, "style": {"font-size": "18px"}}
SITE = "job-boards.greenhouse.io~kargo~jobs~6100170004?utm_source=test"
URL = "https://job-boards.greenhouse.io/kargo/jobs/6100170004?utm_source=test"
PNG = "data:image/png;base64," + base64.b64encode(
    bytes.fromhex("89504e470d0a1a0a0000000d4948445200000001000000010806000000"
                  "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082")).decode()
TASK = {"tasks": [], "components": [{"component_id": "c1", "dom_selector": "#first_name"}]}
WIDGET = {"style": {}, "code": "window.render = function (state) {};", "state": {"items": [
    {"label": "First Name", "selector": "#first_name"}, {"label": "Read the guide", "id": "s1", "manual": True}]}}

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

print("\n== a new chat starts a session folder, and what comes before its first turn is turn-00 ==")
c.post("/interface-representation/reset")
check("the reset made a folder with a summary", (session_folder() / "summary.json").exists())
first = session_folder()
records.task_representation("analyze", SITE, URL, {"tasks": [], "components": [{"component_id": "c1"}]}, 31.4)
analyzed_file = turn(0) / "task_representations" / "001-analyze-job-boards-greenhouse-io-kargo-jobs-6100170004.json"
check("analyzing the page when the panel opens is kept in turn-00", analyzed_file.exists(), str(list(session_folder().rglob("*.json"))))
analyzed = read(analyzed_file)
check("  the page address is kept without its query string", analyzed["page"] == "https://job-boards.greenhouse.io/kargo/jobs/6100170004", analyzed["page"])
check("  nothing of the page's text is kept", "page_text" not in json.dumps(analyzed))

print("\n== each chat turn gets its own folder ==")
records.chat_turn("I lose my place in the steps.", {"reply": "Is that right?", "agreed": False}, None, False, 2.0)
records.chat_turn("Yes.", {"reply": "Three options: ...", "agreed": False, "suggestions": ["Step guide"]}, None, False, 1.5)
records.chat_turn("The step guide.", {"reply": "Here it is.", "agreed": True}, TREE, True, 3.0)
check("turns 1, 2 and 3 each have a folder with what was said and replied",
      all((turn(n) / "turn.json").exists() for n in (1, 2, 3)) and read(turn(2) / "turn.json")["user"] == "Yes."
      and read(turn(2) / "turn.json")["reply"] == "Three options: ...")
check("  a turn that didn't change the interface representation has none in its folder",
      not (turn(1) / "interface_representation.json").exists())
check("  the turn that made one keeps it", read(turn(3) / "interface_representation.json")["tree"] == TREE)
check("  there is no combined conversation file", not (session_folder() / "conversation.jsonl").exists())
check("the turn the user agreed on is counted", summary()["turns_to_agreement"] == 3, str(summary()))

print("\n== an interface gets its own folder, in the turn that made it ==")
record_id = records.interface(SITE, WIDGET, TREE, TASK, "chat", 40.0)
folder = turn(3) / f"interface-{record_id}"
check("the interface is in turn-03, in its own folder", folder.is_dir(), str(list(turn(3).iterdir())))
check("  with its code as code.js", (folder / "code.js").read_text() == WIDGET["code"])
check("  the interface representation and task representation it was built from",
      read(folder / "interface_representation.json") == TREE and read(folder / "task_representation.json") == TASK)
meta = read(folder / "meta.json")
check("  its items, tracked and by hand", meta["items"] == {"total": 2, "tracked": 1, "by_hand": 1}, str(meta["items"]))
check("  and the turn and iterations that led to it", meta["turn"] == 3 and meta["iterations"]["chat_turns"] == 3, str(meta))
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

print("\n== a picture of every step of an interface that shows one step at a time ==")
r = c.post("/records/steps", json={"record_id": record_id, "images": [PNG, PNG, PNG]})
steps = sorted(p.name for p in folder.glob("screenshot-step-*"))
check("every step is filed with the interface, in order", r.status_code == 200 and steps == ["screenshot-step-01.png", "screenshot-step-02.png", "screenshot-step-03.png"], str(steps))
check("  and its meta says how many steps it has", read(folder / "meta.json")["steps"] == 3)
c.post("/records/steps", json={"record_id": record_id, "images": [PNG, PNG]})
steps = sorted(p.name for p in folder.glob("screenshot-step-*"))
check("taking them again replaces them, so a step the page removed doesn't linger", steps == ["screenshot-step-01.png", "screenshot-step-02.png"], str(steps))
check("  steps that aren't images are refused", c.post("/records/steps", json={"record_id": record_id, "images": [PNG, "data:text/html;base64,PGI+"]}).status_code == 400)
check("  as are steps for an interface that doesn't exist", c.post("/records/steps", json={"record_id": "099-nothing", "images": [PNG]}).status_code == 400)

print("\n== a refinement is its own turn, and the interface it makes gets a new folder ==")
records.chat_turn("Make the text bigger.", {"reply": "Done.", "agreed": True}, BIGGER, True, 2.5)
second_id = records.interface(SITE, WIDGET, BIGGER, TASK, "chat", 38.0)
second = turn(4) / f"interface-{second_id}"
check("turn 4 has its own folder with the version it made", read(turn(4) / "interface_representation.json")["tree"] == BIGGER)
check("  a change after agreeing counts as a refinement", summary()["refinements_after_agreement"] == 1, str(summary()))
check("the new interface is numbered after the first and kept in turn-04", second.is_dir() and second_id.startswith("002-"), str(second_id))
check("  and the first interface is left as it was, in turn-03", folder.is_dir() and read(folder / "interface_representation.json") == TREE)

print("\n== task representations, errors and events are kept with the turn they happened in ==")
records.task_representation("patch", SITE, "", {"tasks": [], "components": []}, 2.2, {"changed": True})
check("a page change's patch is in turn-04, numbered after the first analysis",
      (turn(4) / "task_representations" / "002-patch-job-boards-greenhouse-io-kargo-jobs-6100170004.json").exists())
c.post("/records/errors", json={"source": "widget", "where": "render", "message": "items is not iterable"})
saved = c.post("/interface-representations", json={"name": "Step guide", "record_id": second_id}).json()
c.post(f"/interface-representations/{saved['id']}/update", json={"record_id": second_id})
c.post("/interface-representations", json={"name": "Saved with nothing showing"})
c.post(f"/interface-representations/{saved['id']}/activate")
c.post("/records/events", json={"kind": "page change", "details": {"outcome": "spliced", "added": 1}})
errors = lines(turn(4) / "errors.jsonl")
check("an error from the widget is kept in turn-04", errors and errors[-1]["source"] == "widget", str(errors))
events = [e["kind"] for e in lines(turn(4) / "events.jsonl")]
check("saving and updating an interface and a page change are kept as events in turn-04",
      events == ["saved interface", "updated saved interface", "saved interface", "page change"], str(events))
saves = [e for e in lines(turn(4) / "events.jsonl") if "saved interface" in e["kind"]]
check("  each save names the interface that was showing", [e["interface"] for e in saves] == [second.name, second.name, None], str(saves))
check("  and that interface's meta lists what it was saved as",
      [(e["name"], e["how"]) for e in read(second / "meta.json").get("saved", [])] == [("Step guide", "saved interface"), ("Step guide", "updated saved interface")])
activated = read(turn(4) / "interface_representation-2.json")
check("using a saved interface again is kept as a new version in the turn under way", activated["source"] == 'activated saved interface "Step guide"', activated["source"])

_keys = {k: os.environ.pop(k) for k in ("ANTHROPIC_API_KEY", "GEMINI_API_KEY") if k in os.environ}
try:
    c.post(f"/task-representations/{quote(SITE, safe='')}/analyze", json={"url": URL, "title": "t", "elements": []})
finally:
    os.environ.update(_keys)
backend_error = lines(turn(4) / "errors.jsonl")[-1]
check("a failed model call is kept, by its route rather than the page address",
      backend_error["source"] == "backend" and backend_error["where"] == "/task-representations/{site_id}/analyze", str(backend_error))
s = summary()
check("the summary counts all of it", s["chat_turns"] == 4 and s["errors"] == 2 and s["interfaces_built"] == 2 and s["screenshots"] == 7, str(s))

print("\n== a new chat starts a new folder ==")
c.post("/interface-representation/reset")
check("the next session gets its own folder", session_folder() != first and summary()["chat_turns"] == 0)

print("\n== recording never gets in the way ==")
shutil.rmtree(session_folder())
records.chat_turn("Hello again.", {"reply": "Hi."}, None, False, 1.0)
check("a session folder removed while running is started again", read(turn(1) / "turn.json")["user"] == "Hello again.")


def full_disk(*args):
    raise OSError(28, "No space left on device")


kept, records._write = records._write, full_disk
try:
    turn_number = records.chat_turn("Is this kept?", {"reply": "No."}, None, False, 1.0)
finally:
    records._write = kept
check("a record that can't be written is skipped instead of failing the chat", turn_number == 0, str(turn_number))

print("\n== RESULT ==")
if FAIL:
    print(f"  {len(FAIL)} FAILED: {FAIL}")
    sys.exit(1)
print("  all passed")
