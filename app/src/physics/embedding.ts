import type { StaticSphericalChart } from './spacetime';

/**
 * A curved surface whose straight lines are radial free fall: "time curving makes gravity".
 *
 * The (t, r) plane of a static chart, ds² = −q dt² + dr²/q, can't be drawn faithfully in
 * ordinary 3D space (its geometry is Lorentzian). Following Jonsson (Am. J. Phys. 73, 248,
 * 2005) we instead draw a Riemannian surface
 *
 *   dσ² = h(r) dt² + k(r) dr²,   h = q / (aq − 1),   k = 1 / (q (aq − 1)²)
 *
 * whose geodesics trace exactly the same r(t) curves as radial worldlines. A fall with
 * energy E (E² > 1/a) maps to a surface geodesic with Clairaut constant K² = 1/(a − 1/E²);
 * both have dr/dt = 0 where q = E². Matching (dr/dt)² for every E is what makes the curves
 * identical; validation/test_embedding.py checks the algebra symbolically.
 *
 * The surface is drawn as a surface of revolution with time as the angle, θ = t/P, so its
 * radius is ρ = P√h. Its height comes from making the induced metric correct, which needs
 * k ≥ (dρ/dr)², so P is the largest value that allows this over [rInner, rOuter]. Time
 * therefore wraps around the surface once every 2πP.
 *
 * The surface flares out toward the mass, where clocks are slow. Something "at rest" moves
 * purely through time, i.e. around the surface along a circle; a straight line started
 * that way drifts toward the wider part. That drift is the fall.
 */
export class TimeEmbedding {
  /** The free constant in h and k, fixed so that aq − 1 = `flare` at the inner edge. */
  readonly a: number;
  /** Static-chart time per radian around the surface. */
  readonly P: number;
  private readonly dr: number;
  private readonly rho: Float64Array;
  private readonly y: Float64Array;

  constructor(
    readonly chart: StaticSphericalChart,
    readonly rInner: number,
    readonly rOuter: number,
    /** aq − 1 at the inner edge: smaller flares harder, but forces time to wrap faster. */
    readonly flare = 0.5,
    samples = 1200,
  ) {
    if (!(rOuter > rInner) || chart.lapseSquared(rInner) <= 0) {
      throw new Error('Embedding needs rOuter > rInner > horizon.');
    }
    this.a = (1 + flare) / chart.lapseSquared(rInner);
    this.dr = (rOuter - rInner) / (samples - 1);
    const rs = Array.from({ length: samples }, (_, i) => rInner + i * this.dr);

    // d√h/dr, by central differences of the closed form.
    const dSqrtH = rs.map((r) => {
      const e = 1e-5 * r;
      return (Math.sqrt(this.h(r + e)) - Math.sqrt(this.h(Math.max(rInner, r - e)))) / (r + e - Math.max(rInner, r - e));
    });
    let bound = Infinity;
    rs.forEach((r, i) => {
      if (Math.abs(dSqrtH[i]) > 1e-12) bound = Math.min(bound, Math.sqrt(this.k(r)) / Math.abs(dSqrtH[i]));
    });
    // Flat spacetime gives a cylinder with no bound; any P works, so pick a pleasant one.
    this.P = Math.min(0.9 * bound, rOuter);

    this.rho = Float64Array.from(rs, (r) => this.P * Math.sqrt(this.h(r)));
    const slope = rs.map((r, i) => Math.sqrt(Math.max(0, this.k(r) - (this.P * dSqrtH[i]) ** 2)));
    this.y = new Float64Array(samples);
    for (let i = samples - 2; i >= 0; i--) {
      this.y[i] = this.y[i + 1] - 0.5 * (slope[i] + slope[i + 1]) * this.dr; // mass end at the bottom
    }
  }

  h(r: number) {
    const q = this.chart.lapseSquared(r);
    return q / (this.a * q - 1);
  }

  k(r: number) {
    const q = this.chart.lapseSquared(r);
    return 1 / (q * (this.a * q - 1) ** 2);
  }

  /** Static-chart time for one full turn around the surface. */
  get wrapTime() {
    return 2 * Math.PI * this.P;
  }

  get maxRadius() {
    return Math.max(this.rho[0], this.rho[this.rho.length - 1]);
  }

  /** Height of the inner (mass-side) edge; the outer edge is at height 0. */
  get bottom() {
    return this.y[0];
  }

  radiusAt(r: number) {
    return this.lerp(this.rho, r);
  }

  heightAt(r: number) {
    return this.lerp(this.y, r);
  }

  /**
   * Display position of static-chart time t (measured from the reference meridian) at
   * radius r. Returns false outside the covered range of r.
   */
  place(t: number, r: number, out: Float32Array | number[], o = 0) {
    if (!(r >= this.rInner && r <= this.rOuter)) return false;
    const rho = this.radiusAt(r);
    const th = t / this.P;
    out[o] = rho * Math.cos(th);
    out[o + 1] = this.heightAt(r);
    out[o + 2] = -rho * Math.sin(th);
    return true;
  }

  private lerp(table: Float64Array, r: number) {
    const f = Math.min(Math.max((r - this.rInner) / this.dr, 0), table.length - 1);
    const i = Math.min(Math.floor(f), table.length - 2);
    return table[i] + (f - i) * (table[i + 1] - table[i]);
  }
}
