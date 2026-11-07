# Scrimmagine backend

FastAPI server for Scrimmagine. It samples real 2024-2025 NFL plays to simulate your call and scores you against the real coach using win probability added (WPA).
There is no database: the play-by-play parquet, the WP model and `scenarios.json` are loaded into memory once at startup.

## Setup (Windows PowerShell, from `backend/`)

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env      # optional: add ANTHROPIC_API_KEY and CLAUDE_MODEL
```

macOS/Linux: `source .venv/bin/activate` and `cp .env.example .env`.

Without a key the game still works fully, because commentary and intros fall back to template lines.
`.env` is read at startup; real environment variables take precedence over it.

## Run the scripts in this order (from `backend/`)

```powershell
python -m scripts.download_data     # 1. fetch 2024+2025 pbp, trim columns -> data/pbp.parquet (~1 min)
python -m scripts.train_wp          # 2. train + sanity-check + save data/wp_model.joblib (~30 s)
python -m scripts.build_scenarios   # 3. today's 6 scenarios -> data/scenarios.json (run once per day)
python -m pytest                    # tests
uvicorn app.main:app --port 8000    # serve the API (and /sprites, and frontend/ at / if it exists)
```

`build_scenarios` accepts `--date YYYY-MM-DD` to rebuild a given day's set. Restart the server after rebuilding.

Last sanity check: our WP vs nflverse `wp` on 113 held-out games, mean absolute difference **0.043**.

## Endpoints

| Method | Path | Body / params | Returns |
|---|---|---|---|
| GET | `/api/scenarios` | none | today's 6 `Scenario`s |
| GET | `/api/games` | `season`, `team` (optional) | `Game` list (teams, week, final score) |
| GET | `/api/games/{game_id}/turning-points` | `limit` (default 5) | `Scenario` list for that game |
| POST | `/api/simulate` | `state`, `call` | `SimulateResponse` |
| POST | `/api/commentary` | `state_before`, `call`, `result`, `wp_before`, `wp_after` | `Commentary` |

Interactive docs: http://localhost:8000/docs. Sprites: http://localhost:8000/sprites/crimson_ready.png

All WP values in `SimulateResponse` are from the **original offense's** point of view, even after possession flips.

## curl examples (Git Bash / macOS / Linux; in PowerShell use `curl.exe` and put the JSON in a file with `--data @file.json`)

```bash
curl http://localhost:8000/api/scenarios

curl "http://localhost:8000/api/games?season=2025&team=KC"

curl "http://localhost:8000/api/games/2025_12_PHI_DAL/turning-points?limit=5"

curl -X POST http://localhost:8000/api/simulate -H "Content-Type: application/json" -d '{
  "state": {"offense":"DAL","defense":"PHI","offense_score":21,"defense_score":21,"quarter":4,
            "seconds_left_in_game":325,"down":4,"distance":13,"yardline_100":60,
            "offense_timeouts":3,"defense_timeouts":3},
  "call": "punt"}'

curl -X POST http://localhost:8000/api/commentary -H "Content-Type: application/json" -d '{
  "state_before": {"offense":"DAL","defense":"PHI","offense_score":21,"defense_score":21,"quarter":4,
                   "seconds_left_in_game":325,"down":4,"distance":13,"yardline_100":60,
                   "offense_timeouts":3,"defense_timeouts":3},
  "call": "punt",
  "result": {"call":"punt","yards":50,"outcome":"punt",
             "description":"Punt, net 50 yards. PHI takes over at their own 10.","sampled_play_id":3323},
  "wp_before": 0.5257, "wp_after": 0.4053}'
```

## Simplifications to mention to judges

- **Clock:** 30 s for a run, completion or sack (15 s in the last 2 minutes of a half); 6 s for an incompletion, interception or kick, at any time.
- **Scoring:** touchdowns are worth 7 (extra point assumed). After any score, the receiving team starts at its own 30.
- **Safety:** the API has no `safety` outcome, so it is reported as `turnover` with "SAFETY!" in the description. The defense gets 2 points and receives at its own 40.
- **Punts:** net yards come from where the receiving team's next real snap started (nflverse `yards_gained` is 0 on punts).
- **Passes:** sacks have no pass length, so they are mixed into both the short and deep pools at their real rate in the bucket.
- **Field goals:** the attempt distance is yardline_100 + 17. A real kick is sampled from within 3 yards of that distance (or from the 30 nearest kicks if there are too few). A miss gives the ball back at the spot of the kick, or the 20, whichever is better for the defense.
- **Thin buckets:** when a bucket has fewer than 30 plays, drop the field zone, then merge neighbouring distance buckets, then fall back to all plays on that down, then the whole pool. `/api/simulate` always returns a result.
- **Claude calls:** 3 s timeout, no retries, capped at 30 a minute. On any failure we use template text. Commentary is cached for repeated situations.
