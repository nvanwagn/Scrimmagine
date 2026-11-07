"""Turning point finder: the start of the last drive of a one-possession game.

Starting at a drive's first snap (rather than its single biggest play) means the player
and the real coach both call a whole drive, so their WPA totals are a fair comparison.
"""

from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pandas as pd

from app.ai import down_text, generate_intro
from app.models import GameState, OffensePlayers, PlayCall, RealPlay, Scenario

REAL_PLAY_TYPES = ["run", "pass", "punt", "field_goal"]
COACH_ONLY_CALLS = {"qb_kneel": "kneel", "qb_spike": "spike"}   # real calls the player can't make
COACH_PLAY_TYPES = REAL_PLAY_TYPES + list(COACH_ONLY_CALLS)
WP_MIN, WP_MAX = 0.05, 0.95
ONE_POSSESSION = 8        # a touchdown plus a two-point conversion
MIN_SECONDS_LEFT = 60     # skip drives too short to make more than a play or two

IntroFn = Callable[[GameState, str], str]
WinProbFn = Callable[[GameState], float]


def drive_starts(game: pd.DataFrame) -> pd.DataFrame:
    """The first real snap of each drive, with the drive's total |WPA| as leverage_score."""
    plays = game[game["play_type"].isin(REAL_PLAY_TYPES) & game["down"].notna()]
    if plays.empty:
        return plays
    starts = plays.loc[plays.groupby("drive")["play_id"].idxmin()].copy()
    swing = plays.groupby("drive")["wpa"].apply(lambda wpa: wpa.abs().sum())
    starts["leverage_score"] = starts["drive"].map(swing).fillna(0.0)
    return starts


def find_turning_points(game: pd.DataFrame, limit: int = 5) -> pd.DataFrame:
    """The last `limit` drives that start within one score, outside garbage time, with
    at least a minute left. Returned in game order; limit=1 gives the game's final such drive."""
    starts = drive_starts(game)
    if starts.empty:
        return starts
    margin = (starts["home_score_pre"] - starts["away_score_pre"]).abs()
    live = starts["wp"].between(WP_MIN, WP_MAX)
    enough_time = starts["game_seconds_remaining"] >= MIN_SECONDS_LEFT
    eligible = starts[(margin <= ONE_POSSESSION) & live & enough_time]
    return eligible.nlargest(limit, "play_id").sort_values("play_id")


# ---------- the real coach's drive, scored with OUR win probability model ----------

def coach_snaps(game: pd.DataFrame) -> pd.DataFrame:
    """Every snap a coach called (real plays plus kneels and spikes), in game order."""
    snaps = game[game["play_type"].isin(COACH_PLAY_TYPES) & game["down"].notna()]
    return snaps.sort_values("play_id")


def coach_call(play: pd.Series) -> str:
    """PlayCall value for the snap, or 'kneel' / 'spike'."""
    if play["play_type"] in COACH_ONLY_CALLS:
        return COACH_ONLY_CALLS[play["play_type"]]
    return real_call_from_row(play).value


def final_result_wp(game: pd.DataFrame, team: str) -> float:
    """1 if `team` won the game, 0 if it lost, 0.5 for a tie (nflverse result = home - away)."""
    first = game.iloc[0]
    margin = float(first["result"]) * (1 if team == first["home_team"] else -1)
    return 1.0 if margin > 0 else 0.0 if margin < 0 else 0.5


def drive_end_wp(game: pd.DataFrame, last: pd.Series, team: str, win_prob: WinProbFn) -> float:
    """`team`'s WP once the drive is over: at the game's next snap, or the final result."""
    later = coach_snaps(game)
    later = later[later["play_id"] > last["play_id"]]
    if later.empty:
        return final_result_wp(game, team)
    nxt = later.iloc[0]
    wp = win_prob(state_from_row(nxt))
    return wp if nxt["posteam"] == team else 1 - wp


def coach_drive(game: pd.DataFrame, start: pd.Series, win_prob: WinProbFn) -> tuple[list[RealPlay], float]:
    """Each snap of the real drive from `start` on, and the drive's total WPA, all from our model.

    The first wp_before equals what /api/simulate reports for the scenario's start state,
    so the player and the coach start from the same number.
    """
    team = start["posteam"]
    snaps = coach_snaps(game)
    drive = snaps[(snaps["drive"] == start["drive"]) & (snaps["play_id"] >= start["play_id"])]
    states = [state_from_row(row) for _, row in drive.iterrows()]
    wps = [win_prob(s) if s.offense == team else 1 - win_prob(s) for s in states]
    end = drive_end_wp(game, drive.iloc[-1], team, win_prob)
    afters = wps[1:] + [end]
    plays = [
        RealPlay(state=s, call=coach_call(row), description=str(row["desc"]),
                 wp_before=round(b, 4), wp_after=round(a, 4), wpa=round(a - b, 4))
        for s, (_, row), b, a in zip(states, drive.iterrows(), wps, afters)
    ]
    return plays, round(end - wps[0], 4)


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


