"""Play simulator: bucket the situation, sample a real play, apply it, run the clock."""

import hashlib
from collections.abc import Callable, Iterator
from dataclasses import dataclass

import numpy as np
import pandas as pd

from app.models import CallOdds, GameState, OddsResponse, Outcome, PlayCall, PlayResult, SimulateResponse

MIN_BUCKET = 30
DISTANCE_EDGES = [1, 3, 6, 10]   # buckets: 1 | 2-3 | 4-6 | 7-10 | 11+
ZONE_EDGES = [20, 49, 79]        # zones: 1-20 red zone | 21-49 opp side | 50-79 own side | 80-99 backed up
FG_WINDOW = 3                    # kicks within 3 yards of the attempt distance
FG_SNAP_YARDS = 17               # kick distance = yardline_100 + 17
FG_MAX_DISTANCE = 70             # longest real attempt in 2024-25; from here on, always a miss
MISSED_FG_SPOT = 7               # defense takes over at the spot of the kick (LOS + 7)
KICKOFF_YARDLINE = 70            # team receiving a kickoff starts at its own 30
SAFETY_KICK_YARDLINE = 60        # team receiving a safety free kick starts at its own 40
TOUCHDOWN_POINTS = 7             # simplification: extra point assumed good
TWO_MINUTES = 120
HALF = 1800
RUNNING_CLOCK = 30               # run, completion or sack
STOPPED_CLOCK = 6                # incompletion, interception, kick
HURRY_UP_CLOCK = 15              # running play in the last 2 minutes of a half

WinProbFn = Callable[[GameState], float]


@dataclass
class PlayPools:
    """Real plays grouped by what each play call samples from."""

    runs: pd.DataFrame
    dropbacks: pd.DataFrame
    short_passes: pd.DataFrame
    deep_passes: pd.DataFrame
    punts: pd.DataFrame
    field_goals: pd.DataFrame


@dataclass
class PlayOutcome:
    """A simulated play before win probability is attached."""

    result: PlayResult
    new_state: GameState
    drive_over: bool
    possession_flipped: bool


# ---------- buckets ----------

def distance_bucket(distance: int) -> int:
    """Index of the distance bucket: 0=1, 1=2-3, 2=4-6, 3=7-10, 4=11+."""
    return int(np.searchsorted(DISTANCE_EDGES, distance, side="left"))


def field_zone(yardline_100: int) -> int:
    """Index of the field zone: 0=red zone, 1=opp side, 2=own side, 3=backed up."""
    return int(np.searchsorted(ZONE_EDGES, yardline_100, side="left"))


def add_bucket_columns(df: pd.DataFrame) -> pd.DataFrame:
    """Add dist_b and zone columns using the same edges as the scalar functions."""
    df = df.copy()
    df["dist_b"] = np.searchsorted(DISTANCE_EDGES, df["ydstogo"].to_numpy(), side="left")
    df["zone"] = np.searchsorted(ZONE_EDGES, df["yardline_100"].to_numpy(), side="left")
    return df


def build_pools(plays: pd.DataFrame) -> PlayPools:
    """Split real snaps into the pools each play call samples from."""
    snaps = add_bucket_columns(plays[plays["down"].notna() & plays["yardline_100"].notna()])
    for col in ["yards_gained", "touchdown", "interception", "fumble_lost", "sack"]:
        snaps[col] = snaps[col].fillna(0)
    snaps["incomplete"] = snaps["desc"].fillna("").str.contains("incomplete", case=False)
    passes = snaps[snaps["play_type"] == "pass"]
    return PlayPools(
        runs=snaps[snaps["play_type"] == "run"],
        dropbacks=passes[passes["pass_length"].notna() | (passes["sack"] == 1)],
        short_passes=passes[passes["pass_length"] == "short"],
        deep_passes=passes[passes["pass_length"] == "deep"],
        punts=snaps[(snaps["play_type"] == "punt") & snaps["punt_net_yards"].notna()],
        field_goals=snaps[(snaps["play_type"] == "field_goal") & snaps["kick_distance"].notna()],
    )


