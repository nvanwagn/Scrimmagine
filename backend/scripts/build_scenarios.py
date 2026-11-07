"""Pick today's 6 scenarios: the top turning point from 6 close games, seeded by the date.

Run from backend/ once per day:  python -m scripts.build_scenarios [--date YYYY-MM-DD]
"""

import argparse
import json
from datetime import date

import numpy as np
import pandas as pd

from app.data_loader import SCENARIOS_PATH, load_plays
from app.models import Scenario
from app.turning_points import scenarios_for_game

DAILY_COUNT = 6
CLOSE_GAME_MARGIN = 8   # demo games: decided by one score or less


def demo_games(plays: pd.DataFrame, day: date) -> list[str]:
    """Close games in a date-seeded random order, so the set changes daily but is repeatable."""
    margins = plays.groupby("game_id")["result"].first().abs()
    close = sorted(margins[margins <= CLOSE_GAME_MARGIN].index)
    rng = np.random.default_rng(int(day.strftime("%Y%m%d")))
    return list(rng.permutation(close))


def pick_daily(plays: pd.DataFrame, day: date) -> list[Scenario]:
    """The best turning point from each of the first 6 usable demo games."""
    picked: list[Scenario] = []
    for game_id in demo_games(plays, day):
        found = scenarios_for_game(plays[plays["game_id"] == game_id], limit=1)
        picked.extend(found)
        if len(picked) == DAILY_COUNT:
            break
    return picked


def main() -> None:
    """Build the daily scenarios and write data/scenarios.json."""
    parser = argparse.ArgumentParser()
    parser.add_argument("--date", type=date.fromisoformat, default=date.today())
    day = parser.parse_args().date
    scenarios = pick_daily(load_plays(), day)
    SCENARIOS_PATH.write_text(json.dumps([s.model_dump(mode="json") for s in scenarios], indent=2),
                              encoding="utf-8")
    print(f"Wrote {len(scenarios)} scenarios for {day} to {SCENARIOS_PATH}")
    for s in scenarios:
        print(f"  {s.id:<26} {s.title:<18} lev={s.leverage_score:.3f}  real={s.real_call.value}")


if __name__ == "__main__":
    main()
