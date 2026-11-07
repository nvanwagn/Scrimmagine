"""Turning point finder tests: last one-possession drive, drive starts, filters and ordering."""

import pandas as pd
import pytest

from app.models import PlayCall
from app.turning_points import drive_starts, find_turning_points, scenarios_for_game


def tp_play(play_id: int, drive: int, wp: float = 0.5, wpa: float = 0.0, down: int = 1,
            seconds_left: int = 600, home: int = 7, away: int = 3, play_type: str = "pass",
            posteam: str = "AAA", yardline: int = 75, result: int = 4) -> dict:
    """One synthetic play (AAA is away, BBB home; result = final home - away)."""
    return {
        "game_id": "2024_01_AAA_BBB", "play_id": play_id, "drive": drive, "wp": wp, "wpa": wpa,
        "down": down, "qtr": 4, "half_seconds_remaining": seconds_left, "play_type": play_type,
        "pass_length": "short", "posteam": posteam, "defteam": "BBB" if posteam == "AAA" else "AAA",
        "home_team": "BBB", "away_team": "AAA", "home_score_pre": home, "away_score_pre": away,
        "game_seconds_remaining": seconds_left, "ydstogo": 10, "yardline_100": yardline,
        "posteam_timeouts_remaining": 3, "defteam_timeouts_remaining": 3, "desc": f"play {play_id}",
        "result": result,
    }


def field_wp(state) -> float:
    """Fake WP model: the closer to the opponent's goal line, the better."""
    return 1 - state.yardline_100 / 100


def test_picks_start_of_last_drive() -> None:
    """limit=1 returns the first snap of the game's final eligible drive, not its biggest play."""
    game = pd.DataFrame([
        tp_play(1, 1, wpa=0.30, seconds_left=900), tp_play(2, 1, seconds_left=870),
        tp_play(3, 2, wpa=0.01, seconds_left=400), tp_play(4, 2, wpa=0.40, seconds_left=370),
    ])
    assert list(find_turning_points(game, limit=1)["play_id"]) == [3]


def test_skips_non_snaps_at_drive_start() -> None:
    """A kickoff opening the drive is skipped; the first real snap is the start."""
    game = pd.DataFrame([tp_play(1, 1, play_type="kickoff"), tp_play(2, 1), tp_play(3, 1)])
    assert list(drive_starts(game)["play_id"]) == [2]


def test_requires_one_possession_game() -> None:
    """Drives starting more than 8 points apart are skipped; exactly 8 is kept."""
    game = pd.DataFrame([
        tp_play(1, 1, home=8, away=0, seconds_left=900),
        tp_play(2, 2, home=17, away=8, seconds_left=400),
    ])
    assert list(find_turning_points(game, limit=1)["play_id"]) == [1]


def test_skips_garbage_time_and_too_little_clock() -> None:
    """Drives outside 0.05-0.95 WP or with under a minute left are not picked."""
    game = pd.DataFrame([
        tp_play(1, 1, wp=0.50, seconds_left=900),
        tp_play(2, 2, wp=0.97, seconds_left=600),
        tp_play(3, 3, wp=0.50, seconds_left=59),
        tp_play(4, 4, wp=0.05, seconds_left=60),   # boundary values are kept
    ])
    assert list(find_turning_points(game, limit=5)["play_id"]) == [1, 4]


def test_last_n_drives_in_game_order() -> None:
    """limit=N returns the last N eligible drives, oldest first."""
    game = pd.DataFrame([tp_play(i, i, seconds_left=1000 - 100 * i) for i in range(1, 6)])
    assert list(find_turning_points(game, limit=3)["play_id"]) == [3, 4, 5]


def test_leverage_is_drive_swing() -> None:
    """leverage_score is the sum of |wpa| over the drive's real plays."""
    game = pd.DataFrame([tp_play(1, 1, wpa=0.10), tp_play(2, 1, wpa=-0.05), tp_play(3, 1, wpa=0.20)])
    assert drive_starts(game)["leverage_score"].iloc[0] == pytest.approx(0.35)


def test_coach_drive_scored_with_our_model() -> None:
    """The coach's WP comes from the model we pass in (not nflverse wpa), play by play,
    ending at the opponent's next snap seen from the coach's side."""
    game = pd.DataFrame([
        tp_play(1, 1, wpa=0.9, yardline=75), tp_play(2, 1, wpa=0.9, yardline=60),
        tp_play(3, 2, posteam="BBB", yardline=50, seconds_left=30),   # too late to be a scenario itself
    ])
    s = scenarios_for_game(game, field_wp, limit=1, intro_fn=lambda state, desc: "intro")[0]
    assert [(p.wp_before, p.wp_after) for p in s.real_drive_plays] == [(0.25, 0.4), (0.4, 0.5)]
    assert [p.wpa for p in s.real_drive_plays] == [0.15, 0.1]
    assert s.real_drive_wpa == 0.25                      # 0.50 at drive end - 0.25 at the start
    assert s.real_drive_plays[0].wp_before == field_wp(s.start_state)   # same start as the player


