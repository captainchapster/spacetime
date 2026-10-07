import { describe, expect, it } from 'vitest';
import { type V4, lower, traceRay } from '../src/physics/kerrRays';
import { inner } from '../src/physics/linalg';
import { Kerr } from '../src/physics/metrics/kerr';

/**
 * What you see inside a (non-spinning) black hole, falling from rest at infinity.
 *
 * In the faller's frame, a photon of energy E = 1 and impact parameter b has radial
 * momentum p solving (β² − 1)p² + 2βp + 1 − b²/r² = 0, with β = √(2M/r) and local energy
 * ε = 1 + βp. Only photons with b < 3√3 M fall in from outside, so the outside sky fills a
 * disk around the zenith whose edge is the b = 3√3 M photon. Light from straight up arrives
 * with ε = 1/(1 + β): the disk reddens and darkens as you go deeper, but never vanishes.
 */
const hole = new Kerr(1, 0);

function analyticEdge(r: number) {
  const beta = Math.sqrt(2 / r);
  const b = 3 * Math.sqrt(3);
  const A = beta * beta - 1;
  const B = 2 * beta;
  const C = 1 - (b * b) / (r * r);
  const p = Math.abs(A) < 1e-12 ? -C / B : (-B + Math.sqrt(B * B - 4 * A * C)) / (2 * A);
  return (Math.acos(-p / (1 + beta * p)) * 180) / Math.PI;
}

function rainCamera(r: number) {
  const x: V4 = [0, r, 0, 0];
  const g = hole.metric(x);
  const beta = Math.sqrt(2 / r);
  // u_t = −1 (E = 1) and u^r = −β; Kerr–Schild t differs from Schwarzschild t only by a function of r.
  const u: V4 = [(1 + beta + beta * beta) / (1 + beta), -beta, 0, 0];
  const unit = (v: V4) => {
    const w = v.map((c, k) => c + inner(g, v, u) * u[k]) as V4;
    const n = Math.sqrt(inner(g, w, w));
    return w.map((c) => c / n) as V4;
  };
  const up = unit([0, 1, 0, 0]);
  const side = unit([0, 0, 1, 0]);
  /** Trace the ray seen at `deg` degrees from the zenith. */
  return (deg: number) => {
    const t = (deg * Math.PI) / 180;
    const k = u.map((c, m) => -c + Math.cos(t) * up[m] + Math.sin(t) * side[m]) as V4;
    return traceRay(x, lower(x, k, 0), {
      a: 0,
      rHorizon: 2,
      diskIn: 0,
      diskOut: 0,
      stepScale: 0.01,
      maxSteps: 50000,
      escapeRadius: 1000,
      cameraInside: true,
    });
  };
}

describe('inside the horizon', () => {
  for (const r of [1.5, 1.0, 0.5]) {
    it(`at r = ${r}M: outside sky edge and zenith redshift match the exact result`, () => {
      const see = rainCamera(r);
      const zenith = see(0);
      expect(zenith.kind).toBe('sky');
      if (zenith.kind === 'sky') expect(zenith.g).toBeCloseTo(1 / (1 + Math.sqrt(2 / r)), 4);
      // Bisect for the edge of the outside sky.
      let lo = 90;
      let hi = 179;
      for (let i = 0; i < 20; i++) {
        const mid = (lo + hi) / 2;
        if (see(mid).kind === 'sky') lo = mid;
        else hi = mid;
      }
      expect(Math.abs(lo - analyticEdge(r))).toBeLessThan(0.3);
    });
  }
});
