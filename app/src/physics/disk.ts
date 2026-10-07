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
