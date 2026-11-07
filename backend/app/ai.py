"""The only module that calls the Claude API: commentary and scenario intros, with template fallbacks.

Every call has a 3 second timeout and no retries. If the key or model is missing, the call fails,
times out, or the per-minute cap is hit, we return template text so the game works offline.
"""

import json
import os
import re
import threading
import time
from collections import deque

import anthropic

from app.models import Commentary, CommentaryRequest, GameState, OffensePlayers, Outcome, PlayCall
from app.simulator import field_position_text

TIMEOUT_SECONDS = 3.0
MAX_CALLS_PER_MINUTE = 30   # basic rate limit so a public demo link can't run up costs
MAX_TOKENS = 1024

COMMENTARY_SYSTEM = (
    "You are a two-person NFL TV broadcast booth: line_1 is the play-by-play announcer, line_2 is "
    "the color analyst. React to the coach's call and its result, referencing the real situation "
    "(score, clock, field position). When players are listed, call them by name, e.g. 'N. Collins "
    "hauls it in'. Write team abbreviations exactly as given, in capitals (PHI, never Phi). "
    "Hype good aggressive calls, roast conservative calls that backfire, stay PG. Each line must "
    "be under 25 words. Reply only with the JSON object."
)
INTRO_SYSTEM = (
    "You are an NFL TV play-by-play announcer setting the scene right before a snap. Write 2 to 3 "
    "sentences in broadcast voice using the situation given. End right before the snap. Never "
    "reveal or hint at what happened on the play. Reply only with the JSON object."
)
COMMENTARY_SCHEMA = {
    "type": "object",
    "properties": {"line_1": {"type": "string"}, "line_2": {"type": "string"}},
    "required": ["line_1", "line_2"], "additionalProperties": False,
}
INTRO_SCHEMA = {
    "type": "object", "properties": {"intro": {"type": "string"}},
    "required": ["intro"], "additionalProperties": False,
}

CALL_NAMES = {PlayCall.run: "run", PlayCall.short_pass: "short pass", PlayCall.deep_pass: "deep pass",
              PlayCall.punt: "punt", PlayCall.field_goal: "field goal"}
TEMPLATE_LINE_1 = {
    Outcome.gain: "{offense} picks up {yards} on the {call}.",
    Outcome.first_down: "{call_title}, and that's a first down {offense}!",
    Outcome.touchdown: "{call_title}... TOUCHDOWN {offense}!",
    Outcome.turnover: "Oh no, it's a turnover! {defense} takes it away!",
    Outcome.turnover_on_downs: "They went for it... and they're short! {defense} takes over.",
    Outcome.punt: "{offense} sends out the punt team.",
    Outcome.fg_made: "The kick is up... and it's GOOD!",
    Outcome.fg_missed: "The kick is up... and it's no good!",
}
# Used instead when we know who carried or caught the ball.
NAMED_LINE_1 = {
    Outcome.gain: "{player} picks up {yards} on the {call}.",
    Outcome.first_down: "{player} moves the chains! First down {offense}!",
    Outcome.touchdown: "{player} finds the end zone... TOUCHDOWN {offense}!",
    Outcome.turnover_on_downs: "{player} is stopped short! {defense} takes over on downs.",
}
# Team codes that are also English words: never force these to capitals in Claude's lines.
WORD_LIKE_TEAMS = {"NO", "WAS", "MIN", "DEN", "CAR", "SEA", "PIT"}

_lock = threading.Lock()
_recent_calls: deque[float] = deque()
_commentary_cache: dict[tuple, Commentary] = {}
_client: anthropic.Anthropic | None = None


# ---------- formatting helpers ----------

def clock_text(state: GameState) -> str:
    """Game clock for the current quarter as m:ss."""
    if state.quarter <= 4:
        seconds = max(0, state.seconds_left_in_game - (4 - state.quarter) * 900)
    else:
        seconds = state.seconds_left_in_game
    return f"{seconds // 60}:{seconds % 60:02d}"


def quarter_text(state: GameState) -> str:
    """'Q4' or 'OT'."""
    return "OT" if state.quarter >= 5 else f"Q{state.quarter}"


def score_text(state: GameState) -> str:
    """'CRM trails NVY 17-20', 'leads' or 'tied'."""
    us, them = state.offense_score, state.defense_score
    if us == them:
        return f"{state.offense} and {state.defense} tied at {us}"
    verb = "leads" if us > them else "trails"
    return f"{state.offense} {verb} {state.defense} {us}-{them}"


