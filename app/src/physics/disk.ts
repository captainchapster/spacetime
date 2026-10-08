/**
 * A thin accretion disk (Novikov–Thorne / Page–Thorne): gas on prograde circular
 * equatorial geodesics, spiralling in slowly and radiating locally as a blackbody, down to
 * the innermost stable circular orbit (ISCO), inside which it plunges without radiating.
 * Units M = 1 unless noted.
 */

import { SIGMA_SB, eddingtonLuminosity, gravitationalRadius } from './units';

/** Energy, angular momentum (per unit mass) and angular velocity of a prograde circular orbit. */
export function circularOrbit(r: number, a: number) {
  // Bardeen, Press & Teukolsky (1972), M = 1.
  const sr = Math.sqrt(r);
  const den = r ** 0.75 * Math.sqrt(r * sr - 3 * sr + 2 * a);
  return {
    E: (r * sr - 2 * sr + a) / den,
    L: (r * r - 2 * a * sr + a * a) / den,
    Omega: 1 / (r * sr + a),
  };
}

/**
 * Speed of a prograde circular orbit relative to the local ZAMO (Bardeen, Press & Teukolsky
 * 1972), M = 1.
 */
export function circularSpeed(r: number, a: number) {
  const sr = Math.sqrt(r);
  return (r * r - 2 * a * sr + a * a) / (Math.sqrt(r * r - 2 * r + a * a) * (r * sr + a));
}

/**
 * Retro-brake (proper acceleration against the motion, units 1/M) that winds a prograde
 * circular orbit at r0 down to the ISCO in about `turns` orbits.
 *
 * For gentle braking the orbit stays nearly circular and shrinks slowly. A brake A against
 * the motion (relative to the ZAMO) removes angular momentum at dL/dτ = −Aγ√g_φφ, and turns
 * accrue at Ωu^t/2π = Ωγ/2πα per unit proper time (α the lapse), so
 *   turns = (1/A) ∫ Ω |dL/dr| / (2π α √g_φφ) dr   from the ISCO to r0.
 * (Angular momentum, not energy: inside the ergosphere, where a fast-spinning hole's ISCO
 * lies, frame dragging outpaces the ship, and braking there can even raise the energy.)
 * Braking hard enough to matter is a little faster than this slow-decay estimate; the
 * factor is fitted to full integrations (test/decay.test.ts checks them across spins).
 */
export function decayBrake(a: number, r0: number, turns: number) {
  const isco = iscoRadius(a);
  const n = 400;
  let integral = 0;
  for (let i = 0; i < n; i++) {
    const r = isco + ((i + 0.5) / n) * (r0 - isco);
    const h = 1e-4 * r;
    const dLdr = (circularOrbit(r + h, a).L - circularOrbit(r - h, a).L) / (2 * h);
    const delta = r * r - 2 * r + a * a;
    const big = (r * r + a * a) ** 2 - a * a * delta;
    const alpha = Math.sqrt((r * r * delta) / big);
    const sqrtGphiphi = Math.sqrt(big) / r;
    integral += (circularOrbit(r, a).Omega * Math.abs(dLdr)) / (2 * Math.PI * alpha * sqrtGphiphi);
  }
  integral *= (r0 - isco) / n;
  return (DECAY_FIT * integral) / turns;
}
const DECAY_FIT = 1;

/**
 * Innermost stable spherical orbit for polar orbits (zero angular momentum about the spin
 * axis), M = 1. With L_z = 0 the radial potential is
 *   R(r) = E²[(r² + a²)² − Δa²] − Δ(r² + Q),
 * which is linear in E² and the Carter constant Q. A spherical orbit needs R = R′ = 0, which
 * fixes both; it is stable while R″ < 0, so the innermost one is where R″ = 0. Equals 6
 * without spin; about 5.3 for a near-extremal hole.
 */