# ---------- the offense's skill players in that game ----------

def most_frequent(names: pd.Series, exclude: str | None = None) -> str | None:
    """The most common non-null name (ties go to whoever appears first), skipping `exclude`."""
    names = names.dropna()
    if exclude is not None:
        names = names[names != exclude]
    return str(names.value_counts(sort=True).index[0]) if not names.empty else None


def offense_players(game: pd.DataFrame, team: str) -> OffensePlayers:
    """The team's QB, RB and top target in this game. Missing name columns give None."""
    ours = game[game["posteam"] == team]

    def pick(column: str, exclude: str | None = None) -> str | None:
        return most_frequent(ours[column], exclude) if column in ours else None

    qb = pick("passer_player_name")
    return OffensePlayers(qb=qb, rb=pick("rusher_player_name", exclude=qb), wr=pick("receiver_player_name"))


def build_scenario(game: pd.DataFrame, play: pd.Series, intro: str, win_prob: WinProbFn) -> Scenario:
    """Turn one drive-start play into a Scenario, with the real drive scored by our model."""
    state = state_from_row(play)
    plays, drive_wpa = coach_drive(game, play, win_prob)
    return Scenario(
        id=f"{play['game_id']}_{int(play['play_id'])}", game_id=play["game_id"],
        title=scenario_title(state), intro=intro, start_state=state,
        real_call=real_call_from_row(play), real_play_desc=str(play["desc"]),
        real_drive_wpa=drive_wpa, leverage_score=round(float(play["leverage_score"]), 4),
        real_drive_plays=plays, offense_players=offense_players(game, play["posteam"]),
    )


def scenarios_for_game(game: pd.DataFrame, win_prob: WinProbFn, limit: int = 5,
                       intro_fn: IntroFn = generate_intro) -> list[Scenario]:
    """Find a game's turning points and write their intros in parallel (each AI call times out at 3s).

    win_prob must be our WP model (the one /api/simulate uses) so the coach and the player
    are scored on the same scale.
    """
    points = [row for _, row in find_turning_points(game, limit).iterrows()]
    if not points:
        return []
    with ThreadPoolExecutor(max_workers=len(points)) as pool:
        intros = list(pool.map(lambda p: intro_fn(state_from_row(p), str(p["desc"])), points))
    return [build_scenario(game, play, intro, win_prob) for play, intro in zip(points, intros)]


# ---------- endless mode ----------

ENDLESS_TRIES = 60   # random close games to look through before giving up


def close_game_ids(plays: pd.DataFrame) -> list[str]:
    """Games decided by one score or less (final margin <= 8), sorted for repeatability."""
    margins = plays.groupby("game_id")["result"].first().abs()
    return sorted(margins[margins <= ONE_POSSESSION].index)


def needs_touchdown(starts: pd.DataFrame) -> pd.DataFrame:
    """Drive starts where the offense is tied or trailing, so a touchdown is the goal."""
    home = starts["posteam"] == starts["home_team"]
    ours = starts["home_score_pre"].where(home, starts["away_score_pre"])
    theirs = starts["away_score_pre"].where(home, starts["home_score_pre"])
    return starts[ours <= theirs]


def random_endless_scenario(plays: pd.DataFrame, win_prob: WinProbFn, rng: np.random.Generator,
                            intro_fn: IntroFn = generate_intro,
                            game_ids: list[str] | None = None) -> Scenario | None:
    """A random close game's last one-possession drive where the offense needs a touchdown.

    Uses the same drive rules as the daily set (find_turning_points); None if no game qualifies.
    """
    ids = game_ids if game_ids is not None else close_game_ids(plays)
    for game_id in rng.permutation(ids)[:ENDLESS_TRIES]:
        game = plays[plays["game_id"] == game_id]
        candidates = needs_touchdown(find_turning_points(game, limit=10))
        if candidates.empty:
            continue
        play = candidates.iloc[-1]
        return build_scenario(game, play, intro_fn(state_from_row(play), str(play["desc"])), win_prob)
    return None
