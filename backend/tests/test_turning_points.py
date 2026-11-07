"""Turning point finder tests: garbage-time filter, one play per drive, scoring and ordering."""

import pandas as pd
import pytest

from app.models import PlayCall
from app.turning_points import find_turning_points, scenarios_for_game, score_plays


def tp_play(play_id: int, drive: int, wp: float, wpa: float, down: int = 1, qtr: int = 1,
            half_seconds: int = 1500, play_type: str = "pass") -> dict:
    """One synthetic play for the finder."""
    return {
        "game_id": "2024_01_AAA_BBB", "play_id": play_id, "drive": drive, "wp": wp, "wpa": wpa,
        "down": down, "qtr": qtr, "half_seconds_remaining": half_seconds, "play_type": play_type,
        "pass_length": "short", "posteam": "AAA", "defteam": "BBB", "home_team": "BBB",
        "away_team": "AAA", "home_score_pre": 7, "away_score_pre": 3, "game_seconds_remaining": 3000,
        "ydstogo": 10, "yardline_100": 60, "posteam_timeouts_remaining": 3,
        "defteam_timeouts_remaining": 3, "desc": f"play {play_id}",
    }


def test_skips_garbage_time() -> None:
    """Plays with pre-play wp below 0.05 or above 0.95 are never picked, however big."""
    game = pd.DataFrame([
        tp_play(1, 1, wp=0.03, wpa=0.40),
        tp_play(2, 2, wp=0.97, wpa=-0.40),
        tp_play(3, 3, wp=0.50, wpa=0.05),
        tp_play(4, 4, wp=0.05, wpa=0.02),   # boundary values are kept
        tp_play(5, 5, wp=0.95, wpa=0.01),
    ])
    picked = find_turning_points(game, limit=5)
    assert set(picked["play_id"]) == {3, 4, 5}


def test_keeps_at_most_one_play_per_drive() -> None:
    """Three big plays on one drive yield only that drive's single best play."""
    game = pd.DataFrame([
        tp_play(1, 1, 0.5, 0.20), tp_play(2, 1, 0.5, -0.30), tp_play(3, 1, 0.5, 0.25),
        tp_play(4, 2, 0.5, 0.10), tp_play(5, 3, 0.5, 0.05),
    ])
    picked = find_turning_points(game, limit=5)
    assert picked["drive"].is_unique
    assert list(picked["play_id"]) == [2, 4, 5]


def test_leverage_boosts_and_ordering() -> None:
    """4th down x1.5, last 5 min of Q2/Q4 x1.25; top N by score, returned in game order."""
    game = pd.DataFrame([
        tp_play(1, 1, 0.5, 0.10),                                       # 0.100
        tp_play(2, 2, 0.5, 0.10, down=4),                               # 0.150
        tp_play(3, 3, 0.5, 0.10, qtr=4, half_seconds=200),              # 0.125
        tp_play(4, 4, 0.5, 0.10, down=4, qtr=2, half_seconds=100),      # 0.1875
        tp_play(5, 5, 0.5, 0.01),
    ])
    scores = score_plays(game).set_index("play_id")["leverage_score"]
    assert scores[2] == pytest.approx(0.15) and scores[3] == pytest.approx(0.125)
    assert scores[4] == pytest.approx(0.1875)
    picked = find_turning_points(game, limit=3)
    assert list(picked["play_id"]) == [2, 3, 4]


def test_only_real_play_types() -> None:
    """Kickoffs, extra points etc. are ignored."""
    game = pd.DataFrame([tp_play(1, 1, 0.5, 0.5, play_type="kickoff"), tp_play(2, 2, 0.5, 0.1)])
    assert list(find_turning_points(game)["play_id"]) == [2]


def test_scenarios_built_with_drive_wpa_and_state() -> None:
    """Scenarios carry the real call, the drive WPA from that play on, and the pre-play score."""
    game = pd.DataFrame([tp_play(1, 1, 0.5, -0.02), tp_play(2, 1, 0.5, 0.30), tp_play(3, 1, 0.6, -0.05)])
    scenarios = scenarios_for_game(game, limit=5, intro_fn=lambda state, desc: "intro")
    assert len(scenarios) == 1
    s = scenarios[0]
    assert s.id == "2024_01_AAA_BBB_2" and s.real_call == PlayCall.short_pass
    assert s.real_drive_wpa == 0.25
    assert (s.start_state.offense_score, s.start_state.defense_score) == (3, 7)
    assert s.title == "1ST & 10, DOWN 4" and s.intro == "intro"
