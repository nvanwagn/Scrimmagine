"""Simulator tests: valid results for every call, bucket fallbacks, possession changes, clock."""

import numpy as np
import pandas as pd
import pytest

from app.data_loader import PBP_PATH
from app.models import GameState, Outcome, PlayCall, SimulateResponse
from app.simulator import (FG_MAX_DISTANCE, MIN_BUCKET, apply_field_goal, apply_punt, apply_scrimmage,
                           build_pools, field_goal_make_chance, find_bucket, run_clock, simulate)
from conftest import full_grid, make_play


def scrimmage_row(**fields: object) -> pd.Series:
    """A single run/pass row in the shape build_pools produces."""
    row = make_play(999, "run", 1, 10, 50, **fields)
    row["incomplete"] = "incomplete" in str(row["desc"])
    return pd.Series(row)


def situations(base: GameState) -> list[GameState]:
    """A spread of situations, including edge cases."""
    return [
        base,
        base.model_copy(update={"down": 4, "distance": 1, "yardline_100": 2}),
        base.model_copy(update={"down": 1, "distance": 10, "yardline_100": 99}),
        base.model_copy(update={"down": 3, "distance": 25, "yardline_100": 75}),
        base.model_copy(update={"quarter": 4, "seconds_left_in_game": 10, "down": 4}),
        base.model_copy(update={"quarter": 2, "seconds_left_in_game": 1805}),
        base.model_copy(update={"quarter": 5, "seconds_left_in_game": 300}),
    ]


@pytest.mark.parametrize("call", list(PlayCall))
def test_every_call_returns_valid_response(grid_plays: pd.DataFrame, state: GameState, call: PlayCall) -> None:
    """Every play call returns a SimulateResponse that re-validates, across many situations."""
    pools = build_pools(grid_plays)
    rng = np.random.default_rng(0)
    for situation in situations(state):
        for _ in range(25):
            response = simulate(situation, call, pools, lambda s: 0.5, rng)
            assert isinstance(response, SimulateResponse)
            SimulateResponse.model_validate(response.model_dump())
            assert response.result.call == call
            assert response.wpa == pytest.approx(response.wp_after - response.wp_before, abs=1e-3)


@pytest.mark.skipif(not PBP_PATH.exists(), reason="real data not downloaded")
@pytest.mark.parametrize("call", list(PlayCall))
def test_every_call_valid_on_real_data(state: GameState, call: PlayCall) -> None:
    """Same check against the real 2024-2025 play pools."""
    from app.data_loader import load_plays
    pools = build_pools(load_plays())
    rng = np.random.default_rng(1)
    for situation in situations(state):
        for _ in range(10):
            SimulateResponse.model_validate(simulate(situation, call, pools, lambda s: 0.5, rng).model_dump())


def test_full_bucket_used_when_large_enough(grid_plays: pd.DataFrame, state: GameState) -> None:
    """With 30+ plays in the exact bucket, only that bucket is sampled."""
    bucket = find_bucket(build_pools(grid_plays).runs, state)
    assert len(bucket) >= MIN_BUCKET
    assert set(bucket["down"]) == {2} and set(bucket["dist_b"]) == {3} and set(bucket["zone"]) == {1}


def test_bucket_drops_field_zone_first(state: GameState) -> None:
    """A thin bucket (< 30) widens to all field zones for the same down and distance."""
    rows = [make_play(i, "run", 2, 7, 40) for i in range(10)]          # exact bucket: 10 plays
    rows += [make_play(100 + i, "run", 2, 7, 90) for i in range(25)]   # same down/dist, other zone
    rows += [make_play(200 + i, "run", 2, 2, 40) for i in range(50)]   # other distance
    bucket = find_bucket(build_pools(pd.DataFrame(rows)).runs, state)
    assert len(bucket) == 35
    assert set(bucket["dist_b"]) == {3} and set(bucket["zone"]) == {1, 3}