export function polarIsso(a: number) {
  const curvature = (r: number) => {
    const d = r * r - 2 * r + a * a;
    const dd = 2 * r - 2;
    const [A1, B1, C1] = [(r * r + a * a) ** 2 - d * a * a, d * r * r, d];
    const [A2, B2, C2] = [4 * r * (r * r + a * a) - dd * a * a, dd * r * r + 2 * r * d, dd];
    const [A3, B3, C3] = [12 * r * r + 2 * a * a, 2 * r * r + 4 * r * dd + 2 * d, 2];
    const E2 = (B2 - (C2 * B1) / C1) / (A2 - (C2 * A1) / C1);
    const Q = (E2 * A1 - B1) / C1;
    return E2 * A3 - B3 - C3 * Q;
  };
  // Stable (R″ < 0) far out, unstable inside: bisect for the change.
  let lo = 1 + Math.sqrt(1 - a * a) + 1.5;
  let hi = 12;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (curvature(mid) < 0) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

/** Prograde ISCO radius for spin a (M = 1). */
export function iscoRadius(a: number) {
  const z1 = 1 + Math.cbrt(1 - a * a) * (Math.cbrt(1 + a) + Math.cbrt(1 - a));
  const z2 = Math.sqrt(3 * a * a + z1 * z1);
  return 3 + z2 - Math.sqrt((3 - z1) * (3 + z1 + 2 * z2));
}

/**
 * Flux emitted from each face of the disk, per unit accretion rate (M = 1, Ṁ = 1), at the
 * radii `rs` (ascending, starting at the ISCO). Page & Thorne (1974):
 *
 *   F(r) = −Ω′ / (4π r (E − ΩL)²) · ∫_{r_isco}^{r} (E − ΩL) L′ dr
 *
 * Far out it tends to the Newtonian 3/(8π r³)·(1 − √(r_in/r)).
 */
export function novikovThorneFlux(a: number, rs: number[]) {
  const d = (fn: (r: number) => number, r: number) => {
    const h = 1e-5 * r;
    return (fn(r + h) - fn(r - h)) / (2 * h);
  };
  const E = (r: number) => circularOrbit(r, a).E;
  const L = (r: number) => circularOrbit(r, a).L;
  const W = (r: number) => circularOrbit(r, a).Omega;
  const integrand = (r: number) => (E(r) - W(r) * L(r)) * d(L, r);

  const flux: number[] = [];
  let integral = 0;
  rs.forEach((r, i) => {
    if (i > 0) {
      // Simpson on each interval keeps the integral accurate near the ISCO.
      const r0 = rs[i - 1];
      integral += ((r - r0) / 6) * (integrand(r0) + 4 * integrand((r0 + r) / 2) + integrand(r));
    }
    const { E: e, L: l, Omega: w } = circularOrbit(r, a);
    flux.push((-d(W, r) / (4 * Math.PI * r * (e - w * l) ** 2)) * integral);
  });
  return flux;
}

export interface DiskModel {
  rIn: number;
  rOut: number;
  /** Radii of the samples, denser near the ISCO: r = rIn + (rOut − rIn)·s², s uniform. */
  r: number[];
  /** Effective temperature (K) of the gas at each sample, in its own rest frame. */
  T: number[];
  Tmax: number;
  /** Radius of the hottest ring. */
  rPeak: number;
  /** Radiative efficiency 1 − E_isco: the fraction of rest mass radiated before plunging. */
  efficiency: number;
  /** Total luminosity (W), as measured far away. */
  luminosity: number;
}

/**
 * Temperatures across a real disk: mass in solar masses, spin χ, accretion rate as a fraction
 * of the Eddington rate (the rate whose luminosity would balance gravity with radiation
 * pressure). σT⁴ = F_SI with F_SI = Ṁc² F / r_g², from the dimensionless flux above.
 */
export function diskModel(massSolar: number, spin: number, eddington: number, rOut: number, samples = 256): DiskModel {
  const rIn = iscoRadius(spin);
  const r = Array.from({ length: samples }, (_, i) => rIn + (rOut - rIn) * (i / (samples - 1)) ** 2);
  const F = novikovThorneFlux(spin, r);
  const efficiency = 1 - circularOrbit(rIn, spin).E;
  const mdotC2 = (eddington * eddingtonLuminosity(massSolar)) / efficiency; // W
  const rg = gravitationalRadius(massSolar);
  const T = F.map((f) => ((Math.max(f, 0) * mdotC2) / (rg * rg) / SIGMA_SB) ** 0.25);
  const iMax = T.indexOf(Math.max(...T));
  return { rIn, rOut, r, T, Tmax: T[iMax], rPeak: r[iMax], efficiency, luminosity: efficiency * mdotC2 };
}
