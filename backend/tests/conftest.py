"""Shared fixtures: a small synthetic play-by-play table with controllable bucket sizes."""

import sys
from pathlib import Path

import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.models import GameState  # noqa: E402


def make_play(play_id: int, play_type: str, down: int, ydstogo: int, yardline_100: int,
              yards: int = 4, **extra: object) -> dict:
    """One synthetic play row with sensible defaults."""
    row = {
        "play_id": play_id, "play_type": play_type, "down": down, "ydstogo": ydstogo,
        "yardline_100": yardline_100, "yards_gained": yards, "touchdown": 0, "interception": 0,
        "fumble_lost": 0, "sack": 0, "pass_length": None, "desc": "synthetic play",
        "punt_net_yards": None, "kick_distance": None, "field_goal_result": None,
    }
    row.update(extra)
    return row


def full_grid() -> pd.DataFrame:
    """Every down x distance x zone bucket has 30+ runs, short, deep passes and some sacks."""
    rows, pid = [], 0
    for down in (1, 2, 3, 4):
        for dist in (1, 2, 5, 8, 12):
            for yl in (10, 35, 65, 90):
                for i in range(30):
                    pid += 1
                    rows.append(make_play(pid, "run", down, dist, yl, yards=i % 9 - 2))
                    pid += 1
                    rows.append(make_play(pid, "pass", down, dist, yl, yards=i % 12,
                                          pass_length="short"))
                    pid += 1
                    rows.append(make_play(pid, "pass", down, dist, yl, yards=(i % 4) * 12,
                                          pass_length="deep",
                                          desc="incomplete" if i % 2 else "complete"))
                pid += 1
                rows.append(make_play(pid, "pass", down, dist, yl, yards=-7, sack=1))
    for yl in range(30, 100):
        pid += 1
        rows.append(make_play(pid, "punt", 4, 10, yl, yards=0, punt_net_yards=min(40, yl - 20)))
    for kick in range(18, 66):
        for result in ("made", "made", "missed"):
            pid += 1
            rows.append(make_play(pid, "field_goal", 4, 5, kick - 17, yards=0,
                                  kick_distance=kick, field_goal_result=result))
    return pd.DataFrame(rows)


@pytest.fixture
def grid_plays() -> pd.DataFrame:
    """Synthetic plays covering every bucket."""
    return full_grid()


@pytest.fixture
def state() -> GameState:
    """A neutral mid-game state: 2nd and 7 at the opponent 40."""
    return GameState(offense="CRM", defense="NVY", offense_score=17, defense_score=20, quarter=3,
                     seconds_left_in_game=1500, down=2, distance=7, yardline_100=40,
                     offense_timeouts=3, defense_timeouts=3)
