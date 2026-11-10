// Thin wrappers over the frozen backend contract (see backend/app/models.py).

async function request(path, body) {
  const init = body === undefined
    ? {}
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const res = await fetch(path, init);
  if (!res.ok) throw new Error(`${init.method || 'GET'} ${path} failed: ${res.status}`);
  return res.json();
}

/** GET /api/scenarios -> today's 6 Scenarios (the same for everyone, new at midnight US Eastern) */
export const getScenarios = () => request('/api/scenarios');

/** GET /api/endless/next -> a random Scenario where the offense needs a touchdown */
export const endlessNext = () => request('/api/endless/next');

/**
 * POST /api/simulate {state, call, scenario_id?} -> SimulateResponse. With a scenario id (daily
 * games) the outcome is predetermined: everyone making that call in that spot gets the same play.
 */
export const simulate = (state, call, scenarioId = null) =>
  request('/api/simulate', scenarioId ? { state, call, scenario_id: scenarioId } : { state, call });

/** POST /api/commentary {state_before, call, result, wp_before, wp_after, players?} -> {line_1, line_2} */
export const commentary = (stateBefore, sim, players = null) => request('/api/commentary', {
  state_before: stateBefore,
  call: sim.result.call,
  result: sim.result,
  wp_before: sim.wp_before,
  wp_after: sim.wp_after,
  players,
});

/**
 * POST /api/call-odds {state} -> {wp_before, calls: CallOdds[]}: for each of the five calls, the
 * success / touchdown / turnover chances, average yards and expected WP over every real play it
 * can draw. Also the pre-snap win probability.
 */
export const callOdds = state => request('/api/call-odds', { state });
