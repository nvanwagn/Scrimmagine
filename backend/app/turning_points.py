"""Turning point finder: rank a game's plays by leverage, keep the best play per drive."""

from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor

import pandas as pd

from app.ai import down_text, generate_intro
from app.models import GameState, PlayCall, Scenario

REAL_PLAY_TYPES = ["run", "pass", "punt", "field_goal"]
WP_MIN, WP_MAX = 0.05, 0.95
FOURTH_DOWN_BOOST = 1.5
LATE_HALF_BOOST = 1.25
LATE_HALF_SECONDS = 300

IntroFn = Callable[[GameState, str], str]


def score_plays(game: pd.DataFrame) -> pd.DataFrame:
    """Real plays outside garbage time, with a leverage_score column."""
    plays = game[game["play_type"].isin(REAL_PLAY_TYPES) & game["down"].notna() & game["wpa"].notna()]
    plays = plays[(plays["wp"] >= WP_MIN) & (plays["wp"] <= WP_MAX)].copy()
    score = plays["wpa"].abs()
    score = score.where(plays["down"] != 4, score * FOURTH_DOWN_BOOST)
    late = plays["qtr"].isin([2, 4]) & (plays["half_seconds_remaining"] < LATE_HALF_SECONDS)
    plays["leverage_score"] = score.where(~late, score * LATE_HALF_BOOST)
    return plays


def find_turning_points(game: pd.DataFrame, limit: int = 5) -> pd.DataFrame:
    """Top `limit` plays by leverage, at most one per drive, returned in game order."""
    plays = score_plays(game)
    if plays.empty:
        return plays
    best_per_drive = plays.loc[plays.groupby("drive")["leverage_score"].idxmax()]
    return best_per_drive.nlargest(limit, "leverage_score").sort_values("play_id")


def real_drive_wpa(game: pd.DataFrame, play: pd.Series) -> float:
    """The real coach's total WPA from this play to the end of its drive."""
    rest = game[(game["drive"] == play["drive"]) & (game["play_id"] >= play["play_id"])]
    return round(float(rest["wpa"].fillna(0).sum()), 4)


def state_from_row(play: pd.Series) -> GameState:
    """The GameState right before a real play."""
    home = play["posteam"] == play["home_team"]
    us = play["home_score_pre"] if home else play["away_score_pre"]
    them = play["away_score_pre"] if home else play["home_score_pre"]
    return GameState(
        offense=play["posteam"], defense=play["defteam"],
        offense_score=int(us), defense_score=int(them),
        quarter=int(play["qtr"]), seconds_left_in_game=int(play["game_seconds_remaining"]),
        down=int(play["down"]), distance=max(1, int(play["ydstogo"])),
        yardline_100=int(play["yardline_100"]),
        offense_timeouts=int(pd.Series([play["posteam_timeouts_remaining"]]).fillna(3)[0]),
        defense_timeouts=int(pd.Series([play["defteam_timeouts_remaining"]]).fillna(3)[0]),
    )


def real_call_from_row(play: pd.Series) -> PlayCall:
    """Map the real play to a PlayCall (sacks count as short passes: the length is unknown)."""
    if play["play_type"] == "pass":
        return PlayCall.deep_pass if play["pass_length"] == "deep" else PlayCall.short_pass
    return PlayCall(play["play_type"])


def scenario_title(state: GameState) -> str:
    """Short headline like '4TH & 2, DOWN 3'."""
    diff = state.offense_score - state.defense_score
    score = "TIED" if diff == 0 else f"{'UP' if diff > 0 else 'DOWN'} {abs(diff)}"
    return f"{down_text(state).upper()}, {score}"


def build_scenario(game: pd.DataFrame, play: pd.Series, intro: str) -> Scenario:
    """Turn one turning-point play into a Scenario."""
    state = state_from_row(play)
    return Scenario(
        id=f"{play['game_id']}_{int(play['play_id'])}", game_id=play["game_id"],
        title=scenario_title(state), intro=intro, start_state=state,
        real_call=real_call_from_row(play), real_play_desc=str(play["desc"]),
        real_drive_wpa=real_drive_wpa(game, play),
        leverage_score=round(float(play["leverage_score"]), 4),
    )


def scenarios_for_game(game: pd.DataFrame, limit: int = 5,
                       intro_fn: IntroFn = generate_intro) -> list[Scenario]:
    """Find a game's turning points and write their intros in parallel (each AI call times out at 3s)."""
    points = [row for _, row in find_turning_points(game, limit).iterrows()]
    if not points:
        return []
    with ThreadPoolExecutor(max_workers=len(points)) as pool:
        intros = list(pool.map(lambda p: intro_fn(state_from_row(p), str(p["desc"])), points))
    return [build_scenario(game, play, intro) for play, intro in zip(points, intros)]
