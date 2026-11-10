"""Load pbp.parquet and the WP model into memory once at startup."""

from dataclasses import dataclass
from pathlib import Path

import pandas as pd

from app.models import Game
from app.simulator import PlayPools, build_pools
from app.wp_model import WinProbModel

DATA_DIR = Path(__file__).resolve().parents[1] / "data"
PBP_PATH = DATA_DIR / "pbp.parquet"
MODEL_PATH = DATA_DIR / "wp_model.joblib"
SCENARIOS_PATH = DATA_DIR / "scenarios.json"


@dataclass
class DataStore:
    """Everything the API serves, held in memory."""

    plays: pd.DataFrame
    pools: PlayPools
    wp: WinProbModel
    games: list[Game]


def add_pre_play_scores(df: pd.DataFrame) -> pd.DataFrame:
    """Add home/away scores before each play (nflverse totals are after the play)."""
    by_game = df.groupby("game_id", sort=False)
    df["home_score_pre"] = by_game["total_home_score"].shift(1).fillna(0).astype(int)
    df["away_score_pre"] = by_game["total_away_score"].shift(1).fillna(0).astype(int)
    return df


def add_punt_net_yards(df: pd.DataFrame) -> pd.DataFrame:
    """Add net punt yards, measured from where the receiving team's next snap starts."""
    snaps = df[df["down"].notna() & df["yardline_100"].notna()]
    by_game = snaps.groupby("game_id", sort=False)
    next_team = by_game["posteam"].shift(-1)
    next_yardline = by_game["yardline_100"].shift(-1)
    same_half = (snaps["qtr"] <= 2) == (by_game["qtr"].shift(-1) <= 2)
    is_clean_punt = (snaps["play_type"] == "punt") & (next_team == snaps["defteam"]) & same_half
    net = snaps["yardline_100"] - (100 - next_yardline)
    df["punt_net_yards"] = net.where(is_clean_punt)
    return df


def load_plays(path: Path = PBP_PATH) -> pd.DataFrame:
    """Read the trimmed play-by-play parquet and add derived columns."""
    df = pd.read_parquet(path).sort_values(["game_id", "play_id"]).reset_index(drop=True)
    df = add_pre_play_scores(df)
    return add_punt_net_yards(df)


def build_games(plays: pd.DataFrame) -> list[Game]:
    """One Game per game_id with its final score."""
    grouped = plays.groupby("game_id", sort=True).agg(
        season=("season", "first"), week=("week", "first"),
        home_team=("home_team", "first"), away_team=("away_team", "first"),
        home_score=("total_home_score", "max"), away_score=("total_away_score", "max"),
    )
    return [Game(game_id=gid, **{k: (v if isinstance(v, str) else int(v)) for k, v in row.items()})
            for gid, row in grouped.iterrows()]


def load_store() -> DataStore:
    """Build the in-memory DataStore from the files in data/."""
    plays = load_plays()
    return DataStore(
        plays=plays,
        pools=build_pools(plays),
        wp=WinProbModel.load(MODEL_PATH, plays),
        games=build_games(plays),
    )
