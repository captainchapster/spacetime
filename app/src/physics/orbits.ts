/**
 * Initial conditions for Schwarzschild orbits, starting on the +x axis and moving toward +y.
 * Velocities are coordinate velocities dx/dt, as `World.addParticle` expects.
 */

/** Circular orbit of radius r: Ω = √(M/r³) exactly, so v = rΩ = √(M/r). Stable for r > 6M. */
export function circularOrbitSpeed(M: number, r: number) {
  return Math.sqrt(M / r);
}

/**
 * Bound orbit with periapsis r1 and apoapsis r2. Returns the specific energy E and angular
 * momentum L (per unit mass), and the tangential coordinate speed at periapsis.
 *
 * From the radial equation (dr/dτ)² = E² − (1 − 2M/r)(1 + L²/r²) vanishing at r1 and r2.
 */
export function boundOrbit(M: number, r1: number, r2: number) {
  const V = (r: number, L2: number) => (1 - (2 * M) / r) * (1 + L2 / (r * r));
  const L2 = (2 * M * (1 / r1 - 1 / r2)) / ((1 - (2 * M) / r1) / (r1 * r1) - (1 - (2 * M) / r2) / (r2 * r2));
  const L = Math.sqrt(L2);
  const E = Math.sqrt(V(r1, L2));
  // dφ/dt = (dφ/dτ)/(dt/dτ) = (L/r²)·(1 − 2M/r)/E, and dr = 0 so KS t and Schwarzschild t agree.
  const speed = r1 * (L / (r1 * r1)) * ((1 - (2 * M) / r1) / E);
  return { E, L, speed };
}

/**
 * Exact periapsis advance per orbit (radians) for a bound orbit between r1 and r2.
 * With u = 1/r, (du/dφ)² = 2M(u − u1)(u − u2)(u − u3), u3 = 1/(2M) − u1 − u2; substituting
 * u = u2 + (u1 − u2) sin²χ gives Δφ = 4∫₀^{π/2} dχ / √(2M(u3 − u)) − 2π.
 */
export function periapsisAdvance(M: number, r1: number, r2: number, steps = 2000) {
  const u1 = 1 / r1;
  const u2 = 1 / r2;
  const u3 = 1 / (2 * M) - u1 - u2;
  const f = (chi: number) => 1 / Math.sqrt(2 * M * (u3 - (u2 + (u1 - u2) * Math.sin(chi) ** 2)));
  // Simpson's rule (the integrand is smooth).
  const h = Math.PI / 2 / steps;
  let s = f(0) + f(Math.PI / 2);
  for (let k = 1; k < steps; k++) s += (k % 2 ? 4 : 2) * f(k * h);
  return 4 * (s * h) / 3 - 2 * Math.PI;
}