def down_text(state: GameState) -> str:
    """'4th & 2' or '1st & goal'."""
    ordinal = {1: "1st", 2: "2nd", 3: "3rd", 4: "4th"}[state.down]
    distance = "goal" if state.distance >= state.yardline_100 else str(state.distance)
    return f"{ordinal} & {distance}"


def situation_text(state: GameState) -> str:
    """One-line situation summary used in prompts and templates."""
    spot = field_position_text(state.yardline_100, state.defense)
    return (f"{quarter_text(state)} {clock_text(state)}, {score_text(state)}, {down_text(state)} "
            f"at {spot}, timeouts {state.offense_timeouts}-{state.defense_timeouts}")


def display_name(name: str | None) -> str | None:
    """nflverse 'N.Collins' -> 'N. Collins' ('A.St. Brown' -> 'A. St. Brown')."""
    if not name:
        return None
    return re.sub(r"^([A-Za-z]{1,3})\.(?=\S)", r"\1. ", name.strip())


def play_actors(call: PlayCall, players: OffensePlayers | None) -> tuple[str | None, str | None]:
    """(passer, ball carrier or target) for this call, matching the field's name tags."""
    if players is None or call in (PlayCall.punt, PlayCall.field_goal):
        return None, None
    if call == PlayCall.run:
        return None, display_name(players.rb)
    target = players.wr if call == PlayCall.deep_pass else (players.wr2 or players.wr)
    return display_name(players.qb), display_name(target)


def players_text(call: PlayCall, players: OffensePlayers | None) -> str | None:
    """'QB C. Stroud, target N. Collins' or 'ball carrier J. Mixon' for the prompt."""
    passer, target = play_actors(call, players)
    if call == PlayCall.run:
        return f"ball carrier {target}" if target else None
    parts = [f"QB {passer}" if passer else None, f"target {target}" if target else None]
    return ", ".join(p for p in parts if p) or None


def fix_team_case(text: str, teams: tuple[str, ...]) -> str:
    """Force team abbreviations to capitals ('Phi' -> 'PHI'), skipping codes that are words."""
    for team in teams:
        if team.upper() not in WORD_LIKE_TEAMS:
            text = re.sub(rf"\b{re.escape(team)}\b", team.upper(), text, flags=re.IGNORECASE)
    return text


# ---------- Claude call with timeout, rate limit and fallback ----------

def get_client() -> anthropic.Anthropic | None:
    """A shared client with a 3s timeout and no retries, or None if no key is configured."""
    global _client
    if not os.environ.get("ANTHROPIC_API_KEY") or not os.environ.get("CLAUDE_MODEL"):
        return None
    if _client is None:
        _client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"],
                                      timeout=TIMEOUT_SECONDS, max_retries=0)
    return _client


def allow_call() -> bool:
    """True if we are under the per-minute cap (and records the call)."""
    with _lock:
        now = time.monotonic()
        while _recent_calls and now - _recent_calls[0] > 60:
            _recent_calls.popleft()
        if len(_recent_calls) >= MAX_CALLS_PER_MINUTE:
            return False
        _recent_calls.append(now)
        return True


def ask_claude_json(system: str, prompt: str, schema: dict) -> dict | None:
    """Ask Claude for JSON matching the schema; None on any failure so callers use a fallback."""
    client = get_client()
    if client is None or not allow_call():
        return None
    try:
        response = client.messages.create(
            model=os.environ["CLAUDE_MODEL"], max_tokens=MAX_TOKENS, system=system,
            messages=[{"role": "user", "content": prompt}],
            output_config={"effort": "low", "format": {"type": "json_schema", "schema": schema}},
        )
        if response.stop_reason != "end_turn":
            return None
        text = next(block.text for block in response.content if block.type == "text")
        return json.loads(text)
    except anthropic.APIError:
        return None  # timeout, connection, rate limit, auth, bad model name, ...
    except Exception:
        return None  # anything else (bad JSON, empty reply): the game must keep working


# ---------- commentary ----------

def special_line_1(req: CommentaryRequest, passer: str | None, target: str | None) -> str | None:
    """Sacks, incompletions and stuffed runs, which the per-outcome templates don't cover."""
    state, result = req.state_before, req.result
    if result.outcome not in (Outcome.gain, Outcome.turnover_on_downs):
        return None
    on_downs = f" {state.defense} takes over on downs." if result.outcome == Outcome.turnover_on_downs else ""
    qb = passer or state.offense
    if result.description.startswith("Sacked"):
        loss = f" for a loss of {abs(result.yards)}" if result.yards < 0 else " at the line"
        return f"{qb} is sacked{loss}!{on_downs}"
    if "incomplete" in result.description:
        aimed = f", intended for {target}" if target else ""
        return f"{qb}'s pass falls incomplete{aimed}.{on_downs}"
    if result.outcome == Outcome.gain and result.yards <= 0:
        how = "for no gain" if result.yards == 0 else f"for a loss of {abs(result.yards)}"
        return f"{target or state.offense} is stopped {how}."
    return None


