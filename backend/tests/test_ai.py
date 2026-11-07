"""AI fallback tests: the game must work with no key and when the API fails."""

import anthropic
import pytest

from app import ai
from app.models import CommentaryRequest, GameState, Outcome, PlayCall, PlayResult


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