def bucket_masks(pool: pd.DataFrame, down: int, dist_b: int, zone: int) -> Iterator[pd.Series]:
    """Yield masks from most to least specific: full bucket, drop zone, then merge distances."""
    same_down = pool["down"] == down
    yield same_down & (pool["dist_b"] == dist_b) & (pool["zone"] == zone)
    for width in range(len(DISTANCE_EDGES) + 1):
        yield same_down & ((pool["dist_b"] - dist_b).abs() <= width)


def find_bucket(pool: pd.DataFrame, state: GameState) -> pd.DataFrame:
    """Return the most specific bucket with at least MIN_BUCKET plays (whole pool as last resort)."""
    dist_b, zone = distance_bucket(state.distance), field_zone(state.yardline_100)
    for mask in bucket_masks(pool, state.down, dist_b, zone):
        if mask.sum() >= MIN_BUCKET:
            return pool[mask]
    return pool


def pick(pool: pd.DataFrame, rng: np.random.Generator) -> pd.Series:
    """Sample one real play uniformly from a pool."""
    return pool.iloc[int(rng.integers(len(pool)))]


# ---------- what each call can draw ----------
# A call draws from one or more groups of real plays: first a group, by its probability, then a
# play uniformly within it. sample_play uses the groups for one random draw; call_odds averages
# over all of them, so the odds the player sees are exactly the odds the game plays with.

PlayGroups = list[tuple[pd.DataFrame, float]]


def run_groups(pools: PlayPools, state: GameState) -> PlayGroups:
    """Runs: the situation bucket."""
    return [(find_bucket(pools.runs, state), 1.0)]


def pass_groups(pools: PlayPools, state: GameState, call: PlayCall) -> PlayGroups:
    """Passes of the called length, plus sacks at their real rate for the dropback bucket."""
    dropbacks = find_bucket(pools.dropbacks, state)
    sacks = dropbacks[dropbacks["sack"] == 1]
    sack_rate = len(sacks) / len(dropbacks) if len(dropbacks) else 0.0
    pool = pools.short_passes if call == PlayCall.short_pass else pools.deep_passes
    return [(sacks, sack_rate), (find_bucket(pool, state), 1.0 - sack_rate)]


def punt_groups(pools: PlayPools, state: GameState) -> PlayGroups:
    """Real punts from the same field zone (all punts if the zone is thin)."""
    same_zone = pools.punts[pools.punts["zone"] == field_zone(state.yardline_100)]
    return [(same_zone if len(same_zone) >= MIN_BUCKET else pools.punts, 1.0)]


def play_groups(pools: PlayPools, state: GameState, call: PlayCall) -> PlayGroups:
    """The groups of real plays a call draws from, with each group's probability."""
    if call == PlayCall.run:
        return run_groups(pools, state)
    if call == PlayCall.punt:
        return punt_groups(pools, state)
    if call == PlayCall.field_goal:
        return field_goal_groups(pools, state)
    return pass_groups(pools, state, call)


def sample_play(pools: PlayPools, state: GameState, call: PlayCall, rng: np.random.Generator) -> pd.Series:
    """Draw one real play for the call: a group by probability, then a play within it."""
    groups = [(rows, p) for rows, p in play_groups(pools, state, call) if p > 0 and len(rows)]
    weights = np.array([p for _, p in groups])
    index = int(rng.choice(len(groups), p=weights / weights.sum())) if len(groups) > 1 else 0
    return pick(groups[index][0], rng)


def field_goal_kicks(pools: PlayPools, kick_distance: int) -> pd.DataFrame:
    """Real kicks within 3 yards of the distance, or the 30 nearest kicks if that is too few."""
    gap = (pools.field_goals["kick_distance"] - kick_distance).abs()
    close = pools.field_goals[gap <= FG_WINDOW]
    if len(close) >= MIN_BUCKET:
        return close
    return pools.field_goals.loc[gap.nsmallest(MIN_BUCKET).index]


