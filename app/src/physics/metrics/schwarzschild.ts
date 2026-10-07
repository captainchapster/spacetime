import { ETA, type Mat4, type Vec4 } from '../linalg';
import { type Spacetime, numericalChristoffel, spatialRadius } from '../spacetime';

/**
 * A non-rotating black hole of mass M at the origin, in ingoing Kerr–Schild coordinates:
 *
 *   g_μν = η_μν + (2M/r) l_μ l_ν,   l_μ = (1, x/r, y/r, z/r)
 *
 * Unlike textbook Schwarzschild coordinates these are Cartesian-like and regular at the
 * horizon r = 2M, so infalling bodies cross it smoothly instead of freezing there.
 * The time coordinate differs from Schwarzschild t by 2M·ln|r/2M − 1|, which depends only
 * on r: clocks at fixed position still tick at √(1 − 2M/r) relative to t, and circular
 * orbits have the same angular velocity Ω = √(M/r³). Units: G = c = 1.
 */
export class Schwarzschild implements Spacetime {
  readonly id = 'schwarzschild';
  readonly label = 'Schwarzschild black hole';

  constructor(readonly mass = 1) {}

  get horizonRadius() {
    return 2 * this.mass;
  }

  /** Textbook Schwarzschild coordinates: q = 1 − 2M/r, and t_S = t − 2M·ln(r/2M − 1) outside the horizon. */
  readonly chart = {
    lapseSquared: (r: number) => 1 - (2 * this.mass) / r,
    staticTime: (t: number, r: number) => t - 2 * this.mass * Math.log(r / (2 * this.mass) - 1),
  };

  metric(x: Vec4): Mat4 {
    const r = spatialRadius(x);
    const f = (2 * this.mass) / r;
    const l = [1, x[1] / r, x[2] / r, x[3] / r];
    return ETA.map((row, a) => row.map((v, b) => v + f * l[a] * l[b]));
  }

  christoffel(x: Vec4) {
    const h = 1e-4 * Math.max(spatialRadius(x), this.mass);
    return numericalChristoffel((p) => this.metric(p), x, h, true);
  }

  timescale(x: Vec4) {
    // ~ the local orbital (or light-crossing, near the hole) time, which shrinks toward r = 0.
    const r = spatialRadius(x);
    return r * Math.sqrt(r / (2 * this.mass));
  }

  isSingular(x: Vec4) {
    return spatialRadius(x) < 0.1 * this.mass;
  }
}
