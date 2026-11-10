"""FastAPI app: CORS, routes, static mounts and one-time startup loading.

Run from backend/:  uvicorn app.main:app
"""

import os
import threading
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import date
from pathlib import Path

import numpy as np
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.data_loader import DataStore, load_store
from app.ai import generate_commentary
from app.models import (Commentary, CommentaryRequest, Game, OddsRequest, OddsResponse, Scenario,
                        SimulateRequest, SimulateResponse)
from app.simulator import odds_for_state, seeded_rng, simulate
from app.turning_points import (close_game_ids, daily_date, daily_scenarios, random_endless_scenario,
                                 scenarios_for_game)

REPO_ROOT = Path(__file__).resolve().parents[2]
ENV_PATH = Path(__file__).resolve().parents[1] / ".env"
ALLOWED_ORIGINS = ["http://localhost:8000", "http://127.0.0.1:5500"]

store: DataStore | None = None
rng = np.random.default_rng()
turning_point_cache: dict[tuple[str, int], list[Scenario]] = {}  # intros are written once per game
close_games: list[str] | None = None   # endless mode's game pool, computed on first use
DAILY_CACHE_DAYS = 3                   # today's set, plus a little slack around midnight
daily_cache: dict[date, list[Scenario]] = {}
daily_lock = threading.Lock()


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
    """Load the parquet and WP model once, and pick today's scenarios, before serving requests."""
    global store
    load_env_file(ENV_PATH)
    store = load_store()
    scenarios_for_day(daily_date())   # warm today's set so the first visitor doesn't wait
    yield


app = FastAPI(title="Scrimmagine API", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=ALLOWED_ORIGINS,
                   allow_methods=["*"], allow_headers=["*"])


def scenarios_for_day(day: date) -> list[Scenario]:
    """A day's 6, picked from the in-memory plays the first time that day is asked for, then cached."""
    with daily_lock:
        if day not in daily_cache:
            data = get_store()
            daily_cache[day] = daily_scenarios(data.plays, day, data.wp)
            while len(daily_cache) > DAILY_CACHE_DAYS:
                daily_cache.pop(next(iter(daily_cache)))   # oldest first
        return daily_cache[day]


@app.get("/api/scenarios", response_model=list[Scenario])
def get_scenarios() -> list[Scenario]:
    """Today's 6 daily scenarios: the same for everyone, new at midnight US Eastern.
    There is deliberately no date parameter, so tomorrow's set can't be previewed."""
    return scenarios_for_day(daily_date())


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


@app.get("/api/endless/next", response_model=Scenario)
def get_endless_next() -> Scenario:
    """Endless mode: a random close game's one-possession drive where the offense needs a TD."""
    global close_games
    data = get_store()
    if close_games is None:
        close_games = close_game_ids(data.plays)
    scenario = random_endless_scenario(data.plays, data.wp, rng, game_ids=close_games)
    if scenario is None:
        raise HTTPException(status_code=503, detail="No endless scenarios available")
    return scenario


@app.post("/api/call-odds", response_model=OddsResponse)
def post_call_odds(body: OddsRequest) -> OddsResponse:
    """Success chance and expected WP of every call from a state, over all the real plays it can draw."""
    data = get_store()
    return odds_for_state(body.state, data.pools, data.wp)


@app.post("/api/simulate", response_model=SimulateResponse)
def post_simulate(body: SimulateRequest) -> SimulateResponse:
    """Simulate one play call from a game state. With a scenario_id (the daily game) the outcome is
    predetermined: the same scenario, situation and call give every player the same real play."""
    data = get_store()
    draw = seeded_rng(body.scenario_id, body.state, body.call) if body.scenario_id else rng
    return simulate(body.state, body.call, data.pools, data.wp, draw)


@app.post("/api/commentary", response_model=Commentary)
def post_commentary(body: CommentaryRequest) -> Commentary:
    """Two booth lines for a play (Claude with a 3s timeout, template fallback)."""
    return generate_commentary(body)



app.mount("/sprites", StaticFiles(directory=REPO_ROOT / "sprites"), name="sprites")
if (REPO_ROOT / "sound-effects").is_dir():
    app.mount("/sound-effects", StaticFiles(directory=REPO_ROOT / "sound-effects"), name="sound-effects")
class RevalidatedStaticFiles(StaticFiles):
    """Static files sent with Cache-Control: no-cache. The browser still caches them but checks
    with the server on every load (a cheap 304 when unchanged), so an updated JS module is never
    mixed with a stale cached one, e.g. a new app.js calling a function an old api.js lacks."""

    def file_response(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        response = super().file_response(*args, **kwargs)
        response.headers["Cache-Control"] = "no-cache"
        return response


if (REPO_ROOT / "frontend").is_dir():
    app.mount("/", RevalidatedStaticFiles(directory=REPO_ROOT / "frontend", html=True), name="frontend")
