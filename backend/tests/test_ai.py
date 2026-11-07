"""AI fallback tests: the game must work with no key and when the API fails."""

import anthropic
import pytest

from app import ai
from app.models import CommentaryRequest, GameState, OffensePlayers, Outcome, PlayCall, PlayResult


def request(state: GameState) -> CommentaryRequest:
    """A 4th-down conversion commentary request."""
    result = PlayResult(call=PlayCall.short_pass, yards=7, outcome=Outcome.first_down,
                        description="Short pass complete for 7 yards. First down!", sampled_play_id=1)
    return CommentaryRequest(state_before=state, call=PlayCall.short_pass, result=result,
                             wp_before=0.34, wp_after=0.47)


def test_template_when_no_key(monkeypatch: pytest.MonkeyPatch, state: GameState) -> None:
    """Without ANTHROPIC_API_KEY the booth still returns two lines referencing the situation."""
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    lines = ai.generate_commentary(request(state))
    assert lines.line_1 and "CRM" in lines.line_1
    assert "47%" in lines.line_2


def test_template_when_api_fails(monkeypatch: pytest.MonkeyPatch, state: GameState) -> None:
    """A timeout from the API falls back to template lines instead of raising."""
    class FailingMessages:
        def create(self, **_: object) -> None:
            raise anthropic.APITimeoutError(request=None)  # type: ignore[arg-type]

    class FailingClient:
        messages = FailingMessages()

    monkeypatch.setattr(ai, "get_client", lambda: FailingClient())
    monkeypatch.setenv("CLAUDE_MODEL", "test-model")
    assert ai.generate_commentary(request(state)) == ai.template_commentary(request(state))
    assert "Your call" in ai.generate_intro(state, "real play")


def test_clock_and_down_text(state: GameState) -> None:
    """Q3 with 1500s left in the game is 10:00 in the quarter."""
    assert ai.clock_text(state) == "10:00"
    assert ai.down_text(state.model_copy(update={"down": 1, "distance": 4, "yardline_100": 4})) == "1st & goal"


def players() -> OffensePlayers:
    """The offense's skill players, as nflverse writes them."""
    return OffensePlayers(qb="C.Stroud", rb="J.Mixon", wr="N.Collins", wr2="T.Dell")


def with_result(state: GameState, call: PlayCall, outcome: Outcome, yards: int, desc: str) -> CommentaryRequest:
    """A commentary request for one result, with player names."""
    result = PlayResult(call=call, yards=yards, outcome=outcome, description=desc, sampled_play_id=1)
    return CommentaryRequest(state_before=state, call=call, result=result, wp_before=0.4,
                             wp_after=0.45, players=players())


def test_display_names() -> None:
    """'N.Collins' reads 'N. Collins'; multi-part last names keep their dots."""
    assert ai.display_name("N.Collins") == "N. Collins"
    assert ai.display_name("A.St. Brown") == "A. St. Brown"
    assert ai.display_name(None) is None


def test_templates_name_the_players(state: GameState) -> None:
    """Deep pass -> WR, short pass -> second target, run -> RB, sacks and incompletions -> QB."""
    deep = ai.template_commentary(with_result(state, PlayCall.deep_pass, Outcome.first_down, 31, "Deep pass complete for 31 yards."))
    assert deep.line_1 == "N. Collins moves the chains! First down CRM!"
    short = ai.template_commentary(with_result(state, PlayCall.short_pass, Outcome.gain, 4, "Short pass complete for 4 yards."))
    assert short.line_1.startswith("T. Dell picks up 4")
    run = ai.template_commentary(with_result(state, PlayCall.run, Outcome.touchdown, 40, "Run for 40 yards. TOUCHDOWN!"))
    assert run.line_1.startswith("J. Mixon finds the end zone")
    sack = ai.template_commentary(with_result(state, PlayCall.short_pass, Outcome.gain, -7, "Sacked for a loss of 7."))
    assert sack.line_1 == "C. Stroud is sacked for a loss of 7!"
    miss = ai.template_commentary(with_result(state, PlayCall.deep_pass, Outcome.gain, 0, "Deep pass falls incomplete."))
    assert miss.line_1 == "C. Stroud's pass falls incomplete, intended for N. Collins."


def test_names_in_the_prompt(state: GameState) -> None:
    """Claude is told who threw and who was targeted."""
    prompt = ai.commentary_prompt(with_result(state, PlayCall.deep_pass, Outcome.gain, 12, "Deep pass complete for 12 yards."))
    assert "Players: QB C. Stroud, target N. Collins." in prompt


def test_team_codes_stay_capitalised(state: GameState) -> None:
    """Template color lines never lower-case team codes; Claude's 'Crm' is fixed to 'CRM'."""
    quiet = with_result(state, PlayCall.run, Outcome.gain, 3, "Run for 3 yards.")
    quiet.wp_after = quiet.wp_before
    assert ai.template_commentary(quiet).line_2.startswith("CRM trails NVY 17-20")
    assert ai.fix_team_case("Crm needed that. nvy is reeling.", ("CRM", "NVY")) == "CRM needed that. NVY is reeling."
    assert ai.fix_team_case("There was no stopping him.", ("WAS", "NO")) == "There was no stopping him."