def field_goal_make_chance(kicks: pd.DataFrame, distance: int) -> float:
    """Real make rate of the sampled kicks. Past their average distance (the data runs thin
    beyond ~63 yards) it fades linearly to 0 at FG_MAX_DISTANCE; longer tries always miss."""
    if distance >= FG_MAX_DISTANCE:
        return 0.0
    rate = float((kicks["field_goal_result"] == "made").mean())
    center = float(kicks["kick_distance"].mean())
    if distance <= center:
        return rate
    return rate * (FG_MAX_DISTANCE - distance) / (FG_MAX_DISTANCE - center)


def kicks_with_result(pools: PlayPools, kicks: pd.DataFrame, made: bool) -> pd.DataFrame:
    """The nearby kicks that were made (or missed); any such kick if none are nearby."""
    matching = kicks[(kicks["field_goal_result"] == "made") == made]
    if matching.empty:
        result = "made" if made else "missed"
        matching = pools.field_goals[pools.field_goals["field_goal_result"] == result]
    return matching


def field_goal_groups(pools: PlayPools, state: GameState) -> PlayGroups:
    """Made kicks with the distance's make chance, missed kicks with the rest."""
    distance = state.yardline_100 + FG_SNAP_YARDS
    kicks = field_goal_kicks(pools, distance)
    make = field_goal_make_chance(kicks, distance)
    return [(kicks_with_result(pools, kicks, True), make),
            (kicks_with_result(pools, kicks, False), 1.0 - make)]


# ---------- clock and state helpers ----------