def test_drive_that_ends_the_game_uses_final_result() -> None:
    """No later snap: WP after the drive is 1 for a win (AAA away, result = home - away < 0)."""
    game = pd.DataFrame([tp_play(1, 1, yardline=75, result=-3), tp_play(2, 1, yardline=70, play_type="qb_kneel", result=-3)])
    s = scenarios_for_game(game, field_wp, limit=1, intro_fn=lambda state, desc: "intro")[0]
    assert [p.call for p in s.real_drive_plays] == ["short_pass", "kneel"]
    assert s.real_drive_plays[-1].wp_after == 1.0
    assert s.real_drive_wpa == 0.75


def test_offense_players_from_that_game() -> None:
    """QB = most passes, RB = most carries other than the QB, WR / WR2 = top two targets; the
    other team's players and missing columns are ignored."""
    rows = [
        tp_play(1, 1) | {"passer_player_name": "D.Prescott", "receiver_player_name": "G.Pickens"},
        tp_play(2, 1) | {"passer_player_name": "D.Prescott", "receiver_player_name": "C.Lamb"},
        tp_play(3, 1) | {"passer_player_name": "D.Prescott", "receiver_player_name": "G.Pickens"},
        tp_play(4, 1, play_type="run") | {"rusher_player_name": "D.Prescott"},   # scramble
        tp_play(5, 1, play_type="run") | {"rusher_player_name": "D.Prescott"},
        tp_play(6, 1, play_type="run") | {"rusher_player_name": "J.Williams"},
        tp_play(7, 2, posteam="BBB", seconds_left=30) | {"passer_player_name": "J.Hurts", "receiver_player_name": "A.Brown"},
        # The RB is the most-targeted receiver here; he must not take a WR tag too.
        *[tp_play(i, 1) | {"passer_player_name": "D.Prescott", "receiver_player_name": "J.Williams"} for i in (8, 9, 10)],
    ]
    s = scenarios_for_game(pd.DataFrame(rows), field_wp, limit=1, intro_fn=lambda state, desc: "intro")[0]
    op = s.offense_players
    assert (op.qb, op.rb, op.wr, op.wr2) == ("D.Prescott", "J.Williams", "G.Pickens", "C.Lamb")
    bare = scenarios_for_game(pd.DataFrame([tp_play(1, 1)]), field_wp, limit=1, intro_fn=lambda state, desc: "intro")[0]
    assert bare.offense_players.qb is None and bare.offense_players.wr is None and bare.offense_players.wr2 is None


def test_scenarios_built_with_first_call_and_state() -> None:
    """Scenarios carry the real first call and the pre-snap score."""
    game = pd.DataFrame([tp_play(1, 1), tp_play(2, 1), tp_play(3, 1)])
    s = scenarios_for_game(game, field_wp, limit=5, intro_fn=lambda state, desc: "intro")[0]
    assert s.id == "2024_01_AAA_BBB_1" and s.real_call == PlayCall.short_pass
    assert (s.start_state.offense_score, s.start_state.defense_score) == (3, 7)
    assert s.title == "1ST & 10, DOWN 4" and s.intro == "intro"
    assert len(s.real_drive_plays) == 3


def test_endless_picks_a_drive_that_needs_a_touchdown() -> None:
    """Only drives where the offense is tied or trailing; the latest one in the game."""
    import numpy as np
    from app.turning_points import random_endless_scenario
    game = pd.DataFrame([
        tp_play(1, 1, seconds_left=900, home=7, away=3),                    # AAA (away) down 4 -> eligible
        tp_play(2, 2, posteam="BBB", seconds_left=600, home=7, away=3),     # BBB (home) up 4 -> not
        tp_play(3, 3, seconds_left=300, home=10, away=10),                  # AAA tied -> eligible, latest
        tp_play(4, 4, posteam="BBB", seconds_left=120, home=10, away=10),   # BBB tied -> eligible, latest overall
    ])
    s = random_endless_scenario(game, field_wp, np.random.default_rng(0), intro_fn=lambda st, d: "intro")
    assert s.id == "2024_01_AAA_BBB_4"
    leading_only = pd.DataFrame([tp_play(1, 1, home=3, away=7)])          # AAA (away) up 4
    assert random_endless_scenario(leading_only, field_wp, np.random.default_rng(0), intro_fn=lambda st, d: "intro") is None


def test_close_game_pool() -> None:
    """Endless draws from games decided by 8 or fewer."""
    from app.turning_points import close_game_ids
    plays = pd.DataFrame([tp_play(1, 1, result=8) | {"game_id": "G1"}, tp_play(1, 1, result=-9) | {"game_id": "G2"}])
    assert close_game_ids(plays) == ["G1"]
