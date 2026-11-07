// Thin wrappers over the frozen backend contract (see backend/app/models.py).

async function request(path, body) {
  const init = body === undefined
    ? {}
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const res = await fetch(path, init);
  if (!res.ok) throw new Error(`${init.method || 'GET'} ${path} failed: ${res.status}`);
  return res.json();
}

/** GET /api/scenarios -> Scenario[] */
export const getScenarios = () => request('/api/scenarios');

/** GET /api/endless/next -> a random Scenario where the offense needs a touchdown */
export const endlessNext = () => request('/api/endless/next');

/** POST /api/simulate {state, call} -> SimulateResponse */
export const simulate = (state, call) => request('/api/simulate', { state, call });

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
 * Pre-snap win probability. There is no WP endpoint, but wp_before in a
 * SimulateResponse depends only on the state, so we read it from a throwaway
 * simulation whose result is discarded.
 */
export const winProbability = state => simulate(state, 'run').then(r => r.wp_before);
