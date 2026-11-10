"""Pydantic models that define the API contract (snake_case, matching the design doc)."""

from enum import Enum

from pydantic import BaseModel, Field


class PlayCall(str, Enum):
    """The player's decision. Going for it on 4th = calling a run or pass on 4th down."""

    run = "run"
    short_pass = "short_pass"
    deep_pass = "deep_pass"
    punt = "punt"
    field_goal = "field_goal"


class Outcome(str, Enum):
    """How a single play ended."""

    gain = "gain"
    first_down = "first_down"
    touchdown = "touchdown"
    turnover = "turnover"
    turnover_on_downs = "turnover_on_downs"
    punt = "punt"
    fg_made = "fg_made"
    fg_missed = "fg_missed"


class GameState(BaseModel):
    """The situation before a play. yardline_100 = yards from the opponent's end zone."""

    offense: str
    defense: str
    offense_score: int = Field(ge=0)
    defense_score: int = Field(ge=0)
    quarter: int = Field(ge=1, le=5)
    seconds_left_in_game: int = Field(ge=0, le=3600)
    down: int = Field(ge=1, le=4)
    distance: int = Field(ge=1, le=99)
    yardline_100: int = Field(ge=1, le=99)
    offense_timeouts: int = Field(ge=0, le=3)
    defense_timeouts: int = Field(ge=0, le=3)


class PlayResult(BaseModel):
    """What happened, plus the real play it was sampled from."""

    call: PlayCall
    yards: int
    outcome: Outcome
    description: str
    sampled_play_id: int


class SimulateRequest(BaseModel):
    """Body for POST /api/simulate. scenario_id (daily games) makes the outcome predetermined:
    the same for every player who makes that call in that situation. Omit it for a random draw."""

    state: GameState
    call: PlayCall
    scenario_id: str | None = None


class SimulateResponse(BaseModel):
    """Returned after every call. WP values are always from the original offense's view."""

    result: PlayResult
    new_state: GameState
    wp_before: float = Field(ge=0, le=1)
    wp_after: float = Field(ge=0, le=1)
    wpa: float
    drive_over: bool


class OddsRequest(BaseModel):
    """Body for POST /api/call-odds."""

    state: GameState


class CallOdds(BaseModel):
    """What one call is expected to do from a state, averaged over every real play it can draw.

    success_chance: first down or touchdown (run, pass) or a made kick (field goal); None for punts.
    avg_yards is net yards for punts. expected_wp is the offense's WP after the play, averaged
    (original offense's point of view, like SimulateResponse); expected_wpa = expected_wp - wp_before.
    """

    call: PlayCall
    success_chance: float | None
    touchdown_chance: float
    turnover_chance: float
    avg_yards: float
    expected_wp: float
    expected_wpa: float
    plays_considered: int


class OddsResponse(BaseModel):
    """WP before the snap and the odds of all five calls (the client decides which are legal)."""

    wp_before: float
    calls: list[CallOdds]


class RealPlay(BaseModel):
    """One snap the real coach called on the scenario's drive, scored with our WP model.

    call is a PlayCall value, or "kneel" / "spike" (real calls the player can't make).
    WP is from the coach's team's point of view.
    """

    state: GameState
    call: str
    description: str
    wp_before: float
    wp_after: float
    wpa: float


class OffensePlayers(BaseModel):
    """The offense's main skill players in that real game, as nflverse names ("D.Prescott").

    qb = most dropbacks, rb = most carries (not counting the QB), wr = most targets,
    wr2 = second-most targets (play-by-play has no positions, so either can be a tight end).
    None if unknown.
    """

    qb: str | None = None
    rb: str | None = None
    wr: str | None = None
    wr2: str | None = None


class Scenario(BaseModel):
    """One playable starting moment from a real game.

    real_drive_wpa is our WP model's change for the coach's team from the drive's first
    snap to the end of the drive, the same model that scores the player.
    """

    id: str
    game_id: str
    title: str
    intro: str
    start_state: GameState
    real_call: PlayCall
    real_play_desc: str
    real_drive_wpa: float
    leverage_score: float
    real_drive_plays: list[RealPlay] = Field(default_factory=list)
    offense_players: OffensePlayers = Field(default_factory=OffensePlayers)


class CommentaryRequest(BaseModel):
    """Body for POST /api/commentary."""

    state_before: GameState
    call: PlayCall
    result: PlayResult
    wp_before: float
    wp_after: float
    players: OffensePlayers | None = None   # optional: the scenario's offense_players, for names


class Commentary(BaseModel):
    """Two announcer lines."""

    line_1: str
    line_2: str



class Game(BaseModel):
    """One game for the game picker: teams, week, final score."""

    game_id: str
    season: int
    week: int
    home_team: str
    away_team: str
    home_score: int
    away_score: int