def quarter_from_seconds(seconds_left: int) -> int:
    """Regulation quarter for a game-clock value (2700 left = start of Q2)."""
    return min(4, max(1, 4 - (seconds_left - 1) // 900))


def half_seconds_left(state: GameState) -> int:
    """Seconds left in the current half (or in overtime)."""
    if state.quarter <= 2:
        return state.seconds_left_in_game - HALF
    return state.seconds_left_in_game


def run_clock(state: GameState, base_seconds: int) -> GameState:
    """Return the state with play time taken off. In the last 2 min of a half a running play
    takes HURRY_UP_CLOCK (15s); stopped-clock plays (incompletions, kicks) keep their 6s."""
    late = half_seconds_left(state) <= TWO_MINUTES
    used = min(base_seconds, HURRY_UP_CLOCK) if late else base_seconds
    seconds = state.seconds_left_in_game - used
    if state.quarter <= 2 and seconds < HALF:
        seconds = HALF
    seconds = max(0, seconds)
    quarter = quarter_from_seconds(seconds) if state.quarter <= 4 else state.quarter
    if state.quarter <= 2 and seconds == HALF:
        quarter = 2  # still the first half; the half just ran out
    return state.model_copy(update={"seconds_left_in_game": seconds, "quarter": quarter})


def half_over(before: GameState, after: GameState) -> bool:
    """True if this play ran out the clock in the half or the game."""
    if after.seconds_left_in_game == 0:
        return True
    return before.quarter <= 2 and after.seconds_left_in_game == HALF


def first_down_distance(yardline_100: int) -> int:
    """10 yards to go, or goal to go inside the 10."""
    return min(10, yardline_100)


def add_points(state: GameState, offense_points: int = 0, defense_points: int = 0) -> GameState:
    """Return the state with points added to either side."""
    return state.model_copy(update={"offense_score": state.offense_score + offense_points,
                                    "defense_score": state.defense_score + defense_points})


def new_series(state: GameState, yardline_100: int) -> GameState:
    """Same offense, 1st and 10 (or goal) at yardline_100."""
    yardline_100 = min(99, max(1, yardline_100))
    return state.model_copy(update={"down": 1, "yardline_100": yardline_100,
                                    "distance": first_down_distance(yardline_100)})


def flip_possession(state: GameState, yardline_100: int) -> GameState:
    """The old defense takes over, 1st and 10 at yardline_100 (from its own view)."""
    swapped = state.model_copy(update={
        "offense": state.defense, "defense": state.offense,
        "offense_score": state.defense_score, "defense_score": state.offense_score,
        "offense_timeouts": state.defense_timeouts, "defense_timeouts": state.offense_timeouts,
    })
    return new_series(swapped, yardline_100)


def field_position_text(yardline_100: int, defense: str) -> str:
    """Broadcast-style spot: 'their own 25', 'midfield' or 'the NVY 38'."""
    if yardline_100 == 50:
        return "midfield"
    if yardline_100 > 50:
        return f"their own {100 - yardline_100}"
    return f"the {defense} {yardline_100}"


# ---------- applying results ----------

def make_outcome(call: PlayCall, yards: int, outcome: Outcome, description: str, play_id: int,
                 new_state: GameState, drive_over: bool, flipped: bool) -> PlayOutcome:
    """Bundle a PlayResult with its new state."""
    result = PlayResult(call=call, yards=yards, outcome=outcome,
                        description=description, sampled_play_id=play_id)
    return PlayOutcome(result, new_state, drive_over, flipped)


def describe_scrimmage(call: PlayCall, row: pd.Series, yards: int) -> str:
    """Plain description of a run or pass before any outcome suffix."""
    if row["sack"] == 1:
        return f"Sacked for a loss of {abs(yards)}." if yards < 0 else "Sacked at the line."
    if call != PlayCall.run and row["incomplete"]:
        return f"{'Short' if call == PlayCall.short_pass else 'Deep'} pass falls incomplete."
    label = {PlayCall.run: "Run", PlayCall.short_pass: "Short pass complete",
             PlayCall.deep_pass: "Deep pass complete"}[call]
    if yards == 0:
        return f"{label} for no gain."
    if yards < 0:
        return f"{label}, stopped for a loss of {abs(yards)}."
    return f"{label} for {yards} yard{'s' if yards != 1 else ''}."


def apply_turnover(before: GameState, timed: GameState, call: PlayCall, row: pd.Series,
                   yards: int) -> PlayOutcome:
    """Interception or lost fumble: flip at the spot, or a defensive touchdown."""
    play_id = int(row["play_id"])
    what = "Intercepted!" if row["interception"] == 1 else "Fumble, and the defense recovers!"
    if row["touchdown"] == 1:
        scored_on = new_series(add_points(timed, defense_points=TOUCHDOWN_POINTS), KICKOFF_YARDLINE)
        return make_outcome(call, 0, Outcome.turnover, f"{what} Returned for a touchdown.",
                            play_id, scored_on, True, False)
    spot = min(99, max(1, before.yardline_100 - yards))
    return make_outcome(call, yards, Outcome.turnover, what, play_id,
                        flip_possession(timed, 100 - spot), True, True)


def apply_scrimmage(state: GameState, call: PlayCall, row: pd.Series) -> PlayOutcome:
    """Apply a sampled run or pass: touchdown, safety, first down, turnover on downs or gain."""
    yards, play_id = int(row["yards_gained"]), int(row["play_id"])
    stopped = bool(row["incomplete"]) or row["interception"] == 1
    timed = run_clock(state, STOPPED_CLOCK if stopped else RUNNING_CLOCK)
    clock_out = half_over(state, timed)
    if row["interception"] == 1 or row["fumble_lost"] == 1:
        return apply_turnover(state, timed, call, row, yards)
    new_yardline = state.yardline_100 - yards
    if new_yardline <= 0:
        yards = state.yardline_100
        scored = add_points(timed, offense_points=TOUCHDOWN_POINTS)
        text = describe_scrimmage(call, row, yards) + " TOUCHDOWN!"
        return make_outcome(call, yards, Outcome.touchdown, text, play_id,
                            flip_possession(scored, KICKOFF_YARDLINE), True, True)
    if new_yardline >= 100:
        yards = state.yardline_100 - 100
        scored = add_points(timed, defense_points=2)
        text = describe_scrimmage(call, row, yards) + " Brought down in the end zone. SAFETY!"
        return make_outcome(call, yards, Outcome.turnover, text, play_id,
                            flip_possession(scored, SAFETY_KICK_YARDLINE), True, True)
    text = describe_scrimmage(call, row, yards)
    if yards >= state.distance:
        return make_outcome(call, yards, Outcome.first_down, text + " First down!", play_id,
                            new_series(timed, new_yardline), clock_out, False)
    if state.down == 4:
        text += " Short of the sticks. Turnover on downs."
        return make_outcome(call, yards, Outcome.turnover_on_downs, text, play_id,
                            flip_possession(timed, 100 - new_yardline), True, True)
    next_down = timed.model_copy(update={"down": state.down + 1, "yardline_100": new_yardline,
                                         "distance": max(1, state.distance - yards)})
    return make_outcome(call, yards, Outcome.gain, text, play_id, next_down, clock_out, False)


def apply_punt(state: GameState, row: pd.Series) -> PlayOutcome:
    """Apply a sampled real punt's net yards and give the ball to the defense."""
    net = int(row["punt_net_yards"])
    landing = min(99, max(1, state.yardline_100 - net))
    new_state = flip_possession(run_clock(state, STOPPED_CLOCK), 100 - landing)
    spot = field_position_text(new_state.yardline_100, new_state.defense)
    text = f"Punt, net {net} yards. {state.defense} takes over at {spot}."
    return make_outcome(PlayCall.punt, net, Outcome.punt, text, int(row["play_id"]),
                        new_state, True, True)


def apply_field_goal(state: GameState, row: pd.Series) -> PlayOutcome:
    """Apply a sampled real kick from about the same distance: 3 points or a miss at the spot."""
    distance = state.yardline_100 + FG_SNAP_YARDS
    timed = run_clock(state, STOPPED_CLOCK)
    play_id = int(row["play_id"])
    if row["field_goal_result"] == "made":
        new_state = flip_possession(add_points(timed, offense_points=3), KICKOFF_YARDLINE)
        return make_outcome(PlayCall.field_goal, 0, Outcome.fg_made,
                            f"{distance}-yard field goal is GOOD!", play_id, new_state, True, True)
    kick_spot = state.yardline_100 + MISSED_FG_SPOT
    new_state = flip_possession(timed, 100 - max(kick_spot, 20))
    return make_outcome(PlayCall.field_goal, 0, Outcome.fg_missed,
                        f"{distance}-yard field goal is no good.", play_id, new_state, True, True)


def apply_play(state: GameState, call: PlayCall, row: pd.Series) -> PlayOutcome:
    """Apply one real play to the state as the given call."""
    if call == PlayCall.punt:
        return apply_punt(state, row)
    if call == PlayCall.field_goal:
        return apply_field_goal(state, row)
    return apply_scrimmage(state, call, row)


def run_play(state: GameState, call: PlayCall, pools: PlayPools, rng: np.random.Generator) -> PlayOutcome:
    """Sample a real play for the call and apply it to the state."""
    return apply_play(state, call, sample_play(pools, state, call, rng))


def seeded_rng(scenario_id: str, state: GameState, call: PlayCall) -> np.random.Generator:
    """A random generator fixed by the scenario, the exact situation and the call, so every player
    who makes the same call in the same spot gets the same real play (a stable hash, not hash())."""
    key = f"{scenario_id}|{state.model_dump_json()}|{call.value}".encode()
    return np.random.default_rng(int.from_bytes(hashlib.sha256(key).digest()[:8], "big"))


def simulate(state: GameState, call: PlayCall, pools: PlayPools, win_prob: WinProbFn,
             rng: np.random.Generator) -> SimulateResponse:
    """Simulate one call and score it with WP from the original offense's point of view."""
    outcome = run_play(state, call, pools, rng)
    wp_before = win_prob(state)
    wp_new = win_prob(outcome.new_state)
    wp_after = 1 - wp_new if outcome.possession_flipped else wp_new
    return SimulateResponse(
        result=outcome.result, new_state=outcome.new_state,
        wp_before=round(wp_before, 4), wp_after=round(wp_after, 4),
        wpa=round(wp_after - wp_before, 4), drive_over=outcome.drive_over,
    )


# ---------- odds: every outcome a call can have, averaged ----------

MAX_ODDS_PLAYS = 250   # per group: enough for stable averages while staying fast
SUCCESS = {Outcome.first_down, Outcome.touchdown, Outcome.fg_made}


def thin(rows: pd.DataFrame, limit: int = MAX_ODDS_PLAYS) -> pd.DataFrame:
    """An evenly spaced subset of a big group (deterministic, so odds don't jitter)."""
    if len(rows) <= limit:
        return rows
    return rows.iloc[np.linspace(0, len(rows) - 1, limit).astype(int)]


def odds_rows(pools: PlayPools, state: GameState, call: PlayCall) -> tuple[list[pd.Series], np.ndarray]:
    """Every play the call can draw, with the probability of drawing it. A field goal's
    outcome only depends on make or miss, so one kick stands in for each side."""
    rows, weights = [], []
    for group, p in play_groups(pools, state, call):
        if p <= 0 or group.empty:
            continue
        group = group.head(1) if call == PlayCall.field_goal else thin(group)
        rows += [row for _, row in group.iterrows()]
        weights += [p / len(group)] * len(group)
    return rows, np.array(weights) / sum(weights)


def win_probs(states: list[GameState], win_prob: WinProbFn) -> np.ndarray:
    """WP for many states: one batch through the model when it supports it, each state once."""
    keys = [tuple(s.model_dump().values()) for s in states]
    unique = dict(zip(keys, states))
    batch = getattr(win_prob, "predict_many", None)
    values = batch(list(unique.values())) if batch else [win_prob(s) for s in unique.values()]
    lookup = dict(zip(unique, values))
    return np.array([lookup[k] for k in keys], dtype=float)


def call_odds(state: GameState, call: PlayCall, pools: PlayPools, win_prob: WinProbFn,
              wp_before: float) -> CallOdds:
    """What a call is expected to do from this state, averaged over every real play it can draw."""
    rows, weights = odds_rows(pools, state, call)
    outcomes = [apply_play(state, call, row) for row in rows]
    wp_new = win_probs([o.new_state for o in outcomes], win_prob)
    flipped = np.array([o.possession_flipped for o in outcomes])
    expected_wp = float(np.dot(weights, np.where(flipped, 1 - wp_new, wp_new)))

    def chance(kinds: set[Outcome]) -> float:
        """Probability the play ends in one of these outcomes."""
        return round(float(sum(w for w, o in zip(weights, outcomes) if o.result.outcome in kinds)), 4)

    return CallOdds(
        call=call, success_chance=None if call == PlayCall.punt else chance(SUCCESS),
        touchdown_chance=chance({Outcome.touchdown}), turnover_chance=chance({Outcome.turnover}),
        avg_yards=round(float(np.dot(weights, [o.result.yards for o in outcomes])), 1),
        expected_wp=round(expected_wp, 4), expected_wpa=round(expected_wp - wp_before, 4),
        plays_considered=len(outcomes),
    )


def odds_for_state(state: GameState, pools: PlayPools, win_prob: WinProbFn) -> OddsResponse:
    """WP right now and the odds of every call from this state."""
    wp_before = win_prob(state)
    calls = [call_odds(state, call, pools, win_prob, wp_before) for call in PlayCall]
    return OddsResponse(wp_before=round(wp_before, 4), calls=calls)
