"""Preview a day's 6 scenarios and write them to data/scenarios.json.

The server picks each day's set by itself (GET /api/scenarios, seeded by today's date in US Eastern time),
so running this is optional: use it to see what a date will serve, or to inspect the JSON.

Run from backend/:  python -m scripts.build_scenarios [--date YYYY-MM-DD]
"""

import argparse
import json
from datetime import date

from app.data_loader import MODEL_PATH, SCENARIOS_PATH, load_plays
from app.turning_points import daily_date, daily_scenarios
from app.wp_model import WinProbModel


def main() -> None:
    """Pick the day's scenarios exactly like the server does and write data/scenarios.json."""
    parser = argparse.ArgumentParser()
    parser.add_argument("--date", type=date.fromisoformat, default=daily_date())
    day = parser.parse_args().date
    plays = load_plays()
    scenarios = daily_scenarios(plays, day, WinProbModel.load(MODEL_PATH, plays))
    SCENARIOS_PATH.write_text(json.dumps([s.model_dump(mode="json") for s in scenarios], indent=2),
                              encoding="utf-8")
    print(f"Wrote {len(scenarios)} scenarios for {day} to {SCENARIOS_PATH}")
    for s in scenarios:
        print(f"  {s.id:<26} {s.title:<18} lev={s.leverage_score:.3f}  real={s.real_call.value}")


if __name__ == "__main__":
    main()
