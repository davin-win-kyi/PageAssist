"""TaskWeb API — thin assembly point.

- api/endpoints/    — the four FastAPI routers (one module per domain)
- api/data/         — in-process state (task slot, interface working-tree + saved DB, in-memory widget)
- api/utils/        — shared infra: JSON persistence, Anthropic plumbing, debug logs
- definitions/      — the prompt(s) + schemas for each domain (no behavior)
"""
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

load_dotenv(Path(__file__).with_name(".env"))

from api.endpoints import task as task_endpoint
from api.endpoints import chat as chat_endpoint
from api.endpoints import interface_representation as interface_representation_endpoint
from api.endpoints import webpage_interface as webpage_interface_endpoint

app = FastAPI(title="TaskWeb API", version="0.1.0")
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5173"], allow_methods=["*"], allow_headers=["*"])

app.include_router(task_endpoint.router)
app.include_router(chat_endpoint.router)
app.include_router(interface_representation_endpoint.router)
app.include_router(webpage_interface_endpoint.router)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
