"""TaskWeb API — thin assembly point. Domains live in their own packages:

- task/       — analyze a page into a grounded task model; page-change events
- interface/  — the webpage-agnostic preference set + /chat + saved database + the grounded widget
- common/     — shared state (store) and Anthropic plumbing (llm)
"""
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

load_dotenv(Path(__file__).with_name(".env"))

from task import representation as task_representation
from task import events as task_events
from interface import representation as interface_representation
from interface import webpage as interface_webpage

app = FastAPI(title="TaskWeb API", version="0.1.0")
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5173"], allow_methods=["*"], allow_headers=["*"])

app.include_router(task_representation.router)
app.include_router(task_events.router)
app.include_router(interface_representation.router)
app.include_router(interface_webpage.router)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
