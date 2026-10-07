import { type BodyKind, renormalise, rk4Step } from './geodesic';
import type { Vec4 } from './linalg';
import { type Spacetime, spatialRadius } from './spacetime';

/** Number of values stored per recorded event: t, x, y, z, τ. */
export const EVENT_STRIDE = 5;

export interface IntegratorConfig {
  /** Fraction of the spacetime's local timescale taken per step. */
  stepFraction: number;
  /** Upper bound on the coordinate time per step. */
  maxStep: number;
  /** Coordinate time between recorded worldline events. */
  recordInterval: number;
  /** Safety cap on steps per `advanceTo` call, so one body can't freeze a frame. */
  maxStepsPerCall: number;
  /** Bodies beyond this coordinate radius stop being integrated. */
  escapeRadius: number;
}

export type BodyFate = 'active' | 'absorbed' | 'escaped' | 'stalled';

let nextId = 1;

/**
 * A free-falling test body. Its state is integrated along a geodesic, and its past is kept
 * as a worldline: a list of events. Views never touch the state directly; they only read
 * the worldline, which is what lets any slice or projection of 4D be rendered.
 */
export class Body {
  readonly id = nextId++;
  x: Vec4;
  u: Vec4;
  /** Proper time elapsed along the worldline (stays 0 for light). */
  tau = 0;
  fate: BodyFate = 'active';
  /** Recorded events, flattened as [t, x, y, z, τ, t, x, ...]. */
  history: number[] = [];
  private lastRecordT = -Infinity;

  constructor(
    readonly kind: BodyKind,
    x: Vec4,
    u: Vec4,
    readonly color: number,
    readonly label = '',
  ) {
    this.x = [...x];
    this.u = [...u];
    this.record();
  }

  get alive() {
    return this.fate === 'active';
  }

  get eventCount() {
    return this.history.length / EVENT_STRIDE;
  }

  /** Integrate forward until coordinate time reaches T (or the body stops). */
  advanceTo(st: Spacetime, T: number, cfg: IntegratorConfig) {
    let steps = 0;
    while (this.alive && this.x[0] < T - 1e-9) {
      if (steps++ >= cfg.maxStepsPerCall) return; // resume next frame
      const dt = Math.min(T - this.x[0], cfg.stepFraction * st.timescale(this.x), cfg.maxStep);
      const h = dt / this.u[0];
      const next = rk4Step(st, this.x, this.u, h);
      if (!next.x.every(Number.isFinite) || !next.u.every(Number.isFinite) || next.u[0] <= 0) {
        this.fate = 'stalled';
        break;
      }
      this.x = next.x;
      this.u = renormalise(st, next.x, next.u, this.kind);
      if (this.kind === 'massive') this.tau += h;

      if (st.isSingular(this.x)) this.fate = 'absorbed';
      else if (spatialRadius(this.x) > cfg.escapeRadius) this.fate = 'escaped';
      if (this.x[0] - this.lastRecordT >= cfg.recordInterval) this.record();
    }
    if (!this.alive) this.record();
  }

  /** Last coordinate time this body has been integrated to. */
  get latestT() {
    return this.x[0];
  }

  /** Drop recorded events older than t (keeping one, so the line still reaches t). */
  trimBefore(t: number) {
    const h = this.history;
    let i = 0;
    while (i + EVENT_STRIDE < h.length && h[i + EVENT_STRIDE] < t) i += EVENT_STRIDE;
    // Splicing is O(n), so only bother once a decent chunk has expired.
    if (i >= 256 * EVENT_STRIDE) h.splice(0, i);
  }

  /**
   * Interpolated event at coordinate time t, written into out[0..4] as (t, x, y, z, τ).
   * Returns false if t is outside the recorded worldline.
   */
  sampleAt(t: number, out: number[]): boolean {
    const h = this.history;
    const n = h.length / EVENT_STRIDE;
    if (n === 0 || t < h[0] || t > h[(n - 1) * EVENT_STRIDE]) return false;
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (h[mid * EVENT_STRIDE] <= t) lo = mid;
      else hi = mid;
    }
    const a = lo * EVENT_STRIDE;
    const b = hi * EVENT_STRIDE;
    const span = h[b] - h[a];
    const f = span > 0 ? (t - h[a]) / span : 0;
    for (let k = 0; k < EVENT_STRIDE; k++) out[k] = h[a + k] + f * (h[b + k] - h[a + k]);
    return true;
  }

  private record() {
    this.history.push(this.x[0], this.x[1], this.x[2], this.x[3], this.tau);
    this.lastRecordT = this.x[0];
  }
}
