"""Train the win probability model, sanity-check it against nflverse wp, save wp_model.joblib.

Run from backend/:  python -m scripts.train_wp
"""

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier

from app.data_loader import MODEL_PATH, PBP_PATH
from app.wp_model import FEATURES, add_features

HOLDOUT_SHARE = 0.2
SEED = 7


def training_rows(pbp: pd.DataFrame) -> pd.DataFrame:
    """Real snaps with features, a label (did the team with the ball win?) and no ties."""
    rows = pbp.dropna(subset=["posteam", "down", "ydstogo", "yardline_100", "score_differential",
                              "game_seconds_remaining", "wp"])
    rows = rows[rows["result"] != 0]
    home_won = rows["result"] > 0
    rows = rows.assign(label=((rows["posteam"] == rows["home_team"]) == home_won).astype(int))
    return add_features(rows)


def split_by_game(rows: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Hold out whole games so the check measures unseen games."""
    games = rows["game_id"].unique()
    rng = np.random.default_rng(SEED)
    held_out = set(rng.choice(games, size=int(len(games) * HOLDOUT_SHARE), replace=False))
    is_held = rows["game_id"].isin(held_out)
    return rows[~is_held], rows[is_held]


def train(rows: pd.DataFrame) -> HistGradientBoostingClassifier:
    """Fit the gradient boosting classifier on the feature columns."""
    # Small trees + large leaves + L2 keep the model smooth; 2 seasons is not much data.
    model = HistGradientBoostingClassifier(max_iter=100, learning_rate=0.05, max_leaf_nodes=15,
                                           min_samples_leaf=500, l2_regularization=1.0,
                                           random_state=SEED)
    return model.fit(rows[FEATURES], rows["label"])


def sanity_check(model: HistGradientBoostingClassifier, held_out: pd.DataFrame) -> float:
    """Mean absolute difference between our WP and nflverse wp on held-out games."""
    ours = model.predict_proba(held_out[FEATURES])[:, 1]
    return float(np.mean(np.abs(ours - held_out["wp"].to_numpy())))


def main() -> None:
    """Train on 80% of games, check on 20%, then refit on everything and save."""
    rows = training_rows(pd.read_parquet(PBP_PATH))
    train_rows, held_out = split_by_game(rows)
    mad = sanity_check(train(train_rows), held_out)
    print(f"Trained on {len(train_rows):,} plays, checked on {len(held_out):,} held-out plays "
          f"({held_out['game_id'].nunique()} games).")
    print(f"WP sanity check: mean absolute difference from nflverse wp = {mad:.4f} (target <= ~0.05)")
    joblib.dump(train(rows), MODEL_PATH)
    print(f"Saved model trained on all {len(rows):,} plays to {MODEL_PATH}")


if __name__ == "__main__":
    main()
