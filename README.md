# Scrimmagine - Indy Init Hackathon Project

Call the plays at the biggest moments of real NFL games. Each day brings 6 scenarios: the final one-possession drive of a close 2024 or 2025 game. You pick run, short pass, deep pass, punt or field goal on every snap. Each call is simulated by sampling a real NFL play from the same situation, and you're scored against the real coach's drive using win probability added (WPA). An AI broadcast booth (Claude) reacts to every call, with offline template lines when no API key is set.

## Repo layout

| Path | What it is |
|---|---|
| `backend/` | FastAPI server: play simulator, win probability model, turning-point finder, Claude commentary |
| `backend/scripts/` | One-off data scripts: download play-by-play, train the WP model, build the day's scenarios |
| `backend/data/` | Generated data (git-ignored): `pbp.parquet`, `wp_model.joblib`, `scenarios.json` |
| `backend/tests/` | pytest suite |
| `frontend/` | Plain HTML/CSS/JS game client, served by the backend at `/` |
| `sprites/`, `sound-effects/` | Pixel-art sprites and sounds, served at `/sprites` and `/sound-effects` |
| `scrimmagine-mockups/` | UI mockups |
| `Dockerfile` | One image with the backend, the frontend and pre-built data |
| `Indy Init Design Doc.pdf` | Design document |

There is no database: the server loads the play-by-play parquet, the WP model and `scenarios.json` into memory once at startup.

## Requirements

- Python 3.13 (the version it was built and tested on)
- Internet access for the first data download (nflverse). Afterwards the game runs fully offline.
- Optional: an Anthropic API key for AI commentary and scenario intros

## Setup (Windows PowerShell)

All commands from here on run from the `backend/` folder, inside its virtual environment.

```powershell
cd backend
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env      # optional: add ANTHROPIC_API_KEY and CLAUDE_MODEL
```

macOS/Linux: `source .venv/bin/activate` and `cp .env.example .env`.

Without a key the game still works fully, because commentary and intros fall back to template lines.
`backend/.env` is read at startup; real environment variables take precedence over it.

## Build the data (from `backend/`, run in this order)

```powershell
python -m scripts.download_data     # 1. fetch 2024+2025 pbp, trim columns -> data/pbp.parquet (~1 min)
python -m scripts.train_wp          # 2. train + sanity-check + save data/wp_model.joblib (~30 s)
python -m scripts.build_scenarios   # 3. today's 6 scenarios -> data/scenarios.json (run once per day)
python -m pytest                    # optional: run the tests
```

Steps 1 and 2 only need to run once. Run step 3 each day for a new set of 6 scenarios. It accepts `--date YYYY-MM-DD` to rebuild a given day's set; restart the server afterwards.

Last sanity check: our WP vs nflverse `wp` on 113 held-out games, mean absolute difference **0.043**.

## Play it on localhost

The FastAPI server also serves the game itself (`frontend/` at `/`, plus `/sprites` and `/sound-effects`), so one command runs everything.

1. Do the setup and build the data above once. `backend/data/` should contain `pbp.parquet`, `wp_model.joblib` and `scenarios.json`.
2. From `backend/`, start the server with the venv's Python:

   ```powershell
   python -m uvicorn app.main:app --port 8000
   ```

   Wait for `Application startup complete.` (loading the data takes a few seconds). Add `--reload` while you are editing backend code.
3. Open **http://localhost:8000** in a browser and pick one of today's scenarios, or try endless mode.
4. Stop the server with `Ctrl+C`.

Troubleshooting:

- **numpy `RuntimeWarning`s on startup** (`invalid value encountered in exp2`): the server is running on your system Python, not the venv. Activate `.venv` and use `python -m uvicorn`, or run `.venv\Scripts\python.exe -m uvicorn app.main:app --port 8000`.
- **"Couldn't load today's scenarios"**: the server isn't running, or `backend/data/scenarios.json` is missing. Run `python -m scripts.build_scenarios`, then restart the server.
- **Port 8000 already in use**: run `python -m uvicorn app.main:app --port 8001` and open http://localhost:8001.
- **Open the game through the server, not a static file server** like VS Code Live Server. The frontend calls `/api/...` on the origin it was loaded from.
- **No AI commentary**: without `ANTHROPIC_API_KEY` and `CLAUDE_MODEL` in `backend/.env`, the booth uses template lines. That's expected.

## Run with Docker (from the repo root)

The image builds the data during the build, so the container needs no setup:

```powershell
docker build -t scrimmagine --build-arg DATA_DATE=2026-11-07 .
docker run --rm -p 8000:8000 scrimmagine
```

Then open http://localhost:8000. Pass a new `DATA_DATE` to rebuild with a fresh set of scenarios. Scenario intros built inside the image use templates because no API key is available at build time. To get live commentary, add `-e ANTHROPIC_API_KEY=... -e CLAUDE_MODEL=...` to `docker run`.

## Endpoints

| Method | Path | Body / params | Returns |
|---|---|---|---|
| GET | `/api/scenarios` | none | today's 6 `Scenario`s |
| GET | `/api/games` | `season`, `team` (optional) | `Game` list (teams, week, final score) |
| GET | `/api/games/{game_id}/turning-points` | `limit` (default 5) | `Scenario` list for that game |
| GET | `/api/endless/next` | none | a random `Scenario` for endless mode |
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
