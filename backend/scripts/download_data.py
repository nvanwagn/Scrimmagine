"""Fetch 2024-2025 nflverse play-by-play, keep only the columns we use, save to data/pbp.parquet."""

from pathlib import Path

import nflreadpy
import pandas as pd

SEASONS = [2024, 2025]
DATA_DIR = Path(__file__).resolve().parents[1] / "data"
OUT_PATH = DATA_DIR / "pbp.parquet"

COLUMNS = [
    "game_id", "play_id", "season", "week", "home_team", "away_team", "posteam", "defteam",
    "qtr", "game_seconds_remaining", "half_seconds_remaining", "down", "ydstogo",
    "yardline_100", "score_differential", "posteam_timeouts_remaining",
    "defteam_timeouts_remaining", "play_type", "pass_length", "yards_gained", "touchdown",
    "interception", "fumble_lost", "sack", "field_goal_result", "kick_distance", "wp", "wpa",
    "desc", "drive", "total_home_score", "total_away_score", "result",
]


def download() -> pd.DataFrame:
    """Download the play-by-play seasons and trim to the used columns."""
    pbp = nflreadpy.load_pbp(SEASONS).to_pandas()
    missing = [c for c in COLUMNS if c not in pbp.columns]
    if missing:
        raise SystemExit(f"Missing expected columns: {missing}")
    return pbp[COLUMNS]


def main() -> None:
    """Download, save, and print a quick confirmation of the data."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    pbp = download()
    pbp.to_parquet(OUT_PATH, index=False)
    print(f"Saved {len(pbp):,} plays from {pbp['game_id'].nunique()} games to {OUT_PATH}")
    print(f"All {len(COLUMNS)} columns present.")
    print(pbp[["game_id", "posteam", "qtr", "down", "ydstogo", "yardline_100", "play_type", "wp"]]
          .dropna(subset=["down"]).head(5).to_string(index=False))


if __name__ == "__main__":
    main()