def test_bucket_merges_distances_next(state: GameState) -> None:
    """If down + distance is still thin, neighbouring distance buckets are merged in."""
    rows = [make_play(i, "run", 2, 7, 40) for i in range(10)]          # 7-10 bucket
    rows += [make_play(100 + i, "run", 2, 5, 40) for i in range(25)]   # 4-6 (neighbour)
    rows += [make_play(200 + i, "run", 2, 1, 40) for i in range(50)]   # 1 (three buckets away)
    bucket = find_bucket(build_pools(pd.DataFrame(rows)).runs, state)
    assert len(bucket) == 35
    assert set(bucket["dist_b"]) == {2, 3}


def test_bucket_falls_back_to_whole_pool(state: GameState) -> None:
    """With fewer than 30 plays anywhere on that down, the whole pool is used (never empty)."""
    rows = [make_play(i, "run", 1, 10, 40) for i in range(5)]
    bucket = find_bucket(build_pools(pd.DataFrame(rows)).runs, state)
    assert len(bucket) == 5


def test_touchdown_scores_and_flips(state: GameState) -> None:
    """A gain past the goal line is capped, scores 7 and the defense receives the kickoff."""
    out = apply_scrimmage(state, PlayCall.run, scrimmage_row(yards=55))
    assert out.result.outcome == Outcome.touchdown and out.result.yards == 40
    assert out.new_state.offense == "NVY" and out.new_state.offense_score == 20
    assert out.new_state.defense_score == 24 and out.new_state.yardline_100 == 70
    assert out.drive_over and out.possession_flipped


def test_interception_flips_at_spot(state: GameState) -> None:
    """An interception gives the defense the ball at the spot, from its own view."""
    out = apply_scrimmage(state, PlayCall.deep_pass, scrimmage_row(yards=0, interception=1))
    assert out.result.outcome == Outcome.turnover
    assert out.new_state.offense == "NVY" and out.new_state.yardline_100 == 60
    assert out.new_state.down == 1 and out.drive_over and out.possession_flipped


def test_fumble_lost_flips(state: GameState) -> None:
    """A lost fumble after a 5-yard gain flips possession at the fumble spot."""
    out = apply_scrimmage(state, PlayCall.run, scrimmage_row(yards=5, fumble_lost=1))
    assert out.result.outcome == Outcome.turnover and out.new_state.yardline_100 == 65
    assert out.new_state.offense_timeouts == state.defense_timeouts


def test_defensive_touchdown_keeps_ball_with_offense(state: GameState) -> None:
    """A pick-six adds 7 for the defense and the original offense receives the kickoff."""
    out = apply_scrimmage(state, PlayCall.short_pass, scrimmage_row(yards=0, interception=1, touchdown=1))
    assert out.result.outcome == Outcome.turnover and out.drive_over
    assert not out.possession_flipped and out.new_state.offense == "CRM"
    assert out.new_state.defense_score == 27


def test_turnover_on_downs_flips(state: GameState) -> None:
    """Coming up short on 4th down hands the ball over at the spot."""
    fourth = state.model_copy(update={"down": 4, "distance": 5})
    out = apply_scrimmage(fourth, PlayCall.run, scrimmage_row(yards=2))
    assert out.result.outcome == Outcome.turnover_on_downs
    assert out.new_state.offense == "NVY" and out.new_state.yardline_100 == 62
    assert out.drive_over and out.possession_flipped


def test_fourth_down_conversion_keeps_ball(state: GameState) -> None:
    """Converting on 4th down is a first down for the same offense."""
    fourth = state.model_copy(update={"down": 4, "distance": 2})
    out = apply_scrimmage(fourth, PlayCall.short_pass, scrimmage_row(yards=7))
    assert out.result.outcome == Outcome.first_down and out.new_state.offense == "CRM"
    assert out.new_state.down == 1 and out.new_state.yardline_100 == 33 and not out.drive_over


def test_gain_advances_down(state: GameState) -> None:
    """A short gain moves to the next down with the remaining distance."""
    out = apply_scrimmage(state, PlayCall.run, scrimmage_row(yards=3))
    assert out.result.outcome == Outcome.gain
    assert (out.new_state.down, out.new_state.distance, out.new_state.yardline_100) == (3, 4, 37)


