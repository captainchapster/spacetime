import { type Christoffel, type Mat4, type Vec4, inverse4, zeroChristoffel, zeros4 } from './linalg';

/**
 * Static, spherically symmetric spacetimes can be written in a "Schwarzschild-form" chart
 *   ds² = −q(r) dt² + dr²/q(r) + r² dΩ²
 * The time-warp embedding is built from q. This chart's t may differ from the coordinate
 * time the spacetime is simulated in, so `staticTime` converts between them.
 */
export interface StaticSphericalChart {
  /** q(r) = −g_tt in the static chart: the squared tick rate of a clock held at radius r. */
  lapseSquared(r: number): number;
  /** The static chart's time for an event at simulation time t and radius r. */
  staticTime(t: number, r: number): number;
}

/**
 * A spacetime is a metric field g_μν(x) over coordinates (t, x, y, z).
 * Everything else (geodesics, light cones, clock rates) is derived from it, so adding
 * a new spacetime only needs `metric`; `numericalChristoffel` supplies the connection.
 */
export interface Spacetime {
  readonly id: string;
  readonly label: string;
  /** Coordinate radius of an event horizon centred on the spatial origin, or null. */
  readonly horizonRadius: number | null;
  /** Present only for static, spherically symmetric spacetimes. */
  readonly chart?: StaticSphericalChart;
  metric(x: Vec4): Mat4;
  christoffel(x: Vec4): Christoffel;
  /**
   * Coordinate time over which the geometry near x changes appreciably.
   * The integrator takes a small fraction of this per step.
   */
  timescale(x: Vec4): number;
  /** Integration cannot continue here (e.g. at a curvature singularity). */
  isSingular(x: Vec4): boolean;
}

/**
 * Γ^μ_αβ = ½ g^μν (∂_α g_νβ + ∂_β g_να − ∂_ν g_αβ), with the metric derivatives taken
 * by central differences of step h. Pass `stationary` when g does not depend on t.
 */
export function numericalChristoffel(
  metric: (x: Vec4) => Mat4,
  x: Vec4,
  h: number,
  stationary = false,
): Christoffel {
  // dg[n][a][b] = ∂_n g_ab
  const dg: Mat4[] = [];
  for (let n = 0; n < 4; n++) {
    if (n === 0 && stationary) {
      dg.push(zeros4());
      continue;
    }
    const xp: Vec4 = [...x];
    const xm: Vec4 = [...x];
    xp[n] += h;
    xm[n] -= h;
    const gp = metric(xp);
    const gm = metric(xm);
    dg.push(gp.map((row, a) => row.map((v, b) => (v - gm[a][b]) / (2 * h))));
  }

  const gi = inverse4(metric(x));
  const G = zeroChristoffel();
  for (let m = 0; m < 4; m++) {
    for (let a = 0; a < 4; a++) {
      for (let b = a; b < 4; b++) {
        let s = 0;
        for (let n = 0; n < 4; n++) s += gi[m][n] * (dg[a][n][b] + dg[b][n][a] - dg[n][a][b]);
        G[m][a][b] = G[m][b][a] = 0.5 * s;
      }
    }
  }
  return G;
}

export function spatialRadius(x: ArrayLike<number>): number {
  return Math.hypot(x[1], x[2], x[3]);
}

/**
 * Tick rate of a clock held at fixed spatial coordinates, relative to coordinate time:
 * dτ/dt = √(−g_tt). Null where no such observer exists (g_tt ≥ 0, e.g. inside a horizon).
 */
export function staticClockRate(st: Spacetime, x: Vec4): number | null {
  const gtt = st.metric(x)[0][0];
  return gtt < 0 ? Math.sqrt(-gtt) : null;
}
