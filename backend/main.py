"""
The following file creates the PageAssist API from the routers
- api/endpoints/: one package per domain, the routes in router.py and the logic behind them in helpers.py
- api/state/: the stored task representation, interface representation and widget
- api/utils/: JSON storage, the model calls, and the study records (user_study/ at the top of the repo)
- definitions/: the prompts and schemas for each domain
"""
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

load_dotenv(Path(__file__).with_name(".env"))

from api.endpoints import task as task_endpoint
from api.endpoints import patch as patch_endpoint
from api.endpoints import chat as chat_endpoint
from api.endpoints import interface_representation as interface_representation_endpoint
from api.endpoints import webpage_interface as webpage_interface_endpoint
from api.endpoints import records as records_endpoint
from api.utils.llm import ModelError
from api.utils import records

app = FastAPI(title="PageAssist API", version="0.1.0")
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5173"], allow_methods=["*"], allow_headers=["*"])

app.include_router(task_endpoint.router)
app.include_router(patch_endpoint.router)
app.include_router(chat_endpoint.router)
app.include_router(interface_representation_endpoint.router)
app.include_router(webpage_interface_endpoint.router)
app.include_router(records_endpoint.router)


# The route an error happened on, as written in the code, so no page address ends up in the records
def route_of(request: Request) -> str:
    route = request.scope.get("route")
    return getattr(route, "path", "") or "unknown"


# A missing or failed model call goes back to the panel as an error it shows the user.
@app.exception_handler(ModelError)
async def model_error_handler(request: Request, error: ModelError) -> JSONResponse:
    print(f"model error: {error}")
    records.error("backend", route_of(request), str(error))
    return JSONResponse(status_code=502, content={"detail": str(error)})


# Anything else that breaks is kept in the records too, and reported to the panel as an error.
@app.exception_handler(Exception)
async def unexpected_error_handler(request: Request, error: Exception) -> JSONResponse:
    print(f"unexpected error: {error!r}")
    records.error("backend", route_of(request), f"{type(error).__name__}: {error}")
    return JSONResponse(status_code=500, content={"detail": f"Something went wrong in PageAssist: {type(error).__name__}"})


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
