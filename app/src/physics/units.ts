/** SI constants and real-scale conversions. Geometric units (G = c = M = 1) inside the physics. */

export const G = 6.6743e-11;
export const C = 299_792_458;
export const SOLAR_MASS = 1.98847e30;
export const SIGMA_SB = 5.670374419e-8;
export const AU = 1.495978707e11;
export const LIGHT_YEAR = 9.4607304725808e15;
export const STANDARD_GRAVITY = 9.80665;

/** GM/c² in metres: the length unit "M". */
export function gravitationalRadius(massSolar: number) {
  return (G * massSolar * SOLAR_MASS) / (C * C);
}

/** GM/c³ in seconds: the time unit "M". */
export function gravitationalTime(massSolar: number) {
  return gravitationalRadius(massSolar) / C;
}

/** Eddington luminosity for ionised hydrogen, 4πGMm_p c/σ_T (W). */
export function eddingtonLuminosity(massSolar: number) {
  return 1.25704e31 * massSolar;
}

/** Proper acceleration in units of standard gravity → geometric units (1/M). */
export function gToGeometric(gs: number, massSolar: number) {
  return (gs * STANDARD_GRAVITY * gravitationalRadius(massSolar)) / (C * C);
}

export function geometricToG(acc: number, massSolar: number) {
  return (acc * C * C) / gravitationalRadius(massSolar) / STANDARD_GRAVITY;
}

export function formatDistance(metres: number) {
  const m = Math.abs(metres);
  if (m < 1e3) return `${metres.toFixed(0)} m`;
  if (m < 1e7) return `${fmt(metres / 1e3)} km`;
  if (m < 0.05 * AU) return `${fmt(metres / 1e9)} million km`;
  if (m < 0.1 * LIGHT_YEAR) return `${fmt(metres / AU)} AU`;
  return `${fmt(metres / LIGHT_YEAR)} ly`;
}

export function formatDuration(seconds: number) {
  const s = Math.abs(seconds);
  const sign = seconds < 0 ? '−' : '';
  if (s < 120) return `${sign}${s.toFixed(1)} s`;
  if (s < 7200) return `${sign}${(s / 60).toFixed(1)} min`;
  if (s < 2 * 86400) return `${sign}${(s / 3600).toFixed(2)} h`;
  if (s < 2 * 365.25 * 86400) return `${sign}${(s / 86400).toFixed(2)} days`;
  return `${sign}${fmt(s / (365.25 * 86400))} years`;
}

function fmt(x: number) {
  const a = Math.abs(x);
  if (a >= 1e5 || (a < 0.01 && a > 0)) return x.toExponential(2);
  return x.toPrecision(4).replace(/\.?0+$/, '');
}