def template_line_1(req: CommentaryRequest) -> str:
    """Play-by-play line from the outcome, naming the ball carrier or receiver when known."""
    state, result = req.state_before, req.result
    passer, target = play_actors(req.call, req.players)
    special = special_line_1(req, passer, target)
    if special:
        return special
    call = CALL_NAMES[req.call]
    template = NAMED_LINE_1.get(result.outcome) if target else None
    return (template or TEMPLATE_LINE_1[result.outcome]).format(
        offense=state.offense, defense=state.defense, yards=result.yards, call=call,
        call_title=call.capitalize(), player=target)


def template_line_2(req: CommentaryRequest) -> str:
    """Color line from the win probability swing (team codes stay in capitals)."""
    state, result = req.state_before, req.result
    swing = (req.wp_after - req.wp_before) * 100
    if result.outcome in (Outcome.turnover, Outcome.turnover_on_downs, Outcome.fg_missed):
        return f"And the drive stalls there. {state.offense} drops to {req.wp_after:.0%} to win."
    if swing >= 5:
        return f"Big call with {clock_text(state)} left in {quarter_text(state)}. {state.offense} up to {req.wp_after:.0%} to win."
    if swing <= -5:
        return f"That one hurts. {state.offense} slides to {req.wp_after:.0%} with {clock_text(state)} to go."
    return f"{score_text(state)}, and {state.offense} sits at {req.wp_after:.0%} to win."


def template_commentary(req: CommentaryRequest) -> Commentary:
    """Offline booth lines built from the result, the players and the situation."""
    return Commentary(line_1=template_line_1(req), line_2=template_line_2(req))


def commentary_cache_key(req: CommentaryRequest) -> tuple:
    """Repeated situations (same teams, players, call, outcome, yards and rough WP swing) share lines."""
    s = req.state_before
    return (s.offense, s.defense, s.down, req.call, req.result.outcome, req.result.yards,
            play_actors(req.call, req.players), round((req.wp_after - req.wp_before) * 20))


def commentary_prompt(req: CommentaryRequest) -> str:
    """User prompt describing the situation, the call, the players, the result and the WP swing."""
    players = players_text(req.call, req.players)
    return (f"Situation: {situation_text(req.state_before)}.\n"
            f"Call: {CALL_NAMES[req.call]}.\n"
            + (f"Players: {players}.\n" if players else "")
            + f"Result: {req.result.description} (outcome: {req.result.outcome.value}).\n"
            f"Win probability for {req.state_before.offense}: {req.wp_before:.0%} -> {req.wp_after:.0%}.")


def generate_commentary(req: CommentaryRequest) -> Commentary:
    """Two announcer lines from Claude, cached, with a template fallback."""
    key = commentary_cache_key(req)
    if key in _commentary_cache:
        return _commentary_cache[key]
    data = ask_claude_json(COMMENTARY_SYSTEM, commentary_prompt(req), COMMENTARY_SCHEMA)
    if not data or not data.get("line_1") or not data.get("line_2"):
        return template_commentary(req)
    teams = (req.state_before.offense, req.state_before.defense)
    commentary = Commentary(line_1=fix_team_case(data["line_1"], teams),
                            line_2=fix_team_case(data["line_2"], teams))
    _commentary_cache[key] = commentary
    return commentary


# ---------- scenario intros ----------

def template_intro(state: GameState) -> str:
    """Offline scene-setting intro that stops right before the snap."""
    spot = field_position_text(state.yardline_100, state.defense)
    return (f"{quarter_text(state)}, {clock_text(state)} on the clock. {score_text(state)}, "
            f"facing {down_text(state)} at {spot}. Everybody in the building knows what's at "
            f"stake. Your call, coordinator.")


def generate_intro(state: GameState, real_play_desc: str) -> str:
    """2-3 sentence broadcast intro from Claude (the real result is given only so it is not spoiled)."""
    prompt = (f"Situation: {situation_text(state)}.\n"
              f"What really happened (DO NOT reveal or hint at this): {real_play_desc}")
    data = ask_claude_json(INTRO_SYSTEM, prompt, INTRO_SCHEMA)
    if not data or not data.get("intro"):
        return template_intro(state)
    return data["intro"]

