"""FastAPI app: CORS, routes, static mounts and one-time startup loading.

Run from backend/:  uvicorn app.main:app
"""

import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

import numpy as np
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.data_loader import DataStore, load_store
from app.ai import generate_commentary
from app.models import (Commentary, CommentaryRequest, Game, Scenario, SimulateRequest,
                        SimulateResponse)
from app.simulator import simulate
from app.turning_points import scenarios_for_game

REPO_ROOT = Path(__file__).resolve().parents[2]
ENV_PATH = Path(__file__).resolve().parents[1] / ".env"
ALLOWED_ORIGINS = ["http://localhost:8000", "http://127.0.0.1:5500"]

store: DataStore | None = None
rng = np.random.default_rng()
turning_point_cache: dict[tuple[str, int], list[Scenario]] = {}  # intros are written once per game


def load_env_file(path: Path) -> None:
    """Read KEY=VALUE lines from backend/.env into os.environ (real env vars win)."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        key, sep, value = line.partition("=")
        if sep and not key.strip().startswith("#"):
            os.environ.setdefault(key.strip(), value.strip())


def get_store() -> DataStore:
    """The in-memory DataStore loaded at startup."""
    assert store is not None, "DataStore not loaded"
    return store


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    """Load the parquet, WP model and scenarios once, before serving requests."""
    global store
    load_env_file(ENV_PATH)
    store = load_store()
    yield


app = FastAPI(title="Scrimmagine API", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=ALLOWED_ORIGINS,
                   allow_methods=["*"], allow_headers=["*"])


@app.get("/api/scenarios", response_model=list[Scenario])
def get_scenarios() -> list[Scenario]:
    """Today's curated scenarios from scenarios.json (already in memory)."""
    return get_store().scenarios


@app.get("/api/games", response_model=list[Game])
def get_games(season: int | None = None, team: str | None = None) -> list[Game]:
    """Games with teams, week and final score, optionally filtered by season and team."""
    games = get_store().games
    if season is not None:
        games = [g for g in games if g.season == season]
    if team:
        team = team.upper()
        games = [g for g in games if team in (g.home_team, g.away_team)]
    return games


@app.get("/api/games/{game_id}/turning-points", response_model=list[Scenario])
def get_turning_points(game_id: str, limit: int = Query(5, ge=1, le=20)) -> list[Scenario]:
    """Run the turning point finder on one game (cached so intros are written once)."""
    key = (game_id, limit)
    if key not in turning_point_cache:
        plays = get_store().plays
        game = plays[plays["game_id"] == game_id]
        if game.empty:
            raise HTTPException(status_code=404, detail=f"Unknown game_id {game_id}")
        turning_point_cache[key] = scenarios_for_game(game, get_store().wp, limit)
    return turning_point_cache[key]


@app.post("/api/simulate", response_model=SimulateResponse)
def post_simulate(body: SimulateRequest) -> SimulateResponse:
    """Simulate one play call from a game state."""
    data = get_store()
    return simulate(body.state, body.call, data.pools, data.wp, rng)


@app.post("/api/commentary", response_model=Commentary)
def post_commentary(body: CommentaryRequest) -> Commentary:
    """Two booth lines for a play (Claude with a 3s timeout, template fallback)."""
    return generate_commentary(body)


app.mount("/sprites", StaticFiles(directory=REPO_ROOT / "sprites"), name="sprites")
if (REPO_ROOT / "sound-effects").is_dir():
    app.mount("/sound-effects", StaticFiles(directory=REPO_ROOT / "sound-effects"), name="sound-effects")
if (REPO_ROOT / "frontend").is_dir():
    app.mount("/", StaticFiles(directory=REPO_ROOT / "frontend", html=True), name="frontend")
