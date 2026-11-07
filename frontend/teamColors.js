// Team uniform colors. The only place team colors live.
//
// primary   -> jersey (and score bug / WP bar)
// secondary -> helmet, pants and jersey number
// colorway  -> closest of the 4 stock sprite sets in /sprites/, used as-is
//              if the browser can't recolor sprites on a canvas.

export const TEAM_COLORS = {
  ARI: { primary: '#97233F', secondary: '#000000', colorway: 'crimson' },
  ATL: { primary: '#A71930', secondary: '#000000', colorway: 'crimson' },
  BAL: { primary: '#241773', secondary: '#000000', colorway: 'navy' },
  BUF: { primary: '#00338D', secondary: '#C60C30', colorway: 'navy' },
  CAR: { primary: '#0085CA', secondary: '#101820', colorway: 'navy' },
  CHI: { primary: '#0B162A', secondary: '#C83803', colorway: 'navy' },
  CIN: { primary: '#FB4F14', secondary: '#000000', colorway: 'midnight' },
  CLE: { primary: '#311D00', secondary: '#FF3C00', colorway: 'midnight' },
  DAL: { primary: '#003594', secondary: '#869397', colorway: 'navy' },
  DEN: { primary: '#FB4F14', secondary: '#002244', colorway: 'midnight' },
  DET: { primary: '#0076B6', secondary: '#B0B7BC', colorway: 'navy' },
  GB:  { primary: '#203731', secondary: '#FFB612', colorway: 'forest' },
  HOU: { primary: '#03202F', secondary: '#A71930', colorway: 'navy' },
  IND: { primary: '#002C5F', secondary: '#FFFFFF', colorway: 'navy' },
  JAX: { primary: '#006778', secondary: '#101820', colorway: 'forest' },
  KC:  { primary: '#E31837', secondary: '#FFB81C', colorway: 'crimson' },
  LA:  { primary: '#003594', secondary: '#FFA300', colorway: 'navy' },
  LAC: { primary: '#0080C6', secondary: '#FFC20E', colorway: 'navy' },
  LV:  { primary: '#A5ACAF', secondary: '#000000', colorway: 'midnight' },
  MIA: { primary: '#008E97', secondary: '#FC4C02', colorway: 'forest' },
  MIN: { primary: '#4F2683', secondary: '#FFC62F', colorway: 'navy' },
  NE:  { primary: '#002244', secondary: '#C60C30', colorway: 'navy' },
  NO:  { primary: '#D3BC8D', secondary: '#101820', colorway: 'midnight' },
  NYG: { primary: '#0B2265', secondary: '#A71930', colorway: 'navy' },
  NYJ: { primary: '#125740', secondary: '#000000', colorway: 'forest' },
  PHI: { primary: '#004C54', secondary: '#A5ACAF', colorway: 'forest' },
  PIT: { primary: '#FFB612', secondary: '#101820', colorway: 'midnight' },
  SEA: { primary: '#002244', secondary: '#69BE28', colorway: 'navy' },
  SF:  { primary: '#AA0000', secondary: '#B3995D', colorway: 'crimson' },
  TB:  { primary: '#D50A0A', secondary: '#34302B', colorway: 'crimson' },
  TEN: { primary: '#0C2340', secondary: '#4B92DB', colorway: 'navy' },
  WAS: { primary: '#5A1414', secondary: '#FFB612', colorway: 'crimson' },
};

// Other spellings that show up in play-by-play data.
const ALIASES = { LAR: 'LA', WSH: 'WAS', JAC: 'JAX', OAK: 'LV', SD: 'LAC', STL: 'LA' };

const FALLBACK = { primary: '#5d6582', secondary: '#f0f0e8', colorway: 'navy' };

/** Colors for a team abbreviation (unknown teams get a neutral gray kit). */
export function teamColors(abbr) {
  const key = String(abbr || '').toUpperCase();
  return TEAM_COLORS[ALIASES[key] || key] || FALLBACK;
}
