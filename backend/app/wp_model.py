"""Win probability: our trained HistGradientBoosting model, with a lookup-table fallback."""

from pathlib import Path

import joblib
import numpy as np
import pandas as pd

from app.models import GameState

FEATURES = [
    "score_differential", "game_seconds_remaining", "diff_per_time", "yardline_100",
    "down", "ydstogo", "posteam_timeouts_remaining", "defteam_timeouts_remaining",
]
SCORE_EDGES = [-17, -9, -4, -1, 0, 3, 8, 16]   # fallback score-differential buckets
TIME_EDGES = [120, 300, 900, 1800, 2700]        # fallback game-seconds buckets
ZONE_EDGES = [20, 49, 79]                       # same field zones as the simulator


def add_features(df: pd.DataFrame) -> pd.DataFrame:
    """Add the derived feature (score differential divided by time remaining + 1)."""
    df = df.copy()
    df["diff_per_time"] = df["score_differential"] / (df["game_seconds_remaining"] + 1)
    return df


def state_to_frame(state: GameState) -> pd.DataFrame:
    """One-row frame with the model features for a GameState."""
    row = pd.DataFrame([{
        "score_differential": state.offense_score - state.defense_score,
        "game_seconds_remaining": state.seconds_left_in_game,
        "yardline_100": state.yardline_100, "down": state.down, "ydstogo": state.distance,
        "posteam_timeouts_remaining": state.offense_timeouts,
        "defteam_timeouts_remaining": state.defense_timeouts,
    }])
    return add_features(row)[FEATURES]


def fallback_keys(score_diff: np.ndarray, seconds: np.ndarray, yardline: np.ndarray) -> list[tuple]:
    """Bucket keys (score, time, zone) for the lookup table."""
    s = np.searchsorted(SCORE_EDGES, score_diff, side="left")
    t = np.searchsorted(TIME_EDGES, seconds, side="left")
    z = np.searchsorted(ZONE_EDGES, yardline, side="left")
    return list(zip(s.tolist(), t.tolist(), z.tolist()))


def build_fallback_table(plays: pd.DataFrame) -> dict[tuple, float]:
    """Average nflverse wp by score differential, time bucket and field zone."""
    rows = plays.dropna(subset=["wp", "score_differential", "game_seconds_remaining", "yardline_100"])
    keys = fallback_keys(rows["score_differential"].to_numpy(),
                         rows["game_seconds_remaining"].to_numpy(), rows["yardline_100"].to_numpy())
    return rows["wp"].groupby(pd.Series(keys, index=rows.index)).mean().to_dict()


class WinProbModel:
    """Predicts the offense's chance of winning from a GameState."""

    def __init__(self, model: object | None, fallback: dict[tuple, float]) -> None:
        """Wrap a trained classifier (or None) and the fallback lookup table."""
        self.model = model
        self.fallback = fallback

    @classmethod
    def load(cls, model_path: Path, plays: pd.DataFrame) -> "WinProbModel":
        """Load the joblib model if present and build the fallback table from the plays."""
        model = joblib.load(model_path) if model_path.exists() else None
        return cls(model, build_fallback_table(plays))

    def predict_fallback(self, state: GameState) -> float:
        """Lookup-table WP for when the model is missing or fails."""
        key = fallback_keys(np.array([state.offense_score - state.defense_score]),
                            np.array([state.seconds_left_in_game]), np.array([state.yardline_100]))[0]
        return float(self.fallback.get(key, 0.5))

    def predict(self, state: GameState) -> float:
        """Offense win probability; exact when the game clock has hit zero."""
        if state.seconds_left_in_game == 0 and state.quarter <= 4:
            diff = state.offense_score - state.defense_score
            return 1.0 if diff > 0 else 0.0 if diff < 0 else 0.5
        if self.model is None:
            return self.predict_fallback(state)
        try:
            wp = float(self.model.predict_proba(state_to_frame(state))[0, 1])
        except Exception:
            return self.predict_fallback(state)
        return wp if np.isfinite(wp) else self.predict_fallback(state)

    __call__ = predict