def test_safety_scores_two_and_flips(state: GameState) -> None:
    """A loss behind the own goal line is a safety: 2 points and a flip."""
    backed_up = state.model_copy(update={"yardline_100": 98})
    out = apply_scrimmage(backed_up, PlayCall.short_pass, scrimmage_row(yards=-6, sack=1))
    assert out.result.yards == -2 and out.new_state.offense == "NVY"
    assert out.new_state.offense_score == 22 and out.possession_flipped


def test_punt_flips_possession(state: GameState) -> None:
    """A 40-yard net punt from your own 30 gives the defense the ball at its own 30."""
    own_30 = state.model_copy(update={"down": 4, "yardline_100": 70})
    row = pd.Series(make_play(5, "punt", 4, 10, 70, punt_net_yards=40))
    out = apply_punt(own_30, row)
    assert out.result.outcome == Outcome.punt and out.result.yards == 40
    assert out.new_state.offense == "NVY" and out.new_state.yardline_100 == 70
    assert out.drive_over and out.possession_flipped


def test_field_goal_made_and_missed(state: GameState) -> None:
    """Made kicks add 3 and kick off; misses give the ball back at the spot of the kick."""
    made = apply_field_goal(state, pd.Series(make_play(1, "field_goal", 4, 5, 40, field_goal_result="made")))
    assert made.result.outcome == Outcome.fg_made and made.new_state.defense_score == 20
    assert made.new_state.offense == "NVY" and made.possession_flipped
    missed = apply_field_goal(state, pd.Series(make_play(2, "field_goal", 4, 5, 40, field_goal_result="missed")))
    assert missed.result.outcome == Outcome.fg_missed and missed.new_state.yardline_100 == 53


def test_field_goal_chance_fades_past_the_data() -> None:
    """Real make rate up to the kicks' average distance, then a linear fade to 0 at 70 yards."""
    kicks = pd.DataFrame({"kick_distance": [64.0] * 4, "field_goal_result": ["made"] * 4})
    assert field_goal_make_chance(kicks, 60) == 1.0
    assert field_goal_make_chance(kicks, 67) == pytest.approx(0.5)
    assert field_goal_make_chance(kicks, FG_MAX_DISTANCE) == 0.0
    assert field_goal_make_chance(kicks, 116) == 0.0


@pytest.mark.skipif(not PBP_PATH.exists(), reason="real data not downloaded")
def test_impossible_field_goals_always_miss(state: GameState) -> None:
    """A 116-yard try never goes in; a chip shot almost always does."""
    from app.data_loader import load_plays
    pools = build_pools(load_plays())
    rng = np.random.default_rng(2)
    deep = state.model_copy(update={"down": 4, "yardline_100": 99})
    assert all(simulate(deep, PlayCall.field_goal, pools, lambda s: 0.5, rng).result.outcome == Outcome.fg_missed
               for _ in range(200))
    close = state.model_copy(update={"down": 4, "distance": 5, "yardline_100": 5})
    made = sum(simulate(close, PlayCall.field_goal, pools, lambda s: 0.5, rng).result.outcome == Outcome.fg_made
               for _ in range(200))
    assert made >= 180


def test_clock_rules(state: GameState) -> None:
    """30s for a running play, 15s in the last 2 minutes, and the half stops at 1800."""
    assert run_clock(state, 30).seconds_left_in_game == 1470
    late = state.model_copy(update={"quarter": 4, "seconds_left_in_game": 100})
    assert run_clock(late, 6).seconds_left_in_game == 85
    first_half = state.model_copy(update={"quarter": 2, "seconds_left_in_game": 1810})
    out = apply_scrimmage(first_half, PlayCall.run, scrimmage_row(yards=3))
    assert out.new_state.seconds_left_in_game == 1800 and out.drive_over


def test_full_grid_fixture_is_dense() -> None:
    """Sanity check on the fixture itself."""
    assert len(full_grid()) > 7000
